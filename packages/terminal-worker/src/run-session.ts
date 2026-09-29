import {
  createTerminalModel,
  type EngineResult,
  type EngineState,
  type EngineBaselineResult,
  type EnginePreviewResult,
  type TerminalModel,
  type RetainedBytesLease,
  type RetainedBytesReservation,
} from "@cove/terminal-engine";
import { M0_LIMITS, type EffectiveBudgets } from "@cove/protocol/budgets";
import {
  nextCounter,
  sameRunRef,
  type RunRef,
  type SubscriptionRef,
} from "@cove/protocol/identity";
import type { Appearance, Geometry } from "@cove/protocol/profile";
import type { RunEvent } from "@cove/protocol/terminal";
import type { IBoundedWriteOwnerResult } from "node-pty";
import type {
  NativeExit,
  NativePtyAdapter,
  NativePtyFactory,
  NativePtyFault,
  NativeSpawnResult,
  NativeSpawnSpec,
  NativeStopResult,
} from "./native-pty.js";
import { boundedNativeCause, boundedNativeStopResult } from "./native-pty.js";

const OUTPUT_CHUNK_BYTES = 65_536;
const INGRESS_RECORD_BYTES = 64;
const PENDING_WRITER: RunSessionWriterObservation = Object.freeze({ kind: "pending-at-deadline" });
const PENDING_STOP: RunSessionStopObservation = Object.freeze({ kind: "pending-at-deadline" });

type Fact = { readonly event: RunEvent; readonly bytes?: Buffer };
type Pending =
  | { readonly kind: "fact"; readonly fact: Fact; readonly retireIngress: () => void }
  | { readonly kind: "unpublished"; readonly bytes: Buffer; readonly retireIngress: () => void }
  | { readonly kind: "deferred-output"; readonly bytes: Buffer; readonly retireIngress: () => void }
  | {
      readonly kind: "deferred-exit";
      readonly exit: NativeExit;
      readonly retireIngress: () => void;
    }
  | { readonly kind: "barrier"; readonly resolve: (result: EngineResult<EngineState>) => void }
  | {
      readonly kind: "baseline";
      readonly reserveDetached?: (bytes: number) => boolean;
      readonly resolve: (result: EngineBaselineResult) => void;
    }
  | { readonly kind: "preview"; readonly resolve: (result: EnginePreviewResult) => void }
  | {
      readonly kind: "operation";
      readonly operation: RunSessionOperation;
      readonly resolve: (result: RunSessionOperationResult) => void;
    };

type ControlHolder = Extract<RunEvent, { type: "control" }>["holder"];
export type RunSessionOperation =
  | { readonly type: "status"; readonly cached?: boolean }
  | { readonly type: "stop" }
  | {
      readonly type: "control";
      readonly expectedEpoch: number;
      readonly nextEpoch: number;
      readonly holder: ControlHolder | null;
      readonly geometry: Geometry;
      readonly appearance?: Appearance;
    }
  | {
      readonly type: "resize";
      readonly subscription: SubscriptionRef;
      readonly epoch: number;
      readonly geometry: Geometry;
    }
  | {
      readonly type: "appearance";
      readonly subscription: SubscriptionRef;
      readonly epoch: number;
      readonly appearance: Appearance;
    }
  | {
      readonly type: "input";
      readonly subscription: SubscriptionRef;
      readonly epoch: number;
      readonly inputSeq: number;
      readonly bytes: Uint8Array;
      readonly beforeNativeInput?: () => boolean;
    };
export type RunSessionOperationResult =
  | { readonly kind: "stopped"; readonly receipt: RunSessionDisposalReceipt }
  | {
      readonly kind: "settled";
      readonly atSeq: number;
      readonly state: EngineState;
      readonly controlEpoch: number;
      readonly controlHolder: ControlHolder | null;
    }
  | { readonly kind: "written"; readonly writtenBytes: number; readonly atSeq: number }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

export interface WorkerRunSessionCapability {
  execute(operation: RunSessionOperation): Promise<RunSessionOperationResult>;
  captureBaseline(reserveDetached?: (bytes: number) => boolean): Promise<EngineBaselineResult>;
  capturePreview(): Promise<EnginePreviewResult>;
}

export interface RunSessionOptions {
  readonly run: RunRef;
  readonly geometry: Geometry;
  readonly appearance?: Appearance;
  readonly spawn: Omit<NativeSpawnSpec, "cols" | "rows">;
  readonly factory: NativePtyFactory;
  readonly onFact?: (fact: Fact) => void;
  readonly onRetainedFact?: (fact: Fact) => void;
  readonly onFault?: (fault: RunSessionFault) => void;
  readonly reserveIngressBytes?: RetainedBytesReservation;
  readonly reserveInputIdentity?: (subscription: SubscriptionRef) => boolean;
  readonly isSubscriptionInstalled?: (subscription: SubscriptionRef) => boolean;
  readonly reserveRetainedBytes?: RetainedBytesReservation;
  readonly availableRetainedBytes?: () => number;
  readonly reserveNativeRetainedBytes?: NativeSpawnSpec["reserveRetainedBytes"];
  readonly effectiveBudgets?: EffectiveBudgets;
}

export type RunSessionFault =
  | NativePtyFault
  | { readonly kind: "pump"; readonly reason: string }
  | { readonly kind: "consumer"; readonly reason: "parsed-fact-observer-failed" };

export type RunSessionWriterObservation =
  | { readonly kind: "pending-at-deadline" }
  | { readonly kind: "closed" }
  | { readonly kind: "close-uncertain"; readonly error: string }
  | { readonly kind: "invalid" };

export type RunSessionStopObservation =
  | { readonly kind: "pending-at-deadline" }
  | { readonly kind: "failed-to-observe" }
  | { readonly kind: "observed"; readonly result: NativeStopResult };

