import { composeSpawnPayload, type PipeCommand, type PipeEvent } from "@cove/protocol/pipe";
import { domainError } from "@cove/protocol/errors";
import { sameWorkerRef, type RunRef, type WorkerRef } from "@cove/protocol/identity";
import type { Geometry } from "@cove/protocol/profile";
import type { RuntimeResult, RuntimeTerminalPort } from "@cove/protocol/runtime";
import type { WorkerHealth } from "@cove/protocol/terminal";
import { WorkerPool } from "./worker-pool.js";
import { RunRegistry } from "./run-registry.js";
import { WorkerPipeSession, type ResultHandoff } from "./worker-pipe-session.js";
import type { ByteReservation } from "./runtime-retained-bytes.js";
import { PreviewRefresh, type PreviewPolicy } from "./preview-refresh.js";
import type { PreviewResultSeal } from "./worker-pipe-session.js";

export class LocalRuntime implements RuntimeTerminalPort {
  private readonly listeners = new Map<
    (event: PipeEvent, payload: Uint8Array) => void,
    ByteReservation
  >();
  private readonly workerListeners: { dispose(): void }[] = [];
  private readonly healthListeners = new Map<
    (worker: WorkerRef, health: WorkerHealth) => void,
    ByteReservation
  >();
  private disposed = false;
  private previewOwner: PreviewRefresh | undefined;
  constructor(
    readonly pool: WorkerPool,
    readonly registry: RunRegistry,
    private readonly encodeUtf8: (text: string) => Uint8Array,
    private readonly resultHandoff?: ResultHandoff,
    private readonly previewPolicy: Partial<PreviewPolicy> = {},
  ) {
    if (registry.composition !== pool.composition || registry.maxRuns > pool.budgets.maxRuns)
      throw new Error("Runtime budget mismatch");
  }

  get composition() {
    return this.pool.composition;
  }
  private get bytes() {
    return this.composition.bytes;
  }

  addWorker(session: WorkerPipeSession): boolean {
    if (this.disposed || !this.pool.accepts(session)) return false;
    let listener: { dispose(): void };
    try {
      listener = session.onEvent((event, payload) => {
        if (this.disposed) return;
        // Record the exit before any subscriber can publish it, so a client that has
        // seen the exit event never reads a live run record afterwards.
        if (event.terminal.type === "exit")
          this.registry.observeExit(event.worker, event.run, event.terminal);
        for (const sink of [...this.listeners.keys()]) {
          if (this.disposed) break;
          if (this.listeners.has(sink)) sink(event, payload);
        }
      });
    } catch {
      return false;
    }
    let health: { dispose(): void };
    try {
      health = session.onHealth((value) => {
        if (this.disposed) return;
        for (const sink of [...this.healthListeners.keys()]) {
          if (this.disposed) break;
          if (this.healthListeners.has(sink)) sink({ ...session.worker }, value);
        }
      });
    } catch {
      listener.dispose();
      return false;
    }
    if (!this.pool.add(session)) {
      listener.dispose();
      health.dispose();
      return false;
    }
    this.workerListeners.push(listener, health);
    return true;
  }

  // Informational worker health changes (issue #103), for logging and for subscriptions to
  // publish to clients. A listener may be foreign code; a throwing one is isolated by the session.
  onWorkerHealth(listener: (worker: WorkerRef, health: WorkerHealth) => void): {
    dispose(): void;
  } {
    if (this.disposed || this.healthListeners.size >= 1024 || this.healthListeners.has(listener))
      throw new Error("Health listener capacity unavailable");
    const lease = this.bytes.reserve(512);
    if (!lease) throw new Error("Health listener byte capacity unavailable");
    this.healthListeners.set(listener, lease);
    return {
      dispose: () => {
        if (this.healthListeners.get(listener) !== lease) return;
        this.healthListeners.delete(listener);
        lease.release();
      },
    };
  }

  // The current health of the worker serving a run, or undefined when it has none.
  workerHealth(run: RunRef): WorkerHealth | undefined {
    return this.pool.get(run)?.session.workerHealth;
  }

