import type { Readable, Writable } from "node:stream";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import { sameWorkerRef } from "@cove/protocol/identity";
import {
  HEADER_BYTES,
  MAX_METADATA_BYTES,
  PIPE_VERSION,
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
  validatePipeReadiness,
  validatePipeResultForCommand,
  type PipeCommand,
  type PipeError,
  type PipeResult,
} from "@cove/protocol/pipe";
import {
  createWorkerExecution,
  type WorkerExecution,
  type WorkerExecutionOptions,
} from "./worker-execution.js";

const MAX_REPLY_BYTES = HEADER_BYTES + MAX_METADATA_BYTES;
const emptyPayload = new Uint8Array();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type Hello = Parameters<typeof validatePipeReadiness>[0];
type Ready = Parameters<typeof validatePipeReadiness>[1];

export interface WorkerPipeOptions {
  readonly buildVersion: string;
  readonly createExecution?: (options: WorkerExecutionOptions) => WorkerExecution;
  readonly onFault?: WorkerExecutionOptions["onFault"];
  readonly onFact?: WorkerExecutionOptions["onFact"];
}

export interface WorkerPipeClose {
  readonly reason: string;
  readonly uncertainRequestIds: readonly string[];
  readonly disposalReceipts: Awaited<ReturnType<WorkerExecution["shutdown"]>>;
  readonly disposalUnverifiable: boolean;
}

export interface WorkerPipeSnapshot {
  readonly state: "awaiting-hello" | "ready" | "closing" | "closed";
  readonly pendingCommands: number;
  readonly ingressBytes: number;
  readonly queuedBytes: number;
  readonly transportBytes: number;
  readonly peakAccountedBytes: number;
  readonly blocked: boolean;
}

export interface WorkerPipe {
  readonly closed: Promise<WorkerPipeClose>;
  snapshot(): WorkerPipeSnapshot;
  shutdown(reason: string): Promise<WorkerPipeClose>;
}

interface OutboundFrame {
  readonly bytes: Uint8Array;
  readonly requestId?: string;
}

class WorkerPipeCore {
  readonly #readable: Readable;
  readonly #writable: Writable;
  readonly #options: WorkerPipeOptions;
  readonly #decoder = createPipeDecoder();
  readonly #outbound: OutboundFrame[] = [];
  readonly #pending = new Set<string>();
  readonly #awaitingSend = new Set<string>();
  readonly #transportPending = new Set<string>();
  readonly #closedPromise: Promise<WorkerPipeClose>;
  #resolveClosed!: (value: WorkerPipeClose) => void;
  #state: WorkerPipeSnapshot["state"] = "awaiting-hello";
  #hello: Hello | undefined;
  #execution: WorkerExecution | undefined;
  #queuedBytes = 0;
  #reservedReplyBytes = 0;
  #peakAccountedBytes = 0;
  #blocked = false;
  #blockedFrameBytes = 0;
  #activeChunk: Uint8Array | undefined;
  #activeOffset = 0;
  #processing = false;
  #allowCommands = false;
  #shutdownPromise: Promise<WorkerPipeClose> | undefined;

