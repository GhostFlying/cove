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
  TerminalControlOutcome,
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
import { Notifier } from "./notifier.js";
import {
  REJECTION_SLOTS,
  RejectionAggregate,
  rejectionClass,
  rejectionSource,
} from "./input-notices.js";

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

// A registered focus request (terminal-architecture 4.4.4). Its identity is fixed at
// registration: the request number (the latest one wins), the input-target version (any later
// target loss supersedes it) and the acceptance time its deadline counts from.
interface FocusEntry {
  readonly kind: "focus";
  readonly request: number;
  readonly targetVersion: number;
  readonly deadlineAtMs: number;
  // The grid this request asks for. Known at registration when the caller or view supplied it,
  // otherwise once measured; the focus-announcement dedupe compares against it.
  requested: Geometry | undefined;
  readonly settle: ((outcome: TerminalControlOutcome) => void)[];
  settled: boolean;
}

// A registered input-target loss. The local effect (no further input, held input failed) took
// place at registration; this entry only releases the epoch recorded then (relay-protocol 9.1).
interface UnfocusEntry {
  readonly kind: "unfocus";
  epoch: number | null;
  readonly ref: SubscriptionRef;
  readonly deadlineAtMs: number;
  readonly settle: ((outcome: TerminalOutcome<TerminalControlReceipt | undefined>) => void)[];
}

interface FatalEntry {
  readonly kind: "fatal";
  readonly error: DomainError;
  readonly view: TerminalView;
}

type ControlEntry = FocusEntry | UnfocusEntry | FatalEntry;

// An accepted input. It keeps its count slot until its outcome notice has been delivered, which
// bounds undelivered outcomes and pushes back on producers (4.4.3).
interface InputItem {
  readonly inputId: number;
  readonly source: TerminalInputSource;
  readonly bytes: Uint8Array;
  readonly ref: SubscriptionRef;
  readonly binding: NegotiatedConnection;
  readonly targetVersion: number;
  readonly deadlineAtMs: number;
  readonly resolve: (outcome: TerminalInputOutcome) => void;
  written: number;
  unknown: number;
  // Set when a chunk passes the lane's final check, just before socket.send(): from then on the
  // input is never held, retried or replayed.
  started: boolean;
  epoch: number | undefined;
  settled: boolean;
  outcome: TerminalInputOutcome | undefined;
  hold: HoldGeneration | undefined;
}

// Inputs held while the controller cannot send (a recovery, or this subscription's own focus or
// resize grant wait), together with the earlier unsettled inputs they must follow (the barrier).
// See relay-protocol 9.1. Once `cause` is set the generation is closed: its unsent inputs have
// failed and new inputs fail with the same cause until the generation ends.
interface HoldGeneration {
  unsettled: number;
  undelivered: number;
  cause: ClientError | DomainError | undefined;
  // Once closed, inputs accepted after this inputId fail; those accepted up to it keep going.
  closedAfter: number;
}

// Bounds the work one drain round does before yielding a host task (4.4.4).
const CONTROL_DRAIN_QUANTUM = 16;

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

function inputNotice(outcome: TerminalInputOutcome): TerminalInputNotice {
  return Object.freeze({
    kind: "input",
    outcome: Object.freeze({
      ...outcome,
      value: Object.freeze({ ...outcome.value }),
      ...(!outcome.ok ? { error: Object.freeze({ ...outcome.error }) } : {}),
    }),
  });
}

export class RoutedTerminalController implements TerminalController {
  private execution: TerminalExecutionEvidence = Object.freeze({
    status: "unverifiable",
    source: "none",
  });
  private latestGetOrdinal = 0;
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
  // Identifies the latest focus request. A focus deferred across a recovery is sent only if no
  // newer request was made meanwhile (see requestFocus).
  private focusRequests = 0;
  private inputIntentSequence = 0;
  private retainedInputBytes = 0;
  private pendingInputIntents = 0;
  // Accepted inputs whose outcome notice is not delivered yet; see InputItem.
  private inputSlots = 0;
  private rejectionSlots = 0;
  private readonly inputQueue: InputItem[] = [];
  // Accepted inputs in acceptance order until their outcome notice is queued. An input can settle
  // before an earlier one (a connection loss fails queued input at once while the earlier input's
  // handed-off chunk is still being settled by the lane), but outcomes are reported in order.
  private readonly noticeOrder: InputItem[] = [];
  private pumping = false;
  private hold: HoldGeneration | undefined;
  // The ordered intent log and its drain (4.4.4).
  private readonly controlLog: ControlEntry[] = [];
  private drainScheduled = false;
  private controlDraining = false;
  // The latest registered focus request until it settles.
  private liveFocus: FocusEntry | undefined;
  // A fatal view failure, latched at registration. Terminal for this view and subscription: only
  // replaceView or a new attach clears it.
  private fatal: DomainError | undefined;
  private recoverySequence = 0;
  private resizeRequests = 0;
  private appearanceRequests = 0;
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
  // Internal waits (recovery ready, grant usable, input authority). They are not observers: each
  // commit point checks them synchronously, and a check only reads state and settles its own
  // promise; the woken continuation re-checks its operation's predicate (4.4.3).
  private readonly waiters = new Set<() => void>();
  // The grid requested by the focus of `intent` (updated by granted resizes), so a repeated
  // focus announcement for the grant it produced can be recognized as adding nothing.
  private focusGeometry: { readonly intent: number; readonly geometry: Geometry } | undefined;
  private progressInFlight = false;
  private pendingProgress: number | undefined;
  private autoRecoveryUsed = false;
  private retiring = false;
  private disposalComplete = false;
  private readonly notifier: Notifier<TerminalSnapshot, TerminalInputNotice, RejectionAggregate>;

  constructor(
    private readonly host: ControllerHost,
    private readonly run: RunRef,
    private readonly viewId: string,
    private view: TerminalView,
    private appearance: Appearance,
  ) {
    this.notifier = new Notifier({
      scheduler: host.scheduler,
      snapshot: () => this.snapshot(),
      aggregate: {
        create: () => new RejectionAggregate(),
        freeze: (aggregate) => aggregate.freeze(),
      },
    });
  }

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
    const view = this.view;
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    // The ID supplier may reenter (dispose, replaceView, another attach); create the operation
    // only if nothing it owns changed meanwhile (terminal-architecture 4.4.2).
    const raced = this.creationRaced("attach", binding, view, undefined);
    if (raced) return raced;
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
    const racedId = this.creationRaced("recover", binding, priorView, ref, priorToken);
    if (racedId) return racedId;
    if (!requestId) return Promise.resolve(errorOutcome(domainError("COUNTER_EXHAUSTED")));
    // Read what the resume decision needs before measureGrid(): the view may reenter and clear it.
    const retainedGeometry = this.retainedGeometry;
    let resume:
      | {
          appliedSeq: number;
          profile: typeof PROFILE;
          encoding: typeof BASELINE_ENCODING;
          geometry: Geometry;
        }
      | undefined;
    const appliedSeq = this.appliedSeq;
    if (
      this.retainedModel &&
      retainedGeometry &&
      this.appliedGeometry &&
      ![...this.viewWork.values()].some((work) => work.view === priorView) &&
      reason !== "gap" &&
      reason !== "resize-context"
    ) {
      let measured: Geometry;
      try {
        measured = priorView.measureGrid();
      } catch {
        return Promise.resolve(errorOutcome(localError("invalid-state")));
      }
      const racedMeasure = this.creationRaced("recover", binding, priorView, ref, priorToken);
      if (racedMeasure) return racedMeasure;
      if (measured.cols === retainedGeometry.cols && measured.rows === retainedGeometry.rows) {
        resume = {
          appliedSeq,
          profile: PROFILE,
          encoding: BASELINE_ENCODING,
          geometry: retainedGeometry,
        };
      }
    }
    const racedLate = this.creationRaced("recover", binding, priorView, ref, priorToken);
    if (racedLate) return racedLate;
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