export type RunSessionLeaderObservation =
  { readonly kind: "not-observed" } | { readonly kind: "exit-observed"; readonly exit: NativeExit };

export type RunSessionOwnershipEvidence = "closure-proven" | "retained-uncertain" | "unresolved";

export interface RunSessionDisposalReceipt {
  readonly stop: RunSessionStopObservation;
  readonly leader: RunSessionLeaderObservation;
  readonly writer: RunSessionWriterObservation;
  readonly ownershipEvidence: RunSessionOwnershipEvidence;
}

export interface RunSessionSnapshot {
  readonly receivedSeq: number;
  readonly parsedSeq: number;
  readonly queuedBytes: number;
  readonly queuedItems: number;
  readonly peakQueuedBytes: number;
  readonly paused: boolean;
  readonly exited: boolean;
  readonly faulted: boolean;
  readonly counterExhausted: boolean;
  readonly epochCounterExhausted: boolean;
  readonly inputCounterExhausted: boolean;
  readonly currentInputCounterExhausted: boolean;
  readonly consumerFenced: boolean;
  readonly diagnosticFenced: boolean;
  readonly writer: RunSessionWriterObservation;
  readonly leader: RunSessionLeaderObservation;
  readonly stop: RunSessionStopObservation;
  readonly ownershipEvidence: RunSessionOwnershipEvidence;
  readonly disposed: boolean;
  readonly controlEpoch: number;
  readonly controlHolder: ControlHolder | null;
  readonly geometry: Geometry;
  readonly writableFenced: boolean;
  readonly settledState: EngineState;
}

export interface RunSession {
  barrier(): Promise<EngineResult<EngineState>>;
  snapshot(): RunSessionSnapshot;
  dispose(): Promise<RunSessionDisposalReceipt>;
}

export type RunSessionStart =
  | { readonly kind: "created"; readonly session: RunSession }
  | Exclude<NativeSpawnResult, { readonly kind: "created" }>;

function failure(reason: string): EngineResult<never> {
  return { ok: false, error: { code: "faulted", reason } };
}

const UNACCOUNTED_INGRESS_LEASE: RetainedBytesLease = Object.freeze({ release() {} });

function ingressRetirements(lease: RetainedBytesLease, count: number): Array<() => void> {
  let remaining = count;
  return Array.from({ length: count }, () => {
    let retired = false;
    return () => {
      if (retired) return;
      retired = true;
      if (--remaining === 0) lease.release();
    };
  });
}

function consumesThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  let then: unknown;
  try {
    then = (value as PromiseLike<unknown>).then;
  } catch {
    return true;
  }
  if (typeof then !== "function") return false;
  // Assimilation consumes rejection without awaiting a user callback in the parse turn.
  void new Promise<void>((resolve, reject) => {
    queueMicrotask(() => {
      try {
        then.call(value, () => resolve(), reject);
      } catch (error) {
        reject(error);
      }
    });
  }).catch(() => {});
  return true;
}

class RunSessionCore {
  readonly #run: RunRef;
  #model: TerminalModel | undefined;
  #onFact: ((fact: Fact) => void) | undefined;
  #onFault: RunSessionOptions["onFault"];
  #native: NativePtyAdapter | undefined;
  #pending: Pending[] = [];
  #queuedBytes = 0;
  #peakQueuedBytes = 0;
  #receivedSeq = 0;
  #parsedSeq = 0;
  #running = false;
  #scheduled = false;
  #paused = false;
  #exited = false;
  #exitApplied = false;
  #faulted = false;
  #counterExhausted = false;
  #epochCounterExhausted = false;
  #inputCounterExhausted = false;
  #disposed = false;
  #consumerFenced = false;
  #diagnosticFenced = false;
  #leaderExit: NativeExit | undefined;
  #writer: RunSessionWriterObservation = PENDING_WRITER;
  #stop: RunSessionStopObservation = PENDING_STOP;
  #stopStarted = false;
  #disposePromise: Promise<RunSessionDisposalReceipt> | undefined;
  #stopOperationPromise: Promise<RunSessionOperationResult> | undefined;
  #resolveDispose: ((receipt: RunSessionDisposalReceipt) => void) | undefined;
  #disposeTimer: ReturnType<typeof setTimeout> | undefined;
  #deferIngress = false;
  #writableFenced = false;
  #geometry: Geometry;
  #controlEpoch = 0;
  #controlHolder: ControlHolder | null = null;
  #inputSequences = new Map<string, number>();
  #lastState!: EngineState;
  readonly #reserveIngressBytes: RetainedBytesReservation;
  readonly #reserveInputIdentity: (subscription: SubscriptionRef) => boolean;
  readonly #isSubscriptionInstalled: (subscription: SubscriptionRef) => boolean;
  readonly #onRetainedFact: RunSessionOptions["onRetainedFact"];
  readonly #parseLowBytes: number;
  readonly #parseHighBytes: number;
  readonly #parseHardBytes: number;
  readonly #itemCap: number;
  readonly #itemHigh: number;
  readonly #itemLow: number;

