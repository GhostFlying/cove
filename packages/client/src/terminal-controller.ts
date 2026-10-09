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
import {
  BASELINE_ENCODING,
  GeometrySchema,
  PROFILE,
  validateAppearance,
  type Appearance,
  type Geometry,
} from "@cove/protocol/profile";
import {
  validateBaselineDescriptor,
  MAX_PAYLOAD_BYTES,
  type BaselineDescriptor,
  type ExternalTerminalEvent,
  type RunEvent,
  type TerminalCommand,
} from "@cove/protocol/terminal";
import type {
  ClientError,
  LocalErrorReason,
  TerminalController,
  TerminalControlReceipt,
  TerminalAppliedAuthority,
  TerminalAppliedGeometry,
  TerminalExecutionEvidence,
  TerminalInputOutcome,
  TerminalInputNotice,
  TerminalInputReceipt,
  TerminalInputSource,
  TerminalOutcome,
  TerminalReady,
  TerminalSnapshot,
  ReadonlyTerminalControlHolder,
} from "./client.js";
import type { NegotiatedConnection } from "./connection-session.js";
import { TerminalLane, type CommandOutcome } from "./terminal-delivery.js";
import { TerminalControl } from "./terminal-control.js";
import { completeTerminalView } from "./terminal-view-contract.js";
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
  readonly resumeGeometry?: TerminalAppliedGeometry;
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

// Whether a detach outcome leaves the connection's subscription state unprovable, so only
// replacing the connection can release it. A server reply with acceptance "not-accepted"
// (the lane creates no such error locally) proves the detach did not run: the server has
// already retired the route (STALE_CONNECTION, or the failure that retired it such as
// RESYNC_REQUIRED) or refused it outright (e.g. BUSY). The controller has already withdrawn
// the route, so its frames are dropped and the subscription simply ends here; retiring the
// healthy connection would end every other terminal on it and misreport a transport loss.
// A route the server may still hold after a refusal such as BUSY stays until the server
// evicts it or the connection closes; meanwhile its frames are dropped here. The detach is never resent: a definite refusal is final
// for this subscription, and an unknown result is never repeated. Everything else — an
// unknown or accepted result, a timeout after handoff, or a detach that never reached the
// server — keeps the old rule and retires the connection.
function detachLeavesStateUnproven(outcome: CommandOutcome): boolean {
  if (outcome.ok) return false;
  return (
    outcome.uncertain ||
    !("acceptance" in outcome.error) ||
    outcome.error.acceptance !== "not-accepted"
  );
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

function sameGrid(a: Geometry | undefined, b: Geometry | undefined): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows;
}

function geometryFact(geometry: Geometry, atSeq: number): TerminalAppliedGeometry {
  return Object.freeze({ geometry: Object.freeze({ ...geometry }), atSeq });
}

function authorityFact(
  epoch: number,
  holder: ReadonlyTerminalControlHolder | null,
  atSeq: number,
): TerminalAppliedAuthority {
  return Object.freeze({
    epoch,
    holder: holder
      ? Object.freeze({
          connection: Object.freeze({ ...holder.connection }),
          viewId: holder.viewId,
          subscriptionId: holder.subscriptionId,
        })
      : null,
    atSeq,
  });
}

function inputReceipt(
  source: TerminalInputSource,
  total: number,
  inputId: number | null,
  writtenBytes = 0,
  unknownBytes = 0,
): TerminalInputReceipt {
  return Object.freeze({
    inputId,
    source,
    writtenBytes,
    unknownBytes,
    notSentBytes: total - writtenBytes - unknownBytes,
  });
}

function inputFailure(
  source: TerminalInputSource,
  total: number,
  error: ClientError | DomainError,
  inputId: number | null = null,
  writtenBytes = 0,
  unknownBytes = 0,
): TerminalInputOutcome {
  return {
    ok: false,
    error,
    value: inputReceipt(source, total, inputId, writtenBytes, unknownBytes),
  };
}

export class RoutedTerminalController implements TerminalController {
  private execution: TerminalExecutionEvidence = Object.freeze({
    status: "unverifiable",
    source: "none",
  });
  private latestGetOrdinal = 0;
  private publicationRevision = Symbol();
  private phase: Phase = "idle";
  private ref: SubscriptionRef | undefined;
  private operation: Operation | undefined;
  private token = 0;
  private viewGeneration = 0;
  private listener: Disposable | undefined;
  private focusListener: Disposable | undefined;
  private inputListener: Disposable | undefined;
  private readonly control = new TerminalControl();
  private localFocusSequence = 0;
  private localFocusGeneration = 0;
  private inputIntentSequence = 0;
  private retainedInputBytes = 0;
  private pendingInputIntents = 0;
  private inputTail: Promise<void> = Promise.resolve();
  private appliedSeq = 0;
  private provenSeq = 0;
  private retainedModel = false;
  private retainedGeometry: Geometry | undefined;
  private appliedGeometry: TerminalAppliedGeometry | null = null;
  private appliedAuthority: TerminalAppliedAuthority | null = null;
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
  // The server admits input, resize and appearance under a grant only after it has processed an
  // applied-ack covering max(control boundary, grant atSeq) for this subscription. Applying the
  // grant fact locally is not enough: acks are serialized, so a fresh grant's covering ack can
  // still be waiting behind an earlier one. fenceSeq is the highest boundary seq this client knows
  // the server fences on; handedAckSeq is the highest ack already handed to the ordered uplink.
  // A granted command sent after handedAckSeq >= fenceSeq follows its covering ack on the lane.
  private fenceSeq = 0;
  private handedAckSeq = 0;
  // Granted resize/appearance requests not yet settled. The server moves its control boundary
  // when it performs one, so a granted command sent behind it on the lane would be fenced on a seq
  // this client cannot know until the result arrives. Later granted commands wait until it settles
  // and its result's covering ack has been handed off. A resize whose fact requires a baseline
  // (every grid change in M0) triggers resize-context recovery, which carries only the grant to
  // the baseline's authority check; held input fails with a reported invalid-state rather than
  // being carried across recovery.
  private grantedControlsInFlight = 0;
  // Wakes authority waits on changes that publish() does not report (ack handoff, control settle).
  private readonly authorityWatchers = new Set<() => void>();
  // Geometry carried by the pending or accepted focus request (updated by granted resizes), so
  // a repeated focus intent with the same grid can be recognized as adding nothing.
  private focusGeometry: Geometry | undefined;
  private progressInFlight = false;
  private pendingProgress: number | undefined;
  private autoRecoveryUsed = false;
  private retiring = false;
  private disposalComplete = false;
  private readonly listeners = new Set<(snapshot: TerminalSnapshot) => void>();
  private readonly inputOutcomeListeners = new Set<(notice: TerminalInputNotice) => void>();
  private pendingInputNotifications = 0;

