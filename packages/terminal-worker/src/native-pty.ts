import * as pty from "node-pty";
import type { RetainedBytesLease } from "@cove/terminal-engine";
import type {
  BoundedPtyCleanupResult,
  IBoundedWriteOwnerResult,
  IDisposable,
  IPty,
  OwnedSignal,
  OwnedSignalResult,
  OwnedSignalScope,
} from "node-pty";
import {
  PtyInputController,
  SharedNativeInputBudget,
  type NativeBoundedWriter,
  type NativeInputAdmission,
  type NativeInputFault,
  type NativeInputSettlement,
  type NativeInputSnapshot,
} from "./pty-input.js";

export type {
  NativeInputAdmission,
  NativeInputFault,
  NativeInputOrigin,
  NativeInputRejectionReason,
  NativeInputSettlement,
  NativeInputSnapshot,
} from "./pty-input.js";

const MAX_OWNERS = 128;
const MAX_PTY_INPUT_BYTES = 64 * 1024;
const MAX_PTY_INPUT_TASKS = 256;
const MAX_FACTORY_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_FACTORY_INPUT_TASKS = MAX_OWNERS * MAX_PTY_INPUT_TASKS;
const MAX_EARLY_OUTPUT_BYTES = 1024 * 1024;

export interface NativeFactoryLimits {
  readonly maxOwners: number;
  readonly aggregateInputBytes: number;
  readonly aggregateInputTasks: number;
  readonly perPtyInputBytes?: number;
  readonly perPtyInputTasks?: number;
  readonly earlyOutputBytes: number;
}

export interface NativeSpawnSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cols: number;
  readonly rows: number;
  readonly inputBytes?: number;
  readonly inputTasks?: number;
  readonly reserveRetainedBytes?: (
    category: "native-input" | "native-output",
    bytes: number,
  ) => RetainedBytesLease | undefined;
}

export interface NativeExit {
  readonly exitCode: number;
  readonly signal?: number;
}

export type NativePtyFault =
  | {
      readonly kind: "binding" | "input" | "output" | "io" | "observer";
      readonly reason: string;
      readonly cause?: unknown;
    }
  | {
      readonly kind: "automatic-output";
      readonly reason: "rejected" | "unknown";
      readonly admission: NativeInputAdmission;
    };

export interface NativeObserver {
  onData(bytes: Buffer): void;
  onExit(exit: NativeExit): void;
  onFault(fault: NativePtyFault): void;
}

export type NativeStopAttempt =
  | OwnedSignalResult
  | {
      readonly kind: "not-attempted";
      readonly reason:
        "already-exited" | "already-reaped" | "deadline-not-reached" | "capability-fault";
    };

export interface NativeStopCleanup {
  readonly scope: "initial-process-group";
  readonly verified: false;
  readonly graceful: NativeStopAttempt;
  readonly force: NativeStopAttempt;
}

export type NativeStopResult =
  | {
      readonly kind: "exited";
      readonly exit: NativeExit;
      readonly cleanup: NativeStopCleanup;
      readonly signalFailure?: { readonly phase: "graceful" | "force"; readonly cause: unknown };
    }
  | {
      readonly kind: "unverifiable";
      readonly cause: unknown;
      readonly cleanup: NativeStopCleanup;
      readonly signalFailure?: { readonly phase: "graceful" | "force"; readonly cause: unknown };
    };

export interface BoundedNativeCause {
  readonly category: "native-failure" | "diagnostic-unavailable";
  readonly summary?: string;
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = "";
  let bytes = 0;
  for (const point of value) {
    const width = Buffer.byteLength(point);
    if (bytes + width > maxBytes) break;
    text += point;
    bytes += width;
  }
  return text;
}

export function boundedNativeCause(value: unknown): BoundedNativeCause {
  try {
    const summary = boundedText(value, 128);
    return Object.freeze(
      summary ? { category: "native-failure", summary } : { category: "native-failure" },
    );
  } catch {
    return Object.freeze({ category: "diagnostic-unavailable" });
  }
}

function boundedStopAttempt(value: NativeStopAttempt): NativeStopAttempt {
  try {
    if (value.kind === "signaled" || value.kind === "already-reaped") return { kind: value.kind };
    if (value.kind === "not-attempted") {
      const reason = value.reason;
      if (
        reason === "already-exited" ||
        reason === "already-reaped" ||
        reason === "deadline-not-reached" ||
        reason === "capability-fault"
      )
        return { kind: "not-attempted", reason };
    }
    if (value.kind === "unverifiable") {
      const reason = value.reason;
      if (reason === "not-found" || reason === "signal-failed" || reason === "scope-unavailable") {
        const errorCode = boundedText(value.errorCode, 32);
        return errorCode && /^[\x20-\x7e]*$/.test(errorCode)
          ? { kind: "unverifiable", reason, errorCode }
          : { kind: "unverifiable", reason };
      }
    }
  } catch {
    // An accessor from an injected factory cannot become retained state.
  }
  return { kind: "not-attempted", reason: "capability-fault" };
}

