import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError, type DomainError } from "@cove/protocol/errors";
import {
  nextCounter,
  SubscriptionRefSchema,
  sameConnectionRef,
  sameRunRef,
  sameSubscriptionRef,
  type RunRef,
  type SubscriptionRef,
} from "@cove/protocol/identity";
import { BASELINE_ENCODING, PROFILE, type Appearance } from "@cove/protocol/profile";
import type { Geometry } from "@cove/protocol/profile";
import {
  validateBaselineDescriptor,
  type BaselineDescriptor,
  type ExternalTerminalEvent,
  type TerminalCommand,
} from "@cove/protocol/terminal";
import type {
  ClientError,
  LocalErrorReason,
  TerminalController,
  TerminalOutcome,
  TerminalReady,
  TerminalSnapshot,
} from "./client.js";
import type { NegotiatedConnection } from "./connection-session.js";
import { TerminalLane, type CommandOutcome } from "./terminal-delivery.js";
import type { Disposable, Scheduler } from "./transport-ports.js";
import type { TerminalView } from "@cove/protocol/view";

type RecoveryReason = "gap" | "released-view" | "resize-context" | "expired";
type Phase = "idle" | "await-marker" | "baseline" | "replay" | "ready" | "unavailable" | "disposed";

interface Operation {
  readonly kind: "attach" | "recover";
  readonly token: number;
  readonly promise: Promise<TerminalOutcome<TerminalReady>>;
  readonly resolve: (result: TerminalOutcome<TerminalReady>) => void;
  timer?: Disposable;
  settled: boolean;
  mode?: "baseline" | "replay";
  atSeq?: number;
  readonly priorParses: readonly Promise<void>[];
  markerAttempted: boolean;
  attachDisposition?: "not-accepted" | "accepted" | "unknown";
}

interface QueuedEvent {
  readonly event: ExternalTerminalEvent;
  readonly payload: Uint8Array;
  readonly charge: number;
  readonly token: number;
}

export interface ControllerHost {
  readonly lane: TerminalLane;
  readonly scheduler: Scheduler;
  binding(): NegotiatedConnection | undefined;
  generation(): number;
  retireConnection(origin?: RoutedTerminalController, error?: ClientError | DomainError): void;
  remove(controller: RoutedTerminalController): void;
}

function localError(reason: LocalErrorReason): ClientError {
  return { category: "local", reason };
}

function errorOutcome(error: ClientError | DomainError): TerminalOutcome<TerminalReady> {
  return { ok: false, error };
}

function safeDispose(disposable: Disposable | undefined): void {
  try {
    disposable?.dispose();
  } catch {
    /* Local retirement continues. */
  }
}

function consumeObserverResult(value: unknown): void {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return;
  try {
    const then = (value as { then?: unknown }).then;
    if (typeof then !== "function") return;
    const derived: unknown = then.call(
      value,
      () => undefined,
      () => undefined,
    );
    if (derived && derived !== value)
      void Promise.resolve(derived).then(undefined, () => undefined);
  } catch {
    /* A hostile observer cannot interrupt state publication. */
  }
}

function identityCopy(ref: SubscriptionRef): SubscriptionRef {
  return Object.freeze({
    run: Object.freeze({ ...ref.run }),
    connection: Object.freeze({ ...ref.connection }),
    subscriptionId: ref.subscriptionId,
    viewId: ref.viewId,
  });
}

export class RoutedTerminalController implements TerminalController {
  private phase: Phase = "idle";
  private ref: SubscriptionRef | undefined;
  private operation: Operation | undefined;
  private token = 0;
  private viewGeneration = 0;
  private listener: Disposable | undefined;
  private appliedSeq = 0;
  private provenSeq = 0;
  private retainedModel = false;
  private retainedGeometry: Geometry | undefined;
  private baseline: BaselineDescriptor | undefined;
  private baselineOrdinal = 0;
  private baselineBytes = 0;
  private readonly queue: QueuedEvent[] = [];
  private queuedBytes = 0;
  private activeBytes = 0;
  private activeItems = 0;
  private readonly viewWork = new Map<
    QueuedEvent,
    { view: TerminalView; promise: Promise<void>; finish: () => void }
  >();
  private drainToken = 0;
  private drainingToken = -1;
  private ackInFlight = false;
  private pendingAck: number | undefined;
  private progressInFlight = false;
  private pendingProgress: number | undefined;
  private autoRecoveryUsed = false;
  private retiring = false;
  private disposalComplete = false;
  private readonly listeners = new Set<(snapshot: TerminalSnapshot) => void>();

