import type { Readable, Writable } from "node:stream";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import { sameWorkerRef } from "@cove/protocol/identity";
import {
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_METADATA_BYTES,
  PIPE_ROUTE_CONTROL_COMMANDS,
  PIPE_VERSION,
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
  validatePipeReadiness,
  validatePipeResultForCommand,
  type PipeCommand,
  type PipeError,
  type PipeEvent,
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
  readonly parkedRequests: number;
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
  bytes: Uint8Array;
  readonly token?: number;
  request?: RequestRecord;
  readonly control: boolean;
  readonly extra: boolean;
  state: "queued" | "transport" | "settled";
}

interface RequestRecord {
  readonly command: PipeCommand;
  readonly role: "ordinary" | "status" | "stop" | "route" | "rejection";
  phase: "parked" | "deferred" | "executing" | "response";
  readonly frames: Set<OutboundFrame>;
}

function guardTerminalErrors(stream: Readable | Writable, pendingCallbacks = 0): () => void {
  if (stream.closed && pendingCallbacks === 0) return () => {};
  // The stream alone owns late callback errors until close; no execution graph is retained.
  const ignoreTerminalError = (): void => {};
  let closed = stream.closed;
  let remaining = pendingCallbacks;
  const release = (): void => {
    if (closed && remaining === 0) stream.off("error", ignoreTerminalError);
  };
  stream.on("error", ignoreTerminalError);
  if (!closed)
    stream.once("close", () => {
      closed = true;
      release();
    });
  return () => {
    if (remaining > 0) remaining--;
    // Node may emit the write error after invoking its write callback.
    if (closed && remaining === 0) setImmediate(release);
  };
}