export function boundedNativeStopResult(value: NativeStopResult): NativeStopResult {
  let cleanup: NativeStopCleanup;
  try {
    cleanup = {
      scope: "initial-process-group",
      verified: false,
      graceful: boundedStopAttempt(value.cleanup.graceful),
      force: boundedStopAttempt(value.cleanup.force),
    };
  } catch {
    cleanup = {
      scope: "initial-process-group",
      verified: false,
      graceful: { kind: "not-attempted", reason: "capability-fault" },
      force: { kind: "not-attempted", reason: "capability-fault" },
    };
  }
  let signalFailure: NativeStopResult["signalFailure"];
  try {
    const raw = value.signalFailure;
    if (raw) {
      const phase = raw.phase;
      if (phase === "graceful" || phase === "force")
        signalFailure = { phase, cause: boundedNativeCause(raw.cause) };
    }
  } catch {
    // An unreadable diagnostic does not justify inventing a signal phase.
  }
  try {
    if (
      value.kind === "exited" &&
      Number.isSafeInteger(value.exit.exitCode) &&
      (value.exit.signal === undefined || Number.isSafeInteger(value.exit.signal))
    )
      return Object.freeze({
        kind: "exited",
        exit: Object.freeze({
          exitCode: value.exit.exitCode,
          ...(value.exit.signal === undefined ? {} : { signal: value.exit.signal }),
        }),
        cleanup: Object.freeze(cleanup),
        ...(signalFailure && { signalFailure }),
      });
  } catch {
    // Preserve uncertainty if independently reported exit facts are malformed.
  }
  let cause: BoundedNativeCause;
  try {
    cause =
      value.kind === "unverifiable"
        ? boundedNativeCause(value.cause)
        : boundedNativeCause(undefined);
  } catch {
    cause = { category: "diagnostic-unavailable" };
  }
  return Object.freeze({
    kind: "unverifiable",
    cause,
    cleanup: Object.freeze(cleanup),
    ...(signalFailure && { signalFailure }),
  });
}

export interface NativePtyAdapterSnapshot {
  readonly pid: number;
  readonly exited: boolean;
  readonly writer: "pending" | "closed" | "close-uncertain" | "invalid";
  readonly input: NativeInputSnapshot;
  readonly earlyOutputBytes: number;
  readonly paused: boolean;
}

export interface NativePtyAdapter {
  readonly pid: number;
  readonly writerCompletion: Promise<IBoundedWriteOwnerResult>;
  submit(
    bytes: Uint8Array,
    onSettled: (result: NativeInputSettlement) => void,
  ): NativeInputAdmission;
  automaticOutputSink(event: {
    readonly atSeq: number;
    readonly kind: "query" | "focus";
    readonly bytes: Uint8Array;
  }): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  retireInput(): void;
  stop(): Promise<NativeStopResult>;
  snapshot(): NativePtyAdapterSnapshot;
}

export interface NativeFactorySnapshot {
  readonly owners: number;
  readonly provisionalOwners: number;
  readonly rollbackPendingOwners: number;
  readonly activeOwners: number;
  readonly tombstones: number;
  readonly peakOwners: number;
  readonly maxOwners: number;
  readonly aggregateInput: NativeInputSnapshot;
}

export type NativeSpawnRejectionReason =
  | "invalid-spec"
  | "unsupported-platform"
  | "binding-unavailable"
  | "binding-mismatch"
  | "preflight-failed"
  | "owner-limit";

export type NativeSpawnResult =
  | { readonly kind: "created"; readonly pty: NativePtyAdapter }
  | { readonly kind: "rejected"; readonly reason: NativeSpawnRejectionReason }
  | {
      readonly kind: "failed";
      readonly cause: unknown;
      readonly cleanup: Promise<BoundedPtyCleanupResult>;
    }
  | { readonly kind: "unclassified-failure"; readonly cause: unknown };

export interface NativePtyFactory {
  readonly retainedBytesAccounting?: "participating";
  spawn(spec: NativeSpawnSpec, observer: NativeObserver): NativeSpawnResult;
  snapshot(): NativeFactorySnapshot;
}

type OwnerState = "provisional" | "rollback-pending" | "active" | "tombstone" | "released";

class OwnerLedger {
  readonly #maxOwners: number;
  #owners = 0;
  #provisionalOwners = 0;
  #rollbackPendingOwners = 0;
  #activeOwners = 0;
  #tombstones = 0;
  #peakOwners = 0;

  constructor(maxOwners: number) {
    this.#maxOwners = maxOwners;
  }

  reserve(): OwnerReservation | undefined {
    if (this.#owners >= this.#maxOwners) return undefined;
    this.#owners += 1;
    this.#provisionalOwners += 1;
    this.#peakOwners = Math.max(this.#peakOwners, this.#owners);
    return new OwnerReservation(this);
  }

  transition(from: OwnerState, to: OwnerState): void {
    if (from === to || from === "released") return;
    this.#decrement(from);
    if (to === "released") this.#owners -= 1;
    else this.#increment(to);
  }

  snapshot(input: NativeInputSnapshot): NativeFactorySnapshot {
    return {
      owners: this.#owners,
      provisionalOwners: this.#provisionalOwners,
      rollbackPendingOwners: this.#rollbackPendingOwners,
      activeOwners: this.#activeOwners,
      tombstones: this.#tombstones,
      peakOwners: this.#peakOwners,
      maxOwners: this.#maxOwners,
      aggregateInput: input,
    };
  }

  #decrement(state: OwnerState): void {
    if (state === "provisional") this.#provisionalOwners -= 1;
    else if (state === "rollback-pending") this.#rollbackPendingOwners -= 1;
    else if (state === "active") this.#activeOwners -= 1;
    else if (state === "tombstone") this.#tombstones -= 1;
  }