  constructor(
    private readonly host: ControllerHost,
    private readonly run: RunRef,
    private readonly viewId: string,
    private view: TerminalView,
    private readonly appearance: Appearance,
  ) {}

  attach(): Promise<TerminalOutcome<TerminalReady>> {
    if (this.phase === "disposed") return Promise.resolve(errorOutcome(localError("disposed")));
    if (this.retiring) return Promise.resolve(errorOutcome(localError("invalid-state")));
    if (this.operation)
      return this.operation.kind === "attach"
        ? this.operation.promise
        : Promise.resolve(errorOutcome(localError("invalid-state")));
    if (this.ref) return Promise.resolve(errorOutcome(localError("invalid-state")));
    if (this.host.lane.retiredCount >= 256)
      return Promise.resolve(errorOutcome(domainError("COUNTER_EXHAUSTED")));
    const binding = this.host.binding();
    if (!binding) return Promise.resolve(errorOutcome(localError("invalid-state")));
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    if (!requestId) return Promise.resolve(errorOutcome(domainError("COUNTER_EXHAUSTED")));
    const operation = this.beginOperation(binding, "attach");
    if (!operation) return Promise.resolve(errorOutcome(localError("invalid-state")));
    if (operation.settled) return operation.promise;
    const command: TerminalCommand = {
      type: "attach",
      requestId,
      run: this.run,
      connection: binding.connection,
      viewId: this.viewId,
      profile: PROFILE,
      encoding: BASELINE_ENCODING,
    };
    this.sendMarker(command, operation);
    return operation.promise;
  }

  recover(reason: RecoveryReason): Promise<TerminalOutcome<TerminalReady>> {
    if (
      reason !== "gap" &&
      reason !== "released-view" &&
      reason !== "resize-context" &&
      reason !== "expired"
    )
      return Promise.resolve(errorOutcome(localError("invalid-request")));
    if (this.phase === "disposed") return Promise.resolve(errorOutcome(localError("disposed")));
    if (this.retiring) return Promise.resolve(errorOutcome(localError("invalid-state")));
    if (this.operation)
      return this.operation.kind === "recover"
        ? this.operation.promise
        : Promise.resolve(errorOutcome(localError("invalid-state")));
    const ref = this.ref;
    const binding = this.host.binding();
    if (!ref || !binding || this.phase !== "ready")
      return Promise.resolve(errorOutcome(localError("invalid-state")));
    const priorToken = this.token;
    const priorView = this.view;
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    if (!requestId) return Promise.resolve(errorOutcome(domainError("COUNTER_EXHAUSTED")));
    let resume:
      | {
          appliedSeq: number;
          profile: typeof PROFILE;
          encoding: typeof BASELINE_ENCODING;
          geometry: Geometry;
        }
      | undefined;
    if (
      this.retainedModel &&
      this.retainedGeometry &&
      ![...this.viewWork.values()].some((work) => work.view === this.view) &&
      reason !== "gap" &&
      reason !== "resize-context"
    ) {
      let measured: Geometry;
      try {
        measured = this.view.measureGrid();
      } catch {
        return Promise.resolve(errorOutcome(localError("invalid-state")));
      }
      if (
        measured.cols === this.retainedGeometry.cols &&
        measured.rows === this.retainedGeometry.rows
      ) {
        resume = {
          appliedSeq: this.appliedSeq,
          profile: PROFILE,
          encoding: BASELINE_ENCODING,
          geometry: this.retainedGeometry,
        };
      }
    }
    if (
      this.token !== priorToken ||
      this.view !== priorView ||
      this.ref !== ref ||
      this.phase !== "ready" ||
      this.host.binding() !== binding
    )
      return Promise.resolve(errorOutcome(localError("invalid-state")));
    if ([...this.viewWork.values()].some((work) => work.view === this.view)) resume = undefined;
    const operation = this.beginOperation(binding, "recover");
    if (!operation) return Promise.resolve(errorOutcome(localError("invalid-state")));
    if (operation.settled) return operation.promise;
    this.host.lane.cancelUnsentControl(ref);
    const command: TerminalCommand = {
      type: "recover",
      requestId,
      run: this.run,
      subscription: ref,
      reason,
      ...(resume ? { resume } : {}),
    };
    this.sendMarker(command, operation);
    return operation.promise;
  }