  reserveRun(run: RunRef, geometry: Geometry): WorkerRef | null {
    if (
      this.disposed ||
      geometry.cols > this.pool.budgets.maxCols ||
      geometry.rows > this.pool.budgets.maxRows
    )
      return null;
    const placement = this.pool.reserve(run);
    if (!placement) return null;
    if (!this.registry.reserve(run, placement.worker, geometry)) {
      this.pool.release(run, placement.worker);
      return null;
    }
    if (!placement.session.registerRun(run)) {
      this.registry.cancelReservation(run, placement.worker);
      this.pool.release(run, placement.worker);
      return null;
    }
    return { ...placement.worker };
  }

  cancelRunReservation(run: RunRef, worker: WorkerRef): boolean {
    if (!this.registry.cancelReservation(run, worker)) return false;
    this.pool.get(run)?.session.forgetUnstartedRun(run);
    return this.pool.release(run, worker);
  }

  // The future native adapter supplies this proof, never a socket-close callback.
  releaseOwnedCapacity(proof: {
    run: RunRef;
    worker: WorkerRef;
    writerClosed: true;
    directlyOwnedLeaderExited: true;
  }): boolean {
    if (
      proof.writerClosed !== true ||
      proof.directlyOwnedLeaderExited !== true ||
      !this.pool.get(proof.run) ||
      !this.registry.releaseCapacity(proof.run, proof.worker)
    )
      return false;
    return this.pool.release(proof.run, proof.worker);
  }

  private unavailable(command: PipeCommand): RuntimeResult {
    return {
      type: "error",
      worker: command.worker,
      run: command.run,
      requestId: command.requestId,
      commandType: command.type,
      error: domainError("WORKER_UNAVAILABLE"),
    };
  }

  private async request(
    command: PipeCommand,
    payload?: Uint8Array,
    unsubscribe = false,
    statusEligible?: () => boolean,
  ): Promise<RuntimeResult> {
    const placement = this.pool.get(command.run);
    if (this.disposed || !placement || !sameWorkerRef(command.worker, placement.worker))
      return this.unavailable(command);
    if (!placement.session.ready) this.registry.contactLost(placement.worker);
    // A spawn is dispatched only once its frame is handed to the worker transport: the worker can
    // spawn nothing it never received. A spawn refused at admission (full window, session not
    // ready, ...) or queued and then withdrawn unsent (contact lost while the transport was
    // blocked) never reaches the worker, so the run must not be treated as known to the worker
    // (preview ticks would poll it) or keep holding run resources. A spawn that was handed over
    // keeps its reservation even when its result is unknown: the worker may have spawned it.
    let sent = false;
    const markSent =
      command.type === "spawn"
        ? () => {
            sent = true;
            this.registry.markDispatched(command.run, command.worker);
          }
        : undefined;
    // An unsubscribe carries no result handoff; every route-control command, this one
    // included, waits for a free slot in the worker's route-control window.
    const result = await (unsubscribe && command.type === "unsubscribe"
      ? placement.session.requestUnsubscribe(command)
      : command.type === "status"
        ? placement.session.requestStatus(command, statusEligible)
        : placement.session.request(command, payload, this.resultHandoff, markSent));
    // Never written, so definitely not accepted: release the reservation, which also drops the
    // session's record of the run.
    if (command.type === "spawn" && !sent) this.cancelRunReservation(command.run, command.worker);
    if (result.type === "result" && result.runStatus)
      this.registry.observe(placement.worker, result.runStatus);
    if (!placement.session.ready) this.registry.contactLost(placement.worker);
    return result;
  }