  #increment(state: OwnerState): void {
    if (state === "provisional") this.#provisionalOwners += 1;
    else if (state === "rollback-pending") this.#rollbackPendingOwners += 1;
    else if (state === "active") this.#activeOwners += 1;
    else if (state === "tombstone") this.#tombstones += 1;
  }
}

class OwnerReservation {
  readonly #ledger: OwnerLedger;
  #state: OwnerState = "provisional";
  #writerClosed = false;
  #childExited = false;

  constructor(ledger: OwnerLedger) {
    this.#ledger = ledger;
  }

  markRollbackPending(): void {
    this.#move("rollback-pending");
  }

  markCommitted(): void {
    this.#move("active");
  }

  markWriterClosed(): void {
    if (this.#state !== "active") return;
    this.#writerClosed = true;
    this.#releaseSuccessfulOwnerIfComplete();
  }

  markChildExited(): void {
    if (this.#state !== "active") return;
    this.#childExited = true;
    this.#releaseSuccessfulOwnerIfComplete();
  }

  releaseConfirmedClean(): void {
    if (this.#state !== "rollback-pending") return;
    this.#move("released");
  }

  tombstone(): void {
    if (this.#state === "released" || this.#state === "tombstone") return;
    this.#move("tombstone");
  }

  #releaseSuccessfulOwnerIfComplete(): void {
    if (this.#writerClosed && this.#childExited) this.#move("released");
  }

  #move(next: OwnerState): void {
    if (this.#state === next || this.#state === "released") return;
    const previous = this.#state;
    this.#state = next;
    this.#ledger.transition(previous, next);
  }
}

interface ValidLimits {
  readonly maxOwners: number;
  readonly aggregateInputBytes: number;
  readonly aggregateInputTasks: number;
  readonly perPtyInputBytes: number;
  readonly perPtyInputTasks: number;
  readonly earlyOutputBytes: number;
}

interface ValidSpawnSpec {
  readonly file: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly cols: number;
  readonly rows: number;
  readonly inputBytes: number;
  readonly inputTasks: number;
  readonly observer: NativeObserver;
  readonly reserveRetainedBytes?: NativeSpawnSpec["reserveRetainedBytes"];
}

interface BoundedPty extends IPty {
  writeBounded: NativeBoundedWriter["writeBounded"];
  disposeBoundedWrite: NativeBoundedWriter["disposeBoundedWrite"];
  readonly boundedWriteCompletion: Promise<IBoundedWriteOwnerResult>;
  signalOwned: (signal: OwnedSignal, scope: OwnedSignalScope) => OwnedSignalResult;
}

type EarlyEvent =
  | { readonly kind: "data"; readonly bytes: Buffer; readonly lease?: RetainedBytesLease }
  | { readonly kind: "exit"; readonly exit: NativeExit };

class NativePtyAdapterImpl implements NativePtyAdapter {
  readonly #terminal: BoundedPty;
  readonly #observer: NativeObserver;
  readonly #reservation: OwnerReservation;
  readonly #input: PtyInputController;
  readonly #earlyOutputLimit: number;
  readonly #reserveRetainedBytes: NativeSpawnSpec["reserveRetainedBytes"];
  readonly #earlyEvents: EarlyEvent[] = [];
  #dataListener: IDisposable | undefined;
  #exitListener: IDisposable | undefined;
  #constructing = true;
  #earlyOutputBytes = 0;
  #outputFailed = false;
  #exited: NativeExit | undefined;
  #writerState: NativePtyAdapterSnapshot["writer"] = "pending";
  #paused = false;
  #stopAfterActivation = false;
  #stopPromise: Promise<NativeStopResult> | undefined;
  #resolveStop: ((result: NativeStopResult) => void) | undefined;
  #stopSettled = false;
  #graceTimer: ReturnType<typeof setTimeout> | undefined;
  #finalTimer: ReturnType<typeof setTimeout> | undefined;
  #stopDeadline = 0;
  #stopFailure: { phase: "graceful" | "force"; cause: unknown } | undefined;
  #groupGraceful: NativeStopAttempt = { kind: "not-attempted", reason: "already-exited" };
  #leaderGraceful: NativeStopAttempt = { kind: "not-attempted", reason: "already-exited" };
  #groupForce: NativeStopAttempt = { kind: "not-attempted", reason: "deadline-not-reached" };

  readonly pid: number;
  readonly writerCompletion: Promise<IBoundedWriteOwnerResult>;

  constructor(
    terminal: BoundedPty,
    observer: NativeObserver,
    reservation: OwnerReservation,
    sharedBudget: SharedNativeInputBudget,
    inputBytes: number,
    inputTasks: number,
    earlyOutputLimit: number,
    reserveRetainedBytes?: NativeSpawnSpec["reserveRetainedBytes"],
  ) {
    this.#terminal = terminal;
    this.#observer = observer;
    this.#reservation = reservation;
    this.#earlyOutputLimit = earlyOutputLimit;
    this.#reserveRetainedBytes = reserveRetainedBytes;
    this.pid = terminal.pid;
    this.writerCompletion = Promise.prototype.then.call(
      terminal.boundedWriteCompletion,
      (result: IBoundedWriteOwnerResult): IBoundedWriteOwnerResult => {
        try {
          if (result.kind === "closed") return { kind: "closed" };
          if (result.kind === "close-uncertain")
            return {
              kind: "close-uncertain",
              error: boundedText(result.error, 128) ?? "unavailable",
            };
        } catch {
          // A malformed completion never proves writer closure.
        }
        return { kind: "close-uncertain", error: "invalid writer completion" };
      },
      (): IBoundedWriteOwnerResult => ({
        kind: "close-uncertain",
        error: "writer completion rejected",
      }),
    ) as Promise<IBoundedWriteOwnerResult>;
    this.#input = new PtyInputController({
      writer: terminal,
      sharedBudget,
      maxBytes: inputBytes,
      maxTasks: inputTasks,
      onFault: (fault) => this.#reportInputFault(fault),
      ...(reserveRetainedBytes && {
        reserveRetainedBytes: (bytes: number) => reserveRetainedBytes("native-input", bytes),
      }),
    });

    // Listener registration can synchronously invoke a controlled public seam.
    // Buffering only this construction window closes the early-data gap without
    // introducing a second steady-state output queue.
    try {
      const dataListener = this.#listenForData((value) => this.#onData(value));
      if (!isDisposable(dataListener)) throw new Error("Invalid data listener receipt");
      this.#dataListener = dataListener;
      const exitListener = terminal.onExit((exit) => this.#onExit(exit));
      if (!isDisposable(exitListener)) throw new Error("Invalid exit listener receipt");
      this.#exitListener = exitListener;
      void Promise.prototype.then.call(
        this.writerCompletion,
        (result) => {
          try {
            this.#onWriterCompletion(result);
          } catch (error) {
            this.#onInvalidWriterCompletion(error);
          }
        },
        (error) => this.#onInvalidWriterCompletion(error),
      );
    } catch (error) {
      for (const event of this.#earlyEvents) if (event.kind === "data") event.lease?.release();
      this.#earlyEvents.length = 0;
      this.#disposeListeners();
      throw error;
    }
  }

  activate(): void {
    let preserveBufferedData = this.#outputFailed;
    this.#constructing = false;
    for (const event of this.#earlyEvents.splice(0)) {
      if (event.kind === "data") {
        try {
          if (!this.#deliverData(event.bytes, preserveBufferedData)) preserveBufferedData = false;
        } finally {
          event.lease?.release();
        }
      } else this.#deliverExit(event.exit);
    }
    this.#earlyOutputBytes = 0;
    if (this.#stopAfterActivation) void this.stop();
  }

  submit(
    bytes: Uint8Array,
    onSettled: (result: NativeInputSettlement) => void,
  ): NativeInputAdmission {
    return this.#input.submit(bytes, "user", onSettled);
  }

  automaticOutputSink(event: {
    readonly atSeq: number;
    readonly kind: "query" | "focus";
    readonly bytes: Uint8Array;
  }): void {
    let admission: NativeInputAdmission;
    try {
      const { atSeq, kind, bytes } = event;
      if (
        typeof event !== "object" ||
        event === null ||
        !Number.isSafeInteger(atSeq) ||
        atSeq < 0 ||
        (kind !== "query" && kind !== "focus") ||
        !(bytes instanceof Uint8Array)
      ) {
        throw new TypeError("Invalid automatic output event");
      }
      admission = this.#input.submit(bytes, kind, () => {});
    } catch (error) {
      admission = {
        kind: "unknown",
        reason: "native-admission-invalid",
        byteLength: 0,
        cause: error,
      };
    }
    if (admission.kind === "accepted") return;
    this.#reportFault({
      kind: "automatic-output",
      reason: admission.kind === "rejected" ? "rejected" : "unknown",
      admission,
    });
    this.#input.retire();
  }

  resize(cols: number, rows: number): void {
    validateGeometry(cols, rows);
    if (this.#exited) return;
    try {
      this.#terminal.resize(cols, rows);
    } catch (error) {
      this.#reportFault({ kind: "io", reason: "resize-failed", cause: error });
    }
  }

  pause(): void {
    if (this.#paused || this.#exited) return;
    try {
      this.#terminal.pause();
      this.#paused = true;
    } catch (error) {
      this.#reportFault({ kind: "io", reason: "pause-failed", cause: error });
    }
  }

  resume(): void {
    if (!this.#paused || this.#exited || this.#outputFailed) return;
    try {
      this.#terminal.resume();
      this.#paused = false;
    } catch (error) {
      this.#reportFault({ kind: "io", reason: "resume-failed", cause: error });
    }
  }

  retireInput(): void {
    this.#input.retire();
  }

  stop(): Promise<NativeStopResult> {
    if (this.#stopPromise) return this.#stopPromise;
    let resolveStop!: (result: NativeStopResult) => void;
    const promise = new Promise<NativeStopResult>((resolve) => {
      resolveStop = resolve;
    });
    // Publish the one receipt before retirement or a public seam can reenter.
    this.#stopPromise = promise;
    this.#resolveStop = resolveStop;
    if (this.#exited) {
      this.#settleStop();
      return promise;
    }
    this.#stopDeadline = performance.now() + 3_000;
    this.#input.retire();
    if (this.#stopSettled) return promise;
    this.#groupGraceful = this.#attemptSignal("SIGHUP", "initial-process-group", "graceful");
    if (!this.#stopSettled) {
      this.#leaderGraceful = this.#attemptSignal("SIGHUP", "leader", "graceful");
    }
    if (this.#stopSettled) return promise;
    this.#graceTimer = setTimeout(() => {
      if (this.#stopSettled) return;
      if (performance.now() >= this.#stopDeadline) {
        this.#settleStop();
        return;
      }
      this.#groupForce =
        this.#groupGraceful.kind === "already-reaped"
          ? { kind: "not-attempted", reason: "already-reaped" }
          : this.#attemptSignal("SIGKILL", "initial-process-group", "force");
      if (
        !this.#stopSettled &&
        performance.now() < this.#stopDeadline &&
        this.#leaderGraceful.kind !== "already-reaped"
      ) {
        this.#attemptSignal("SIGKILL", "leader", "force");
      }
    }, 2_000);
    this.#finalTimer = setTimeout(() => this.#settleStop(), 3_000);
    return promise;
  }

  #attemptSignal(
    signal: OwnedSignal,
    scope: OwnedSignalScope,
    phase: "graceful" | "force",
  ): NativeStopAttempt {
    if (this.#exited || this.#stopSettled)
      return { kind: "not-attempted", reason: "already-exited" };
    try {
      const result = this.#terminal.signalOwned(signal, scope);
      if (
        result.kind !== "signaled" &&
        result.kind !== "already-reaped" &&
        result.kind !== "unverifiable"
      ) {
        throw new Error("Invalid owned signal result");
      }
      if (result.kind === "unverifiable") this.#recordSignalFailure(phase, result);
      return boundedStopAttempt(result);
    } catch (error) {
      this.#recordSignalFailure(phase, error);
      return { kind: "not-attempted", reason: "capability-fault" };
    }
  }

  #recordSignalFailure(phase: "graceful" | "force", cause: unknown): void {
    this.#stopFailure ??= { phase, cause: boundedNativeCause(cause) };
    this.#reportFault({ kind: "io", reason: "owned-stop-failed", cause });
  }

  #settleStop(): void {
    if (this.#stopSettled) return;
    this.#stopSettled = true;
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    if (this.#finalTimer) clearTimeout(this.#finalTimer);
    const cleanup: NativeStopCleanup = {
      scope: "initial-process-group",
      verified: false,
      graceful: this.#groupGraceful,
      force: this.#groupForce,
    };
    const signalFailure = this.#stopFailure;
    this.#resolveStop?.(
      boundedNativeStopResult(
        this.#exited
          ? { kind: "exited", exit: this.#exited, cleanup, ...(signalFailure && { signalFailure }) }
          : {
              kind: "unverifiable",
              cause:
                signalFailure?.cause ??
                boundedNativeCause("Owned PTY leader exit was not observed"),
              cleanup,
              ...(signalFailure && { signalFailure }),
            },
      ),
    );
    this.#resolveStop = undefined;
  }

  snapshot(): NativePtyAdapterSnapshot {
    return {
      pid: this.pid,
      exited: this.#exited !== undefined,
      writer: this.#writerState,
      input: this.#input.snapshot(),
      earlyOutputBytes: this.#earlyOutputBytes,
      paused: this.#paused,
    };
  }

  #listenForData(listener: (value: unknown) => void): IDisposable {
    const onData = this.#terminal.onData as unknown as (
      listener: (value: unknown) => void,
    ) => IDisposable;
    return onData(listener);
  }

  #onData(value: unknown): void {
    if (this.#exited || this.#outputFailed) return;
    if (!Buffer.isBuffer(value)) {
      this.#failOutput("non-buffer-data", new Error("Native PTY emitted decoded data"));
      return;
    }
    if (value.byteLength === 0) return;
    if (this.#constructing) {
      if (value.byteLength > this.#earlyOutputLimit - this.#earlyOutputBytes) {
        this.#failOutput(
          "early-output-limit",
          new Error("Native PTY exceeded its early output byte budget"),
        );
        return;
      }
      const lease = this.#reserveRetainedBytes?.("native-output", value.byteLength + 64);
      if (this.#reserveRetainedBytes && !lease) {
        this.#failOutput(
          "early-output-worker-limit",
          new Error("Early output exceeded worker capacity"),
        );
        return;
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(value);
      } catch (error) {
        lease?.release();
        this.#failOutput("early-output-copy-failed", error);
        return;
      }
      this.#earlyOutputBytes += bytes.byteLength;
      this.#earlyEvents.push({ kind: "data", bytes, ...(lease && { lease }) });
      return;
    }
    this.#deliverData(value);
  }

  #onExit(value: unknown): void {
    if (this.#exited) return;
    let normalized: NativeExit | undefined;
    try {
      normalized = normalizeExit(value);
    } catch (error) {
      this.#invalidateExit(error);
      return;
    }
    if (!normalized) {
      this.#invalidateExit(new Error("Native PTY emitted an invalid exit event"));
      return;
    }
    this.#exited = normalized;
    this.#input.retire();
    this.#reservation.markChildExited();
    if (this.#stopPromise) queueMicrotask(() => this.#settleStop());
    if (this.#constructing) this.#earlyEvents.push({ kind: "exit", exit: normalized });
    else this.#deliverExit(normalized);
  }

  #onWriterCompletion(result: IBoundedWriteOwnerResult): void {
    this.#input.markWriterClosed();
    if (result.kind === "closed") {
      this.#writerState = "closed";
      this.#reservation.markWriterClosed();
      return;
    }
    if (result.kind === "close-uncertain" && typeof result.error === "string") {
      this.#writerState = "close-uncertain";
      this.#reservation.tombstone();
      this.#reportFault({
        kind: "binding",
        reason: "writer-close-uncertain",
        cause: new Error(result.error),
      });
      return;
    }
    this.#onInvalidWriterCompletion(result);
  }

  #onInvalidWriterCompletion(cause: unknown): void {
    this.#writerState = "invalid";
    this.#reservation.tombstone();
    this.#input.retire();
    this.#reportFault({ kind: "binding", reason: "writer-completion-invalid", cause });
  }

  #deliverData(bytes: Buffer, bufferedBeforeFailure = false): boolean {
    if (this.#outputFailed && !bufferedBeforeFailure) return false;
    try {
      this.#observer.onData(bytes);
      return true;
    } catch (error) {
      this.#failOutput("data-observer-threw", error);
      return false;
    }
  }

  #deliverExit(exit: NativeExit): void {
    try {
      this.#observer.onExit(exit);
    } catch (error) {
      this.#reportFault({ kind: "observer", reason: "exit-observer-threw", cause: error });
    } finally {
      this.#disposeListeners();
    }
  }

  #invalidateExit(cause: unknown): void {
    this.#reservation.tombstone();
    this.#input.retire();
    this.#reportFault({ kind: "binding", reason: "exit-event-invalid", cause });
    if (this.#constructing) this.#stopAfterActivation = true;
    else void this.stop();
  }

  #disposeListeners(): void {
    for (const listener of [this.#dataListener, this.#exitListener]) {
      try {
        listener?.dispose();
      } catch (error) {
        this.#reportFault({ kind: "binding", reason: "listener-dispose-failed", cause: error });
      }
    }
    this.#dataListener = undefined;
    this.#exitListener = undefined;
  }

  #failOutput(reason: string, cause: unknown): void {
    if (this.#outputFailed) return;
    this.#outputFailed = true;
    this.#input.retire();
    try {
      this.#terminal.pause();
      this.#paused = true;
    } catch (pauseError) {
      this.#reportFault({
        kind: "io",
        reason: "pause-after-output-fault-failed",
        cause: pauseError,
      });
    }
    this.#reportFault({ kind: "output", reason, cause });
    if (this.#constructing) this.#stopAfterActivation = true;
    else void this.stop();
  }

  #reportInputFault(fault: NativeInputFault): void {
    this.#reportFault({
      kind: "input",
      reason: fault.reason,
      ...(fault.cause === undefined ? {} : { cause: fault.cause }),
    });
  }

  #reportFault(fault: NativePtyFault): void {
    try {
      this.#observer.onFault(fault);
    } catch {
      // A diagnostic observer cannot corrupt native resource accounting.
    }
  }
}