  async detach(): Promise<TerminalOutcome> {
    if (this.phase === "disposed") return { ok: false, error: localError("disposed") };
    if (this.retiring) return { ok: true, value: undefined };
    const ref = this.ref;
    const unknownAttach = this.mayHaveUnidentifiedAttach();
    if (unknownAttach) {
      const token = this.token;
      this.host.retireConnection(this, localError("invalid-state"));
      if (this.token === token) this.retire(localError("invalid-state"));
      return { ok: true, value: undefined };
    }
    this.retire(localError("invalid-state"));
    if (!ref || !this.currentConnection(ref)) return { ok: true, value: undefined };
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    if (!requestId) return { ok: false, error: domainError("COUNTER_EXHAUSTED") };
    const result = await this.host.lane.send(
      { type: "detach", requestId, run: this.run, subscription: ref },
      5_000,
    );
    if (!result.ok && this.currentConnection(ref)) this.host.retireConnection();
    return result.ok ? { ok: true, value: undefined } : { ok: false, error: result.error };
  }

  async replaceView(view: TerminalView): Promise<TerminalOutcome<TerminalReady>> {
    if (this.phase === "disposed") return errorOutcome(localError("disposed"));
    if (this.retiring) return errorOutcome(localError("invalid-state"));
    void this.detach();
    if (this.snapshot().phase === "disposed") return errorOutcome(localError("disposed"));
    if (this.retiring) return errorOutcome(localError("invalid-state"));
    this.releaseListener();
    try {
      this.view.dispose();
    } catch {
      /* Replacement remains local. */
    }
    this.view = view;
    this.viewGeneration = nextCounter(this.viewGeneration) ?? Number.MAX_SAFE_INTEGER;
    return this.attach();
  }

  setVisibility(visible: boolean): void {
    if (this.phase === "disposed" || this.retiring) return;
    try {
      this.view.setVisibility(visible);
    } catch {
      this.fail(localError("invalid-state"));
    }
  }

  snapshot(): TerminalSnapshot {
    return Object.freeze({
      phase: this.phase,
      appliedSeq: this.appliedSeq,
      viewGeneration: this.viewGeneration,
      queuedBytes: this.queuedBytes,
      activeParseBytes: this.activeBytes,
      ...(this.ref ? { subscription: identityCopy(this.ref) } : {}),
    });
  }

  onState(listener: (snapshot: TerminalSnapshot) => void): Disposable {
    if (this.phase === "disposed") return { dispose() {} };
    this.listeners.add(listener);
    let active = true;
    return {
      dispose: () => {
        if (active) {
          active = false;
          this.listeners.delete(listener);
        }
      },
    };
  }

  dispose(): void {
    if (this.phase === "disposed") return;
    if (this.retiring) {
      // The active retirement owns cleanup; this terminal request cannot be undone.
      this.phase = "disposed";
      return;
    }
    const unknownAttach = this.mayHaveUnidentifiedAttach();
    if (unknownAttach) this.host.retireConnection(this, localError("disposed"));
    if (this.snapshot().phase === "disposed") return;
    const ref = this.ref;
    this.phase = "disposed";
    this.retire(localError("disposed"));
    if (ref) this.releaseRemote(ref);
  }