  // Re-checks what an attach or recover recorded before calling foreign code (the ID supplier,
  // measureGrid). If an operation of the same kind started meanwhile, the caller joins it;
  // anything else that changed ends this creation with invalid-state, touching nothing.
  private creationRaced(
    kind: "attach" | "recover",
    binding: NegotiatedConnection,
    view: TerminalView,
    ref: SubscriptionRef | undefined,
    token?: number,
  ): Promise<TerminalOutcome<TerminalReady>> | undefined {
    if (this.isDisposed()) return Promise.resolve(errorOutcome(localError("disposed")));
    const operation = this.operation;
    if (operation)
      return operation.kind === kind
        ? operation.promise
        : Promise.resolve(errorOutcome(localError("invalid-state")));
    if (
      this.retiring ||
      this.host.binding() !== binding ||
      this.view !== view ||
      this.ref !== ref ||
      (token !== undefined && this.token !== token) ||
      (kind === "recover" && this.phase !== "ready")
    )
      return Promise.resolve(errorOutcome(localError("invalid-state")));
    return undefined;
  }

  // Reads the phase through a call so the compiler does not narrow it across reentrant calls.
  private isDisposed(): boolean {
    return this.phase === "disposed";
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
    if (this.isDisposed()) return errorOutcome(localError("disposed"));
    if (this.retiring) return errorOutcome(localError("invalid-state"));
    const phase = this.phase;
    const token = this.token;
    const ref = this.ref;
    const previousView = this.view;
    const binding = this.host.binding();
    if (!completeTerminalView(view)) return errorOutcome(localError("invalid-request"));
    if (this.isDisposed()) return errorOutcome(localError("disposed"));
    if (
      this.retiring ||
      this.phase !== phase ||
      this.token !== token ||
      this.ref !== ref ||
      this.view !== previousView ||
      this.host.binding() !== binding
    )
      return errorOutcome(localError("invalid-state"));
    // Commit the new owner before any foreign code runs (4.4.2): the old view's disposer, the
    // detach and the listener disposers may all reenter, and none of them may see the old view as
    // current or dispose the new one.
    const generation = nextCounter(this.viewGeneration);
    this.view = view;
    this.viewGeneration = generation ?? Number.MAX_SAFE_INTEGER;
    this.fatal = undefined;
    this.control.replaceView();
    this.failUnsentInputs(localError("invalid-state"));
    void this.detach();
    if (this.isDisposed()) return errorOutcome(localError("disposed"));
    this.releaseListener();
    this.releaseFocusListener();
    this.releaseInputListener();
    try {
      previousView.dispose();
    } catch {
      /* Replacement remains local. */
    }
    if (this.isDisposed()) return errorOutcome(localError("disposed"));
    // A newer replacement made during the old view's disposal owns the controller now.
    if (this.view !== view || this.retiring) return errorOutcome(localError("invalid-state"));
    return this.attach();
  }

  setVisibility(visible: boolean): void {
    if (this.phase === "disposed" || this.retiring) return;
    const token = this.token;
    const view = this.view;
    try {
      view.setVisibility(visible);
    } catch {
      // Attributed to the subscription that made the call, never to a successor.
      if (this.view === view) this.fail(localError("invalid-state"), token);
    }
  }

  // ---- Intent registration (terminal-architecture 4.4.4) ----
  //
  // Public focus/input entry points and view intents register synchronously: bookkeeping only,
  // no foreign code and no lane access. Work that needs the lane or the view is appended to the
  // control log (focus, unfocus, fatal) or the input queue and runs later from an empty stack.

  setInputTarget(foreground: boolean, focused: boolean): TerminalOutcome {
    if (this.phase === "disposed") return { ok: false, error: localError("disposed") };
    if (this.retiring) return { ok: false, error: localError("invalid-state") };
    if (typeof foreground !== "boolean" || typeof focused !== "boolean")
      return { ok: false, error: localError("invalid-request") };
    if (!foreground || !focused) this.registerUnfocus(foreground, undefined);
    else this.control.setTarget(true, true);
    this.publish();
    return { ok: true, value: undefined };
  }

  requestFocus(geometry?: Geometry): Promise<TerminalControlOutcome> {
    if (this.phase === "disposed")
      return Promise.resolve({ ok: false, error: localError("disposed") });
    let requested: Geometry | undefined;
    if (geometry !== undefined) {
      const checked = GeometrySchema.safeParse(geometry);
      if (!checked.success)
        return Promise.resolve({ ok: false, error: localError("invalid-request") });
      requested = Object.freeze({ ...checked.data });
    }
    return new Promise((resolve) => this.registerFocus(requested, resolve));
  }

  blur(): Promise<TerminalOutcome<TerminalControlReceipt | undefined>> {
    if (this.phase === "disposed")
      return Promise.resolve({ ok: false, error: localError("disposed") });
    return new Promise((resolve) => {
      this.registerUnfocus(this.control.hostForeground, resolve);
      this.publish();
    });
  }

  // A user's focus during a recovery (for example the baseline another client's resize forces on
  // this one) is deferred, not rejected: it is sent once the recovery reaches ready. The recovery
  // itself never sends focus; this is the user's request, only delayed (relay-protocol 9.1).
  private registerFocus(
    requested: Geometry | undefined,
    settle: (outcome: TerminalControlOutcome) => void,
  ): void {
    const binding = this.host.binding();
    if (
      this.retiring ||
      this.fatal ||
      !this.ref ||
      !binding ||
      !this.control.wantsFocus ||
      (this.phase !== "ready" && !this.recovering())
    ) {
      settle({ ok: false, error: localError("invalid-state") });
      return;
    }
    const request = nextCounter(this.focusRequests);
    if (request === null) {
      settle({ ok: false, error: domainError("COUNTER_EXHAUSTED") });
      return;
    }
    this.focusRequests = request;
    const entry: FocusEntry = {
      kind: "focus",
      request,
      targetVersion: this.control.targetVersion,
      deadlineAtMs: this.host.scheduler.nowMs() + this.recoveryBudget(binding),
      requested,
      settle: [settle],
      settled: false,
    };
    this.liveFocus = entry;
    this.appendControl(entry);
  }

  // Loss of the input target takes effect now: no further input is admitted or handed off and
  // every input not yet handed off fails. Releasing the epoch held now is left to the drain.
  private registerUnfocus(
    foreground: boolean,
    settle: ((outcome: TerminalOutcome<TerminalControlReceipt | undefined>) => void) | undefined,
  ): void {
    const ref = this.ref;
    // A focus still awaiting its result releases its own epoch when the result arrives
    // (releaseStaleFocus); this records the grant held or carried now.
    const epoch = ref ? (this.control.heldEpoch ?? null) : null;
    this.control.setTarget(foreground, false);
    this.failUnsentInputs(localError("invalid-state"));
    if (!ref || this.fatal || this.phase === "disposed") {
      settle?.({ ok: true, value: undefined });
      this.wake();
      return;
    }
    this.appendControl({
      kind: "unfocus",
      epoch,
      ref,
      deadlineAtMs: this.host.scheduler.nowMs() + this.recoveryBudget(this.host.binding()),
      settle: settle ? [settle] : [],
    });
  }

  private registerFatal(error: DomainError, view: TerminalView): void {
    if (this.fatal || this.phase === "disposed") return;
    this.fatal = Object.freeze({ ...error });
    this.failUnsentInputs(localError("invalid-state"));
    this.appendControl({ kind: "fatal", error: this.fatal, view });
  }