class NativePtyFactoryImpl implements NativePtyFactory {
  readonly retainedBytesAccounting = "participating" as const;
  readonly #limits: ValidLimits;
  readonly #owners: OwnerLedger;
  readonly #input: SharedNativeInputBudget;

  constructor(limits: ValidLimits) {
    this.#limits = limits;
    this.#owners = new OwnerLedger(limits.maxOwners);
    this.#input = new SharedNativeInputBudget(
      limits.aggregateInputBytes,
      limits.aggregateInputTasks,
    );
  }

  spawn(spec: NativeSpawnSpec, observer: NativeObserver): NativeSpawnResult {
    let validSpec: ValidSpawnSpec | undefined;
    try {
      validSpec = validateSpawnSpec(spec, observer, this.#limits);
    } catch {
      return { kind: "rejected", reason: "invalid-spec" };
    }
    if (!validSpec) return { kind: "rejected", reason: "invalid-spec" };

    try {
      const rejection = classifySupport(pty.checkBoundedPtySupport());
      if (rejection) return { kind: "rejected", reason: rejection };
    } catch {
      return { kind: "rejected", reason: "preflight-failed" };
    }

    const reservation = this.#owners.reserve();
    if (!reservation) return { kind: "rejected", reason: "owner-limit" };

    let terminal: IPty;
    try {
      terminal = pty.spawn(validSpec.file, validSpec.args, {
        cols: validSpec.cols,
        rows: validSpec.rows,
        cwd: validSpec.cwd,
        env: validSpec.env,
        encoding: null,
        handleFlowControl: false,
        boundedWrite: {
          maxAllocatedBytes: validSpec.inputBytes,
          maxTasks: validSpec.inputTasks,
        },
      });
    } catch (error) {
      try {
        if (
          error instanceof pty.BoundedPtySpawnError &&
          error.code === "COVE_BOUNDED_PTY_SPAWN_FAILED"
        ) {
          return this.#handleTypedSpawnFailure(error, reservation);
        }
      } catch (classificationError) {
        reservation.tombstone();
        return { kind: "unclassified-failure", cause: classificationError };
      }
      reservation.tombstone();
      return { kind: "unclassified-failure", cause: error };
    }

    let bounded: BoundedPty | undefined;
    try {
      bounded = narrowBoundedPty(terminal);
    } catch (error) {
      reservation.tombstone();
      attemptPublicCleanup(terminal);
      reportObserverFault(validSpec.observer, {
        kind: "binding",
        reason: "bounded-pty-shape-inspection-failed",
        cause: error,
      });
      return { kind: "unclassified-failure", cause: error };
    }
    if (!bounded) {
      reservation.tombstone();
      attemptPublicCleanup(terminal);
      reportObserverFault(validSpec.observer, {
        kind: "binding",
        reason: "bounded-pty-shape-invalid",
      });
      return {
        kind: "unclassified-failure",
        cause: new Error("Spawn returned an invalid bounded PTY public shape"),
      };
    }

    reservation.markCommitted();
    try {
      const adapter = new NativePtyAdapterImpl(
        bounded,
        validSpec.observer,
        reservation,
        this.#input,
        validSpec.inputBytes,
        validSpec.inputTasks,
        this.#limits.earlyOutputBytes,
        validSpec.reserveRetainedBytes,
      );
      adapter.activate();
      return { kind: "created", pty: adapter };
    } catch (error) {
      reservation.tombstone();
      attemptPublicCleanup(bounded);
      reportObserverFault(validSpec.observer, {
        kind: "binding",
        reason: "adapter-listener-install-failed",
        cause: error,
      });
      return { kind: "unclassified-failure", cause: error };
    }
  }

  snapshot(): NativeFactorySnapshot {
    return this.#owners.snapshot(this.#input.snapshot());
  }

  #handleTypedSpawnFailure(
    error: pty.BoundedPtySpawnError,
    reservation: OwnerReservation,
  ): NativeSpawnResult {
    reservation.markRollbackPending();
    let cleanup: Promise<BoundedPtyCleanupResult>;
    let cause: unknown;
    try {
      cleanup = error.cleanup;
      cause = error.cause;
      if (!(cleanup instanceof Promise)) throw new Error("Invalid cleanup promise");
    } catch (receiptError) {
      reservation.tombstone();
      return { kind: "unclassified-failure", cause: receiptError };
    }

    try {
      void Promise.prototype.then.call(
        cleanup,
        (result): void => {
          try {
            if (
              typeof result === "object" &&
              result !== null &&
              Reflect.get(result, "kind") === "confirmed-clean"
            ) {
              reservation.releaseConfirmedClean();
            } else {
              reservation.tombstone();
            }
          } catch {
            reservation.tombstone();
          }
        },
        (): void => reservation.tombstone(),
      );
    } catch (subscriptionError) {
      reservation.tombstone();
      return { kind: "unclassified-failure", cause: subscriptionError };
    }
    // Preserve the exact dependency receipt for callers. Factory accounting has
    // already subscribed, so callers cannot delay or replace its observation.
    return { kind: "failed", cause, cleanup };
  }
}

