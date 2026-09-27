import {
  createTerminalModel,
  type EngineResult,
  type EngineState,
  type TerminalModel,
} from "@cove/terminal-engine";
import { M0_LIMITS } from "@cove/protocol/budgets";
import type { RunRef } from "@cove/protocol/identity";
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

const OUTPUT_CHUNK_BYTES = 65_536;
const PENDING_WRITER: RunSessionWriterObservation = Object.freeze({ kind: "pending-at-deadline" });
const PENDING_STOP: RunSessionStopObservation = Object.freeze({ kind: "pending-at-deadline" });

type Fact = { readonly event: RunEvent; readonly bytes?: Buffer };
type Pending =
  | { readonly kind: "fact"; readonly fact: Fact }
  | { readonly kind: "unpublished"; readonly bytes: Buffer }
  | { readonly kind: "barrier"; readonly resolve: (result: EngineResult<EngineState>) => void };

export interface RunSessionOptions {
  readonly run: RunRef;
  readonly geometry: Geometry;
  readonly appearance?: Appearance;
  readonly spawn: Omit<NativeSpawnSpec, "cols" | "rows">;
  readonly factory: NativePtyFactory;
  readonly onFact?: (fact: Fact) => void;
  readonly onFault?: (fault: RunSessionFault) => void;
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
  readonly consumerFenced: boolean;
  readonly diagnosticFenced: boolean;
  readonly writer: RunSessionWriterObservation;
  readonly leader: RunSessionLeaderObservation;
  readonly stop: RunSessionStopObservation;
  readonly ownershipEvidence: RunSessionOwnershipEvidence;
  readonly disposed: boolean;
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

function frozenStopResult(result: NativeStopResult): NativeStopResult {
  const cleanup = Object.freeze({
    ...result.cleanup,
    graceful: Object.freeze({ ...result.cleanup.graceful }),
    force: Object.freeze({ ...result.cleanup.force }),
  });
  const signalFailure = result.signalFailure
    ? Object.freeze({ ...result.signalFailure })
    : undefined;
  return Object.freeze(
    result.kind === "exited"
      ? {
          ...result,
          exit: Object.freeze({ ...result.exit }),
          cleanup,
          ...(signalFailure && { signalFailure }),
        }
      : { ...result, cleanup, ...(signalFailure && { signalFailure }) },
  );
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
  #faulted = false;
  #counterExhausted = false;
  #disposed = false;
  #consumerFenced = false;
  #diagnosticFenced = false;
  #leaderExit: NativeExit | undefined;
  #writer: RunSessionWriterObservation = PENDING_WRITER;
  #stop: RunSessionStopObservation = PENDING_STOP;
  #stopStarted = false;
  #disposePromise: Promise<RunSessionDisposalReceipt> | undefined;
  #resolveDispose: ((receipt: RunSessionDisposalReceipt) => void) | undefined;
  #disposeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RunSessionOptions) {
    this.#run = options.run;
    this.#onFact = options.onFact;
    this.#onFault = options.onFault;
    this.#model = createTerminalModel({
      run: options.run,
      geometry: options.geometry,
      ...(options.appearance === undefined ? {} : { appearance: options.appearance }),
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
    if (this.#queuedBytes >= M0_LIMITS.parseHighBytes) this.#pause();
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
      bytes.length > M0_LIMITS.parseHardBytes - this.#queuedBytes ||
      chunks > M0_LIMITS.pendingWorkerCommands - this.#pending.length - Number(this.#running)
    ) {
      this.#fault("Native output exceeded the bounded parse queue");
      return;
    }
    for (let offset = 0; offset < bytes.length; offset += OUTPUT_CHUNK_BYTES) {
      // The native callback buffer may be reused immediately after return.
      const owned = Buffer.from(bytes.subarray(offset, offset + OUTPUT_CHUNK_BYTES));
      if (this.#receivedSeq === Number.MAX_SAFE_INTEGER) {
        this.#counterExhausted = true;
        this.#pending.push({ kind: "unpublished", bytes: owned });
      } else {
        const event: RunEvent = { type: "output", run: this.#run, seq: ++this.#receivedSeq };
        this.#pending.push({ kind: "fact", fact: { event, bytes: owned } });
      }
      this.#queuedBytes += owned.length;
    }
    this.#peakQueuedBytes = Math.max(this.#peakQueuedBytes, this.#queuedBytes);
    if (this.#queuedBytes >= M0_LIMITS.parseHighBytes) this.#pause();
    this.#schedule();
  }

  onExit(exit: NativeExit): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#leaderExit = Object.freeze({ ...exit });
    this.#settleDisposalIfComplete();
    if (this.#disposed) return;
    if (this.#faulted) return;
    if (this.#receivedSeq === Number.MAX_SAFE_INTEGER) {
      this.#counterExhausted = true;
      return;
    }
    if (this.#pending.length + Number(this.#running) >= M0_LIMITS.pendingWorkerCommands) {
      this.#fault("Run exit could not enter the bounded parse queue");
      return;
    }
    const event: RunEvent = {
      type: "exit",
      run: this.#run,
      seq: ++this.#receivedSeq,
      exitCode: exit.exitCode,
      signal: exit.signal === undefined ? null : String(exit.signal),
    };
    this.#pending.push({ kind: "fact", fact: { event } });
    this.#schedule();
  }

  onFault(fault: NativePtyFault): void {
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
    if (this.#pending.length + Number(this.#running) >= M0_LIMITS.pendingWorkerCommands)
      return Promise.resolve(failure("Run service queue full"));
    return new Promise((resolve) => {
      this.#pending.push({ kind: "barrier", resolve });
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
      consumerFenced: this.#consumerFenced,
      diagnosticFenced: this.#diagnosticFenced,
      writer: this.#writer,
      leader: this.#leaderObservation(),
      stop: this.#stop,
      ownershipEvidence: this.#ownershipEvidence(),
      disposed: this.#disposed,
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
                : result?.kind === "close-uncertain" && typeof result.error === "string"
                  ? Object.freeze({ kind: "close-uncertain", error: result.error.slice(0, 128) })
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
              const frozen = frozenStopResult(result);
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

  #pause(): void {
    if (!this.#native || this.#paused) return;
    const native = this.#native;
    try {
      native.pause();
    } catch {
      this.onFault({ kind: "io", reason: "pause-threw" });
      return;
    }
    if (!this.#faulted && !this.#disposed && !this.#exited && native === this.#native)
      this.#paused = true;
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
    this.#running = true;
    try {
      if (item.kind === "barrier") {
        const result = await this.#model!.barrier();
        item.resolve(this.#disposed ? failure("Run session disposed") : result);
      } else if (item.kind === "unpublished") {
        const result = await this.#model!.continueUnpublishedOutput(item.bytes);
        this.#queuedBytes = Math.max(0, this.#queuedBytes - item.bytes.length);
        if (!result.ok) this.#fault(`Terminal model ${result.error.code}: ${result.error.reason}`);
      } else {
        const { event, bytes } = item.fact;
        const result = await this.#model!.apply(event, bytes);
        if (bytes) this.#queuedBytes = Math.max(0, this.#queuedBytes - bytes.length);
        if (!result.ok) this.#fault(`Terminal model ${result.error.code}: ${result.error.reason}`);
        else if (!this.#disposed && !this.#faulted) {
          this.#parsedSeq = event.seq;
          if (!this.#consumerFenced) {
            try {
              const returned = this.#onFact?.(item.fact) as unknown;
              if (consumesThenable(returned)) this.#fenceConsumer();
            } catch {
              this.#fenceConsumer();
            }
          }
        }
      }
    } catch {
      if (item.kind === "barrier") item.resolve(failure("Ordered terminal barrier failed"));
      this.#fault("Ordered terminal parse failed");
    } finally {
      this.#running = false;
      const native = this.#native;
      if (
        native &&
        this.#paused &&
        !this.#faulted &&
        !this.#disposed &&
        !this.#exited &&
        this.#queuedBytes <= M0_LIMITS.parseLowBytes
      ) {
        try {
          native.resume();
          if (!this.#faulted && !this.#disposed && native === this.#native) this.#paused = false;
        } catch {
          this.#fault("Native resume failed");
        }
      }
      this.#schedule();
    }
  }

  #releasePending(reason: string): void {
    for (const item of this.#pending.splice(0)) {
      if (item.kind === "barrier") item.resolve(failure(reason));
    }
    this.#queuedBytes = 0;
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

export function createRunSession(options: RunSessionOptions): RunSessionStart {
  const core = new RunSessionCore(options);
  let result: NativeSpawnResult;
  try {
    result = options.factory.spawn(
      { ...options.spawn, cols: options.geometry.cols, rows: options.geometry.rows },
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
  return { kind: "created", session };
}
