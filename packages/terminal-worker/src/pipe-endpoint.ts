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
  readonly outstandingRequests: number;
  readonly responseItems: number;
  readonly ingressBytes: number;
  readonly peakDecodeSliceBytes: number;
  readonly queuedBytes: number;
  readonly transportBytes: number;
  readonly ordinaryAccountedBytes: number;
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
  readonly request?: RequestRecord;
  readonly control: boolean;
  readonly extra: boolean;
  state: "queued" | "transport" | "settled";
}

interface RequestRecord {
  readonly command: PipeCommand;
  readonly role: "ordinary" | "status" | "stop" | "rejection";
  phase: "deferred" | "executing" | "response";
  readonly frames: Set<OutboundFrame>;
}

class WorkerPipeCore {
  readonly #readable: Readable;
  readonly #writable: Writable;
  readonly #options: WorkerPipeOptions;
  readonly #decoder = createPipeDecoder();
  readonly #outbound: OutboundFrame[] = [];
  readonly #pending = new Map<string, RequestRecord>();
  readonly #unsettledFrames = new Set<OutboundFrame>();
  readonly #deferredControl: RequestRecord[] = [];
  readonly #closedPromise: Promise<WorkerPipeClose>;
  #resolveClosed!: (value: WorkerPipeClose) => void;
  #state: WorkerPipeSnapshot["state"] = "awaiting-hello";
  #hello: Hello | undefined;
  #execution: WorkerExecution | undefined;
  #queuedBytes = 0;
  #transportFrameBytes = 0;
  #reservedReplyBytes = 0;
  #extraResponseItems = 0;
  #peakAccountedBytes = 0;
  #blocked = false;
  #blockedFrameBytes = 0;
  #activeChunk: Uint8Array | undefined;
  #activeOffset = 0;
  #peakDecodeSliceBytes = 0;
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
    readable.once("close", this.#onReadClose);
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
      pendingCommands: [...this.#pending.values()].filter((record) => record.phase === "executing")
        .length,
      outstandingRequests: this.#pending.size,
      responseItems: this.#unsettledFrames.size,
      // The backing buffer stays live until the complete chunk is released.
      ingressBytes: (this.#activeChunk?.buffer.byteLength ?? 0) + this.#decoder.retainedBytes,
      peakDecodeSliceBytes: this.#peakDecodeSliceBytes,
      queuedBytes: this.#queuedBytes,
      transportBytes: this.#transportBytes(),
      ordinaryAccountedBytes: this.#ordinaryAccountedBytes(),
      peakAccountedBytes: this.#peakAccountedBytes,
      blocked: this.#blocked,
    };
  }

  shutdown(reason: string): Promise<WorkerPipeClose> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    // Latch before stream teardown or execution disposal can reenter shutdown.
    this.#shutdownPromise = this.#closedPromise;
    this.#state = "closing";
    const uncertainRequestIds = [...this.#pending.keys()];
    this.#readable.pause();
    this.#readable.off("data", this.#onData);
    this.#readable.off("end", this.#onEnd);
    this.#readable.off("error", this.#onReadError);
    this.#readable.off("close", this.#onReadClose);
    this.#writable.off("drain", this.#onDrain);
    this.#writable.off("error", this.#onWriteError);
    this.#writable.off("close", this.#onWriteClose);
    this.#activeChunk = undefined;
    this.#outbound.length = 0;
    this.#queuedBytes = 0;
    void (async () => {
      let disposalReceipts: WorkerPipeClose["disposalReceipts"] = [];
      let disposalUnverifiable = false;
      try {
        disposalReceipts = (await this.#execution?.shutdown(reason)) ?? [];
      } catch {
        // An unverified dispose cannot turn an in-flight command into a known failure.
        disposalUnverifiable = true;
      }
      try {
        if (!this.#writable.destroyed && !this.#writable.writableEnded) this.#writable.end();
      } catch {
        disposalUnverifiable = true;
      }
      this.#state = "closed";
      const closed = { reason, uncertainRequestIds, disposalReceipts, disposalUnverifiable };
      this.#resolveClosed(closed);
    })();
    return this.#shutdownPromise;
  }

  #transportBytes(): number {
    return Math.max(
      this.#writable.writableLength,
      this.#blockedFrameBytes,
      this.#transportFrameBytes,
    );
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

  #ordinaryAccountedBytes(): number {
    let bytes = 0;
    for (const record of this.#pending.values())
      if (record.role === "ordinary" && record.phase === "executing") bytes += MAX_REPLY_BYTES;
    for (const frame of this.#unsettledFrames) if (!frame.control) bytes += frame.bytes.byteLength;
    // Unknown third-party writable buffering cannot borrow the control reserve.
    return bytes + Math.max(0, this.#writable.writableLength - this.#transportFrameBytes);
  }

  #role(command: PipeCommand): "ordinary" | "status" | "stop" {
    return command.type === "status" || command.type === "stop" ? command.type : "ordinary";
  }

  #slotAvailable(role: "ordinary" | "status" | "stop"): boolean {
    let count = 0;
    for (const record of this.#pending.values()) if (record.role === role) count++;
    return role === "ordinary"
      ? count < this.#hello!.effectiveBudgets.pendingWorkerCommands
      : count === 0;
  }

  #replyCapacity(role: "ordinary" | "status" | "stop"): boolean {
    if (this.#accountedBytes() + MAX_REPLY_BYTES > this.#hello!.effectiveBudgets.pipeQueuedBytes)
      return false;
    return (
      role !== "ordinary" ||
      this.#ordinaryAccountedBytes() + 2 * MAX_REPLY_BYTES <= this.#ordinaryLimit()
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
      chunk.buffer.byteLength + this.#decoder.retainedBytes >
      (this.#hello?.effectiveBudgets.pipeQueuedBytes ?? M0_LIMITS.pipeQueuedBytes)
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
        const read = this.#decoder.read(remaining);
        this.#activeOffset += read.consumedBytes;
        // Decoder-owned frame copies are consumed in this synchronous slice, not queued at the endpoint.
        this.#peakDecodeSliceBytes = Math.max(
          this.#peakDecodeSliceBytes,
          read.frames.reduce(
            (bytes, frame) => bytes + frame.metadata.byteLength + frame.payload.byteLength,
            0,
          ),
        );
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
      if (
        this.#activeChunk &&
        this.#activeChunk.buffer.byteLength + this.#decoder.retainedBytes >
          metadata.effectiveBudgets.pipeQueuedBytes
      ) {
        void this.shutdown("ingress-capacity-exceeded");
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
    const outstanding = this.#pending.get(command.requestId);
    if (outstanding) {
      if (this.#extraResponseItems !== 0) {
        void this.shutdown("duplicate-response-capacity");
        return false;
      }
      const duplicate: PipeError = {
        type: "error",
        worker: command.worker,
        run: command.run,
        requestId: command.requestId,
        commandType: command.type,
        error: domainError("OPERATION_ID_CONFLICT"),
      };
      if (
        !this.#enqueue(
          duplicate,
          4,
          outstanding.role === "status" || outstanding.role === "stop",
          outstanding,
          true,
        )
      )
        void this.shutdown("duplicate-response-capacity");
      return true;
    }
    const role = this.#role(command);
    if (!this.#slotAvailable(role)) return this.#rejectBusy(command);
    const record: RequestRecord = { command, role, phase: "deferred", frames: new Set() };
    this.#pending.set(command.requestId, record);
    if (!this.#replyCapacity(role)) {
      if (role === "ordinary") {
        this.#pending.delete(command.requestId);
        return this.#rejectBusy(command);
      }
      this.#deferredControl.push(record);
      return true;
    }
    this.#startExecution(record, frame.payload);
    return true;
  }

  #rejectBusy(command: PipeCommand): boolean {
    if (this.#extraResponseItems !== 0) {
      void this.shutdown("rejection-slot-exhausted");
      return false;
    }
    const record: RequestRecord = {
      command,
      role: "rejection",
      phase: "response",
      frames: new Set(),
    };
    this.#pending.set(command.requestId, record);
    const busy: PipeError = {
      type: "error",
      worker: command.worker,
      run: command.run,
      requestId: command.requestId,
      commandType: command.type,
      error: domainError("BUSY"),
    };
    if (
      !this.#enqueue(busy, 4, command.type === "status" || command.type === "stop", record, true)
    ) {
      void this.shutdown("rejection-byte-capacity");
      return false;
    }
    return true;
  }

  #startExecution(record: RequestRecord, payload?: Uint8Array): void {
    record.phase = "executing";
    this.#reservedReplyBytes += MAX_REPLY_BYTES;
    this.#recordPeak();
    void this.#execution!.execute(record.command, payload).then(
      (response) => this.#completeCommand(record, response),
      () => this.#completeCommand(record, this.#unknownError(record.command)),
    );
  }

  #tryStartDeferred(): void {
    if (this.#state !== "ready") return;
    for (let index = 0; index < this.#deferredControl.length;) {
      const record = this.#deferredControl[index]!;
      if (!this.#replyCapacity(record.role === "status" ? "status" : "stop")) {
        index++;
        continue;
      }
      this.#deferredControl.splice(index, 1);
      this.#startExecution(record);
    }
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

  #completeCommand(record: RequestRecord, response: PipeResult | PipeError): void {
    const command = record.command;
    if (this.#pending.get(command.requestId) !== record || record.phase !== "executing") return;
    record.phase = "response";
    this.#reservedReplyBytes -= MAX_REPLY_BYTES;
    if (this.#state !== "ready") return;
    if (!validatePipeResultForCommand(command, response)) {
      void this.shutdown("invalid-execution-correlation");
      return;
    }
    if (
      !this.#enqueue(
        response,
        response.type === "result" ? 2 : 4,
        record.role === "status" || record.role === "stop",
        record,
      )
    ) {
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
    request?: RequestRecord,
    extra = false,
  ): boolean {
    const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
    if (!validatePipeFrame({ kind, metadata: metadataBytes, payload: emptyPayload }, metadata).ok)
      return false;
    const encoded = encodePipeFrame(kind, metadataBytes, emptyPayload);
    if (!encoded.ok || !this.#hello) return false;
    const total = this.#accountedBytes() + encoded.value.byteLength;
    if (total > this.#hello.effectiveBudgets.pipeQueuedBytes) return false;
    if (
      !control &&
      this.#ordinaryAccountedBytes() + encoded.value.byteLength > this.#ordinaryLimit()
    )
      return false;
    const frame: OutboundFrame = {
      bytes: encoded.value,
      ...(request && { request }),
      control,
      extra,
      state: "queued",
    };
    this.#outbound.push(frame);
    this.#unsettledFrames.add(frame);
    request?.frames.add(frame);
    if (extra) this.#extraResponseItems++;
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
      frame.state = "transport";
      this.#transportFrameBytes += frame.bytes.byteLength;
      let accepted: boolean;
      try {
        accepted = this.#writable.write(Buffer.from(frame.bytes), (error) => {
          if (error) {
            void this.shutdown("stdout-write-failed");
          } else {
            this.#settleFrame(frame);
          }
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

  #settleFrame(frame: OutboundFrame): void {
    if (frame.state === "settled") return;
    if (frame.state === "transport") this.#transportFrameBytes -= frame.bytes.byteLength;
    frame.state = "settled";
    this.#unsettledFrames.delete(frame);
    frame.request?.frames.delete(frame);
    if (frame.extra) this.#extraResponseItems--;
    const record = frame.request;
    if (
      record &&
      record.phase === "response" &&
      record.frames.size === 0 &&
      this.#pending.get(record.command.requestId) === record
    )
      this.#pending.delete(record.command.requestId);
    this.#tryStartDeferred();
  }

  #onDrain = (): void => {
    this.#blocked = false;
    this.#blockedFrameBytes = 0;
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

  #onReadClose = (): void => {
    void this.shutdown("stdin-close");
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