  constructor(
    private readonly host: ControllerHost,
    private readonly run: RunRef,
    private readonly viewId: string,
    private view: TerminalView,
    private appearance: Appearance,
  ) {}

  matchesRun(run: RunRef): boolean {
    return sameRunRef(this.run, run);
  }

  noteGetDispatched(ordinal: number): number | null {
    if (this.phase === "disposed") return null;
    if (ordinal > this.latestGetOrdinal) this.latestGetOrdinal = ordinal;
    return this.token;
  }

  installGetEvidence(
    token: number,
    ordinal: number,
    status: "live" | "unverifiable" | "exited",
  ): boolean {
    if (token !== this.token || this.phase === "disposed") return false;
    if (this.execution.status === "exited") return false;
    if (status === "exited") {
      this.execution = Object.freeze({
        status: "exited",
        source: "terminal-get",
        seq: null,
        exitCode: null,
        signal: null,
      });
      this.control.exit();
      return true;
    }
    if (ordinal !== this.latestGetOrdinal) return false;
    this.execution = Object.freeze({ status, source: "terminal-get" });
    return true;
  }

  publishGetEvidence(token: number): void {
    if (token === this.token && this.phase !== "disposed") this.publish();
  }

  private resetExecution(): void {
    if (this.execution.status !== "exited")
      this.execution = Object.freeze({ status: "unverifiable", source: "none" });
  }

  private latchExit(fact: Extract<RunEvent, { type: "exit" }>): void {
    if (this.execution.status === "exited" && this.execution.source === "run-event") return;
    this.execution = Object.freeze({
      status: "exited",
      source: "run-event",
      seq: fact.seq,
      exitCode: fact.exitCode,
      signal: fact.signal,
    });
    this.control.exit();
    this.publish();
  }

  attach(): Promise<TerminalOutcome<TerminalReady>> {
    if (this.phase === "disposed") return Promise.resolve(errorOutcome(localError("disposed")));
    if (this.retiring) return Promise.resolve(errorOutcome(localError("invalid-state")));
    if (this.operation)
      return this.operation.kind === "attach"
        ? this.operation.promise
        : Promise.resolve(errorOutcome(localError("invalid-state")));
    if (this.ref) return Promise.resolve(errorOutcome(localError("invalid-state")));
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
      this.appliedGeometry &&
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
    const resumeGeometry =
      resume && this.appliedGeometry
        ? geometryFact(this.appliedGeometry.geometry, this.appliedGeometry.atSeq)
        : undefined;
    const operation = this.beginOperation(binding, "recover", resumeGeometry);
    if (!operation) return Promise.resolve(errorOutcome(localError("invalid-state")));
    if (operation.settled) return operation.promise;
    // A resize-context recovery follows a grid change this subscription may have caused by its
    // own focus; the server keeps it as holder, so the grant is carried to the baseline's verdict
    // (see TerminalControl.suspendForRecovery). Other reasons start from no authority.
    if (reason === "resize-context") this.control.suspendForRecovery();
    else this.control.resetForRecovery();
    this.host.lane.cancelUnsent(ref, ["focus", "blur", "resize", "appearance", "input"]);
    this.host.lane.cancelUnsentControl(ref);
    this.publish();
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
    if (detachLeavesStateUnproven(result) && this.currentConnection(ref))
      this.host.retireConnection();
    return result.ok ? { ok: true, value: undefined } : { ok: false, error: result.error };
  }