  constructor(readable: Readable, writable: Writable, options: WorkerPipeOptions) {
    if (!options.buildVersion || options.buildVersion.length > 128)
      throw new TypeError("Invalid worker build version");
    this.#readable = readable;
    this.#writable = writable;
    this.#options = options;
    this.#closedPromise = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    readable.on("data", this.#onData);
    readable.once("end", this.#onEnd);
    readable.once("error", this.#onReadError);
    writable.on("drain", this.#onDrain);
    writable.once("error", this.#onWriteError);
    writable.once("close", this.#onWriteClose);
  }

  get closed(): Promise<WorkerPipeClose> {
    return this.#closedPromise;
  }

  snapshot(): WorkerPipeSnapshot {
    return {
      state: this.#state,
      pendingCommands: this.#pending.size,
      ingressBytes:
        (this.#activeChunk?.byteLength ?? 0) - this.#activeOffset + this.#decoder.retainedBytes,
      queuedBytes: this.#queuedBytes,
      transportBytes: this.#transportBytes(),
      peakAccountedBytes: this.#peakAccountedBytes,
      blocked: this.#blocked,
    };
  }

  shutdown(reason: string): Promise<WorkerPipeClose> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#state = "closing";
    this.#readable.pause();
    this.#readable.off("data", this.#onData);
    this.#readable.off("end", this.#onEnd);
    this.#readable.off("error", this.#onReadError);
    this.#writable.off("drain", this.#onDrain);
    this.#writable.off("error", this.#onWriteError);
    this.#writable.off("close", this.#onWriteClose);
    this.#activeChunk = undefined;
    this.#outbound.length = 0;
    this.#queuedBytes = 0;
    const uncertainRequestIds = [
      ...new Set([...this.#pending, ...this.#awaitingSend, ...this.#transportPending]),
    ];
    this.#shutdownPromise = (async () => {
      let disposalReceipts: WorkerPipeClose["disposalReceipts"] = [];
      let disposalUnverifiable = false;
      try {
        disposalReceipts = (await this.#execution?.shutdown(reason)) ?? [];
      } catch {
        // An unverified dispose cannot turn an in-flight command into a known failure.
        disposalUnverifiable = true;
      } finally {
        if (!this.#writable.destroyed && !this.#writable.writableEnded) this.#writable.end();
        this.#state = "closed";
      }
      const closed = { reason, uncertainRequestIds, disposalReceipts, disposalUnverifiable };
      this.#resolveClosed(closed);
      return closed;
    })();
    return this.#shutdownPromise;
  }

  #transportBytes(): number {
    return Math.max(this.#writable.writableLength, this.#blockedFrameBytes);
  }

  #accountedBytes(): number {
    return this.#reservedReplyBytes + this.#queuedBytes + this.#transportBytes();
  }

  #recordPeak(): void {
    this.#peakAccountedBytes = Math.max(this.#peakAccountedBytes, this.#accountedBytes());
  }

  #ordinaryLimit(): number {
    return (
      this.#hello!.effectiveBudgets.pipeQueuedBytes -
      this.#hello!.effectiveBudgets.reservedControlBytes
    );
  }

  #mayAdmitCommand(): boolean {
    return (
      this.#pending.size < this.#hello!.effectiveBudgets.pendingWorkerCommands &&
      this.#accountedBytes() + MAX_REPLY_BYTES <= this.#ordinaryLimit()
    );
  }

  #onData = (chunk: unknown): void => {
    if (this.#state === "closing" || this.#state === "closed") return;
    this.#readable.pause();
    if (!(chunk instanceof Uint8Array)) {
      void this.shutdown("non-byte-ingress");
      return;
    }
    if (this.#activeChunk) {
      void this.shutdown("overlapping-ingress");
      return;
    }
    if (
      chunk.byteLength + this.#decoder.retainedBytes >
      (this.#hello?.effectiveBudgets.workerBytes ?? M0_LIMITS.workerBytes)
    ) {
      void this.shutdown("ingress-capacity-exceeded");
      return;
    }
    this.#activeChunk = chunk;
    this.#activeOffset = 0;
    this.#processChunk();
  };

  #processChunk(): void {
    if (this.#processing || !this.#activeChunk) return;
    this.#processing = true;
    try {
      while (this.#activeChunk && this.#state !== "closing" && this.#state !== "closed") {
        const remaining = this.#activeChunk.subarray(this.#activeOffset);
        if (remaining.length === 0) {
          this.#activeChunk = undefined;
          this.#activeOffset = 0;
          if (this.#hello && !this.#blocked) this.#allowCommands = true;
          if (!this.#blocked) this.#readable.resume();
          break;
        }
        // A completed command may already be held by the decoder; reserve reply room before more input.
        if (this.#hello && !this.#mayAdmitCommand()) break;
        const read = this.#decoder.read(remaining);
        this.#activeOffset += read.consumedBytes;
        for (const frame of read.frames) {
          if (!this.#handleFrame(frame)) break;
        }
        if (read.status === "error") {
          void this.shutdown(`decode-${read.error?.code ?? "error"}`);
          break;
        }
        if (read.status === "budget") {
          setImmediate(() => this.#processChunk());
          break;
        }
        if (read.consumedBytes === 0) break;
      }
    } finally {
      this.#processing = false;
    }
  }

  #handleFrame(frame: { kind: 1 | 2 | 3 | 4; metadata: Uint8Array; payload: Uint8Array }): boolean {
    let decoded: unknown;
    try {
      decoded = JSON.parse(textDecoder.decode(frame.metadata));
    } catch {
      void this.shutdown("invalid-metadata-json");
      return false;
    }
    const checked = validatePipeFrame(frame, decoded);
    if (!checked.ok) {
      void this.shutdown(`invalid-frame-${checked.error.code}`);
      return false;
    }
    const metadata = checked.value;
    if (!this.#hello) {
      if (metadata.type !== "hello") {
        void this.shutdown("command-before-hello");
        return false;
      }
      const ready: Ready = {
        type: "ready",
        worker: metadata.worker,
        pipeVersion: PIPE_VERSION,
        buildVersion: this.#options.buildVersion,
        effectiveBudgets: metadata.effectiveBudgets,
      };
      if (!validatePipeReadiness(metadata, ready)) {
        void this.shutdown("hello-mismatch");
        return false;
      }
      try {
        this.#execution = (this.#options.createExecution ?? createWorkerExecution)({
          worker: metadata.worker,
          effectiveBudgets: metadata.effectiveBudgets,
          ...(this.#options.onFact && { onFact: this.#options.onFact }),
          ...(this.#options.onFault && { onFault: this.#options.onFault }),
        });
      } catch {
        void this.shutdown("execution-start-failed");
        return false;
      }
      this.#hello = metadata;
      this.#state = "ready";
      if (!this.#enqueue(ready, 2, true)) {
        void this.shutdown("ready-send-failed");
        return false;
      }
      return true;
    }
    if (
      !this.#allowCommands ||
      metadata.type === "hello" ||
      metadata.type === "ready" ||
      !("requestId" in metadata) ||
      frame.kind !== 1
    ) {
      void this.shutdown("unexpected-frame");
      return false;
    }
    if (!sameWorkerRef(metadata.worker, this.#hello.worker)) {
      void this.shutdown("foreign-worker");
      return false;
    }
    const command = metadata as PipeCommand;
    if (!this.#mayAdmitCommand()) {
      void this.shutdown("command-capacity-exceeded");
      return false;
    }
    if (this.#pending.has(command.requestId)) {
      const duplicate: PipeError = {
        type: "error",
        worker: command.worker,
        run: command.run,
        requestId: command.requestId,
        commandType: command.type,
        error: domainError("OPERATION_ID_CONFLICT"),
      };
      if (!this.#enqueue(duplicate, 4, false, command.requestId))
        void this.shutdown("duplicate-response-capacity");
      return true;
    }
    this.#pending.add(command.requestId);
    this.#reservedReplyBytes += MAX_REPLY_BYTES;
    this.#recordPeak();
    void this.#execution!.execute(command, frame.payload).then(
      (response) => this.#completeCommand(command, response),
      () => this.#completeCommand(command, this.#unknownError(command)),
    );
    return true;
  }

  #unknownError(command: PipeCommand): PipeError {
    return {
      type: "error",
      worker: command.worker,
      run: command.run,
      requestId: command.requestId,
      commandType: command.type,
      error: domainError(
        "RESULT_UNKNOWN",
        "unknown",
        command.type === "input" ? "input" : undefined,
      ),
    };
  }

  #completeCommand(command: PipeCommand, response: PipeResult | PipeError): void {
    if (!this.#pending.has(command.requestId)) return;
    this.#pending.delete(command.requestId);
    this.#reservedReplyBytes -= MAX_REPLY_BYTES;
    if (this.#state !== "ready") return;
    this.#awaitingSend.add(command.requestId);
    if (!validatePipeResultForCommand(command, response)) {
      void this.shutdown("invalid-execution-correlation");
      return;
    }
    if (!this.#enqueue(response, response.type === "result" ? 2 : 4, false, command.requestId)) {
      void this.shutdown("response-send-failed");
      return;
    }
    this.#processChunk();
    if (!this.#activeChunk) this.#readable.resume();
  }

  #enqueue(
    metadata: Ready | PipeResult | PipeError,
    kind: 2 | 4,
    control: boolean,
    requestId?: string,
  ): boolean {
    const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
    if (!validatePipeFrame({ kind, metadata: metadataBytes, payload: emptyPayload }, metadata).ok)
      return false;
    const encoded = encodePipeFrame(kind, metadataBytes, emptyPayload);
    if (!encoded.ok || !this.#hello) return false;
    const total = this.#accountedBytes() + encoded.value.byteLength;
    const cap = control ? this.#hello.effectiveBudgets.pipeQueuedBytes : this.#ordinaryLimit();
    if (total > cap) return false;
    this.#outbound.push({ bytes: encoded.value, ...(requestId && { requestId }) });
    if (requestId) this.#awaitingSend.add(requestId);
    this.#queuedBytes += encoded.value.byteLength;
    this.#recordPeak();
    this.#flush();
    return true;
  }

  #flush(): void {
    if (this.#blocked || this.#state === "closing" || this.#state === "closed") return;
    while (this.#outbound.length) {
      const frame = this.#outbound.shift()!;
      this.#queuedBytes -= frame.bytes.byteLength;
      if (frame.requestId) {
        this.#awaitingSend.delete(frame.requestId);
        this.#transportPending.add(frame.requestId);
      }
      let accepted: boolean;
      try {
        accepted = this.#writable.write(Buffer.from(frame.bytes), (error) => {
          if (!error && frame.requestId) this.#transportPending.delete(frame.requestId);
        });
      } catch {
        void this.shutdown("stdout-write-failed");
        return;
      }
      if (!accepted) {
        // write(false) has already handed off this frame. Never enqueue it again.
        this.#blocked = true;
        this.#blockedFrameBytes = frame.bytes.byteLength;
      }
      this.#recordPeak();
      if (this.#accountedBytes() > this.#hello!.effectiveBudgets.pipeQueuedBytes) {
        void this.shutdown("stdout-capacity-exceeded");
        return;
      }
      if (this.#blocked) break;
    }
  }

  #onDrain = (): void => {
    this.#blocked = false;
    this.#blockedFrameBytes = 0;
    this.#transportPending.clear();
    if (this.#hello && !this.#activeChunk) this.#allowCommands = true;
    this.#flush();
    this.#processChunk();
    if (!this.#activeChunk && this.#state === "ready") this.#readable.resume();
  };

  #onEnd = (): void => {
    const complete = this.#decoder.finish();
    void this.shutdown(complete.ok ? "stdin-eof" : "stdin-truncated-frame");
  };

  #onReadError = (): void => {
    void this.shutdown("stdin-error");
  };

  #onWriteError = (): void => {
    void this.shutdown("stdout-error");
  };

  #onWriteClose = (): void => {
    void this.shutdown("stdout-close");
  };
}

export function runWorkerPipe(
  readable: Readable,
  writable: Writable,
  options: WorkerPipeOptions,
): WorkerPipe {
  const core = new WorkerPipeCore(readable, writable, options);
  return Object.freeze({
    closed: core.closed,
    snapshot: () => core.snapshot(),
    shutdown: (reason: string) => core.shutdown(reason),
  });
}