  constructor(options: RunSessionOptions) {
    this.#run = options.run;
    this.#geometry = Object.freeze({ ...options.geometry });
    this.#onFact = options.onFact;
    this.#onRetainedFact = options.onRetainedFact;
    this.#onFault = options.onFault;
    this.#reserveIngressBytes = options.reserveIngressBytes ?? (() => UNACCOUNTED_INGRESS_LEASE);
    this.#reserveInputIdentity = options.reserveInputIdentity ?? (() => true);
    this.#isSubscriptionInstalled = options.isSubscriptionInstalled ?? (() => true);
    this.#parseLowBytes = options.effectiveBudgets?.parseLowBytes ?? M0_LIMITS.parseLowBytes;
    this.#parseHighBytes = options.effectiveBudgets?.parseHighBytes ?? M0_LIMITS.parseHighBytes;
    this.#parseHardBytes = options.effectiveBudgets?.parseHardBytes ?? M0_LIMITS.parseHardBytes;
    this.#itemCap = M0_LIMITS.pendingWorkerCommands;
    this.#itemHigh = Math.floor((this.#itemCap * 3) / 4);
    this.#itemLow = Math.floor(this.#itemCap / 4);
    this.#model = createTerminalModel({
      run: options.run,
      geometry: options.geometry,
      ...(options.appearance === undefined ? {} : { appearance: options.appearance }),
      ...(options.effectiveBudgets === undefined
        ? {}
        : { effectiveBudgets: options.effectiveBudgets }),
      ...(options.reserveRetainedBytes && { reserveRetainedBytes: options.reserveRetainedBytes }),
      ...(options.availableRetainedBytes && {
        availableRetainedBytes: options.availableRetainedBytes,
      }),
      onAutomaticOutput: (output) => {
        if (this.#disposed || this.#faulted) return;
        if (!this.#native || (output.atSeq === null && !this.#counterExhausted)) {
          this.#fault("Automatic output has no bound native writer");
          return;
        }
        // Query replies must enter the native FIFO before this parse settles.
        this.#native.automaticOutputSink({
          atSeq: output.atSeq ?? this.#receivedSeq,
          kind: output.kind,
          bytes: output.bytes,
        });
      },
    });
    this.#lastState = this.#model.currentState();
  }

  attach(native: NativePtyAdapter): void {
    if (this.#native) throw new Error("Run session already has an owned PTY");
    this.#native = native;
    this.#observeWriter(native);
    if (this.#faulted || this.#disposed) {
      this.#releasePending("Run session faulted before native attachment");
      this.#requestStop();
      return;
    }
    this.#pauseIfHigh();
    this.#schedule();
  }

  onData(bytes: Buffer): void {
    if (this.#disposed || this.#faulted || this.#exited) return;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      this.#fault("Native output callback was not a nonempty Buffer");
      return;
    }
    const chunks = Math.ceil(bytes.length / OUTPUT_CHUNK_BYTES);
    if (
      bytes.length > this.#parseHardBytes - this.#queuedBytes ||
      chunks > this.#itemCap - this.#pending.length - Number(this.#running)
    ) {
      this.#fault("Native output exceeded the bounded parse queue");
      return;
    }
    const lease = this.#reserveIngressBytes(bytes.length + chunks * INGRESS_RECORD_BYTES);
    if (!lease) {
      this.#fault("Native output exceeded the worker byte budget");
      return;
    }
    const pendingBefore = this.#pending.length;
    try {
      const retirements = ingressRetirements(lease, chunks);
      const prepared: Pending[] = [];
      let receivedSeq = this.#receivedSeq;
      let exhausted = false;
      for (let index = 0; index < chunks; index++) {
        // Copy all chunks before publication; a failed copy cannot publish a valid prefix.
        const offset = index * OUTPUT_CHUNK_BYTES;
        const owned = Buffer.from(bytes.subarray(offset, offset + OUTPUT_CHUNK_BYTES));
        const retireIngress = retirements[index]!;
        if (this.#deferIngress)
          prepared.push({ kind: "deferred-output", bytes: owned, retireIngress });
        else if (receivedSeq === Number.MAX_SAFE_INTEGER) {
          exhausted = true;
          prepared.push({ kind: "unpublished", bytes: owned, retireIngress });
        } else {
          const event: RunEvent = { type: "output", run: this.#run, seq: ++receivedSeq };
          prepared.push({ kind: "fact", fact: { event, bytes: owned }, retireIngress });
        }
      }
      this.#pending.push(...prepared);
      this.#receivedSeq = receivedSeq;
      if (exhausted) this.#counterExhausted = true;
      this.#queuedBytes += bytes.length;
    } catch {
      this.#pending.splice(pendingBefore);
      lease.release();
      this.#fault("Native output copy or enqueue failed");
      return;
    }
    this.#peakQueuedBytes = Math.max(this.#peakQueuedBytes, this.#queuedBytes);
    this.#pauseIfHigh();
    this.#schedule();
  }

  onExit(exit: NativeExit): void {
    if (this.#exited) return;
    let normalized: NativeExit;
    try {
      const exitCode = exit.exitCode;
      const signal = exit.signal;
      if (
        !Number.isSafeInteger(exitCode) ||
        (signal !== undefined && !Number.isSafeInteger(signal))
      )
        throw new TypeError("Invalid native exit");
      normalized = Object.freeze({ exitCode, ...(signal === undefined ? {} : { signal }) });
    } catch {
      this.onFault({ kind: "binding", reason: "exit-event-invalid" });
      return;
    }
    this.#exited = true;
    this.#leaderExit = normalized;
    this.#settleDisposalIfComplete();
    if (this.#disposed) return;
    if (this.#faulted) return;
    if (this.#deferIngress) {
      const lease = this.#reserveIngressBytes(INGRESS_RECORD_BYTES);
      if (!lease) {
        this.#fault("Run exit exceeded worker retention capacity");
        return;
      }
      try {
        this.#pending.push({
          kind: "deferred-exit",
          exit: this.#leaderExit,
          retireIngress: () => lease.release(),
        });
      } catch {
        lease.release();
        this.#fault("Run exit could not enter the bounded parse queue");
        return;
      }
      this.#schedule();
      return;
    }
    if (this.#receivedSeq === Number.MAX_SAFE_INTEGER) {
      this.#counterExhausted = true;
      return;
    }
    if (this.#pending.length + Number(this.#running) >= this.#itemCap) {
      this.#fault("Run exit could not enter the bounded parse queue");
      return;
    }
    const lease = this.#reserveIngressBytes(INGRESS_RECORD_BYTES);
    if (!lease) {
      this.#fault("Run exit exceeded worker retention capacity");
      return;
    }
    const event: RunEvent = {
      type: "exit",
      run: this.#run,
      seq: this.#receivedSeq + 1,
      exitCode: exit.exitCode,
      signal: exit.signal === undefined ? null : String(exit.signal),
    };
    try {
      this.#pending.push({ kind: "fact", fact: { event }, retireIngress: () => lease.release() });
    } catch {
      lease.release();
      this.#fault("Run exit could not enter the bounded parse queue");
      return;
    }
    this.#receivedSeq = event.seq;
    this.#schedule();
  }

  onFault(fault: NativePtyFault): void {
    if (
      fault.kind === "input" ||
      fault.kind === "automatic-output" ||
      (fault.kind === "io" &&
        (fault.reason === "resize-failed" || fault.reason === "owned-stop-failed"))
    ) {
      this.#writableFenced = true;
      this.#reportFault(fault);
      return;
    }
    if (this.#faulted) return;
    this.#faulted = true;
    this.#requestStop();
    if (this.#disposed) return;
    // A fault can be raised synchronously by pause itself; retrying it recurses.
    try {
      this.#native?.retireInput();
    } catch {
      // The owned stop receipt remains observable after a retirement failure.
    }
    this.#reportFault(fault);
    this.#schedule();
  }

  barrier(): Promise<EngineResult<EngineState>> {
    if (this.#disposed) return Promise.resolve(failure("Run session disposed"));
    if (this.#faulted) return Promise.resolve(failure("Run session faulted"));
    if (this.#pending.length + Number(this.#running) >= this.#itemCap)
      return Promise.resolve(failure("Run service queue full"));
    return new Promise((resolve) => {
      this.#pending.push({ kind: "barrier", resolve });
      this.#pauseIfHigh();
      this.#schedule();
    });
  }

  captureBaseline(reserveDetached?: (bytes: number) => boolean): Promise<EngineBaselineResult> {
    if (this.#disposed)
      return Promise.resolve({ status: "disposed", reason: "Run session disposed" });
    if (this.#faulted) return Promise.resolve({ status: "faulted", reason: "Run session faulted" });
    if (this.#pending.length + Number(this.#running) >= this.#itemCap)
      return Promise.resolve({ status: "unavailable", reason: "Run service queue full" });
    return new Promise((resolve) => {
      this.#deferIngress = true;
      this.#pending.push({
        kind: "baseline",
        ...(reserveDetached && { reserveDetached }),
        resolve,
      });
      this.#pauseIfHigh();
      this.#schedule();
    });
  }

  capturePreview(): Promise<EnginePreviewResult> {
    if (this.#disposed)
      return Promise.resolve({ status: "disposed", reason: "Run session disposed" });
    if (this.#faulted) return Promise.resolve({ status: "faulted", reason: "Run session faulted" });
    if (this.#pending.length + Number(this.#running) >= this.#itemCap)
      return Promise.resolve({ status: "unavailable", reason: "Run service queue full" });
    return new Promise((resolve) => {
      this.#deferIngress = true;
      this.#pending.push({ kind: "preview", resolve });
      this.#pauseIfHigh();
      this.#schedule();
    });
  }

  execute(operation: RunSessionOperation): Promise<RunSessionOperationResult> {
    if (operation.type === "stop") {
      if (this.#stopOperationPromise) return this.#stopOperationPromise;
      let resolveStop!: (result: RunSessionOperationResult) => void;
      const promise = new Promise<RunSessionOperationResult>((resolve) => {
        resolveStop = resolve;
      });
      this.#stopOperationPromise = promise;
      if (this.#disposed || this.#faulted)
        void this.dispose().then((receipt) => resolveStop({ kind: "stopped", receipt }));
      else {
        this.#deferIngress = true;
        this.#pending.push({ kind: "operation", operation, resolve: resolveStop });
        this.#pauseIfHigh();
        this.#schedule();
      }
      return promise;
    }
    if (
      operation.type === "status" &&
      (operation.cached ||
        this.#disposed ||
        this.#faulted ||
        this.#pending.length + Number(this.#running) >= this.#itemCap)
    )
      return Promise.resolve({
        kind: "settled",
        atSeq: this.#parsedSeq,
        state: this.#lastState,
        controlEpoch: this.#controlEpoch,
        controlHolder: this.#controlHolder,
      });
    if (this.#disposed || this.#faulted)
      return Promise.resolve({ kind: "rejected", reason: "session-fenced" });
    if (this.#pending.length + Number(this.#running) >= this.#itemCap)
      return Promise.resolve({ kind: "rejected", reason: "queue-full" });
    return new Promise((resolve) => {
      this.#deferIngress = true;
      this.#pending.push({ kind: "operation", operation, resolve });
      this.#pauseIfHigh();
      this.#schedule();
    });
  }

  snapshot(): RunSessionSnapshot {
    return {
      receivedSeq: this.#receivedSeq,
      parsedSeq: this.#parsedSeq,
      queuedBytes: this.#queuedBytes,
      queuedItems: this.#pending.length + Number(this.#running),
      peakQueuedBytes: this.#peakQueuedBytes,
      paused: this.#paused,
      exited: this.#exited,
      faulted: this.#faulted,
      counterExhausted: this.#counterExhausted,
      epochCounterExhausted: this.#epochCounterExhausted,
      inputCounterExhausted: this.#inputCounterExhausted,
      currentInputCounterExhausted:
        this.#controlHolder !== null &&
        this.#inputSequences.get(
          JSON.stringify([
            this.#controlHolder.connection.connectionId,
            this.#controlHolder.connection.generation,
            this.#controlHolder.viewId,
            this.#controlHolder.subscriptionId,
          ]),
        ) === Number.MAX_SAFE_INTEGER,
      consumerFenced: this.#consumerFenced,
      diagnosticFenced: this.#diagnosticFenced,
      writer: this.#writer,
      leader: this.#leaderObservation(),
      stop: this.#stop,
      ownershipEvidence: this.#ownershipEvidence(),
      disposed: this.#disposed,
      controlEpoch: this.#controlEpoch,
      controlHolder: this.#controlHolder,
      geometry: this.#geometry,
      writableFenced: this.#writableFenced,
      settledState: this.#lastState,
    };
  }

  dispose(): Promise<RunSessionDisposalReceipt> {
    if (this.#disposePromise) return this.#disposePromise;
    const promise = new Promise<RunSessionDisposalReceipt>((resolve) => {
      this.#resolveDispose = resolve;
    });
    // Publish identity before model retirement or native stop can reenter.
    this.#disposePromise = promise;
    this.#disposed = true;
    this.#disposeTimer = setTimeout(() => this.#finishDisposal(), 3_000);
    const model = this.#model;
    this.#model = undefined;
    try {
      model?.dispose();
    } catch {
      this.#faulted = true;
    }
    this.#releasePending("Run session disposed");
    this.#onFact = undefined;
    this.#onFault = undefined;
    try {
      this.#native?.retireInput();
    } catch {
      this.#faulted = true;
    }
    this.#requestStop();
    // Pending native completions retain only lifecycle facts, not the model or consumers.
    this.#native = undefined;
    this.#settleDisposalIfComplete();
    return promise;
  }

  finishSpawnFailure(): void {
    this.#stop = Object.freeze({ kind: "failed-to-observe" });
    this.#writer = Object.freeze({ kind: "invalid" });
    this.#settleDisposalIfComplete();
  }

  #observeWriter(native: NativePtyAdapter): void {
    try {
      const completion = native.writerCompletion;
      if (!completion || typeof completion.then !== "function")
        throw new Error("Missing writer completion");
      void Promise.resolve(completion).then(
        (result: IBoundedWriteOwnerResult) => {
          try {
            this.#writer =
              result?.kind === "closed"
                ? Object.freeze({ kind: "closed" })
                : result?.kind === "close-uncertain"
                  ? Object.freeze({
                      kind: "close-uncertain",
                      error: boundedNativeCause(result.error).summary ?? "Writer closure uncertain",
                    })
                  : Object.freeze({ kind: "invalid" });
          } catch {
            this.#writer = Object.freeze({ kind: "invalid" });
          }
          this.#settleDisposalIfComplete();
        },
        () => {
          this.#writer = Object.freeze({ kind: "invalid" });
          this.#settleDisposalIfComplete();
        },
      );
    } catch {
      this.#writer = Object.freeze({ kind: "invalid" });
      this.#settleDisposalIfComplete();
    }
  }

  #requestStop(): void {
    if (!this.#native || this.#stopStarted) return;
    this.#stopStarted = true;
    try {
      void Promise.resolve(this.#native.stop()).then(
        (result) => {
          try {
            if (result?.kind !== "exited" && result?.kind !== "unverifiable") {
              this.#stop = Object.freeze({ kind: "failed-to-observe" });
            } else {
              const frozen = boundedNativeStopResult(result);
              this.#stop = Object.freeze({ kind: "observed", result: frozen });
              if (frozen.kind === "exited" && !this.#leaderExit) {
                this.#leaderExit = frozen.exit;
                this.#exited = true;
              }
            }
          } catch {
            this.#stop = Object.freeze({ kind: "failed-to-observe" });
          }
          this.#settleDisposalIfComplete();
        },
        () => {
          this.#stop = Object.freeze({ kind: "failed-to-observe" });
          this.#settleDisposalIfComplete();
        },
      );
    } catch {
      this.#stop = Object.freeze({ kind: "failed-to-observe" });
      this.#settleDisposalIfComplete();
    }
  }

  #leaderObservation(): RunSessionLeaderObservation {
    return this.#leaderExit
      ? Object.freeze({ kind: "exit-observed", exit: this.#leaderExit })
      : Object.freeze({ kind: "not-observed" });
  }

  #ownershipEvidence(): RunSessionOwnershipEvidence {
    if (this.#writer.kind === "close-uncertain" || this.#writer.kind === "invalid")
      return "retained-uncertain";
    if (this.#leaderExit && this.#writer.kind === "closed") return "closure-proven";
    return "unresolved";
  }

  #settleDisposalIfComplete(): void {
    if (
      this.#disposePromise &&
      this.#stop.kind !== "pending-at-deadline" &&
      this.#writer.kind !== "pending-at-deadline"
    )
      this.#finishDisposal();
  }

  #finishDisposal(): void {
    const resolve = this.#resolveDispose;
    if (!resolve) return;
    this.#resolveDispose = undefined;
    if (this.#disposeTimer) clearTimeout(this.#disposeTimer);
    this.#disposeTimer = undefined;
    // The receipt records this observation boundary; late native facts only improve snapshot().
    resolve(
      Object.freeze({
        stop: this.#stop,
        leader: this.#leaderObservation(),
        writer: this.#writer,
        ownershipEvidence: this.#ownershipEvidence(),
      }),
    );
  }

  #pauseIfHigh(): void {
    if (
      this.#queuedBytes < this.#parseHighBytes &&
      this.#pending.length + Number(this.#running) < this.#itemHigh
    )
      return;
    this.#pause();
  }

  #pause(): void {
    if (!this.#native || this.#paused || this.#faulted || this.#disposed || this.#exited) return;
    const native = this.#native;
    // Native flow-control callbacks can synchronously reenter output admission.
    this.#paused = true;
    try {
      native.pause();
      if (this.#faulted || this.#disposed || this.#exited || native !== this.#native)
        this.#paused = false;
    } catch {
      this.#paused = false;
      this.onFault({ kind: "io", reason: "pause-threw" });
    }
  }

  #schedule(): void {
    if (this.#scheduled || this.#running || !this.#native || this.#disposed) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      void this.#drainOne();
    });
  }

  async #drainOne(): Promise<void> {
    if (this.#running || this.#disposed || !this.#native) return;
    if (this.#faulted) {
      this.#releasePending("Run session faulted");
      return;
    }
    const item = this.#pending.shift();
    if (!item) return;
    const payloadBytes =
      item.kind === "fact"
        ? (item.fact.bytes?.length ?? 0)
        : item.kind === "unpublished" || item.kind === "deferred-output"
          ? item.bytes.length
          : 0;
    let ingressRetired = false;
    const releaseIngress = (): void => {
      if (ingressRetired) return;
      ingressRetired = true;
      if (
        item.kind === "barrier" ||
        item.kind === "operation" ||
        item.kind === "baseline" ||
        item.kind === "preview"
      )
        return;
      this.#queuedBytes = Math.max(0, this.#queuedBytes - payloadBytes);
      item.retireIngress();
    };
    this.#running = true;
    try {
      if (item.kind === "barrier") {
        const result = await this.#model!.barrier();
        item.resolve(this.#disposed ? failure("Run session disposed") : result);
      } else if (item.kind === "baseline") {
        item.resolve(await this.#model!.captureBaseline(item.reserveDetached));
      } else if (item.kind === "preview") {
        item.resolve(await this.#model!.capturePreview());
      } else if (item.kind === "operation") {
        item.resolve(await this.#runOperation(item.operation));
      } else if (item.kind === "unpublished") {
        const result = await this.#model!.continueUnpublishedOutput(item.bytes);
        if (!result.ok) this.#fault(`Terminal model ${result.error.code}: ${result.error.reason}`);
      } else if (item.kind === "deferred-output") {
        if (this.#receivedSeq === Number.MAX_SAFE_INTEGER) {
          this.#counterExhausted = true;
          const result = await this.#model!.continueUnpublishedOutput(item.bytes);
          if (!result.ok)
            this.#fault(`Terminal model ${result.error.code}: ${result.error.reason}`);
        } else {
          const event: RunEvent = { type: "output", run: this.#run, seq: ++this.#receivedSeq };
          await this.#applyFact({ event, bytes: item.bytes });
        }
      } else if (item.kind === "deferred-exit") {
        if (this.#receivedSeq === Number.MAX_SAFE_INTEGER) this.#counterExhausted = true;
        else {
          const event: RunEvent = {
            type: "exit",
            run: this.#run,
            seq: ++this.#receivedSeq,
            exitCode: item.exit.exitCode,
            signal: item.exit.signal === undefined ? null : String(item.exit.signal),
          };
          await this.#applyFact({ event });
        }
      } else {
        await this.#applyFact(item.fact);
      }
    } catch {
      if (item.kind === "barrier") item.resolve(failure("Ordered terminal barrier failed"));
      if (item.kind === "baseline")
        item.resolve({ status: "faulted", reason: "Ordered baseline capture failed" });
      if (item.kind === "preview")
        item.resolve({ status: "faulted", reason: "Ordered preview capture failed" });
      if (item.kind === "operation")
        item.resolve({ kind: "unknown", reason: "ordered-operation-failed" });
      this.#fault("Ordered terminal parse failed");
    } finally {
      releaseIngress();
      this.#running = false;
      this.#deferIngress = this.#pending.some(
        (pending) =>
          pending.kind === "operation" ||
          pending.kind === "baseline" ||
          pending.kind === "preview" ||
          pending.kind === "deferred-output" ||
          pending.kind === "deferred-exit",
      );
      const native = this.#native;
      if (
        native &&
        this.#paused &&
        !this.#faulted &&
        !this.#disposed &&
        !this.#exited &&
        this.#queuedBytes <= this.#parseLowBytes &&
        this.#pending.length <= this.#itemLow
      ) {
        try {
          // Reentrant output may pause again before resume returns.
          this.#paused = false;
          native.resume();
        } catch {
          this.#fault("Native resume failed");
        }
      }
      this.#schedule();
    }
  }

  async #applyFact(fact: Fact): Promise<EngineResult<EngineState>> {
    const result = await this.#model!.apply(fact.event, fact.bytes);
    if (!result.ok) {
      this.#fault(`Terminal model ${result.error.code}: ${result.error.reason}`);
      return result;
    }
    if (!this.#disposed && !this.#faulted) {
      this.#parsedSeq = fact.event.seq;
      this.#lastState = result.value;
      this.#geometry = Object.freeze({ ...result.value.geometry });
      if (fact.event.type === "exit") this.#exitApplied = true;
      try {
        this.#onRetainedFact?.(fact);
      } catch {
        // Replay is an optional bounded optimization; the authoritative parser remains live.
      }
      if (!this.#consumerFenced) {
        try {
          const returned = this.#onFact?.(fact) as unknown;
          if (consumesThenable(returned)) this.#fenceConsumer();
        } catch {
          this.#fenceConsumer();
        }
      }
    }
    return result;
  }

  async #runOperation(operation: RunSessionOperation): Promise<RunSessionOperationResult> {
    if (operation.type === "stop") return { kind: "stopped", receipt: await this.dispose() };
    if (this.#disposed || this.#faulted) return { kind: "rejected", reason: "session-fenced" };
    if (operation.type === "status") {
      const result = await this.#model!.barrier();
      if (result.ok) this.#lastState = result.value;
      return result.ok
        ? {
            kind: "settled",
            atSeq: this.#parsedSeq,
            state: result.value,
            controlEpoch: this.#controlEpoch,
            controlHolder: this.#controlHolder,
          }
        : { kind: "rejected", reason: result.error.reason };
    }
    if (this.#writableFenced || this.#exitApplied)
      return { kind: "rejected", reason: "writable-fenced" };
    if (operation.type === "control") {
      if (operation.expectedEpoch !== this.#controlEpoch)
        return { kind: "rejected", reason: "stale-control" };
      if (operation.holder) {
        if (
          !this.#isSubscriptionInstalled({
            run: this.#run,
            connection: operation.holder.connection,
            viewId: operation.holder.viewId,
            subscriptionId: operation.holder.subscriptionId,
          })
        )
          return { kind: "rejected", reason: "subscription-not-installed" };
        if (this.#controlEpoch === Number.MAX_SAFE_INTEGER) {
          this.#epochCounterExhausted = true;
          return { kind: "rejected", reason: "counter-exhausted" };
        }
        if (nextCounter(this.#controlEpoch) !== operation.nextEpoch)
          return { kind: "rejected", reason: "stale-control" };
      } else if (this.#controlEpoch === 0 || operation.nextEpoch !== this.#controlEpoch) {
        return { kind: "rejected", reason: "stale-control" };
      }
    } else if (!this.#isSubscriptionInstalled(operation.subscription)) {
      return { kind: "rejected", reason: "subscription-not-installed" };
    } else if (!this.#matchesAuthority(operation.subscription, operation.epoch)) {
      return { kind: "rejected", reason: "stale-control" };
    }
    if (operation.type === "input") {
      const key = this.#inputKey(operation.subscription);
      const previous = this.#inputSequences.get(key) ?? 0;
      if (previous === Number.MAX_SAFE_INTEGER) {
        this.#inputCounterExhausted = true;
        return { kind: "rejected", reason: "counter-exhausted" };
      }
      if (operation.inputSeq <= previous) return { kind: "rejected", reason: "input-sequence" };
      if (!this.#inputSequences.has(key) && !this.#reserveInputIdentity(operation.subscription))
        return { kind: "rejected", reason: "input-identity-cap" };
      // Attempted identities survive control loss and uncertain native completion.
      this.#inputSequences.set(key, operation.inputSeq);
      // Reclamation is authorized only after this ordered authority and identity decision.
      try {
        if (operation.beforeNativeInput && !operation.beforeNativeInput())
          return { kind: "rejected", reason: "worker-byte-limit" };
      } catch {
        return { kind: "rejected", reason: "worker-byte-limit" };
      }
      return this.#writeInput(operation.bytes);
    }
    const current = await this.#model!.barrier();
    if (!current.ok) return { kind: "rejected", reason: current.error.reason };
    const changedGeometry =
      operation.type !== "appearance" &&
      (operation.geometry.cols !== current.value.geometry.cols ||
        operation.geometry.rows !== current.value.geometry.rows);
    const appearance =
      operation.type === "appearance" || operation.type === "control"
        ? operation.appearance
        : undefined;
    const changedAppearance =
      appearance !== undefined &&
      JSON.stringify(appearance) !== JSON.stringify(current.value.appearance);
    const controlFact =
      operation.type === "control" && (operation.holder !== null || this.#controlHolder !== null);
    const factCount = Number(changedGeometry) + Number(changedAppearance) + Number(controlFact);
    if (factCount > Number.MAX_SAFE_INTEGER - this.#receivedSeq) {
      this.#counterExhausted = true;
      return { kind: "rejected", reason: "counter-exhausted" };
    }
    if (changedGeometry) {
      try {
        this.#native!.resize(operation.geometry.cols, operation.geometry.rows);
      } catch {
        this.#writableFenced = true;
        return { kind: "unknown", reason: "native-resize-failed" };
      }
      if (this.#faulted || this.#disposed || this.#writableFenced) {
        this.#writableFenced = true;
        return { kind: "unknown", reason: "native-resize-faulted" };
      }
      const resize: RunEvent = {
        type: "resize",
        run: this.#run,
        seq: ++this.#receivedSeq,
        geometry: operation.geometry,
        requiresBaseline: true,
      };
      const result = await this.#applyFact({ event: resize });
      if (!result.ok || this.#faulted || this.#disposed) {
        this.#writableFenced = true;
        return { kind: "unknown", reason: "model-resize-failed" };
      }
    }
    if (appearance && changedAppearance) {
      const event: RunEvent = {
        type: "appearance",
        run: this.#run,
        seq: ++this.#receivedSeq,
        appearance,
      };
      const result = await this.#applyFact({ event });
      if (!result.ok || this.#faulted || this.#disposed) {
        this.#writableFenced = true;
        return { kind: "unknown", reason: "model-appearance-failed" };
      }
    }
    if (operation.type === "control" && controlFact) {
      const event: RunEvent = {
        type: "control",
        run: this.#run,
        seq: ++this.#receivedSeq,
        epoch: operation.nextEpoch,
        holder: operation.holder,
        geometry: operation.geometry,
      };
      const result = await this.#applyFact({ event });
      if (!result.ok || this.#faulted || this.#disposed) {
        this.#writableFenced = true;
        return { kind: "unknown", reason: "model-control-failed" };
      }
    }
    const settled = await this.#model!.barrier();
    if (settled.ok && operation.type === "control") {
      this.#controlEpoch = operation.nextEpoch;
      this.#controlHolder = operation.holder
        ? Object.freeze({
            ...operation.holder,
            connection: Object.freeze({ ...operation.holder.connection }),
          })
        : null;
    }
    if (!settled.ok) {
      this.#writableFenced = true;
      return { kind: "unknown", reason: "operation-barrier-failed" };
    }
    return {
      kind: "settled",
      atSeq: this.#parsedSeq,
      state: settled.value,
      controlEpoch: this.#controlEpoch,
      controlHolder: this.#controlHolder,
    };
  }

  #matchesAuthority(subscription: SubscriptionRef, epoch: number): boolean {
    const holder = this.#controlHolder;
    return (
      holder !== null &&
      epoch === this.#controlEpoch &&
      sameRunRef(subscription.run, this.#run) &&
      holder.connection.connectionId === subscription.connection.connectionId &&
      holder.connection.generation === subscription.connection.generation &&
      holder.viewId === subscription.viewId &&
      holder.subscriptionId === subscription.subscriptionId
    );
  }

  #inputKey(subscription: SubscriptionRef): string {
    return JSON.stringify([
      subscription.connection.connectionId,
      subscription.connection.generation,
      subscription.viewId,
      subscription.subscriptionId,
    ]);
  }

  async #writeInput(bytes: Uint8Array): Promise<RunSessionOperationResult> {
    const native = this.#native!;
    let resolveSettlement!: (value: RunSessionOperationResult) => void;
    const completion = new Promise<RunSessionOperationResult>((resolve) => {
      resolveSettlement = resolve;
    });
    let settled = false;
    let admission: ReturnType<NativePtyAdapter["submit"]>;
    try {
      admission = native.submit(bytes, (result) => {
        if (settled) return;
        settled = true;
        if (result.kind === "written" && result.writtenBytes > 0) {
          resolveSettlement({
            kind: "written",
            writtenBytes: result.writtenBytes,
            atSeq: this.#parsedSeq,
          });
        } else {
          this.#writableFenced = true;
          resolveSettlement({ kind: "unknown", reason: "input-settlement-unknown" });
        }
      });
    } catch {
      this.#writableFenced = true;
      return { kind: "unknown", reason: "native-input-threw" };
    }
    if (admission.kind === "rejected") {
      if (settled) {
        this.#writableFenced = true;
        return { kind: "unknown", reason: "settlement-before-rejection" };
      }
      return { kind: "rejected", reason: admission.reason };
    }
    if (admission.kind === "unknown") {
      this.#writableFenced = true;
      return { kind: "unknown", reason: admission.reason };
    }
    // An unobserved settlement is uncertain, and its bytes remain owned by N2.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<RunSessionOperationResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "unknown", reason: "input-settlement-deadline" }),
        3_000,
      );
    });
    const result = await Promise.race([completion, deadline]);
    if (timer) clearTimeout(timer);
    if (result.kind === "unknown") this.#writableFenced = true;
    return result;
  }

  #releasePending(reason: string): void {
    for (const item of this.#pending.splice(0)) {
      if (item.kind === "barrier") item.resolve(failure(reason));
      if (item.kind === "baseline") item.resolve({ status: "disposed", reason });
      if (item.kind === "preview") item.resolve({ status: "disposed", reason });
      if (item.kind === "operation") {
        if (item.operation.type === "stop")
          void this.dispose().then((receipt) => item.resolve({ kind: "stopped", receipt }));
        else item.resolve({ kind: "rejected", reason });
      }
      if (item.kind === "fact") {
        this.#queuedBytes -= item.fact.bytes?.length ?? 0;
        item.retireIngress();
      }
      if (item.kind === "unpublished" || item.kind === "deferred-output") {
        this.#queuedBytes -= item.bytes.length;
        item.retireIngress();
      }
      if (item.kind === "deferred-exit") item.retireIngress();
    }
  }

  #fault(reason: string): void {
    if (this.#faulted || this.#disposed) return;
    this.#faulted = true;
    try {
      this.#native?.pause();
    } catch {
      // A pause fault must not block owned stop observation.
    }
    try {
      this.#native?.retireInput();
    } catch {
      // A retirement fault must not block owned stop observation.
    }
    this.#requestStop();
    this.#reportFault({ kind: "pump", reason });
    this.#schedule();
  }

  #fenceConsumer(): void {
    if (this.#consumerFenced) return;
    this.#consumerFenced = true;
    if (!this.#disposed)
      this.#reportFault({ kind: "consumer", reason: "parsed-fact-observer-failed" });
  }

  #reportFault(fault: RunSessionFault): void {
    if (this.#disposed || this.#diagnosticFenced || !this.#onFault) return;
    try {
      const returned = this.#onFault(fault) as unknown;
      if (consumesThenable(returned)) this.#diagnosticFenced = true;
    } catch {
      this.#diagnosticFenced = true;
    }
  }
}

function startRunSession(options: RunSessionOptions):
  | {
      readonly kind: "created";
      readonly session: RunSession;
      readonly capability: WorkerRunSessionCapability;
    }
  | Exclude<NativeSpawnResult, { readonly kind: "created" }> {
  const core = new RunSessionCore(options);
  let result: NativeSpawnResult;
  try {
    result = options.factory.spawn(
      {
        ...options.spawn,
        cols: options.geometry.cols,
        rows: options.geometry.rows,
        ...(options.reserveNativeRetainedBytes && {
          reserveRetainedBytes: options.reserveNativeRetainedBytes,
        }),
      },
      {
        onData: (bytes) => core.onData(bytes),
        onExit: (exit) => core.onExit(exit),
        onFault: (fault) => core.onFault(fault),
      },
    );
  } catch (cause) {
    void core.dispose();
    core.finishSpawnFailure();
    return { kind: "unclassified-failure", cause };
  }
  if (result.kind !== "created") {
    void core.dispose();
    core.finishSpawnFailure();
    return result;
  }
  core.attach(result.pty);
  const session: RunSession = Object.freeze(
    Object.assign(Object.create(null) as RunSession, {
      barrier: () => core.barrier(),
      snapshot: () => core.snapshot(),
      dispose: () => core.dispose(),
    }),
  );
  const capability: WorkerRunSessionCapability = Object.freeze({
    execute: (operation: RunSessionOperation) => core.execute(operation),
    captureBaseline: (reserveDetached?: (bytes: number) => boolean) =>
      core.captureBaseline(reserveDetached),
    capturePreview: () => core.capturePreview(),
  });
  return { kind: "created", session, capability };
}

export function createRunSession(options: RunSessionOptions): RunSessionStart {
  const started = startRunSession(options);
  return started.kind === "created" ? { kind: "created", session: started.session } : started;
}

// Package-internal typed capability; the public session never exposes its owner or model.
export function createWorkerRunSession(
  options: RunSessionOptions,
): ReturnType<typeof startRunSession> {
  return startRunSession(options);
}