  connectionLost(error: ClientError | DomainError = localError("transport")): void {
    if (this.phase === "disposed") return;
    this.phase = "unavailable";
    if (this.retiring) {
      this.publish();
      return;
    }
    this.retire(error, false);
    if (this.phase === "unavailable") this.publish();
  }

  receive(event: ExternalTerminalEvent, bytes: Uint8Array): void {
    if (
      !this.ref ||
      this.phase === "disposed" ||
      this.phase === "await-marker" ||
      this.phase === "unavailable" ||
      this.phase === "idle"
    )
      return;
    const ref =
      event.type === "baseline-start"
        ? event.descriptor.subscription
        : event.type === "run-event"
          ? event.subscription
          : event.type === "baseline-chunk" || event.type === "baseline-end"
            ? event.subscription
            : undefined;
    if (!ref || !sameSubscriptionRef(ref, this.ref)) return;
    const binding = this.host.binding();
    if (!binding) return;
    const charge = bytes.byteLength + JSON.stringify(event).length * 3;
    if (
      this.queue.length + this.activeItems >= binding.effectiveBudgets.postNEvents ||
      this.queuedBytes + this.activeBytes + charge >
        binding.effectiveBudgets.subscriptionCreditBytes
    ) {
      this.fail(localError("capacity"));
      return;
    }
    if (!this.host.lane.reserveIngress(charge)) {
      this.fail(localError("capacity"));
      return;
    }
    let payload: Uint8Array;
    try {
      payload = new Uint8Array(bytes);
    } catch {
      this.host.lane.releaseIngress(charge);
      this.fail(localError("capacity"));
      return;
    }
    this.queue.push({ event, payload, charge, token: this.token });
    this.queuedBytes += charge;
    this.drain();
  }

  private beginOperation(
    binding: NegotiatedConnection,
    kind: "attach" | "recover",
  ): Operation | null {
    const token = nextCounter(this.token);
    if (token === null) return null;
    this.token = token;
    // The correlated result is the downlink barrier; same-ref events before it are stale.
    this.clearQueued();
    this.baseline = undefined;
    this.drainToken = token;
    this.phase = "await-marker";
    this.retainedModel = this.retainedModel && !!this.ref;
    this.ackInFlight = false;
    this.pendingAck = undefined;
    this.progressInFlight = false;
    this.pendingProgress = undefined;
    let resolve!: (result: TerminalOutcome<TerminalReady>) => void;
    const promise = new Promise<TerminalOutcome<TerminalReady>>((settle) => {
      resolve = settle;
    });
    const operation: Operation = {
      kind,
      token,
      promise,
      resolve,
      settled: false,
      markerAttempted: false,
      priorParses: [...this.viewWork.values()]
        .filter((work) => work.view === this.view)
        .map((work) => work.promise),
    };
    this.operation = operation;
    if (kind === "recover") {
      try {
        if (!this.bindFailure(this.viewGeneration, token))
          this.fail(localError("invalid-state"), token);
      } catch {
        this.fail(localError("invalid-state"), token);
      }
    }
    if (operation.settled) return operation;
    this.publish();
    try {
      const timer = this.host.scheduler.setTimer(
        Math.min(binding.effectiveBudgets.recoveryDeadlineMs, M0_LIMITS.recoveryDeadlineMs),
        () => this.fail(localError("timeout"), token),
      );
      operation.timer = timer;
      if (operation.settled) safeDispose(timer);
    } catch {
      this.fail(localError("invalid-state"), token);
    }
    return operation;
  }