  async replaceView(view: TerminalView): Promise<TerminalOutcome<TerminalReady>> {
    if (this.snapshot().phase === "disposed") return errorOutcome(localError("disposed"));
    if (this.retiring) return errorOutcome(localError("invalid-state"));
    const phase = this.phase;
    const token = this.token;
    const ref = this.ref;
    const previousView = this.view;
    const binding = this.host.binding();
    if (!completeTerminalView(view)) return errorOutcome(localError("invalid-request"));
    if (this.phase === "disposed") return errorOutcome(localError("disposed"));
    if (
      this.retiring ||
      this.phase !== phase ||
      this.token !== token ||
      this.ref !== ref ||
      this.view !== previousView ||
      this.host.binding() !== binding
    )
      return errorOutcome(localError("invalid-state"));
    this.control.replaceView();
    void this.detach();
    if (this.snapshot().phase === "disposed") return errorOutcome(localError("disposed"));
    if (this.retiring) return errorOutcome(localError("invalid-state"));
    this.releaseListener();
    this.releaseFocusListener();
    this.releaseInputListener();
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

  setInputTarget(foreground: boolean, focused: boolean): TerminalOutcome {
    if (this.phase === "disposed") return { ok: false, error: localError("disposed") };
    if (this.retiring) return { ok: false, error: localError("invalid-state") };
    if (typeof foreground !== "boolean" || typeof focused !== "boolean")
      return { ok: false, error: localError("invalid-request") };
    if (!foreground || !focused) void this.blur();
    this.control.setTarget(foreground, focused);
    if (!this.control.wantsFocus && this.ref)
      this.host.lane.cancelUnsent(this.ref, ["focus", "resize", "appearance", "input"]);
    this.publish();
    return { ok: true, value: undefined };
  }

  async requestFocus(geometry?: Geometry): Promise<TerminalOutcome<TerminalControlReceipt>> {
    if (this.phase === "disposed") return { ok: false, error: localError("disposed") };
    const ref = this.ref;
    const binding = this.host.binding();
    if (
      !ref ||
      !binding ||
      !this.currentConnection(ref) ||
      this.phase !== "ready" ||
      !this.control.wantsFocus
    )
      return { ok: false, error: localError("invalid-state") };
    const token = this.token;
    const generation = this.viewGeneration;
    const view = this.view;
    let proposed = geometry;
    if (!proposed) {
      try {
        proposed = view.measureGrid();
      } catch {
        return { ok: false, error: localError("invalid-state") };
      }
    }
    const checked = GeometrySchema.safeParse(proposed);
    if (!checked.success) return { ok: false, error: localError("invalid-request") };
    if (
      this.token !== token ||
      this.viewGeneration !== generation ||
      this.view !== view ||
      this.ref !== ref ||
      this.host.binding() !== binding ||
      this.phase !== "ready"
    )
      return { ok: false, error: localError("invalid-state") };
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    const focusSeq = this.host.lane.nextFocusSeq(ref);
    // The ID supplier can reenter and end the subscription; see TerminalLane.nextFocusSeq.
    if (focusSeq === undefined) return { ok: false, error: localError("invalid-state") };
    if (!requestId || focusSeq === null)
      return { ok: false, error: domainError("COUNTER_EXHAUSTED") };
    const intent = this.control.beginFocus();
    if (intent === null) return { ok: false, error: domainError("COUNTER_EXHAUSTED") };
    this.focusGeometry = Object.freeze({ ...checked.data });
    // The worker's model admits a control fact only at its current grid, so a focus at a grid
    // other than the applied one is preceded by a resize fact, and every M0 resize requires a
    // baseline: this client will recover before it can apply the grant's own fact.
    const resizes = !sameGrid(this.appliedGeometry?.geometry, checked.data);
    this.host.lane.cancelUnsent(ref, ["focus", "input"]);
    this.publish();
    // A recovery that starts before the result arrives keeps the focus as carried rather than
    // pending (TerminalControl.suspendForRecovery), so its result is still accepted.
    const valid = (): boolean =>
      this.view === view &&
      this.ref === ref &&
      this.host.binding() === binding &&
      ((this.token === token &&
        this.viewGeneration === generation &&
        this.phase === "ready" &&
        this.control.pendingIntent === intent) ||
        this.control.carriesFocus(intent));
    if (!valid()) return { ok: false, error: localError("invalid-state") };
    let settled = false;
    let receipt: TerminalOutcome<TerminalControlReceipt> | undefined;
    let acceptedAtMs = 0;
    const handle = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      if (!outcome.ok) {
        this.control.failFocus(intent);
        receipt = { ok: false, error: outcome.error };
      } else if (
        outcome.result.type !== "focus-result" ||
        !valid() ||
        !this.control.acceptFocus(
          intent,
          ref,
          generation,
          outcome.result.epoch,
          outcome.result.atSeq,
        )
      ) {
        this.control.failFocus(intent);
        if (outcome.result.type === "focus-result")
          this.releaseStaleFocus(ref, outcome.result.epoch);
        receipt = { ok: false, error: localError("invalid-state") };
      } else {
        acceptedAtMs = this.host.scheduler.nowMs();
        receipt = {
          ok: true,
          value: { epoch: outcome.result.epoch, atSeq: outcome.result.atSeq },
        };
      }
      this.publish();
    };
    const outcome = await this.host.lane.send(
      {
        type: "focus",
        requestId,
        run: this.run,
        subscription: ref,
        focusSeq,
        geometry: checked.data,
        appearance: this.appearance,
      },
      5_000,
      undefined,
      handle,
      valid,
    );
    handle(outcome);
    const granted = receipt!;
    // Resolve only once the grant is usable or lost, so input sent after a successful focus is
    // not caught by the recovery that the focus's own resize triggers (that recovery still
    // cancels input queued before it). The wait is keyed on the requested grid because the focus
    // result can arrive before the resize fact. A stalled downlink or view could keep that fact
    // from ever arriving, so the whole wait spends the recovery deadline budget from the moment
    // the result was accepted and then reports the grant as unknown rather than hanging. A focus
    // at the applied grid keeps resolving on its result as before.
    if (granted.ok && (resizes || this.phase !== "ready")) {
      const settledFocus = await this.waitForFocusSettled(
        ref,
        binding,
        view,
        granted.value.epoch,
        acceptedAtMs,
      );
      if (settledFocus !== "usable") return { ok: false, error: localError(settledFocus) };
    }
    return granted;
  }