class WorkerPipeCore {
  readonly #readable: Readable;
  readonly #writable: Writable;
  readonly #options: WorkerPipeOptions;
  #decoder = createPipeDecoder();
  readonly #outbound: OutboundFrame[] = [];
  readonly #pending = new Map<string, RequestRecord>();
  readonly #unsettledFrames = new Set<OutboundFrame>();
  readonly #deferredControl: RequestRecord[] = [];
  // Route-control frames that arrived while the single route slot was taken, in arrival
  // order. Each is an exact-size metadata copy charged to ingress until admitted. The runtime
  // keeps at most PIPE_ROUTE_CONTROL_COMMANDS route commands outstanding, so together with
  // the executing or still-unsettled one this never exceeds that bound.
  readonly #parkedRouteControl: Uint8Array[] = [];
  #parkedRouteBytes = 0;
  #controlCursor = 0;
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
  #writableClosed = false;
  #writeCallbacksPending = 0;
  #writeGuardCallbackSettled: (() => void) | undefined;
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
      parkedRequests: [...this.#pending.values()].filter((record) => record.phase === "parked")
        .length,
      responseItems: this.#unsettledFrames.size,
      // The backing buffer stays live until the complete chunk is released.
      ingressBytes:
        (this.#activeChunk?.buffer.byteLength ?? 0) +
        this.#decoderStorageBound() +
        this.#parkedRouteBytes,
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
    guardTerminalErrors(this.#readable);
    this.#writeGuardCallbackSettled = guardTerminalErrors(
      this.#writable,
      this.#writeCallbacksPending,
    );
    this.#readable.pause();
    this.#readable.off("data", this.#onData);
    this.#readable.off("end", this.#onEnd);
    this.#readable.off("error", this.#onReadError);
    this.#readable.off("close", this.#onReadClose);
    this.#writable.off("drain", this.#onDrain);
    this.#writable.off("error", this.#onWriteError);
    this.#activeChunk = undefined;
    this.#outbound.length = 0;
    this.#deferredControl.length = 0;
    this.#parkedRouteControl.length = 0;
    this.#parkedRouteBytes = 0;
    this.#queuedBytes = 0;
    for (const frame of this.#unsettledFrames) {
      delete frame.request;
      if (frame.state === "queued") {
        frame.state = "settled";
        this.#unsettledFrames.delete(frame);
        if (frame.extra) this.#extraResponseItems--;
        frame.bytes = emptyPayload;
      }
    }
    if (this.#writable.closed) this.#retireTransport();
    else if (
      this.#transportFrameBytes === 0 &&
      this.#blockedFrameBytes === 0 &&
      this.#writable.writableLength === 0
    )
      this.#writable.off("close", this.#onWriteClose);
    this.#pending.clear();
    this.#reservedReplyBytes = 0;
    void (async () => {
      let disposalReceipts: WorkerPipeClose["disposalReceipts"] = [];
      let disposalUnverifiable = false;
      try {
        disposalReceipts = (await this.#execution?.shutdown(reason)) ?? [];
      } catch {
        // An unverified dispose cannot turn an in-flight command into a known failure.
        disposalUnverifiable = true;
      }
      this.#execution = undefined;
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
    if (this.#writableClosed) return 0;
    return Math.max(
      this.#writable.writableLength,
      this.#blockedFrameBytes,
      this.#transportFrameBytes,
    );
  }

  #decoderStorageBound(): number {
    const filled = this.#decoder.retainedBytes;
    if (filled === 0) return 0;
    // A complete header can allocate the full validated frame before its body arrives.
    return filled < HEADER_BYTES ? HEADER_BYTES : MAX_FRAME_BYTES;
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
    return (
      bytes +
      (this.#writableClosed
        ? 0
        : Math.max(0, this.#writable.writableLength - this.#transportFrameBytes))
    );
  }

  #role(command: PipeCommand): "ordinary" | "status" | "stop" | "route" {
    if (command.type === "status" || command.type === "stop") return command.type;
    if (
      command.type === "applied-ack" ||
      command.type === "baseline-progress" ||
      command.type === "unsubscribe"
    )
      return "route";
    return "ordinary";
  }

  #slotAvailable(role: "ordinary" | "status" | "stop" | "route"): boolean {
    let count = 0;
    for (const record of this.#pending.values())
      if (record.role === role && record.phase !== "parked") count++;
    return role === "ordinary"
      ? count < this.#hello!.effectiveBudgets.pendingWorkerCommands
      : role === "route"
        ? count === 0 &&
          this.#extraResponseItems === 0 &&
          ![...this.#pending.values()].some((record) => record.role === "rejection")
        : count === 0;
  }

  #routeRecords(): number {
    let count = 0;
    for (const record of this.#pending.values()) if (record.role === "route") count++;
    return count;
  }

  #controlAccountedBytes(): number {
    let bytes = 0;
    for (const record of this.#pending.values())
      if (record.role !== "ordinary" && record.phase === "executing") bytes += MAX_REPLY_BYTES;
    for (const frame of this.#unsettledFrames) if (frame.control) bytes += frame.bytes.byteLength;
    return bytes;
  }

  #replyCapacity(role: "ordinary" | "status" | "stop" | "route" | "rejection"): boolean {
    if (this.#accountedBytes() + MAX_REPLY_BYTES > this.#hello!.effectiveBudgets.pipeQueuedBytes)
      return false;
    return role === "ordinary"
      ? this.#ordinaryAccountedBytes() + 2 * MAX_REPLY_BYTES <= this.#ordinaryLimit()
      : this.#controlAccountedBytes() + MAX_REPLY_BYTES <=
          this.#hello!.effectiveBudgets.reservedControlBytes;
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
      chunk.buffer.byteLength + this.#decoder.retainedBytes + this.#parkedRouteBytes >
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
          const partial = this.#decoder.retainedBytes;
          if (partial !== 0) {
            if (read.frames.length === 0 || partial > read.consumedBytes) {
              void this.shutdown("decoder-partial-provenance");
              break;
            }
            // Only the unproduced tail is rewound; completed frames already entered execution.
            this.#activeOffset -= partial;
            this.#decoder = createPipeDecoder();
          }
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
        this.#activeChunk.buffer.byteLength + this.#decoder.retainedBytes + this.#parkedRouteBytes >
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
          delivery: {
            enqueue: (event, payload, token) => this.#enqueueEvent(event, payload, token),
            cancelUnsent: (token) => this.#cancelUnsent(token),
          },
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
      const parkedConflictSlot =
        outstanding.phase === "parked" &&
        this.#extraResponseItems === 0 &&
        ![...this.#pending.values()].some((record) => record.role === "rejection");
      if (!parkedConflictSlot && !this.#slotAvailable("route")) {
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
      if (!this.#enqueue(duplicate, 4, true, outstanding, true))
        void this.shutdown("duplicate-response-capacity");
      return true;
    }
    const role = this.#role(command);
    // Route control runs one command at a time, end to end, in arrival order. A later one
    // parks while the slot is taken, and also behind any already parked one so it cannot
    // overtake it. The runtime's window is PIPE_ROUTE_CONTROL_COMMANDS outstanding commands,
    // counted until it receives each reply; this worker holds each record until that reply's
    // write callback, which runs before the runtime can have read the reply. So a record
    // count past the window means the runtime broke the contract, and the pipe fails closed.
    if (role === "route" && (!this.#slotAvailable(role) || this.#parkedRouteControl.length)) {
      const metadata = frame.metadata.slice();
      if (
        this.#routeRecords() >= PIPE_ROUTE_CONTROL_COMMANDS ||
        frame.payload.byteLength !== 0 ||
        (this.#activeChunk?.buffer.byteLength ?? 0) +
          this.#decoderStorageBound() +
          this.#parkedRouteBytes +
          metadata.byteLength >
          this.#hello.effectiveBudgets.pipeQueuedBytes
      ) {
        void this.shutdown("route-control-ingress-capacity");
        return false;
      }
      // Parking owns the ID before any later ordinary command can claim it.
      this.#pending.set(command.requestId, {
        command,
        role,
        phase: "parked",
        frames: new Set(),
      });
      this.#parkedRouteControl.push(metadata);
      this.#parkedRouteBytes += metadata.byteLength;
      return true;
    }
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

  // A BUSY reply normally takes the slot route control uses, one at a time. An ordinary
  // command refused only for reply bytes (its output lane is backed up) is one of the
  // runtime's pendingWorkerCommands, though: the runtime may legally have that many ordinary
  // commands outstanding while a route command or an earlier BUSY is unsettled. So its
  // rejection may also be held within the ordinary window, counted with the executing ones.
  #ordinaryRejectionFits(command: PipeCommand): boolean {
    if (this.#role(command) !== "ordinary") return false;
    let count = 0;
    for (const record of this.#pending.values())
      if (
        (record.role === "ordinary" && record.phase !== "parked") ||
        (record.role === "rejection" && this.#role(record.command) === "ordinary")
      )
        count++;
    return count < this.#hello!.effectiveBudgets.pendingWorkerCommands;
  }

  #rejectBusy(command: PipeCommand): boolean {
    if (!this.#slotAvailable("route") && !this.#ordinaryRejectionFits(command)) {
      void this.shutdown("rejection-slot-exhausted");
      return false;
    }
    const record: RequestRecord = {
      command,
      role: "rejection",
      phase: "deferred",
      frames: new Set(),
    };
    this.#pending.set(command.requestId, record);
    if (!this.#replyCapacity("rejection")) {
      this.#deferredControl.push(record);
      return true;
    }
    return this.#emitBusy(record);
  }

  #emitBusy(record: RequestRecord): boolean {
    const command = record.command;
    record.phase = "response";
    const busy: PipeError = {
      type: "error",
      worker: command.worker,
      run: command.run,
      requestId: command.requestId,
      commandType: command.type,
      error: domainError("BUSY"),
    };
    if (!this.#enqueue(busy, 4, true, record, true)) {
      void this.shutdown("rejection-byte-capacity");
      return false;
    }
    return true;
  }

  #startExecution(record: RequestRecord, payload?: Uint8Array): void {
    record.phase = "executing";
    this.#reservedReplyBytes += MAX_REPLY_BYTES;
    this.#recordPeak();
    // Validated zero-length wire payloads are absent at the execution boundary.
    const executionPayload =
      record.command.type === "spawn" || record.command.type === "input" ? payload : undefined;
    void this.#execution!.execute(record.command, executionPayload).then(
      (response) => this.#completeCommand(record, response),
      () => this.#completeCommand(record, this.#unknownError(record.command)),
    );
  }

  #tryStartDeferred(): void {
    if (this.#state !== "ready") return;
    while (this.#deferredControl.length) {
      const roles = ["status", "stop", "route", "rejection"] as const;
      let selected = -1;
      for (let offset = 0; offset < roles.length; offset++) {
        const index = (this.#controlCursor + offset) % roles.length;
        const candidate = this.#deferredControl.findIndex((record) => record.role === roles[index]);
        if (candidate >= 0 && this.#replyCapacity(this.#deferredControl[candidate]!.role)) {
          selected = candidate;
          this.#controlCursor = (index + 1) % roles.length;
          break;
        }
      }
      if (selected < 0) break;
      const record = this.#deferredControl.splice(selected, 1)[0]!;
      if (record.role === "rejection") this.#emitBusy(record);
      else this.#startExecution(record);
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
        record.role !== "ordinary",
        record,
      )
    ) {
      void this.shutdown("response-send-failed");
      return;
    }
    this.#execution?.markerEnqueued?.(command, response);
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
      control &&
      this.#controlAccountedBytes() + encoded.value.byteLength >
        this.#hello.effectiveBudgets.reservedControlBytes
    )
      return false;
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

  #enqueueEvent(event: PipeEvent, payload: Uint8Array, token: number): number | false {
    if (this.#state !== "ready" || !this.#hello) return false;
    const metadataBytes = textEncoder.encode(JSON.stringify(event));
    if (!validatePipeFrame({ kind: 3, metadata: metadataBytes, payload }, event).ok) return false;
    const encoded = encodePipeFrame(3, metadataBytes, payload);
    if (!encoded.ok) return false;
    const bytes = encoded.value.byteLength;
    if (
      this.#accountedBytes() + bytes > this.#hello.effectiveBudgets.pipeQueuedBytes ||
      this.#ordinaryAccountedBytes() + bytes > this.#ordinaryLimit()
    )
      return false;
    const frame: OutboundFrame = {
      bytes: encoded.value,
      token,
      control: false,
      extra: false,
      state: "queued",
    };
    this.#outbound.push(frame);
    this.#unsettledFrames.add(frame);
    this.#queuedBytes += bytes;
    this.#recordPeak();
    this.#flush();
    return bytes;
  }

  #cancelUnsent(token: number): void {
    for (let index = this.#outbound.length - 1; index >= 0; index--) {
      const frame = this.#outbound[index]!;
      if (frame.token !== token || frame.state !== "queued") continue;
      this.#outbound.splice(index, 1);
      this.#queuedBytes -= frame.bytes.byteLength;
      this.#unsettledFrames.delete(frame);
      frame.bytes = emptyPayload;
      frame.state = "settled";
    }
  }

  #flush(): void {
    if (this.#blocked || this.#state === "closing" || this.#state === "closed") return;
    while (this.#outbound.length) {
      const frame = this.#outbound.shift()!;
      const frameBytes = frame.bytes.byteLength;
      this.#queuedBytes -= frameBytes;
      frame.state = "transport";
      this.#transportFrameBytes += frameBytes;
      let accepted: boolean;
      let callbackReturned = false;
      this.#writeCallbacksPending++;
      try {
        accepted = this.#writable.write(Buffer.from(frame.bytes), (error) => {
          if (callbackReturned) return;
          callbackReturned = true;
          this.#writeCallbacksPending--;
          this.#writeGuardCallbackSettled?.();
          if (error) {
            void this.shutdown("stdout-write-failed");
          } else {
            this.#settleFrame(frame);
          }
        });
      } catch {
        if (!callbackReturned) {
          callbackReturned = true;
          this.#writeCallbacksPending--;
          this.#writeGuardCallbackSettled?.();
        }
        void this.shutdown("stdout-write-failed");
        return;
      }
      if (this.#writableClosed || this.#state !== "ready") return;
      if (!accepted) {
        // write(false) has already handed off this frame. Never enqueue it again.
        this.#blocked = true;
        this.#blockedFrameBytes = frameBytes;
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
    delete frame.request;
    frame.bytes = emptyPayload;
    if (
      record &&
      record.phase === "response" &&
      record.frames.size === 0 &&
      this.#pending.get(record.command.requestId) === record
    ) {
      this.#pending.delete(record.command.requestId);
      this.#execution?.responseSettled?.(record.command.requestId);
    }
    this.#tryStartDeferred();
    this.#admitParkedRoute();
    this.#execution?.deliveryCapacity?.();
  }

  // Admits only the oldest parked frame; it takes the slot, so the next waits for its settlement.
  #admitParkedRoute(): void {
    const raw = this.#parkedRouteControl[0];
    if (!raw || !this.#slotAvailable("route") || this.#state !== "ready") return;
    this.#parkedRouteControl.shift();
    this.#parkedRouteBytes -= raw.byteLength;
    let decoded: unknown;
    try {
      decoded = JSON.parse(textDecoder.decode(raw));
    } catch {
      void this.shutdown("invalid-parked-route-json");
      return;
    }
    const checked = validatePipeFrame({ kind: 1, metadata: raw, payload: emptyPayload }, decoded);
    if (!checked.ok || !("requestId" in checked.value)) {
      void this.shutdown("invalid-parked-route-frame");
      return;
    }
    const command = checked.value as PipeCommand;
    const record = this.#pending.get(command.requestId);
    if (!record || record.phase !== "parked") {
      void this.shutdown("invalid-parked-route-owner");
      return;
    }
    record.phase = "deferred";
    if (this.#replyCapacity("route")) this.#startExecution(record);
    else this.#deferredControl.push(record);
  }

  #retireTransport(): void {
    if (this.#writableClosed) return;
    // Physical close ends ownership; it never acknowledges an uncertain response.
    this.#writableClosed = true;
    for (const frame of this.#unsettledFrames) {
      frame.request?.frames.delete(frame);
      delete frame.request;
      frame.bytes = emptyPayload;
      frame.state = "settled";
    }
    this.#unsettledFrames.clear();
    this.#outbound.length = 0;
    this.#queuedBytes = 0;
    this.#transportFrameBytes = 0;
    this.#blockedFrameBytes = 0;
    this.#blocked = false;
    this.#extraResponseItems = 0;
  }

  #onDrain = (): void => {
    this.#blocked = false;
    this.#blockedFrameBytes = 0;
    if (this.#hello && !this.#activeChunk) this.#allowCommands = true;
    this.#flush();
    this.#execution?.deliveryCapacity?.();
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
    this.#retireTransport();
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