  private sendMarker(command: TerminalCommand, operation: Operation): void {
    let handled = false;
    const handle = (outcome: CommandOutcome): void => {
      if (handled) return;
      handled = true;
      if (this.operation !== operation || operation.settled) return;
      if (!outcome.ok) {
        if (operation.kind === "attach")
          operation.attachDisposition =
            "acceptance" in outcome.error
              ? outcome.error.acceptance
              : outcome.uncertain
                ? "unknown"
                : "not-accepted";
        this.fail(outcome.error, operation.token);
        return;
      }
      if (operation.kind === "attach") operation.attachDisposition = "accepted";
      const result = outcome.result;
      if (
        (command.type === "attach" && result.type !== "attach-result") ||
        (command.type === "recover" && result.type !== "recover-result")
      ) {
        this.fail(localError("invalid-response"), operation.token);
        return;
      }
      if (result.type !== "attach-result" && result.type !== "recover-result") return;
      if (command.type === "attach") {
        const parsedRef = SubscriptionRefSchema.safeParse(result.subscription);
        const canonicalRef = parsedRef.success ? identityCopy(parsedRef.data) : undefined;
        if (
          !canonicalRef ||
          !sameRunRef(canonicalRef.run, this.run) ||
          !this.host.lane.register(canonicalRef, (event, bytes) => this.receive(event, bytes))
        ) {
          this.fail(localError("invalid-response"), operation.token);
          return;
        }
        this.ref = canonicalRef;
      }
      operation.mode = result.mode;
      operation.atSeq = result.atSeq;
      if (result.atSeq < this.provenSeq) {
        this.fail(localError("invalid-response"), operation.token);
        return;
      }
      if (result.mode === "replay" && !this.retainedModel) {
        this.fail(localError("invalid-response"), operation.token);
        return;
      }
      this.phase = result.mode === "baseline" ? "baseline" : "replay";
      this.publish();
      if (result.mode === "replay" && result.atSeq === this.appliedSeq) this.commit(operation);
    };
    operation.markerAttempted = true;
    const deadline = Math.min(
      this.host.binding()?.effectiveBudgets.recoveryDeadlineMs ?? M0_LIMITS.recoveryDeadlineMs,
      M0_LIMITS.recoveryDeadlineMs,
    );
    void this.host.lane.send(command, deadline, undefined, handle).then(handle);
  }

  private drain(): void {
    const drainToken = this.drainToken;
    if (this.drainingToken === drainToken) return;
    this.drainingToken = drainToken;
    void (async () => {
      let frames = 0;
      let bytes = 0;
      while (this.queue.length && this.drainToken === drainToken && this.phase !== "disposed") {
        const item = this.queue.shift()!;
        this.queuedBytes -= item.charge;
        this.activeBytes += item.charge;
        this.activeItems++;
        let finishParse!: () => void;
        const parseDone = new Promise<void>((resolve) => {
          finishParse = resolve;
        });
        this.viewWork.set(item, { view: this.view, promise: parseDone, finish: finishParse });
        try {
          await this.apply(item);
        } catch {
          if (item.token === this.token) this.fail(localError("invalid-state"), item.token);
        } finally {
          this.activeBytes -= item.charge;
          this.activeItems--;
          this.host.lane.releaseIngress(item.charge);
          this.finishViewWork(item);
        }
        frames++;
        bytes += item.charge;
        if (frames >= 32 || bytes >= 256 * 1024) {
          frames = 0;
          bytes = 0;
          try {
            await this.host.scheduler.yieldTurn();
          } catch {
            if (drainToken === this.drainToken) this.fail(localError("invalid-state"));
          }
        }
      }
      if (this.drainingToken === drainToken) this.drainingToken = -1;
      if (this.queue.length && this.phase !== "disposed") this.drain();
    })();
  }

