import { composeSpawnPayload, type PipeCommand, type PipeEvent } from "@cove/protocol/pipe";
import { domainError } from "@cove/protocol/errors";
import { sameWorkerRef, type RunRef, type WorkerRef } from "@cove/protocol/identity";
import type { Geometry } from "@cove/protocol/profile";
import type { RuntimeResult, RuntimeTerminalPort } from "@cove/protocol/runtime";
import { WorkerPool } from "./worker-pool.js";
import { RunRegistry } from "./run-registry.js";
import { WorkerPipeSession, type ResultHandoff } from "./worker-pipe-session.js";
import { RuntimeRetainedBytes, type ByteReservation } from "./runtime-retained-bytes.js";

export class LocalRuntime implements RuntimeTerminalPort {
  private readonly listeners = new Map<
    (event: PipeEvent, payload: Uint8Array) => void,
    ByteReservation
  >();
  private readonly workerListeners: { dispose(): void }[] = [];
  private disposed = false;
  constructor(
    readonly pool: WorkerPool,
    readonly registry: RunRegistry,
    private readonly bytes: RuntimeRetainedBytes,
    private readonly encodeUtf8: (text: string) => Uint8Array,
    private readonly resultHandoff?: ResultHandoff,
  ) {
    if (registry.maxRuns > pool.budgets.maxRuns || bytes.limit > pool.budgets.runtimeBytes)
      throw new Error("Runtime budget mismatch");
  }

  addWorker(session: WorkerPipeSession): boolean {
    if (this.disposed) return false;
    let listener: { dispose(): void };
    try {
      listener = session.onEvent((event, payload) => {
        if (this.disposed) return;
        for (const sink of [...this.listeners.keys()]) {
          if (this.disposed) break;
          if (this.listeners.has(sink)) sink(event, payload);
        }
      });
    } catch {
      return false;
    }
    if (!this.pool.add(session)) {
      listener.dispose();
      return false;
    }
    this.workerListeners.push(listener);
    return true;
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

  private async request(command: PipeCommand, payload?: Uint8Array): Promise<RuntimeResult> {
    const placement = this.pool.get(command.run);
    if (this.disposed || !placement || !sameWorkerRef(command.worker, placement.worker))
      return this.unavailable(command);
    if (!placement.session.ready) this.registry.contactLost(placement.worker);
    if (command.type === "spawn") this.registry.markDispatched(command.run, command.worker);
    const result = await placement.session.request(command, payload, this.resultHandoff);
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
    return composed
      ? this.request(command, composed.bytes)
      : Promise.resolve(this.unavailable(command));
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
    return this.request(input);
  }
  ackApplied(input: Parameters<RuntimeTerminalPort["ackApplied"]>[0]): Promise<RuntimeResult> {
    return this.request(input);
  }
  ackBaselineProgress(
    input: Parameters<RuntimeTerminalPort["ackBaselineProgress"]>[0],
  ): Promise<RuntimeResult> {
    return this.request(input);
  }
  getStatus(input: Parameters<RuntimeTerminalPort["getStatus"]>[0]): Promise<RuntimeResult> {
    return this.request(input);
  }
  refreshPreview(
    input: Parameters<RuntimeTerminalPort["refreshPreview"]>[0],
  ): Promise<RuntimeResult> {
    return this.request(input);
  }

  onEvent(listener: (event: PipeEvent, payload: Uint8Array) => void): { dispose(): void } {
    if (this.disposed || this.listeners.size >= 32 || this.listeners.has(listener))
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
    for (const listener of this.workerListeners) listener.dispose();
    this.workerListeners.length = 0;
    for (const session of this.pool.sessions()) session.loseContact();
    for (const lease of this.listeners.values()) lease.release();
    this.listeners.clear();
    this.pool.dispose();
    this.registry.dispose();
  }
}