  private waitForFocusSettled(
    ref: SubscriptionRef,
    binding: NegotiatedConnection,
    view: TerminalView,
    epoch: number,
    acceptedAtMs: number,
  ): Promise<"usable" | "invalid-state" | "timeout"> {
    return new Promise((resolve) => {
      let settled = false;
      let state: Disposable | undefined;
      let timer: Disposable | undefined;
      const finish = (outcome: "usable" | "invalid-state" | "timeout"): void => {
        if (settled) return;
        settled = true;
        this.authorityWatchers.delete(watcher);
        safeDispose(state);
        safeDispose(timer);
        resolve(outcome);
      };
      // Usable, not merely ready: the grant's covering ACK must already be handed to the uplink,
      // otherwise input sent right after the focus would still wait behind the fence.
      const check = (): void => {
        if (
          this.ref !== ref ||
          this.view !== view ||
          this.host.binding() !== binding ||
          this.phase === "disposed" ||
          this.phase === "unavailable" ||
          this.phase === "idle" ||
          !this.control.keepsGrant(epoch)
        )
          finish("invalid-state");
        else if (
          this.phase === "ready" &&
          this.control.epoch === epoch &&
          this.grantUsable(ref, this.viewGeneration)
        )
          finish("usable");
      };
      const watcher = (): void => check();
      this.authorityWatchers.add(watcher);
      state = this.onState(check);
      const budget = Math.min(
        binding.effectiveBudgets.recoveryDeadlineMs,
        M0_LIMITS.recoveryDeadlineMs,
      );
      try {
        timer = this.host.scheduler.setTimer(
          Math.max(0, budget - (this.host.scheduler.nowMs() - acceptedAtMs)),
          () => finish("timeout"),
        );
      } catch {
        finish("invalid-state");
      }
      if (settled) {
        safeDispose(state);
        safeDispose(timer);
      }
      check();
    });
  }

  async blur(): Promise<TerminalOutcome<TerminalControlReceipt | undefined>> {
    if (this.phase === "disposed") return { ok: false, error: localError("disposed") };
    const ref = this.ref;
    const epoch = ref ? this.control.currentEpoch(ref, this.viewGeneration, this.appliedSeq) : null;
    this.control.setTarget(this.control.hostForeground, false);
    if (ref) this.host.lane.cancelUnsent(ref, ["focus", "resize", "appearance", "input"]);
    this.publish();
    if (!ref || epoch === null || !this.currentConnection(ref))
      return { ok: true, value: undefined };
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    if (!requestId) return { ok: false, error: domainError("COUNTER_EXHAUSTED") };
    const result = await this.host.lane.send(
      { type: "blur", requestId, run: this.run, subscription: ref, epoch },
      5_000,
      undefined,
      undefined,
      () => this.ref === ref && this.currentConnection(ref) && this.phase === "ready",
    );
    return this.controlReceipt(result, "blur-result");
  }

  async requestResize(geometry: Geometry): Promise<TerminalOutcome<TerminalControlReceipt>> {
    const parsed = GeometrySchema.safeParse(geometry);
    if (!parsed.success) return { ok: false, error: localError("invalid-request") };
    return this.sendGrantedControl("resize", { geometry: parsed.data });
  }

  async updateAppearance(appearance: Appearance): Promise<TerminalOutcome<TerminalControlReceipt>> {
    const parsed = validateAppearance(appearance);
    if (!parsed) return { ok: false, error: localError("invalid-request") };
    return this.sendGrantedControl("appearance", { appearance: parsed });
  }

  sendInput(input: {
    source: TerminalInputSource;
    bytes: Uint8Array;
  }): Promise<TerminalInputOutcome> {
    const source = input?.source;
    const bytes = input?.bytes;
    const total = bytes instanceof Uint8Array ? bytes.byteLength : 0;
    const reject = (error: ClientError | DomainError): Promise<TerminalInputOutcome> => {
      const outcome = inputFailure(source, total, error);
      this.publishInputOutcome(outcome);
      return Promise.resolve(outcome);
    };
    if (
      !["keyboard", "paste", "mouse"].includes(source) ||
      !(bytes instanceof Uint8Array) ||
      total < 1
    )
      return reject(localError("invalid-request"));
    if (this.phase === "disposed") return reject(localError("disposed"));
    const ref = this.ref;
    const binding = this.host.binding();
    const token = this.token;
    const generation = this.viewGeneration;
    const intent = this.control.intentVersion;
    if (
      !ref ||
      !binding ||
      this.phase !== "ready" ||
      !this.control.wantsFocus ||
      (this.control.pendingIntent === undefined &&
        this.control.epoch === undefined &&
        !this.control.ready(ref, generation, this.appliedSeq))
    )
      return reject(localError("invalid-state"));
    const cap = Math.min(binding.effectiveBudgets.inputQueueBytes, M0_LIMITS.inputQueueBytes);
    if (
      total > cap ||
      this.retainedInputBytes + total > cap ||
      this.pendingInputIntents >= M0_LIMITS.pendingWorkerCommands - 32
    )
      return reject(localError("capacity"));
    const inputId = nextCounter(this.inputIntentSequence);
    if (inputId === null) return reject(domainError("COUNTER_EXHAUSTED"));
    let owned: Uint8Array;
    try {
      owned = new Uint8Array(bytes);
    } catch {
      return reject(localError("capacity"));
    }
    this.inputIntentSequence = inputId;
    this.retainedInputBytes += total;
    this.pendingInputIntents++;
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const prior = this.inputTail;
    this.inputTail = prior.then(() => turn);
    this.pendingInputNotifications++;
    this.publish();
    return this.deliverInput(
      owned,
      source,
      inputId,
      ref,
      binding,
      token,
      generation,
      intent,
      prior,
      releaseTurn,
    ).then((outcome) => {
      try {
        this.publishInputOutcome(outcome);
        return outcome;
      } finally {
        this.pendingInputNotifications--;
        if (this.phase === "disposed" && this.pendingInputNotifications === 0)
          this.inputOutcomeListeners.clear();
      }
    });
  }

