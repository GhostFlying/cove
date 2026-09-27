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
  | { readonly kind: "consumer"; readonly reason: "parsed-fact-observer-threw" };

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
  readonly disposed: boolean;
}

export type RunSessionStart =
  | { readonly kind: "created"; readonly session: RunSession }
  | Exclude<NativeSpawnResult, { readonly kind: "created" }>;

function failure(reason: string): EngineResult<never> {
  return { ok: false, error: { code: "faulted", reason } };
}

export class RunSession {
  readonly #run: RunRef;
  readonly #model: TerminalModel;
  readonly #onFact: ((fact: Fact) => void) | undefined;
  readonly #onFault: RunSessionOptions["onFault"];
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
    this.#native = native;
    if (this.#faulted || this.#disposed) {
      this.#releasePending("Run session faulted before native attachment");
      void native.stop();
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
    if (this.#disposed || this.#exited) return;
    this.#exited = true;
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
    if (this.#disposed || this.#faulted) return;
    this.#faulted = true;
    // A fault can be raised synchronously by pause itself; retrying it recurses.
    this.#native?.retireInput();
    void this.#native?.stop();
    try {
      this.#onFault?.(fault);
    } catch {
      // Diagnostic observers cannot restore authority after a native fault.
    }
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
      disposed: this.#disposed,
    };
  }

  async dispose(): Promise<NativeStopResult | undefined> {
    if (this.#disposed) return undefined;
    this.#disposed = true;
    this.#model.dispose();
    this.#releasePending("Run session disposed");
    return this.#native?.stop();
  }

  #pause(): void {
    if (!this.#native || this.#paused) return;
    this.#native.pause();
    if (!this.#faulted) this.#paused = true;
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
        const result = await this.#model.barrier();
        item.resolve(this.#disposed ? failure("Run session disposed") : result);
      } else if (item.kind === "unpublished") {
        const result = await this.#model.continueUnpublishedOutput(item.bytes);
        this.#queuedBytes = Math.max(0, this.#queuedBytes - item.bytes.length);
        if (!result.ok) this.#fault(`Terminal model ${result.error.code}: ${result.error.reason}`);
      } else {
        const { event, bytes } = item.fact;
        const result = await this.#model.apply(event, bytes);
        if (bytes) this.#queuedBytes = Math.max(0, this.#queuedBytes - bytes.length);
        if (!result.ok) this.#fault(`Terminal model ${result.error.code}: ${result.error.reason}`);
        else if (!this.#disposed && !this.#faulted) {
          this.#parsedSeq = event.seq;
          if (!this.#consumerFenced) {
            try {
              this.#onFact?.(item.fact);
            } catch {
              this.#consumerFenced = true;
              try {
                this.#onFault?.({ kind: "consumer", reason: "parsed-fact-observer-threw" });
              } catch {
                // A diagnostic callback cannot interrupt authoritative parsing.
              }
            }
          }
        }
      }
    } catch {
      if (item.kind === "barrier") item.resolve(failure("Ordered terminal barrier failed"));
      this.#fault("Ordered terminal parse failed");
    } finally {
      this.#running = false;
      if (this.#paused && !this.#faulted && this.#queuedBytes <= M0_LIMITS.parseLowBytes) {
        this.#native.resume();
        this.#paused = false;
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
    this.#native?.pause();
    this.#native?.retireInput();
    void this.#native?.stop();
    try {
      this.#onFault?.({ kind: "pump", reason });
    } catch {
      // Diagnostic observers cannot revive a fenced run.
    }
    this.#schedule();
  }
}

export function createRunSession(options: RunSessionOptions): RunSessionStart {
  const session = new RunSession(options);
  let result: NativeSpawnResult;
  try {
    result = options.factory.spawn(
      { ...options.spawn, cols: options.geometry.cols, rows: options.geometry.rows },
      {
        onData: (bytes) => session.onData(bytes),
        onExit: (exit) => session.onExit(exit),
        onFault: (fault) => session.onFault(fault),
      },
    );
  } catch (cause) {
    session.dispose();
    return { kind: "unclassified-failure", cause };
  }
  if (result.kind !== "created") {
    void session.dispose();
    return result;
  }
  session.attach(result.pty);
  return { kind: "created", session };
}