  spawn(input: Parameters<RuntimeTerminalPort["spawn"]>[0]): Promise<RuntimeResult> {
    const composed = composeSpawnPayload(input, this.encodeUtf8);
    const command: Extract<PipeCommand, { type: "spawn" }> = {
      type: "spawn",
      worker: input.worker,
      run: input.run,
      requestId: input.requestId,
      operationId: input.operationId,
      geometry: input.geometry,
      appearance: input.appearance,
      effectiveBudgets: input.effectiveBudgets,
      profile: input.profile,
      spawnPayloadBytes: composed?.bytes.byteLength ?? 1,
    };
    if (composed) return this.request(command, composed.bytes);
    // Nothing was sent: release the reservation as for a spawn that was never written.
    this.cancelRunReservation(command.run, command.worker);
    return Promise.resolve(this.unavailable(command));
  }
  stop(input: Parameters<RuntimeTerminalPort["stop"]>[0]): Promise<RuntimeResult> {
    return this.request(input);
  }
  setControl(input: Parameters<RuntimeTerminalPort["setControl"]>[0]): Promise<RuntimeResult> {
    return this.request(input);
  }
  writeInput(
    input: Parameters<RuntimeTerminalPort["writeInput"]>[0],
    bytes: Uint8Array,
  ): Promise<RuntimeResult> {
    return this.request(input, bytes);
  }
  resize(input: Parameters<RuntimeTerminalPort["resize"]>[0]): Promise<RuntimeResult> {
    return this.request(input);
  }
  setAppearance(
    input: Parameters<RuntimeTerminalPort["setAppearance"]>[0],
  ): Promise<RuntimeResult> {
    return this.request(input);
  }
  openSubscription(
    input: Parameters<RuntimeTerminalPort["openSubscription"]>[0],
  ): Promise<RuntimeResult> {
    return this.request(input);
  }
  closeSubscription(
    input: Parameters<RuntimeTerminalPort["closeSubscription"]>[0],
  ): Promise<RuntimeResult> {
    return this.request(input, undefined, true);
  }
  ackApplied(input: Parameters<RuntimeTerminalPort["ackApplied"]>[0]): Promise<RuntimeResult> {
    return this.request(input);
  }
  ackBaselineProgress(
    input: Parameters<RuntimeTerminalPort["ackBaselineProgress"]>[0],
  ): Promise<RuntimeResult> {
    return this.request(input);
  }
  // Status reads wait in arrival order for the worker's single status window rather than being
  // refused while another read holds it (issue #115; see WorkerPipeSession.requestStatus). The
  // wait spends the read's own deadline, and `eligible` (the caller's lifetime) lets an unsent
  // read be dropped when nobody needs its answer any more.
  getStatus(
    input: Parameters<RuntimeTerminalPort["getStatus"]>[0],
    eligible?: () => boolean,
  ): Promise<RuntimeResult> {
    return this.request(input, undefined, false, eligible);
  }
  refreshPreview(
    input: Parameters<RuntimeTerminalPort["refreshPreview"]>[0],
  ): Promise<RuntimeResult> {
    return this.request(input);
  }

  get previews(): PreviewRefresh {
    if (this.disposed) throw new Error("Runtime disposed");
    return (this.previewOwner ??= new PreviewRefresh(this, this.previewPolicy));
  }
  tickPreviews(): void {
    this.previews.tick();
  }
  async requestPreviewSealed(
    input: Extract<PipeCommand, { type: "preview-refresh" }>,
    seal: PreviewResultSeal,
  ): Promise<RuntimeResult> {
    const placement = this.pool.get(input.run);
    if (this.disposed || !placement || !sameWorkerRef(input.worker, placement.worker))
      return this.unavailable(input);
    const result = await placement.session.requestPreview(input, (result) => {
      if (result.type === "result" && result.runStatus)
        this.registry.observe(placement.worker, result.runStatus);
      seal(result);
    });
    if (result.type === "result" && result.runStatus)
      this.registry.observe(placement.worker, result.runStatus);
    if (!placement.session.ready) this.registry.contactLost(placement.worker);
    return result;
  }

  onEvent(listener: (event: PipeEvent, payload: Uint8Array) => void): { dispose(): void } {
    if (
      this.disposed ||
      this.listeners.size >= this.composition.budgets.authenticatedSockets + 2 ||
      this.listeners.has(listener)
    )
      throw new Error("Event listener capacity unavailable");
    const lease = this.bytes.reserve(512);
    if (!lease) throw new Error("Event listener byte capacity unavailable");
    this.listeners.set(listener, lease);
    return {
      dispose: () => {
        if (this.listeners.get(listener) !== lease) return;
        this.listeners.delete(listener);
        lease.release();
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.previewOwner?.dispose();
    for (const listener of this.workerListeners) listener.dispose();
    this.workerListeners.length = 0;
    for (const session of this.pool.sessions()) session.loseContact();
    for (const lease of this.listeners.values()) lease.release();
    this.listeners.clear();
    for (const lease of this.healthListeners.values()) lease.release();
    this.healthListeners.clear();
    this.pool.dispose();
    this.registry.dispose();
  }
}