  private async apply(item: QueuedEvent): Promise<void> {
    const event = item.event;
    const operation = this.operation;
    if (item.token !== this.token || !this.ref) return;
    if (event.type === "baseline-start") {
      if (this.phase !== "baseline" || !operation || this.baseline) throw new Error("start order");
      await Promise.all(operation.priorParses);
      if (item.token !== this.token) return;
      const descriptor = validateBaselineDescriptor(event.descriptor);
      if (
        !descriptor ||
        !sameSubscriptionRef(descriptor.subscription, this.ref) ||
        descriptor.atSeq !== operation.atSeq ||
        descriptor.atSeq < this.provenSeq ||
        descriptor.vtBytes > (this.host.binding()?.effectiveBudgets.baselineVtBytes ?? 0) ||
        descriptor.tailBytes > (this.host.binding()?.effectiveBudgets.baselineTailBytes ?? 0) ||
        descriptor.chunkCount > (this.host.binding()?.effectiveBudgets.baselineChunks ?? 0) ||
        descriptor.coverage.normal.historyLines >
          (this.host.binding()?.effectiveBudgets.historyLines ?? 0)
      )
        throw new Error("descriptor");
      this.baseline = descriptor;
      this.baselineOrdinal = 0;
      this.baselineBytes = 0;
      const generation = nextCounter(this.viewGeneration);
      if (generation === null) throw new Error("view generation");
      this.viewGeneration = generation;
      const view = this.view;
      const ref = this.ref;
      if (!this.bindFailure(generation, item.token)) return;
      if (
        item.token !== this.token ||
        this.viewGeneration !== generation ||
        this.view !== view ||
        this.ref !== ref ||
        this.operation !== operation ||
        this.phase !== "baseline"
      )
        return;
      await view.initialize({
        profile: PROFILE,
        encoding: BASELINE_ENCODING,
        geometry: descriptor.captureGeometry,
        appearance: this.appearance,
        viewGeneration: generation,
      });
      if (item.token !== this.token) return;
      await view.beginBaseline({
        ...descriptor,
        run: Object.freeze({ ...descriptor.run }),
        subscription: identityCopy(descriptor.subscription),
      });
      this.finishViewWork(item);
      return;
    }
    if (event.type === "baseline-chunk") {
      if (
        this.phase !== "baseline" ||
        !this.baseline ||
        event.baselineId !== this.baseline.baselineId ||
        event.ordinal !== this.baselineOrdinal ||
        item.payload.byteLength < 1 ||
        item.payload.byteLength > 65_536
      )
        throw new Error("chunk order");
      this.baselineOrdinal++;
      this.baselineBytes += item.payload.byteLength;
      if (this.baselineBytes > this.baseline.vtBytes + this.baseline.tailBytes)
        throw new Error("chunk size");
      await this.view.writeBaselineChunk(item.payload);
      this.finishViewWork(item);
      if (item.token === this.token) this.sendProgress(event.ordinal);
      return;
    }
    if (event.type === "baseline-end") {
      if (
        this.phase !== "baseline" ||
        !operation ||
        !this.baseline ||
        event.baselineId !== this.baseline.baselineId ||
        event.chunkCount !== this.baseline.chunkCount ||
        this.baselineOrdinal !== this.baseline.chunkCount ||
        event.totalBytes !== this.baseline.vtBytes + this.baseline.tailBytes ||
        this.baselineBytes !== event.totalBytes ||
        event.atSeq !== this.baseline.atSeq
      )
        throw new Error("baseline end");
      await this.view.finishBaseline();
      this.finishViewWork(item);
      if (item.token !== this.token) return;
      this.appliedSeq = event.atSeq;
      this.provenSeq = Math.max(this.provenSeq, event.atSeq);
      this.retainedModel = true;
      this.retainedGeometry = this.baseline.currentGeometry;
      this.baseline = undefined;
      this.commit(operation);
      return;
    }
    if (event.type !== "run-event" || (this.phase !== "replay" && this.phase !== "ready"))
      throw new Error("event phase");
    const fact = event.event;
    if (
      fact.seq !== this.appliedSeq + 1 ||
      (this.phase === "replay" && operation && fact.seq > (operation.atSeq ?? -1)) ||
      (fact.type === "resize" && fact.requiresBaseline)
    ) {
      this.triggerRecovery(fact.type === "resize" ? "resize-context" : "gap");
      return;
    }
    await this.view.applyEvent(fact, item.payload);
    this.finishViewWork(item);
    if (item.token !== this.token) return;
    this.appliedSeq = fact.seq;
    this.provenSeq = Math.max(this.provenSeq, fact.seq);
    if (fact.type === "resize") this.retainedGeometry = fact.geometry;
    if (this.phase === "replay" && operation && this.appliedSeq === operation.atSeq)
      this.commit(operation);
    else if (this.phase === "ready") this.sendAck(this.appliedSeq);
    this.publish();
  }