function validateLimits(limits: NativeFactoryLimits): ValidLimits {
  if (typeof limits !== "object" || limits === null) throw new TypeError("Invalid limits");
  const {
    maxOwners,
    aggregateInputBytes,
    aggregateInputTasks,
    perPtyInputBytes: requestedPtyBytes,
    perPtyInputTasks: requestedPtyTasks,
    earlyOutputBytes,
  } = limits;
  validatePositiveInteger(maxOwners, MAX_OWNERS, "maxOwners");
  validatePositiveInteger(aggregateInputBytes, MAX_FACTORY_INPUT_BYTES, "aggregateInputBytes");
  validatePositiveInteger(aggregateInputTasks, MAX_FACTORY_INPUT_TASKS, "aggregateInputTasks");
  validatePositiveInteger(earlyOutputBytes, MAX_EARLY_OUTPUT_BYTES, "earlyOutputBytes");
  const perPtyInputBytes = requestedPtyBytes ?? Math.min(MAX_PTY_INPUT_BYTES, aggregateInputBytes);
  const perPtyInputTasks = requestedPtyTasks ?? Math.min(MAX_PTY_INPUT_TASKS, aggregateInputTasks);
  validatePositiveInteger(perPtyInputBytes, MAX_PTY_INPUT_BYTES, "perPtyInputBytes");
  validatePositiveInteger(perPtyInputTasks, MAX_PTY_INPUT_TASKS, "perPtyInputTasks");
  if (perPtyInputBytes > aggregateInputBytes) {
    throw new RangeError("perPtyInputBytes exceeds aggregateInputBytes");
  }
  if (perPtyInputTasks > aggregateInputTasks) {
    throw new RangeError("perPtyInputTasks exceeds aggregateInputTasks");
  }
  return {
    maxOwners,
    aggregateInputBytes,
    aggregateInputTasks,
    perPtyInputBytes,
    perPtyInputTasks,
    earlyOutputBytes,
  };
}