  onInputOutcome(listener: (notice: TerminalInputNotice) => void): Disposable {
    if (this.phase === "disposed") return { dispose() {} };
    this.inputOutcomeListeners.add(listener);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        this.inputOutcomeListeners.delete(listener);
      },
    };
  }

  private publishInputOutcome(outcome: TerminalInputOutcome): void {
    const notice: TerminalInputNotice = Object.freeze({
      kind: "input",
      outcome: Object.freeze({
        ...outcome,
        value: Object.freeze({ ...outcome.value }),
        ...(!outcome.ok ? { error: Object.freeze({ ...outcome.error }) } : {}),
      }),
    });
    this.publishInputNotice(notice);
  }

  private publishInputNotice(notice: TerminalInputNotice): void {
    for (const listener of [...this.inputOutcomeListeners]) {
      try {
        consumeObserverResult(listener(notice));
      } catch {
        /* An observer cannot interrupt input settlement. */
      }
    }
  }

  private async deliverInput(
    owned: Uint8Array,
    source: TerminalInputSource,
    inputId: number,
    ref: SubscriptionRef,
    binding: NegotiatedConnection,
    token: number,
    generation: number,
    intent: number,
    prior: Promise<void>,
    releaseTurn: () => void,
  ): Promise<TerminalInputOutcome> {
    const total = owned.byteLength;
    const reject = (
      error: ClientError | DomainError,
      written = 0,
      unknown = 0,
    ): TerminalInputOutcome => inputFailure(source, total, error, inputId, written, unknown);
    let written = 0;
    let unknown = 0;
    let inFlightBytes = 0;
    try {
      await prior;
      // Re-check after every wait: the wait settles on a later microtask, and a newly applied
      // control fact can raise the fence again before this turn resumes.
      while (
        (this.control.pendingIntent === intent || this.control.epoch !== undefined) &&
        !this.grantUsable(ref, generation)
      ) {
        const ready = await this.waitForInputAuthority(ref, token, generation, intent);
        if (!ready) return reject(localError("invalid-state"));
      }
      const epoch = this.control.currentEpoch(ref, generation, this.appliedSeq);
      if (
        this.token !== token ||
        this.ref !== ref ||
        this.host.binding() !== binding ||
        this.phase !== "ready" ||
        this.control.intentVersion !== intent ||
        epoch === null
      )
        return reject(localError("invalid-state"));
      while (written < total) {
        const end = Math.min(total, written + MAX_PAYLOAD_BYTES);
        const chunk = owned.subarray(written, end);
        const requestId = this.host.lane.nextRequestId(this.host.generation());
        const inputSeq = this.host.lane.nextInputSeq(ref);
        // The ID supplier can reenter and end the subscription; see TerminalLane.nextInputSeq.
        if (inputSeq === undefined) return reject(localError("invalid-state"), written);
        if (!requestId || inputSeq === null)
          return reject(domainError("COUNTER_EXHAUSTED"), written);
        inFlightBytes = chunk.byteLength;
        const outcome = await this.host.lane.send(
          { type: "input", requestId, run: this.run, subscription: ref, epoch, inputSeq },
          5_000,
          undefined,
          undefined,
          () =>
            this.token === token &&
            this.ref === ref &&
            this.host.binding() === binding &&
            this.phase === "ready" &&
            this.control.intentVersion === intent &&
            this.control.currentEpoch(ref, generation, this.appliedSeq) === epoch,
          chunk,
        );
        inFlightBytes = 0;
        if (!outcome.ok) {
          if (
            outcome.uncertain ||
            ("acceptance" in outcome.error && outcome.error.acceptance !== "not-accepted")
          )
            unknown += chunk.byteLength;
          return reject(outcome.error, written, unknown);
        }
        if (outcome.result.type !== "input-result") {
          unknown += chunk.byteLength;
          return reject(localError("invalid-response"), written, unknown);
        }
        const length = outcome.result.writtenBytes;
        if (length > chunk.byteLength) {
          unknown += chunk.byteLength;
          return reject(localError("invalid-response"), written, unknown);
        }
        written += length;
        if (length < chunk.byteLength) {
          unknown += chunk.byteLength - length;
          return reject(domainError("RESULT_UNKNOWN", "unknown", "input"), written, unknown);
        }
      }
      return { ok: true, value: inputReceipt(source, total, inputId, written) };
    } catch {
      unknown += inFlightBytes;
      return reject(
        inFlightBytes
          ? domainError("RESULT_UNKNOWN", "unknown", "input")
          : localError("invalid-state"),
        written,
        unknown,
      );
    } finally {
      this.retainedInputBytes -= total;
      this.pendingInputIntents--;
      releaseTurn();
      this.publish();
    }
  }

  private waitForInputAuthority(
    ref: SubscriptionRef,
    token: number,
    generation: number,
    intent: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let listener: Disposable | undefined;
      let timer: Disposable | undefined;
      const finish = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        safeDispose(listener);
        safeDispose(timer);
        resolve(ready);
      };
      const check = (): void => {
        if (
          this.token !== token ||
          this.ref !== ref ||
          this.phase !== "ready" ||
          this.control.intentVersion !== intent ||
          !this.control.wantsFocus
        ) {
          finish(false);
          return;
        }
        if (this.grantUsable(ref, generation)) {
          finish(true);
          return;
        }
        if (this.control.pendingIntent === undefined && this.control.epoch === undefined)
          finish(false);
      };
      const watcher = (): void => check();
      this.authorityWatchers.add(watcher);
      const state = this.onState(check);
      listener = {
        dispose: () => {
          this.authorityWatchers.delete(watcher);
          state.dispose();
        },
      };
      try {
        timer = this.host.scheduler.setTimer(5_000, () => finish(false));
      } catch {
        finish(false);
      }
      if (settled) safeDispose(timer);
      check();
    });
  }

  private grantUsable(ref: SubscriptionRef, generation: number): boolean {
    return (
      this.control.ready(ref, generation, this.appliedSeq) &&
      this.grantedControlsInFlight === 0 &&
      this.handedAckSeq >= Math.max(this.fenceSeq, this.control.grantAtSeq ?? 0)
    );
  }

  private raiseFence(seq: number): void {
    if (seq > this.fenceSeq) this.fenceSeq = seq;
  }

  private async sendGrantedControl(
    type: "resize" | "appearance",
    value: { geometry: Geometry } | { appearance: Appearance },
  ): Promise<TerminalOutcome<TerminalControlReceipt>> {
    if (this.phase === "disposed") return { ok: false, error: localError("disposed") };
    const ref = this.ref;
    const binding = this.host.binding();
    const token = this.token;
    const generation = this.viewGeneration;
    const intent = this.control.intentVersion;
    if (!ref || !binding || this.phase !== "ready")
      return { ok: false, error: localError("invalid-state") };
    // Like input, a granted command must follow the applied-ack that covers the grant fence.
    while (
      this.control.currentEpoch(ref, generation, this.appliedSeq) !== null &&
      !this.grantUsable(ref, generation)
    ) {
      if (!(await this.waitForInputAuthority(ref, token, generation, intent)))
        return { ok: false, error: localError("invalid-state") };
    }
    const epoch = this.control.currentEpoch(ref, generation, this.appliedSeq);
    if (
      epoch === null ||
      this.token !== token ||
      this.ref !== ref ||
      this.host.binding() !== binding ||
      this.phase !== "ready"
    )
      return { ok: false, error: localError("invalid-state") };
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    if (!requestId) return { ok: false, error: domainError("COUNTER_EXHAUSTED") };
    const command = {
      type,
      requestId,
      run: this.run,
      subscription: ref,
      epoch,
      ...value,
    } as TerminalCommand;
    let receipt: TerminalOutcome<TerminalControlReceipt> = {
      ok: false,
      error: localError("invalid-state"),
    };
    this.grantedControlsInFlight++;
    try {
      const result = await this.host.lane.send(
        command,
        5_000,
        undefined,
        undefined,
        () =>
          this.token === token &&
          this.ref === ref &&
          this.host.binding() === binding &&
          this.phase === "ready" &&
          this.control.currentEpoch(ref, generation, this.appliedSeq) === epoch,
      );
      receipt = this.controlReceipt(result, `${type}-result`);
      if (receipt.ok && this.token === token && this.ref === ref) {
        // The server moved its control boundary to this result; later granted commands wait for
        // the ack that covers it, which also proves the result's fact has been applied.
        this.raiseFence(receipt.value.atSeq);
        if ("geometry" in value && this.control.epoch === epoch)
          this.focusGeometry = Object.freeze({ ...value.geometry });
      }
    } finally {
      // Raise the fence before releasing held commands so none slips out under the old one. A
      // failed or unknown result leaves the fence as it was; a command then sent under a boundary
      // the server did move is rejected and reported, never silently retried.
      this.grantedControlsInFlight--;
      for (const watcher of [...this.authorityWatchers]) watcher();
    }
    return receipt;
  }

  private controlReceipt(
    outcome: CommandOutcome,
    type: "blur-result" | "resize-result" | "appearance-result",
  ): TerminalOutcome<TerminalControlReceipt> {
    if (!outcome.ok) return { ok: false, error: outcome.error };
    const result = outcome.result;
    if (result.type !== type || !("epoch" in result))
      return { ok: false, error: localError("invalid-response") };
    return { ok: true, value: { epoch: result.epoch, atSeq: result.atSeq } };
  }

  private releaseStaleFocus(ref: SubscriptionRef, epoch: number): void {
    if (this.ref !== ref || !this.currentConnection(ref) || this.control.epoch === epoch) return;
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    if (!requestId) return;
    void this.host.lane.send(
      { type: "blur", requestId, run: this.run, subscription: ref, epoch },
      5_000,
      undefined,
      undefined,
      () =>
        this.ref === ref &&
        this.currentConnection(ref) &&
        this.control.epoch !== epoch &&
        this.phase === "ready",
    );
  }

  snapshot(): TerminalSnapshot {
    const inputReady =
      this.phase === "ready" &&
      !!this.ref &&
      !!this.host.binding() &&
      this.control.ready(this.ref, this.viewGeneration, this.appliedSeq);
    return Object.freeze({
      run: Object.freeze({ ...this.run }),
      execution: Object.freeze({ ...this.execution }),
      appliedGeometry: this.appliedGeometry
        ? geometryFact(this.appliedGeometry.geometry, this.appliedGeometry.atSeq)
        : null,
      appliedAuthority: this.appliedAuthority
        ? authorityFact(
            this.appliedAuthority.epoch,
            this.appliedAuthority.holder,
            this.appliedAuthority.atSeq,
          )
        : null,
      phase: this.phase,
      appliedSeq: this.appliedSeq,
      viewGeneration: this.viewGeneration,
      queuedBytes: this.queuedBytes,
      activeParseBytes: this.activeBytes,
      ...(this.ref ? { subscription: identityCopy(this.ref) } : {}),
      inputReady,
      retainedInputBytes: this.retainedInputBytes,
      pendingInputIntents: this.pendingInputIntents,
      ...(this.control.epoch !== undefined ? { controlEpoch: this.control.epoch } : {}),
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
    this.control.connectionLost();
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
    if (event.type === "run-event" && event.event.type === "control") {
      this.control.observe(event.event, ref);
      this.publish();
    }
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
    resumeGeometry?: TerminalAppliedGeometry,
  ): Operation | null {
    const token = nextCounter(this.token);
    if (token === null) return null;
    this.token = token;
    this.resetExecution();
    this.appliedGeometry = null;
    this.appliedAuthority = null;
    // The correlated result is the downlink barrier; same-ref events before it are stale.
    this.clearQueued();
    this.baseline = undefined;
    this.drainToken = token;
    this.phase = "await-marker";
    this.retainedModel = this.retainedModel && !!this.ref;
    this.ackInFlight = false;
    this.pendingAck = undefined;
    this.fenceSeq = 0;
    this.handedAckSeq = 0;
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
      ...(resumeGeometry ? { resumeGeometry } : {}),
    };
    this.operation = operation;
    if (kind === "recover") {
      try {
        if (!this.bindFailure(this.viewGeneration, token))
          this.fail(localError("invalid-state"), token);
        else if (!this.bindFocus(this.viewGeneration, token))
          this.fail(localError("invalid-state"), token);
        else if (!this.bindInput(this.viewGeneration, token))
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
      if (result.mode === "baseline") {
        this.retainedModel = false;
        this.retainedGeometry = undefined;
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
      if (!this.bindFocus(generation, item.token)) return;
      if (!this.bindInput(generation, item.token)) return;
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
        geometry: Object.freeze({ ...descriptor.captureGeometry }),
        appearance: this.appearance,
        viewGeneration: generation,
      });
      if (item.token !== this.token) return;
      await view.beginBaseline(
        Object.freeze({
          ...descriptor,
          run: Object.freeze({ ...descriptor.run }),
          subscription: identityCopy(descriptor.subscription),
          captureGeometry: Object.freeze({ ...descriptor.captureGeometry }),
          currentGeometry: Object.freeze({ ...descriptor.currentGeometry }),
          // The controller reads this authority again at baseline-end to decide whether a carried
          // grant is reinstated, so the view gets its own frozen copy and cannot rewrite it.
          control: Object.freeze({
            epoch: descriptor.control.epoch,
            holder: descriptor.control.holder
              ? Object.freeze({
                  ...descriptor.control.holder,
                  connection: Object.freeze({ ...descriptor.control.holder.connection }),
                })
              : null,
          }),
          coverage: Object.freeze({
            normal: Object.freeze({ ...descriptor.coverage.normal }),
            alternate: Object.freeze({ ...descriptor.coverage.alternate }),
          }),
        }),
      );
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
      this.retainedGeometry = Object.freeze({ ...this.baseline.currentGeometry });
      this.appliedGeometry = geometryFact(this.baseline.currentGeometry, event.atSeq);
      // The baseline proves the authority at its atSeq; epoch 0 means control was never granted.
      const authority = this.baseline.control;
      this.appliedAuthority =
        authority.epoch > 0 ? authorityFact(authority.epoch, authority.holder, event.atSeq) : null;
      this.control.restore(
        this.baseline.control,
        event.atSeq,
        this.run,
        this.baseline.currentGeometry,
        this.ref,
        this.viewGeneration,
      );
      this.baseline = undefined;
      this.commit(operation);
      return;
    }
    if (event.type !== "run-event" || (this.phase !== "replay" && this.phase !== "ready"))
      throw new Error("event phase");
    const fact = event.event;
    const factType = fact.type;
    const factSeq = fact.seq;
    const appearance = fact.type === "appearance" ? validateAppearance(fact.appearance) : null;
    const resizeGeometry = fact.type === "resize" ? { ...fact.geometry } : undefined;
    if (
      factSeq !== this.appliedSeq + 1 ||
      (this.phase === "replay" && operation && factSeq > (operation.atSeq ?? -1)) ||
      (factType === "resize" && fact.requiresBaseline)
    ) {
      this.triggerRecovery(factType === "resize" ? "resize-context" : "gap");
      return;
    }
    if (fact.type === "exit") {
      this.latchExit(fact);
      if (item.token !== this.token) return;
    }
    await this.view.applyEvent(fact, item.payload);
    this.finishViewWork(item);
    if (item.token !== this.token) return;
    this.appliedSeq = factSeq;
    this.provenSeq = Math.max(this.provenSeq, factSeq);
    if (factType === "control" || factType === "resize") this.raiseFence(factSeq);
    if (factType === "control") {
      const applied = this.control.apply(fact);
      if (applied) {
        this.appliedGeometry = geometryFact(applied.geometry, applied.seq);
        this.appliedAuthority = authorityFact(applied.epoch, applied.holder, applied.seq);
        this.retainedGeometry = Object.freeze({ ...applied.geometry });
      }
    }
    if (appearance) this.appearance = appearance;
    if (resizeGeometry) {
      this.retainedGeometry = Object.freeze({ ...resizeGeometry });
      this.appliedGeometry = geometryFact(resizeGeometry, factSeq);
    }
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
      if (operation.mode === "replay" && !this.appliedGeometry && operation.resumeGeometry)
        this.appliedGeometry = geometryFact(
          operation.resumeGeometry.geometry,
          operation.resumeGeometry.atSeq,
        );
      this.control.finishRecovery();
      this.phase = "ready";
      this.retainedModel = true;
      this.autoRecoveryUsed = false;
      this.settle(operation, {
        ok: true,
        value: { subscription: identityCopy(this.ref!), atSeq: this.appliedSeq },
      });
      if (this.token === operation.token && this.phase === "ready") {
        const reconnectFocus = this.control.takeReconnectFocus();
        this.publish();
        if (
          reconnectFocus &&
          this.token === operation.token &&
          this.phase === "ready" &&
          this.control.pendingIntent === undefined &&
          this.control.epoch === undefined
        )
          void this.requestFocus();
      }
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
          if (token !== this.token) return;
          if (seq > this.handedAckSeq) this.handedAckSeq = seq;
          onHandoff?.();
          for (const watcher of [...this.authorityWatchers]) watcher();
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
        if (detachLeavesStateUnproven(outcome) && this.currentConnection(ref))
          this.host.retireConnection();
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
    const focusListener = this.focusListener;
    this.focusListener = undefined;
    const inputListener = this.inputListener;
    this.inputListener = undefined;
    this.control.resetForRecovery();
    this.token = nextCounter(this.token) ?? -1;
    this.resetExecution();
    this.drainToken = this.token;
    this.baseline = undefined;
    this.retainedModel = false;
    this.retainedGeometry = undefined;
    this.appliedGeometry = null;
    this.appliedAuthority = null;
    this.ackInFlight = false;
    this.pendingAck = undefined;
    this.fenceSeq = 0;
    this.handedAckSeq = 0;
    this.progressInFlight = false;
    this.pendingProgress = undefined;
    try {
      this.clearQueued();
      // Active parse debt remains charged until the original call settles.
      if (operation) this.settle(operation, errorOutcome(error));
      safeDispose(listener);
      safeDispose(focusListener);
      safeDispose(inputListener);
      if (ref) {
        this.host.lane.cancelUnsent(ref, ["focus", "blur", "resize", "appearance", "input"]);
        this.host.lane.cancelUnsentControl(ref);
        if (rememberRef) this.host.lane.retire(ref);
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
    this.control.dispose();
    this.releaseListener();
    this.releaseFocusListener();
    this.releaseInputListener();
    try {
      this.view.dispose();
    } catch {
      /* All local ownership still retires. */
    }
    this.publish();
    this.listeners.clear();
    if (this.pendingInputNotifications === 0) this.inputOutcomeListeners.clear();
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

  private releaseFocusListener(): void {
    const listener = this.focusListener;
    this.focusListener = undefined;
    safeDispose(listener);
  }

  private releaseInputListener(): void {
    const listener = this.inputListener;
    this.inputListener = undefined;
    safeDispose(listener);
  }

  private bindInput(generation: number, token: number): boolean {
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
    this.releaseInputListener();
    if (!current() || this.inputListener) return false;
    const listener = view.onInputIntent((intent) => {
      if (
        generation !== this.viewGeneration ||
        token !== this.token ||
        view !== this.view ||
        ref !== this.ref ||
        intent.viewGeneration !== generation ||
        this.phase === "disposed"
      )
        return;
      void this.sendInput({ source: intent.source, bytes: intent.bytes });
    });
    if (!current() || this.inputListener) {
      safeDispose(listener);
      return false;
    }
    this.inputListener = listener;
    return true;
  }

  private bindFocus(generation: number, token: number): boolean {
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
    this.releaseFocusListener();
    if (!current() || this.focusListener) return false;
    const listener = view.onFocusIntent((intent) => {
      if (
        generation !== this.viewGeneration ||
        token !== this.token ||
        view !== this.view ||
        ref !== this.ref ||
        intent.viewGeneration !== generation ||
        this.phase !== "ready" ||
        !Number.isSafeInteger(intent.focusSeq) ||
        intent.focusSeq < 1
      )
        return;
      if (this.localFocusGeneration !== generation) {
        this.localFocusGeneration = generation;
        this.localFocusSequence = 0;
      }
      if (intent.focusSeq < this.localFocusSequence) return;
      if (intent.focusSeq === this.localFocusSequence) return;
      this.localFocusSequence = intent.focusSeq;
      if (intent.focused) {
        if (!this.control.hostForeground) return;
        this.control.setTarget(true, true);
        // The view re-announces focus before every deliberate input. While this subscription is
        // already acquiring or holding control, another focus request would only mint a new epoch
        // (and a new ack fence) per keystroke and supersede the request that the pending input is
        // waiting on. Input staged now rides the pending or current grant. The view reports the
        // grid it has applied, so an intent at the applied grid or at the grid already requested
        // (focus or granted resize still settling) proposes nothing new.
        if (
          ref &&
          (this.control.pendingIntent !== undefined || this.control.holds(ref, generation)) &&
          (sameGrid(this.focusGeometry, intent.geometry) ||
            sameGrid(this.appliedGeometry?.geometry, intent.geometry))
        )
          return;
        void this.requestFocus(intent.geometry);
      } else {
        void this.blur();
      }
    });
    if (!current() || this.focusListener) {
      safeDispose(listener);
      return false;
    }
    this.focusListener = listener;
    return true;
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
      if (error.kind === "INPUT_REJECTED") {
        this.publishInputNotice(
          Object.freeze({ kind: "renderer-rejection", error: Object.freeze({ ...error }) }),
        );
      } else {
        this.fail(error, token);
      }
    });
    if (!current() || this.listener) {
      safeDispose(listener);
      return false;
    }
    this.listener = listener;
    return true;
  }

  private publish(): void {
    const revision = Symbol();
    this.publicationRevision = revision;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      if (this.publicationRevision !== revision) break;
      if (!this.listeners.has(listener)) continue;
      try {
        consumeObserverResult(listener(snapshot));
      } catch {
        /* Observers do not control lifecycle. */
      }
    }
  }
}