  private commit(operation: Operation): void {
    if (this.operation !== operation || !this.ref || operation.settled) return;
    // Parsed N is usable only after ACK N enters the ordered uplink.
    this.sendAck(this.appliedSeq, () => {
      if (this.operation !== operation || operation.settled) return;
      this.phase = "ready";
      this.retainedModel = true;
      this.autoRecoveryUsed = false;
      this.settle(operation, {
        ok: true,
        value: { subscription: identityCopy(this.ref!), atSeq: this.appliedSeq },
      });
      if (this.token === operation.token && this.phase === "ready") this.publish();
    });
  }

  private sendAck(seq: number, onHandoff?: () => void): void {
    const ref = this.ref;
    if (!ref) return;
    if (this.ackInFlight) {
      this.pendingAck = Math.max(this.pendingAck ?? seq, seq);
      return;
    }
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    if (!requestId) {
      this.fail(domainError("COUNTER_EXHAUSTED"));
      return;
    }
    this.ackInFlight = true;
    const token = this.token;
    let handled = false;
    const handle = (outcome: CommandOutcome): void => {
      if (handled) return;
      handled = true;
      if (token !== this.token) return;
      this.ackInFlight = false;
      if (!outcome.ok) {
        this.fail(outcome.error, token);
        return;
      }
      const next = this.pendingAck;
      this.pendingAck = undefined;
      if (next !== undefined && next > seq) this.sendAck(next);
    };
    void this.host.lane
      .send(
        { type: "applied-ack", requestId, run: this.run, subscription: ref, appliedSeq: seq },
        5_000,
        () => {
          if (token === this.token) onHandoff?.();
        },
        handle,
      )
      .then(handle);
  }

  private sendProgress(ordinal: number): void {
    const ref = this.ref;
    const descriptor = this.baseline;
    if (!ref || !descriptor) return;
    if (this.progressInFlight) {
      this.pendingProgress = Math.max(this.pendingProgress ?? ordinal, ordinal);
      return;
    }
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    if (!requestId) {
      this.fail(domainError("COUNTER_EXHAUSTED"));
      return;
    }
    this.progressInFlight = true;
    const token = this.token;
    let handled = false;
    const handle = (outcome: CommandOutcome): void => {
      if (handled) return;
      handled = true;
      if (token !== this.token) return;
      this.progressInFlight = false;
      if (!outcome.ok) {
        this.fail(outcome.error, token);
        return;
      }
      const next = this.pendingProgress;
      this.pendingProgress = undefined;
      if (next !== undefined && next > ordinal) this.sendProgress(next);
    };
    void this.host.lane
      .send(
        {
          type: "baseline-progress",
          requestId,
          run: this.run,
          subscription: ref,
          baselineId: descriptor.baselineId,
          lastParsedOrdinal: ordinal,
        },
        5_000,
        undefined,
        handle,
      )
      .then(handle);
  }

  private triggerRecovery(reason: RecoveryReason): void {
    if (this.autoRecoveryUsed || this.phase !== "ready") {
      this.fail(localError("invalid-state"));
      return;
    }
    this.autoRecoveryUsed = true;
    this.retainedModel = false;
    void this.recover(reason);
  }

  private fail(error: ClientError | DomainError, token = this.token): void {
    if (token !== this.token || this.phase === "disposed" || this.retiring) return;
    const ref = this.ref;
    const unknownAttach = this.mayHaveUnidentifiedAttach();
    if (unknownAttach) {
      const before = this.token;
      this.host.retireConnection(this, error);
      if (this.token !== before || this.snapshot().phase === "disposed") return;
    }
    this.phase = "unavailable";
    this.retire(error);
    if (this.phase === "unavailable") this.publish();
    if (ref) this.releaseRemote(ref);
  }