function validatePositiveInteger(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(name + " must be a positive safe integer no greater than " + maximum);
  }
}

function validateSpawnSpec(
  spec: NativeSpawnSpec,
  observer: NativeObserver,
  limits: ValidLimits,
): ValidSpawnSpec | undefined {
  if (typeof spec !== "object" || spec === null) return undefined;
  const {
    file,
    args,
    cwd,
    env,
    cols,
    rows,
    inputBytes: requestedBytes,
    inputTasks: requestedTasks,
    reserveRetainedBytes,
  } = spec;
  if (typeof file !== "string" || file.length === 0) return undefined;
  if (reserveRetainedBytes !== undefined && typeof reserveRetainedBytes !== "function")
    return undefined;
  if (!Array.isArray(args)) {
    return undefined;
  }
  const copiedArgs = [...args];
  if (copiedArgs.some((arg) => typeof arg !== "string")) return undefined;
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return undefined;
  }
  const envEntries = Object.entries(env);
  for (const [key, value] of envEntries) {
    if (key.length === 0 || (typeof value !== "string" && value !== undefined)) return undefined;
  }
  if (!validGeometry(cols, rows)) return undefined;
  if (typeof observer !== "object" || observer === null) {
    return undefined;
  }
  const { onData, onExit, onFault } = observer;
  if (
    typeof onData !== "function" ||
    typeof onExit !== "function" ||
    typeof onFault !== "function"
  ) {
    return undefined;
  }
  const inputBytes = requestedBytes ?? limits.perPtyInputBytes;
  const inputTasks = requestedTasks ?? limits.perPtyInputTasks;
  if (
    !Number.isSafeInteger(inputBytes) ||
    inputBytes <= 0 ||
    inputBytes > limits.perPtyInputBytes ||
    inputBytes > limits.aggregateInputBytes ||
    !Number.isSafeInteger(inputTasks) ||
    inputTasks <= 0 ||
    inputTasks > limits.perPtyInputTasks ||
    inputTasks > limits.aggregateInputTasks
  ) {
    return undefined;
  }
  // Snapshot caller-owned inputs before entering native code. Accessors or later
  // mutation cannot change which executable, budget, or observer this reserved
  // owner is associated with after validation succeeds.
  return {
    file,
    args: copiedArgs,
    cwd,
    env: Object.fromEntries(envEntries),
    cols,
    rows,
    inputBytes,
    inputTasks,
    ...(reserveRetainedBytes && { reserveRetainedBytes }),
    observer: {
      onData: (bytes) => Reflect.apply(onData, observer, [bytes]),
      onExit: (exit) => Reflect.apply(onExit, observer, [exit]),
      onFault: (fault) => Reflect.apply(onFault, observer, [fault]),
    },
  };
}