  // Appends to the control log, coalescing so its length stays bounded whatever the producer
  // does: an unprocessed focus is replaced by a later focus and dropped by a later unfocus (it is
  // already superseded by either, so its caller settles now), and adjacent unfocus entries merge
  // keeping the earliest recorded epoch. Inputs never enter the log, so it holds at most an
  // unfocus, a focus and a fatal entry (plus one unfocus after a fatal).
  private appendControl(entry: ControlEntry): void {
    const log = this.controlLog;
    if (entry.kind === "fatal") {
      if (!log.some((queued) => queued.kind === "fatal")) log.push(entry);
    } else {
      let tail = log[log.length - 1];
      if (tail?.kind === "focus") {
        log.pop();
        this.settleFocus(tail, { ok: false, error: localError("invalid-state") });
        tail = log[log.length - 1];
      }
      if (entry.kind === "unfocus" && tail?.kind === "unfocus" && tail.ref === entry.ref) {
        tail.epoch ??= entry.epoch;
        tail.settle.push(...entry.settle);
      } else log.push(entry);
    }
    this.wake();
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.controlDraining) return;
    this.drainScheduled = true;
    // Always from a microtask: the drain never runs inside foreign code or a view call.
    void Promise.resolve().then(() => this.drainControl());
  }

  // Processes the control log in registration order, one entry at a time. A focus or unfocus
  // holds the drain only until its command is with the lane (or it ends), so later entries keep
  // their order on the wire. Each round handles at most CONTROL_DRAIN_QUANTUM entries and then
  // yields a host task, so a reaction that registers a new entry for every processed one advances
  // one quantum per task.
  private async drainControl(): Promise<void> {
    this.drainScheduled = false;
    if (this.controlDraining) return;
    this.controlDraining = true;
    try {
      let processed = 0;
      while (this.controlLog.length) {
        if (processed >= CONTROL_DRAIN_QUANTUM) {
          processed = 0;
          try {
            await this.host.scheduler.yieldTurn();
          } catch {
            /* The drain continues on the next microtask. */
          }
          continue;
        }
        const entry = this.controlLog.shift()!;
        processed++;
        try {
          if (entry.kind === "focus") await this.runFocus(entry);
          else if (entry.kind === "unfocus") await this.runUnfocus(entry);
          else if (this.view === entry.view && this.ref) this.fail(entry.error);
        } catch {
          /* Every entry settles its own callers. */
        }
      }
    } finally {
      this.controlDraining = false;
      if (this.controlLog.length) this.scheduleDrain();
    }
  }

  private settleFocus(entry: FocusEntry, outcome: TerminalControlOutcome): void {
    if (entry.settled) return;
    entry.settled = true;
    if (this.liveFocus === entry) this.liveFocus = undefined;
    for (const settle of entry.settle) settle(outcome);
    // Held input waiting on this focus re-evaluates whether any focus remains.
    this.wake();
  }

  private liveFocusCurrent(): FocusEntry | undefined {
    const entry = this.liveFocus;
    return entry &&
      !entry.settled &&
      entry.request === this.focusRequests &&
      entry.targetVersion === this.control.targetVersion
      ? entry
      : undefined;
  }

  // Resolves once the drain may move on: the focus command is with the lane, or the focus ended.
  private runFocus(entry: FocusEntry): Promise<void> {
    return new Promise<void>((release) => {
      void this.focusFlow(entry, release).then(
        (outcome) => {
          release();
          this.settleFocus(entry, outcome);
        },
        () => {
          release();
          this.settleFocus(entry, { ok: false, error: localError("invalid-state") });
        },
      );
    });
  }

  private async focusFlow(entry: FocusEntry, release: () => void): Promise<TerminalControlOutcome> {
    // The request stays the user's current intent only until a newer focus request, any loss of
    // the input target (even if regained since), or a fatal view failure; it is checked again
    // right up to the handoff.
    const current = (): boolean =>
      !entry.settled &&
      this.focusRequests === entry.request &&
      this.control.targetVersion === entry.targetVersion &&
      this.control.wantsFocus &&
      !this.fatal;
    for (;;) {
      if (this.isDisposed()) return { ok: false, error: localError("disposed") };
      if (!current()) return { ok: false, error: localError("invalid-state") };
      if (this.host.scheduler.nowMs() >= entry.deadlineAtMs)
        return { ok: false, error: localError("timeout") };
      if (this.recovering()) {
        const waited = await this.waitForRecoveryReady(current, entry.deadlineAtMs);
        if (waited !== "ready") return { ok: false, error: localError(waited) };
        continue;
      }
      const attempt = await this.attemptFocus(entry, current, release);
      if (attempt !== "re-defer") return attempt;
    }
  }

  private async attemptFocus(
    entry: FocusEntry,
    current: () => boolean,
    release: () => void,
  ): Promise<TerminalControlOutcome | "re-defer"> {
    const ref = this.ref;
    const binding = this.host.binding();
    const view = this.view;
    if (!ref || !binding || !this.currentConnection(ref) || this.phase !== "ready" || !current())
      return { ok: false, error: localError("invalid-state") };
    const token = this.token;
    const generation = this.viewGeneration;
    const unchanged = (): boolean =>
      this.token === token &&
      this.viewGeneration === generation &&
      this.view === view &&
      this.ref === ref &&
      this.host.binding() === binding &&
      this.phase === "ready" &&
      current();
    // A focus that was never handed off and lost only to a recovery that started meanwhile is
    // deferred again (relay-protocol 9.1); anything else that changed supersedes it.
    const abandon = (): TerminalControlOutcome | "re-defer" =>
      this.recovering() && current() && this.ref === ref
        ? "re-defer"
        : { ok: false, error: localError("invalid-state") };
    let proposed = entry.requested;
    if (!proposed) {
      try {
        proposed = view.measureGrid();
      } catch {
        return { ok: false, error: localError("invalid-state") };
      }
    }
    const checked = GeometrySchema.safeParse(proposed);
    if (!checked.success) return { ok: false, error: localError("invalid-request") };
    if (!unchanged()) return abandon();
    entry.requested ??= Object.freeze({ ...checked.data });
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    if (!unchanged()) return abandon();
    const focusSeq = this.host.lane.nextFocusSeq(ref);
    // The subscription can end before the counter is allocated; see TerminalLane.nextFocusSeq.
    if (focusSeq === undefined) return { ok: false, error: localError("invalid-state") };
    if (!requestId || focusSeq === null)
      return { ok: false, error: domainError("COUNTER_EXHAUSTED") };
    const intent = this.control.beginFocus();
    if (intent === null) return { ok: false, error: domainError("COUNTER_EXHAUSTED") };
    this.focusGeometry = Object.freeze({
      intent,
      geometry: Object.freeze({ ...checked.data }),
    });
    // The worker's model admits a control fact only at its current grid, so a focus at a grid
    // other than the applied one is preceded by a resize fact, and every M0 resize requires a
    // baseline: this client will recover before it can apply the grant's own fact.
    const resizes = !sameGrid(this.appliedGeometry?.geometry, checked.data);
    this.host.lane.cancelUnsent(ref, ["focus"]);
    this.publish();
    // A recovery that starts after the handoff keeps the focus as carried rather than pending
    // (TerminalControl.suspendForRecovery), so its result is still accepted.
    const valid = (): boolean =>
      this.view === view &&
      this.ref === ref &&
      this.host.binding() === binding &&
      ((this.token === token &&
        this.viewGeneration === generation &&
        this.phase === "ready" &&
        this.control.pendingIntent === intent) ||
        this.control.carriesFocus(intent));
    // Evaluated again by the lane at the actual handoff: still the latest request with no target
    // loss, not expired, and no recovery in progress. A recovery that starts first (from a
    // reentrant callback, say) leaves the command unsent, and it is deferred again below.
    const sendable = (): boolean =>
      current() &&
      valid() &&
      this.phase === "ready" &&
      !this.recovering() &&
      this.host.scheduler.nowMs() < entry.deadlineAtMs;
    if (!sendable()) {
      this.control.failFocus(intent);
      this.publish();
      return abandon();
    }
    let settled = false;
    let receipt: TerminalControlOutcome | undefined;
    let redefer = false;
    let acceptedAtMs = 0;
    const handle = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      if (!outcome.ok) {
        this.control.failFocus(intent);
        // Proven never handed off and lost only to a recovery: wait for the next ready.
        if (
          !outcome.sent &&
          this.recovering() &&
          current() &&
          this.ref === ref &&
          this.host.scheduler.nowMs() < entry.deadlineAtMs
        )
          redefer = true;
        receipt = { ok: false, error: outcome.error };
      } else if (outcome.result.type !== "focus-result") {
        this.control.failFocus(intent);
        receipt = { ok: false, error: localError("invalid-response") };
      } else if (
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
        const epoch = outcome.result.epoch;
        // The server accepted it, so the epoch is released even though this request lost.
        this.host.lane.afterward(() => this.releaseStaleFocus(ref, epoch));
        receipt = {
          ok: false,
          error: localError("invalid-state"),
          accepted: { epoch, atSeq: outcome.result.atSeq },
        };
      } else {
        acceptedAtMs = this.host.scheduler.nowMs();
        receipt = {
          ok: true,
          value: { epoch: outcome.result.epoch, atSeq: outcome.result.atSeq },
        };
      }
      this.publish();
    };
    const sending = this.host.lane.send(
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
      sendable,
    );
    release();
    handle(await sending);
    if (redefer) return "re-defer";
    const granted = receipt!;
    // Resolve only once the grant is usable or lost, so input sent after a successful focus is
    // not caught by the recovery its own resize triggers. The wait is keyed on the requested grid
    // because the focus result can arrive before the resize fact; it spends the recovery budget
    // from the moment the result was accepted. A focus at the applied grid resolves on its result.
    if (granted.ok && (resizes || this.phase !== "ready")) {
      const settledFocus = await this.waitForGrantSettled(
        ref,
        binding,
        view,
        granted.value.epoch,
        acceptedAtMs,
      );
      if (settledFocus !== "usable")
        return { ok: false, error: localError(settledFocus), accepted: granted.value };
    }
    return granted;
  }

  private recovering(): boolean {
    return this.phase !== "ready" && this.operation?.kind === "recover";
  }

  private recoveryBudget(binding: NegotiatedConnection | undefined): number {
    return Math.min(
      binding?.effectiveBudgets.recoveryDeadlineMs ?? M0_LIMITS.recoveryDeadlineMs,
      M0_LIMITS.recoveryDeadlineMs,
    );
  }

  // Wakes every internal wait so it re-checks its condition. Checks only read state and settle
  // their own promise; no foreign code runs here.
  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  // Waits until `check` returns a value or `delayMs` elapses (then `expired`). The timer handle
  // is disposed in the continuation, never inside a commit, because its dispose() is foreign code.
  private waitUntil<T>(check: () => T | undefined, delayMs: number, expired: T): Promise<T> {
    let done = false;
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    const finish = (value: T): void => {
      if (done) return;
      done = true;
      this.waiters.delete(waiter);
      resolve(value);
    };
    const waiter = (): void => {
      if (done) return;
      let value: T | undefined;
      try {
        value = check();
      } catch {
        value = expired;
      }
      if (value !== undefined) finish(value);
    };
    this.waiters.add(waiter);
    let timer: Disposable | undefined;
    waiter();
    if (!done) {
      try {
        timer = this.host.scheduler.setTimer(Math.max(0, delayMs), () => finish(expired));
      } catch {
        finish(expired);
      }
    }
    return promise.then((value) => {
      safeDispose(timer);
      return value;
    });
  }

  // Waits for the recovery in progress to reach ready for a deferred focus. It gives up when the
  // request is superseded, the view is replaced, the subscription or connection changes or the
  // recovery fails, and at the request's deadline. A further recovery that starts meanwhile keeps
  // it waiting; the deadline is never reset.
  private waitForRecoveryReady(
    current: () => boolean,
    deadlineAtMs: number,
  ): Promise<"ready" | "invalid-state" | "timeout" | "disposed"> {
    const ref = this.ref;
    const binding = this.host.binding();
    const view = this.view;
    if (!ref || !binding) return Promise.resolve("invalid-state");
    return this.waitUntil<"ready" | "invalid-state" | "timeout" | "disposed">(
      () => {
        if (this.phase === "disposed") return "disposed";
        if (
          this.ref !== ref ||
          this.view !== view ||
          this.host.binding() !== binding ||
          !current() ||
          this.phase === "unavailable" ||
          this.phase === "idle"
        )
          return "invalid-state";
        if (this.phase === "ready") return "ready";
        if (!this.recovering()) return "invalid-state";
        return undefined;
      },
      deadlineAtMs - this.host.scheduler.nowMs(),
      "timeout",
    );
  }

  private waitForGrantSettled(
    ref: SubscriptionRef,
    binding: NegotiatedConnection,
    view: TerminalView,
    epoch: number,
    acceptedAtMs: number,
  ): Promise<"usable" | "invalid-state" | "timeout" | "disposed"> {
    // Usable, not merely ready: the grant's covering ACK must already be handed to the uplink,
    // otherwise input sent right after the focus would still wait behind the fence.
    return this.waitUntil<"usable" | "invalid-state" | "timeout" | "disposed">(
      () => {
        if (this.phase === "disposed") return "disposed";
        if (
          this.ref !== ref ||
          this.view !== view ||
          this.host.binding() !== binding ||
          this.phase === "unavailable" ||
          this.phase === "idle" ||
          !this.control.keepsGrant(epoch)
        )
          return "invalid-state";
        if (
          this.phase === "ready" &&
          this.control.epoch === epoch &&
          this.grantUsable(ref, this.viewGeneration)
        )
          return "usable";
        return undefined;
      },
      this.recoveryBudget(binding) - (this.host.scheduler.nowMs() - acceptedAtMs),
      "timeout",
    );
  }

  private runUnfocus(entry: UnfocusEntry): Promise<void> {
    return new Promise<void>((release) => {
      const finish = (outcome: TerminalOutcome<TerminalControlReceipt | undefined>): void => {
        release();
        for (const settle of entry.settle) settle(outcome);
      };
      void this.unfocusFlow(entry, release).then(finish, () =>
        finish({ ok: false, error: localError("invalid-state") }),
      );
    });
  }

  // Releases the epoch recorded at the unfocus (relay-protocol 9.1). During a recovery it waits
  // for ready; it is not sent when the authority known then proves the epoch is no longer this
  // subscription's, and a subscription that ended is released by its detach. A blur that may have
  // been handed off is never sent again.
  private async unfocusFlow(
    entry: UnfocusEntry,
    release: () => void,
  ): Promise<TerminalOutcome<TerminalControlReceipt | undefined>> {
    const ref = entry.ref;
    const epoch = entry.epoch;
    if (this.ref === ref)
      this.host.lane.cancelUnsent(ref, ["focus", "resize", "appearance", "input"]);
    if (epoch === null) return { ok: true, value: undefined };
    const active = (): boolean => this.ref === ref && this.currentConnection(ref);
    for (;;) {
      if (!active() || this.isDisposed()) return { ok: true, value: undefined };
      if (this.host.scheduler.nowMs() >= entry.deadlineAtMs)
        return { ok: false, error: localError("timeout") };
      if (this.phase !== "ready") {
        if (!this.recovering()) return { ok: true, value: undefined };
        const ready = await this.waitUntil(
          () => (!active() || this.phase === "ready" || !this.recovering() ? true : undefined),
          entry.deadlineAtMs - this.host.scheduler.nowMs(),
          false,
        );
        if (!ready) return { ok: false, error: localError("timeout") };
        continue;
      }
      if (this.control.rulesOut(epoch, ref)) return { ok: true, value: undefined };
      const requestId = this.host.lane.nextRequestId(this.host.generation());
      if (!active() || this.phase !== "ready") continue;
      if (!requestId) return { ok: false, error: domainError("COUNTER_EXHAUSTED") };
      let refused = false;
      const sending = this.host.lane.send(
        { type: "blur", requestId, run: this.run, subscription: ref, epoch },
        5_000,
        undefined,
        undefined,
        () => {
          const ok =
            active() && this.phase === "ready" && this.host.scheduler.nowMs() < entry.deadlineAtMs;
          if (!ok) refused = true;
          return ok;
        },
      );
      release();
      const result = await sending;
      if (!result.ok && !result.sent && refused && this.recovering() && active()) continue;
      return this.controlReceipt(result, "blur-result");
    }
  }

  async requestResize(geometry: Geometry): Promise<TerminalControlOutcome> {
    const parsed = GeometrySchema.safeParse(geometry);
    if (!parsed.success) return { ok: false, error: localError("invalid-request") };
    const request = nextCounter(this.resizeRequests);
    if (request === null) return { ok: false, error: domainError("COUNTER_EXHAUSTED") };
    this.resizeRequests = request;
    const ref = this.ref;
    const binding = this.host.binding();
    const view = this.view;
    // Every M0 grid change requires a baseline, so a resize to another grid sends this client
    // through a resize-context recovery that carries the grant. Like a resizing focus, resolve
    // only once the grant is usable again or lost; the wait spends the recovery budget from the
    // result. A resize at the applied grid resolves on its result.
    const resizes = !sameGrid(this.appliedGeometry?.geometry, parsed.data);
    const receipt = await this.sendGrantedControl(
      "resize",
      { geometry: parsed.data },
      () => this.resizeRequests === request,
    );
    if (!receipt.ok || !ref || !binding || (!resizes && this.phase === "ready")) return receipt;
    const settled = await this.waitForGrantSettled(
      ref,
      binding,
      view,
      receipt.value.epoch,
      this.host.scheduler.nowMs(),
    );
    return settled === "usable"
      ? receipt
      : { ok: false, error: localError(settled), accepted: receipt.value };
  }

  async updateAppearance(appearance: Appearance): Promise<TerminalOutcome<TerminalControlReceipt>> {
    const parsed = validateAppearance(appearance);
    if (!parsed) return { ok: false, error: localError("invalid-request") };
    const request = nextCounter(this.appearanceRequests);
    if (request === null) return { ok: false, error: domainError("COUNTER_EXHAUSTED") };
    this.appearanceRequests = request;
    const receipt = await this.sendGrantedControl(
      "appearance",
      { appearance: parsed },
      () => this.appearanceRequests === request,
    );
    return receipt.ok ? receipt : { ok: false, error: receipt.error };
  }

  // ---- Input (relay-protocol 9.1 input hold; terminal-architecture 4.4.3/4.4.4) ----

  sendInput(input: {
    source: TerminalInputSource;
    bytes: Uint8Array;
  }): Promise<TerminalInputOutcome> {
    let source: unknown;
    let bytes: unknown;
    try {
      source = input?.source;
      bytes = input?.bytes;
    } catch {
      /* Reported as a malformed input below. */
    }
    return Promise.resolve(this.admitInput(source, bytes));
  }

  onInputOutcome(listener: (notice: TerminalInputNotice) => void): Disposable {
    if (this.phase === "disposed") return { dispose() {} };
    return this.notifier.onNotice(listener);
  }

  // Admission is synchronous bookkeeping: an input is either accepted into the input queue (it
  // then keeps a count slot until its outcome notice is delivered) or rejected now with a visible
  // outcome. Nothing here calls foreign code or the lane.
  private admitInput(source: unknown, bytes: unknown): Promise<TerminalInputOutcome> {
    const total = bytes instanceof Uint8Array ? bytes.byteLength : 0;
    const wellFormed =
      (source === "keyboard" || source === "paste" || source === "mouse") &&
      bytes instanceof Uint8Array &&
      total >= 1;
    const reject = (error: ClientError | DomainError): Promise<TerminalInputOutcome> => {
      const outcome = inputFailure(source as TerminalInputSource, total, error);
      this.publishRejection(
        inputNotice(outcome),
        wellFormed ? rejectionSource(source) : "malformed",
        wellFormed ? total : undefined,
        error,
      );
      return Promise.resolve(outcome);
    };
    if (!wellFormed) return reject(localError("invalid-request"));
    if (this.phase === "disposed") return reject(localError("disposed"));
    if (this.fatal || this.retiring) return reject(localError("invalid-state"));
    const hold = this.hold;
    if (hold?.cause) return reject(hold.cause);
    const ref = this.ref;
    const binding = this.host.binding();
    if (!ref || !binding || !this.control.wantsFocus) return reject(localError("invalid-state"));
    if (
      !this.recovering() &&
      (this.phase !== "ready" ||
        (this.control.pendingIntent === undefined &&
          this.control.epoch === undefined &&
          !this.liveFocusCurrent()))
    )
      return reject(localError("invalid-state"));
    const cap = Math.min(binding.effectiveBudgets.inputQueueBytes, M0_LIMITS.inputQueueBytes);
    if (
      total > cap ||
      this.retainedInputBytes + total > cap ||
      this.inputSlots >= M0_LIMITS.pendingWorkerCommands - 32
    ) {
      const capacity = localError("capacity");
      const outcome = reject(capacity);
      this.closeHeldSuffix(capacity);
      return outcome;
    }
    const inputId = nextCounter(this.inputIntentSequence);
    if (inputId === null) return reject(domainError("COUNTER_EXHAUSTED"));
    let owned: Uint8Array;
    try {
      owned = new Uint8Array(bytes as Uint8Array);
    } catch {
      return reject(localError("capacity"));
    }
    this.inputIntentSequence = inputId;
    let resolve!: (outcome: TerminalInputOutcome) => void;
    const promise = new Promise<TerminalInputOutcome>((settle) => {
      resolve = settle;
    });
    const item: InputItem = {
      inputId,
      source: source as TerminalInputSource,
      bytes: owned,
      ref,
      binding,
      targetVersion: this.control.targetVersion,
      deadlineAtMs: this.host.scheduler.nowMs() + this.recoveryBudget(binding),
      resolve,
      written: 0,
      unknown: 0,
      started: false,
      epoch: undefined,
      settled: false,
      outcome: undefined,
      hold: undefined,
    };
    this.noticeOrder.push(item);
    this.retainedInputBytes += total;
    this.pendingInputIntents++;
    this.inputSlots++;
    // Held: accepted while the controller cannot send it now. It then follows every earlier
    // unsettled input (the barrier) and the prefix rule applies.
    if (this.hold || !this.inputSendableNow(ref)) this.joinHold(item);
    this.inputQueue.push(item);
    this.publish();
    void this.pumpInputs();
    return promise;
  }

  private inputSendableNow(ref: SubscriptionRef): boolean {
    return (
      this.phase === "ready" &&
      !this.recovering() &&
      this.control.currentEpoch(ref, this.viewGeneration, this.appliedSeq) !== null &&
      this.grantUsable(ref, this.viewGeneration)
    );
  }

  // Opens a hold generation if none is open (its barrier is every earlier unsettled input) and
  // adds `item` to it.
  private joinHold(item: InputItem | undefined): void {
    let hold = this.hold;
    if (!hold) {
      hold = { unsettled: 0, undelivered: 0, cause: undefined, closedAfter: 0 };
      this.hold = hold;
      for (const earlier of this.inputQueue)
        if (!earlier.settled && !earlier.hold) this.addToHold(hold, earlier);
    }
    if (item) this.addToHold(hold, item);
  }

  private addToHold(hold: HoldGeneration, item: InputItem): void {
    item.hold = hold;
    hold.unsettled++;
    hold.undelivered++;
  }

  // The prefix-closure decision point (relay-protocol 9.1, option A). Every event that can leave
  // a gap in the held input comes here: an earlier input (barrier or held) that did not complete
  // successfully, a capacity rejection, or a renderer input rejection while a generation is open.
  // Under option A each of them closes the generation at its own position in acceptance order:
  // the inputs accepted after that point and not yet handed off fail with the same cause and are
  // never sent, and new inputs fail with the generation's cause until it ends. Inputs accepted
  // before the point are not behind the gap and keep going; a registration-time rejection
  // (capacity, renderer) therefore only closes the generation to later input. If one of those
  // earlier inputs fails in turn, the point moves back to it. The input that failed keeps its own
  // real receipt.
  private closeHeldSuffix(cause: ClientError | DomainError, origin?: InputItem): void {
    const hold = this.hold;
    if (!hold) return;
    if (origin && origin.hold !== hold) return;
    const at = origin ? origin.inputId : this.inputIntentSequence;
    if (hold.cause && at >= hold.closedAfter) return;
    hold.cause ??= cause;
    hold.closedAfter = at;
    for (const item of [...this.inputQueue])
      if (item.hold === hold && item.inputId > at && !item.settled && !item.started)
        this.settleInput(
          item,
          inputFailure(item.source, item.bytes.byteLength, cause, item.inputId),
        );
    this.wake();
  }

  // Fails every accepted input not yet handed off (target loss, fatal view failure, view
  // replacement, retirement); an open hold generation closes with the same cause.
  private failUnsentInputs(error: ClientError | DomainError): void {
    const hold = this.hold;
    if (hold) {
      hold.cause ??= error;
      hold.closedAfter = 0;
    }
    for (const item of [...this.inputQueue])
      if (!item.settled && !item.started)
        this.settleInput(
          item,
          inputFailure(item.source, item.bytes.byteLength, error, item.inputId),
        );
    this.wake();
  }

  private settleInput(item: InputItem, outcome: TerminalInputOutcome): void {
    if (item.settled) return;
    item.settled = true;
    this.retainedInputBytes -= item.bytes.byteLength;
    this.pendingInputIntents--;
    const hold = item.hold;
    if (hold) hold.unsettled--;
    item.outcome = outcome;
    item.resolve(outcome);
    // The state change is marked before the notice is queued, so an observer never sees an
    // outcome before the state that produced it.
    this.publish();
    this.queueInputNotices();
    if (!outcome.ok) this.closeHeldSuffix(outcome.error, item);
    this.endHoldIfDone();
  }

  private queueInputNotices(): void {
    while (this.noticeOrder[0]?.outcome) {
      const item = this.noticeOrder.shift()!;
      const hold = item.hold;
      this.notifier.pushNotice(inputNotice(item.outcome!), () => {
        this.inputSlots--;
        if (hold) hold.undelivered--;
        this.endHoldIfDone();
        this.notifier.poke();
      });
    }
  }

  // Success end: every input of the generation was written completely. Failure end: the
  // generation is closed, all its inputs settled and their notices delivered; no new grant is
  // needed. Input admitted afterwards starts afresh.
  private endHoldIfDone(): void {
    const hold = this.hold;
    if (!hold || hold.unsettled > 0) return;
    if (hold.cause && hold.undelivered > 0) return;
    this.hold = undefined;
  }

  private publishRejection(
    notice: TerminalInputNotice,
    source: ReturnType<typeof rejectionSource> | "renderer" | "malformed",
    bytes: number | undefined,
    error: ClientError | DomainError,
  ): void {
    if (this.rejectionSlots < REJECTION_SLOTS) {
      this.rejectionSlots++;
      this.notifier.pushNotice(notice, () => {
        this.rejectionSlots--;
      });
      return;
    }
    this.notifier.tailAggregate()?.add(source, rejectionClass(error), bytes);
  }

  private rejectRendererInput(error: DomainError): void {
    const frozen = Object.freeze({ ...error });
    this.publishRejection(
      Object.freeze({ kind: "renderer-rejection", error: frozen }),
      "renderer",
      undefined,
      frozen,
    );
    this.closeHeldSuffix(frozen);
  }

  private async pumpInputs(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // Inputs are delivered one at a time in acceptance order; an input settled while waiting
      // (failed by a target loss, say) is dropped from the queue when reached.
      await Promise.resolve();
      while (this.inputQueue.length) {
        const item = this.inputQueue[0]!;
        if (!item.settled) {
          try {
            await this.deliverItem(item);
          } catch {
            this.failItem(item, localError("invalid-state"));
          }
        }
        const index = this.inputQueue.indexOf(item);
        if (index >= 0) this.inputQueue.splice(index, 1);
      }
    } finally {
      this.pumping = false;
    }
  }

  private failItem(item: InputItem, error: ClientError | DomainError, uncertainBytes = 0): void {
    item.unknown += uncertainBytes;
    this.settleInput(
      item,
      inputFailure(
        item.source,
        item.bytes.byteLength,
        error,
        item.inputId,
        item.written,
        item.unknown,
      ),
    );
  }

  // Whether `item`'s next chunk may be handed off now, must wait, or fails (with the error).
  // Progress generations (token, viewGeneration, focus intent, a recovery) do not supersede input;
  // only its own ownership does: the subscription, the connection, the target version, a fatal
  // failure, its hold generation's closure and its deadline.
  private inputGate(item: InputItem): "go" | "wait" | ClientError | DomainError {
    if (this.phase === "disposed") return localError("disposed");
    if (item.settled || this.fatal) return localError("invalid-state");
    if (item.hold?.cause && item.inputId > item.hold.closedAfter) return item.hold.cause;
    if (
      this.ref !== item.ref ||
      this.host.binding() !== item.binding ||
      this.control.targetVersion !== item.targetVersion ||
      !this.control.wantsFocus
    )
      return localError("invalid-state");
    const recovering = this.recovering();
    // Only never-handed-off input may be held; the rest of a partly sent input is not.
    if (item.started && (recovering || this.phase !== "ready")) return localError("invalid-state");
    if (this.host.scheduler.nowMs() >= item.deadlineAtMs) return localError("timeout");
    if (recovering) return "wait";
    if (this.phase !== "ready") return localError("invalid-state");
    const generation = this.viewGeneration;
    const epoch = this.control.currentEpoch(item.ref, generation, this.appliedSeq);
    if (epoch !== null && this.grantUsable(item.ref, generation)) {
      if (item.started && item.epoch !== epoch) return localError("invalid-state");
      return "go";
    }
    // Wait while a grant or a focus that may produce one remains; fail once neither does.
    if (
      this.control.pendingIntent !== undefined ||
      this.control.heldEpoch !== undefined ||
      this.liveFocusCurrent()
    )
      return "wait";
    return localError("invalid-state");
  }

  private async deliverItem(item: InputItem): Promise<void> {
    const total = item.bytes.byteLength;
    let refusals = 0;
    while (!item.settled) {
      const gate = this.inputGate(item);
      if (gate === "wait") {
        refusals = 0;
        await this.waitUntil(
          () => (item.settled || this.inputGate(item) !== "wait" ? true : undefined),
          item.deadlineAtMs - this.host.scheduler.nowMs(),
          true,
        );
        continue;
      }
      if (gate !== "go") {
        this.failItem(item, gate);
        return;
      }
      const ref = item.ref;
      const epoch = this.control.currentEpoch(ref, this.viewGeneration, this.appliedSeq)!;
      const requestId = this.host.lane.nextRequestId(this.host.generation());
      // The ID supplier may reenter; the gate is evaluated again before anything is allocated.
      if (item.settled) return;
      if (
        this.inputGate(item) !== "go" ||
        this.control.currentEpoch(ref, this.viewGeneration, this.appliedSeq) !== epoch
      )
        continue;
      const inputSeq = this.host.lane.nextInputSeq(ref);
      // The subscription can end before the counter is allocated; see TerminalLane.nextInputSeq.
      if (inputSeq === undefined) {
        this.failItem(item, localError("invalid-state"));
        return;
      }
      if (!requestId || inputSeq === null) {
        this.failItem(item, domainError("COUNTER_EXHAUSTED"));
        return;
      }
      const chunk = item.bytes.subarray(
        item.written,
        Math.min(total, item.written + MAX_PAYLOAD_BYTES),
      );
      const startedBefore = item.started;
      let refused = false;
      const outcome = await this.host.lane.send(
        { type: "input", requestId, run: this.run, subscription: ref, epoch, inputSeq },
        5_000,
        undefined,
        undefined,
        () => {
          const ok =
            this.inputGate(item) === "go" &&
            this.control.currentEpoch(ref, this.viewGeneration, this.appliedSeq) === epoch;
          if (ok) {
            item.started = true;
            item.epoch = epoch;
          } else refused = true;
          return ok;
        },
        chunk,
      );
      if (item.settled) return;
      if (!outcome.ok) {
        // A chunk the lane proves it never handed off, of an input not started yet, returns to
        // the gate (it is held across a recovery that began meanwhile). Bounded so that a lane
        // refusing what the gate allows cannot spin.
        if (!outcome.sent && !startedBefore && (refused || this.recovering()) && refusals++ < 3)
          continue;
        const uncertain =
          outcome.uncertain ||
          ("acceptance" in outcome.error && outcome.error.acceptance !== "not-accepted");
        this.failItem(item, outcome.error, uncertain ? chunk.byteLength : 0);
        return;
      }
      refusals = 0;
      if (outcome.result.type !== "input-result") {
        this.failItem(item, localError("invalid-response"), chunk.byteLength);
        return;
      }
      const length = outcome.result.writtenBytes;
      if (length > chunk.byteLength) {
        this.failItem(item, localError("invalid-response"), chunk.byteLength);
        return;
      }
      item.written += length;
      if (length < chunk.byteLength) {
        this.failItem(
          item,
          domainError("RESULT_UNKNOWN", "unknown", "input"),
          chunk.byteLength - length,
        );
        return;
      }
      if (item.written === total) {
        this.settleInput(item, {
          ok: true,
          value: inputReceipt(item.source, total, item.inputId, item.written),
        });
        return;
      }
    }
  }

  // `except` excludes the caller's own granted-control reservation (4.4.2).
  private grantUsable(ref: SubscriptionRef, generation: number, except = 0): boolean {
    return (
      this.control.ready(ref, generation, this.appliedSeq) &&
      this.grantedControlsInFlight - except === 0 &&
      this.handedAckSeq >= Math.max(this.fenceSeq, this.control.grantAtSeq ?? 0)
    );
  }

  private raiseFence(seq: number): void {
    if (seq > this.fenceSeq) this.fenceSeq = seq;
  }

  private async sendGrantedControl(
    type: "resize" | "appearance",
    value: { geometry: Geometry } | { appearance: Appearance },
    latest: () => boolean,
  ): Promise<TerminalControlOutcome> {
    if (this.phase === "disposed") return { ok: false, error: localError("disposed") };
    const ref = this.ref;
    const binding = this.host.binding();
    const token = this.token;
    const generation = this.viewGeneration;
    if (!ref || !binding || this.phase !== "ready")
      return { ok: false, error: localError("invalid-state") };
    const current = (): boolean =>
      latest() &&
      this.token === token &&
      this.ref === ref &&
      this.host.binding() === binding &&
      this.phase === "ready";
    const startedAtMs = this.host.scheduler.nowMs();
    // Like input, a granted command must follow the applied-ack that covers the grant fence.
    while (
      this.control.currentEpoch(ref, generation, this.appliedSeq) !== null &&
      !this.grantUsable(ref, generation)
    ) {
      const usable = await this.waitUntil(
        () => {
          if (!current() || this.control.currentEpoch(ref, generation, this.appliedSeq) === null)
            return false;
          return this.grantUsable(ref, generation) ? true : undefined;
        },
        5_000 - (this.host.scheduler.nowMs() - startedAtMs),
        false,
      );
      if (!usable) return { ok: false, error: localError("invalid-state") };
    }
    const epoch = this.control.currentEpoch(ref, generation, this.appliedSeq);
    if (epoch === null || !current()) return { ok: false, error: localError("invalid-state") };
    // Reserved before any foreign code (the ID supplier) runs and held until settlement, so input
    // registered reentrantly sees an unsettled granted control and waits behind it.
    this.grantedControlsInFlight++;
    try {
      const requestId = this.host.lane.nextRequestId(this.host.generation());
      if (!current() || this.control.currentEpoch(ref, generation, this.appliedSeq) !== epoch)
        return { ok: false, error: localError("invalid-state") };
      if (!requestId) return { ok: false, error: domainError("COUNTER_EXHAUSTED") };
      const command = {
        type,
        requestId,
        run: this.run,
        subscription: ref,
        epoch,
        ...value,
      } as TerminalCommand;
      const result = await this.host.lane.send(
        command,
        5_000,
        undefined,
        undefined,
        () =>
          current() &&
          this.control.currentEpoch(ref, generation, this.appliedSeq) === epoch &&
          this.grantUsable(ref, generation, 1),
      );
      const receipt = this.controlReceipt(result, `${type}-result`);
      if (receipt.ok && this.token === token && this.ref === ref) {
        // The server moved its control boundary to this result; later granted commands wait for
        // the ack that covers it, which also proves the result's fact has been applied.
        this.raiseFence(receipt.value.atSeq);
        const intent = this.control.heldIntent;
        if ("geometry" in value && this.control.epoch === epoch && intent !== undefined)
          this.focusGeometry = Object.freeze({
            intent,
            geometry: Object.freeze({ ...value.geometry }),
          });
      }
      return receipt;
    } finally {
      // The fence is raised before held commands are released, so none slips out under the old
      // one. A failed or unknown result leaves the fence as it was; a command then sent under a
      // boundary the server did move is rejected and reported, never silently retried.
      this.grantedControlsInFlight--;
      this.wake();
    }
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
    if (!requestId || this.ref !== ref || !this.currentConnection(ref)) return;
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
      recoverySequence: this.recoverySequence,
      ...(this.control.epoch !== undefined ? { controlEpoch: this.control.epoch } : {}),
    });
  }

  onState(listener: (snapshot: TerminalSnapshot) => void): Disposable {
    if (this.phase === "disposed") return { dispose() {} };
    return this.notifier.onState(listener);
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
    // This runs inside the lane's route callback: failing the subscription is follow-up work.
    const token = this.token;
    const failLater = (): void =>
      this.host.lane.afterward(() => this.fail(localError("capacity"), token));
    if (
      this.queue.length + this.activeItems >= binding.effectiveBudgets.postNEvents ||
      this.queuedBytes + this.activeBytes + charge >
        binding.effectiveBudgets.subscriptionCreditBytes
    ) {
      failLater();
      return;
    }
    if (!this.host.lane.reserveIngress(charge)) {
      failLater();
      return;
    }
    let payload: Uint8Array;
    try {
      payload = new Uint8Array(bytes);
    } catch {
      this.host.lane.releaseIngress(charge);
      failLater();
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
    const sequence = nextCounter(this.recoverySequence);
    if (token === null || sequence === null) return null;
    this.token = token;
    this.recoverySequence = sequence;
    // A new subscription starts without the previous one's fatal view failure.
    if (kind === "attach") this.fatal = undefined;
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
    // Input accepted before the recovery and not yet handed off is held across it; input already
    // handed off forms the barrier the held input must follow (relay-protocol 9.1).
    if (kind === "recover" && this.inputQueue.some((item) => !item.settled))
      this.joinHold(undefined);
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
      // Inside the lane only this command's bookkeeping runs inline (the attach route is
      // registered here so a baseline-start in the same delivery is routed); failing the operation
      // and committing it are follow-up work (4.4.5).
      const failLater = (error: ClientError | DomainError): void =>
        this.host.lane.afterward(() => this.fail(error, operation.token));
      if (!outcome.ok) {
        if (operation.kind === "attach")
          operation.attachDisposition =
            "acceptance" in outcome.error
              ? outcome.error.acceptance
              : outcome.uncertain
                ? "unknown"
                : "not-accepted";
        failLater(outcome.error);
        return;
      }
      if (operation.kind === "attach") operation.attachDisposition = "accepted";
      const result = outcome.result;
      if (
        (command.type === "attach" && result.type !== "attach-result") ||
        (command.type === "recover" && result.type !== "recover-result")
      ) {
        failLater(localError("invalid-response"));
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
          failLater(localError("invalid-response"));
          return;
        }
        this.ref = canonicalRef;
      }
      operation.mode = result.mode;
      operation.atSeq = result.atSeq;
      if (result.atSeq < this.provenSeq) {
        failLater(localError("invalid-response"));
        return;
      }
      if (result.mode === "replay" && !this.retainedModel) {
        failLater(localError("invalid-response"));
        return;
      }
      if (result.mode === "baseline") {
        this.retainedModel = false;
        this.retainedGeometry = undefined;
      }
      this.phase = result.mode === "baseline" ? "baseline" : "replay";
      this.publish();
      if (result.mode === "replay" && result.atSeq === this.appliedSeq)
        this.host.lane.afterward(() => this.commit(operation));
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
    // A latched fatal view failure ends the subscription from the intent drain; nothing more is
    // applied to the view meanwhile.
    if (item.token !== this.token || !this.ref || this.fatal) return;
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
        this.phase !== "baseline" ||
        this.fatal
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
    // Ownership is recorded before the ID supplier, which may reenter (recover, detach, another
    // ACK); only the subscription and token that asked may install the in-flight state.
    const token = this.token;
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    if (token !== this.token || ref !== this.ref || this.phase === "await-marker") return;
    if (this.ackInFlight) {
      this.pendingAck = Math.max(this.pendingAck ?? seq, seq);
      return;
    }
    if (!requestId) {
      this.fail(domainError("COUNTER_EXHAUSTED"), token);
      return;
    }
    this.ackInFlight = true;
    let handled = false;
    const handle = (outcome: CommandOutcome): void => {
      if (handled) return;
      handled = true;
      // A superseded ACK's result never clears its successor's state.
      if (token !== this.token) return;
      this.ackInFlight = false;
      if (!outcome.ok) {
        this.host.lane.afterward(() => this.fail(outcome.error, token));
        return;
      }
      const next = this.pendingAck;
      this.pendingAck = undefined;
      if (next !== undefined && next > seq)
        this.host.lane.afterward(() => {
          if (token === this.token) this.sendAck(next);
        });
    };
    void this.host.lane
      .send(
        { type: "applied-ack", requestId, run: this.run, subscription: ref, appliedSeq: seq },
        5_000,
        () => {
          if (token !== this.token) return;
          if (seq > this.handedAckSeq) this.handedAckSeq = seq;
          onHandoff?.();
          this.wake();
        },
        handle,
      )
      .then(handle);
  }

  private sendProgress(ordinal: number): void {
    const ref = this.ref;
    const descriptor = this.baseline;
    const operation = this.operation;
    if (!ref || !descriptor) return;
    if (this.progressInFlight) {
      this.pendingProgress = Math.max(this.pendingProgress ?? ordinal, ordinal);
      return;
    }
    const token = this.token;
    const requestId = this.host.lane.nextRequestId(this.host.generation());
    if (
      token !== this.token ||
      ref !== this.ref ||
      operation !== this.operation ||
      descriptor !== this.baseline ||
      this.phase !== "baseline"
    )
      return;
    if (this.progressInFlight) {
      this.pendingProgress = Math.max(this.pendingProgress ?? ordinal, ordinal);
      return;
    }
    if (!requestId) {
      this.fail(domainError("COUNTER_EXHAUSTED"), token);
      return;
    }
    this.progressInFlight = true;
    let handled = false;
    const handle = (outcome: CommandOutcome): void => {
      if (handled) return;
      handled = true;
      if (token !== this.token) return;
      this.progressInFlight = false;
      if (!outcome.ok) {
        this.host.lane.afterward(() => this.fail(outcome.error, token));
        return;
      }
      const next = this.pendingProgress;
      this.pendingProgress = undefined;
      if (next !== undefined && next > ordinal)
        this.host.lane.afterward(() => {
          if (token === this.token && descriptor === this.baseline) this.sendProgress(next);
        });
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
      // Input not yet handed off ends with the subscription; handed-off input keeps its result.
      this.failUnsentInputs(localError(this.phase === "disposed" ? "disposed" : "invalid-state"));
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
    // The final state and every outcome owed to an accepted input still reach the listeners
    // subscribed now; the notifier lets them go once nothing more is owed.
    this.notifier.closeWhenIdle(() => this.inputSlots === 0);
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
      // Registered synchronously even while a view operation is in progress (4.4.4). A call
      // through a superseded registration is ignored; an intent of an older view generation
      // through the current one is rejected visibly rather than dropped.
      if (
        generation !== this.viewGeneration ||
        token !== this.token ||
        view !== this.view ||
        ref !== this.ref ||
        this.phase === "disposed"
      )
        return;
      let source: unknown;
      let bytes: unknown;
      let intentGeneration: unknown;
      try {
        ({ source, bytes, viewGeneration: intentGeneration } = intent);
      } catch {
        /* Rejected as malformed below. */
      }
      if (intentGeneration !== this.viewGeneration) {
        const total = bytes instanceof Uint8Array ? bytes.byteLength : 0;
        const error = localError("invalid-state");
        this.publishRejection(
          inputNotice(inputFailure(source as TerminalInputSource, total, error)),
          rejectionSource(source),
          bytes instanceof Uint8Array ? total : undefined,
          error,
        );
        return;
      }
      void this.admitInput(source, bytes);
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
      // Focus and unfocus register synchronously, also during a recovery: a focus is deferred to
      // ready and an unfocus takes effect at once (4.4.4, relay-protocol 9.1).
      if (
        generation !== this.viewGeneration ||
        token !== this.token ||
        view !== this.view ||
        ref !== this.ref ||
        this.phase === "disposed" ||
        intent.viewGeneration !== this.viewGeneration ||
        !Number.isSafeInteger(intent.focusSeq) ||
        intent.focusSeq < 1
      )
        return;
      const current = this.viewGeneration;
      if (this.localFocusGeneration !== current) {
        this.localFocusGeneration = current;
        this.localFocusSequence = 0;
      }
      if (intent.focusSeq <= this.localFocusSequence) return;
      this.localFocusSequence = intent.focusSeq;
      if (intent.focused) {
        if (!this.control.hostForeground || this.fatal) return;
        if (this.phase !== "ready" && !this.recovering()) return;
        this.control.setTarget(true, true);
        if (this.focusAnnouncementAddsNothing(intent.geometry)) {
          this.publish();
          return;
        }
        void this.requestFocus(intent.geometry);
      } else {
        this.registerUnfocus(this.control.hostForeground, undefined);
        this.publish();
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
      // Attributed to the logical view, not to a backend incarnation or view generation: a
      // failure reported by a retired backend of this view is not dropped (4.4.4).
      if (view !== this.view || ref !== this.ref) return;
      if (error.kind === "INPUT_REJECTED") this.rejectRendererInput(error);
      else this.registerFatal(error, view);
    });
    if (!current() || this.listener) {
      safeDispose(listener);
      return false;
    }
    this.listener = listener;
    return true;
  }

  // Marks a state change for observers (delivered on a later task) and wakes internal waits.
  private publish(): void {
    this.notifier.markState();
    this.wake();
  }

  // relay-protocol 9.1 focus announcements: the view announces focus before every deliberate
  // input. Only a still-current focus request, or a grant this subscription holds or carries,
  // can make one redundant, and only when it asks for the same grid as that request or grant.
  // The applied grid stands in only for a grant whose requested grid is unknown. With neither
  // (a gap recovery, say) the announcement is the user's focus request.
  private focusAnnouncementAddsNothing(geometry: Geometry): boolean {
    const live = this.liveFocusCurrent();
    if (live) return sameGrid(live.requested, geometry);
    const ref = this.ref;
    if (!ref || !(this.control.holds(ref, this.viewGeneration) || this.control.carriesGrant))
      return false;
    const intent = this.control.heldIntent;
    const requested =
      this.focusGeometry && this.focusGeometry.intent === intent
        ? this.focusGeometry.geometry
        : this.appliedGeometry?.geometry;
    return sameGrid(requested, geometry);
  }
}