  private releaseRemote(ref: SubscriptionRef): void {
    if (!this.currentConnection(ref)) return;
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    if (!requestId) {
      this.host.retireConnection();
      return;
    }
    void this.host.lane
      .send({ type: "detach", requestId, run: this.run, subscription: ref }, 5_000)
      .then((outcome) => {
        if (!outcome.ok && this.currentConnection(ref)) this.host.retireConnection();
      });
  }

  private mayHaveUnidentifiedAttach(): boolean {
    const operation = this.operation;
    return (
      operation?.kind === "attach" &&
      operation.markerAttempted &&
      operation.attachDisposition !== "not-accepted" &&
      !this.ref
    );
  }

  private currentConnection(ref: SubscriptionRef): boolean {
    const connection = this.host.binding()?.connection;
    return !!connection && sameConnectionRef(connection, ref.connection);
  }

  private retire(error: ClientError | DomainError, rememberRef = true): void {
    if (this.retiring) return;
    this.retiring = true;
    const operation = this.operation;
    const ref = this.ref;
    const listener = this.listener;
    // Withdraw all public ownership before a disposer or lane callback may reenter.
    this.operation = undefined;
    this.ref = undefined;
    this.listener = undefined;
    this.token = nextCounter(this.token) ?? -1;
    this.drainToken = this.token;
    this.baseline = undefined;
    this.retainedModel = false;
    this.retainedGeometry = undefined;
    this.ackInFlight = false;
    this.pendingAck = undefined;
    this.progressInFlight = false;
    this.pendingProgress = undefined;
    try {
      this.clearQueued();
      // Active parse debt remains charged until the original call settles.
      if (operation) this.settle(operation, errorOutcome(error));
      safeDispose(listener);
      if (ref) {
        this.host.lane.cancelUnsentControl(ref);
        if (rememberRef && !this.host.lane.retire(ref) && this.currentConnection(ref))
          this.host.retireConnection();
      }
    } finally {
      this.retiring = false;
      if (this.phase === "disposed") this.finalizeDisposal();
    }
  }

  private settle(operation: Operation, result: TerminalOutcome<TerminalReady>): void {
    if (operation.settled) return;
    operation.settled = true;
    const timer = operation.timer;
    delete operation.timer;
    if (this.operation === operation) this.operation = undefined;
    operation.resolve(result);
    safeDispose(timer);
  }

  private finalizeDisposal(): void {
    if (this.disposalComplete) return;
    this.disposalComplete = true;
    this.releaseListener();
    try {
      this.view.dispose();
    } catch {
      /* All local ownership still retires. */
    }
    this.publish();
    this.listeners.clear();
    this.host.remove(this);
  }

  private clearQueued(): void {
    for (const item of this.queue) this.host.lane.releaseIngress(item.charge);
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  private finishViewWork(item: QueuedEvent): void {
    const work = this.viewWork.get(item);
    if (!work) return;
    this.viewWork.delete(item);
    work.finish();
  }

  private releaseListener(): void {
    const listener = this.listener;
    this.listener = undefined;
    safeDispose(listener);
  }

  private bindFailure(generation: number, token: number): boolean {
    const view = this.view;
    const ref = this.ref;
    const operation = this.operation;
    const phase = this.phase;
    const current = (): boolean =>
      generation === this.viewGeneration &&
      token === this.token &&
      view === this.view &&
      ref === this.ref &&
      operation === this.operation &&
      phase === this.phase;
    this.releaseListener();
    if (!current() || this.listener) return false;
    const listener = view.onFailure((error) => {
      if (
        generation !== this.viewGeneration ||
        token !== this.token ||
        view !== this.view ||
        ref !== this.ref
      )
        return;
      if (error.kind !== "INPUT_REJECTED") this.fail(error, token);
    });
    if (!current() || this.listener) {
      safeDispose(listener);
      return false;
    }
    this.listener = listener;
    return true;
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        consumeObserverResult(listener(snapshot));
      } catch {
        /* Observers do not control lifecycle. */
      }
    }
  }
}