function classifySupport(value: unknown): NativeSpawnRejectionReason | undefined {
  if (typeof value !== "object" || value === null) return "preflight-failed";
  const supported = Reflect.get(value, "supported");
  if (supported === true) {
    return Reflect.get(value, "contractVersion") === 3 ? undefined : "binding-mismatch";
  }
  if (supported !== false) return "preflight-failed";
  const reason = Reflect.get(value, "reason");
  return reason === "unsupported-platform" ||
    reason === "binding-unavailable" ||
    reason === "binding-mismatch"
    ? reason
    : "preflight-failed";
}

function validGeometry(cols: number, rows: number): boolean {
  return (
    Number.isSafeInteger(cols) &&
    cols >= 2 &&
    cols <= 120 &&
    Number.isSafeInteger(rows) &&
    rows >= 2 &&
    rows <= 40
  );
}

function normalizeExit(value: unknown): NativeExit | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const exitCode = Reflect.get(value, "exitCode");
  const signal = Reflect.get(value, "signal");
  if (!Number.isSafeInteger(exitCode)) return undefined;
  if (signal !== undefined && !Number.isSafeInteger(signal)) return undefined;
  return {
    exitCode: Number(exitCode),
    ...(signal === undefined ? {} : { signal: Number(signal) }),
  };
}

function validateGeometry(cols: number, rows: number): void {
  if (!validGeometry(cols, rows)) {
    throw new RangeError("PTY geometry must be within 2..120 columns and 2..40 rows");
  }
}

function narrowBoundedPty(terminal: IPty): BoundedPty | undefined {
  const candidate = terminal as Partial<BoundedPty>;
  if (
    !Number.isSafeInteger(candidate.pid) ||
    Number(candidate.pid) <= 0 ||
    typeof candidate.onData !== "function" ||
    typeof candidate.onExit !== "function" ||
    typeof candidate.writeBounded !== "function" ||
    typeof candidate.disposeBoundedWrite !== "function" ||
    typeof candidate.resize !== "function" ||
    typeof candidate.pause !== "function" ||
    typeof candidate.resume !== "function" ||
    typeof candidate.signalOwned !== "function" ||
    !isPromise(candidate.boundedWriteCompletion)
  ) {
    return undefined;
  }
  return candidate as BoundedPty;
}

function isPromise(value: unknown): value is Promise<IBoundedWriteOwnerResult> {
  return value instanceof Promise;
}

function isDisposable(value: unknown): value is IDisposable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "dispose") === "function"
  );
}

function attemptPublicCleanup(terminal: Partial<IPty>): void {
  try {
    terminal.disposeBoundedWrite?.();
  } catch {
    // The owner is already retained as a tombstone; this is best-effort cleanup.
  }
  try {
    terminal.signalOwned?.("SIGHUP", "leader");
  } catch {
    // No public completion is available here, so failure cannot release capacity.
  }
}

function reportObserverFault(observer: NativeObserver, fault: NativePtyFault): void {
  try {
    observer.onFault(fault);
  } catch {
    // A diagnostic observer cannot alter owner accounting.
  }
}

export function createNativePtyFactory(limits: NativeFactoryLimits): NativePtyFactory {
  return new NativePtyFactoryImpl(validateLimits(limits));
}
