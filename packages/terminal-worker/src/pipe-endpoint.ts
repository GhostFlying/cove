import { monitorEventLoopDelay, performance, type ELDHistogram } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import { sameWorkerRef } from "@cove/protocol/identity";
import {
  HEADER_BYTES,
  MAX_METADATA_BYTES,
  PIPE_HEARTBEAT_FRAME_BYTES,
  PIPE_HEARTBEAT_INTERVAL_MS,
  PIPE_ROUTE_CONTROL_COMMANDS,
  PIPE_PREPAID_ROUTE_CONTROL_BYTES,
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
  type WorkerLoad,
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
type Heartbeat = {
  readonly type: "heartbeat";
  readonly worker: Hello["worker"];
  readonly load: WorkerLoad;
};
// Event-loop delay sampling resolution for the heartbeat's load report (issue #103).
const LOOP_DELAY_RESOLUTION_MS = 10;
const LOAD_MS_CAP = 3_600_000;
const loadMs = (value: number): number =>
  Number.isFinite(value) ? Math.min(LOAD_MS_CAP, Math.max(0, Math.round(value))) : 0;

export interface WorkerPipeOptions {
  readonly buildVersion: string;
  readonly createExecution?: (options: WorkerExecutionOptions) => WorkerExecution;
  readonly onFault?: WorkerExecutionOptions["onFault"];
  readonly onFact?: WorkerExecutionOptions["onFact"];
  // Tests only; production uses PIPE_HEARTBEAT_INTERVAL_MS.
  readonly heartbeatIntervalMs?: number;
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
  readonly heartbeat?: boolean;
  state: "queued" | "transport" | "settled";
}

interface RequestRecord {
  readonly command: PipeCommand;
  readonly role: "ordinary" | "status" | "stop" | "route" | "rejection";
  phase: "parked" | "deferred" | "executing" | "response";
  readonly frames: Set<OutboundFrame>;
}

// The bound on ingress storage as measured by #ingressBytes(). The runtime may have
// pipeQueuedBytes of ordinary and control frames plus PIPE_PREPAID_ROUTE_CONTROL_BYTES of prepaid
// route-control frames in flight (issue #96). The prepaid allowance is counted twice: those
// frames can still sit in a not yet fully read chunk while their parked copies exist. Bytes of
// in-flight frames are otherwise owned once: a fully read chunk is released before its frames
// are handled, and the decoder owns only the partial-frame bytes it holds. Past this bound the
// pipe still fails closed.
function ingressLimit(pipeQueuedBytes: number): number {
  return pipeQueuedBytes + 2 * PIPE_PREPAID_ROUTE_CONTROL_BYTES;
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

// The main thread's CPU time in microseconds, where the platform measures it per thread.
function threadCpuMicros(): number | undefined {
  try {
    const usage = (
      process as { threadCpuUsage?: () => { user: number; system: number } }
    ).threadCpuUsage?.();
    return usage ? usage.user + usage.system : undefined;
  } catch {
    return undefined;
  }
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
  // keeps at most PIPE_ROUTE_CONTROL_COMMANDS route commands outstanding (see
  // #routeWindowRecords), so this never holds more than that many.
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
  // A chunk is in progress from #onData until every byte is decoded (#ingressActive gates flow
  // control and overlapping-ingress detection). Its backing (#activeChunk) is released as soon as
  // the decoder has consumed it, which can be before the frames it produced are handled.
  #ingressActive = false;
  #activeChunk: Uint8Array | undefined;
  #activeOffset = 0;
  #peakDecodeSliceBytes = 0;
  #processing = false;
  #allowCommands = false;
  #shutdownPromise: Promise<WorkerPipeClose> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #heartbeatUnsettled = false;
  // Load sampling between heartbeats (see #sampleLoad).
  #loopDelay: ELDHistogram | undefined;
  #loadSampledAt = 0;
  #threadCpuMicros: number | undefined;

  constructor(readable: Readable, writable: Writable, options: WorkerPipeOptions) {
    if (!options.buildVersion || options.buildVersion.length > 128)
      throw new TypeError("Invalid worker build version");
    if (
      options.heartbeatIntervalMs !== undefined &&
      (!Number.isSafeInteger(options.heartbeatIntervalMs) || options.heartbeatIntervalMs < 1)
    )
      throw new TypeError("Invalid worker heartbeat interval");
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
      ingressBytes: this.#ingressBytes(),
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
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#loopDelay?.disable();
    this.#loopDelay = undefined;
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
    this.#ingressActive = false;
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

  // The one measure of ingress storage the endpoint owns, used by every admission check and by
  // snapshot(): the backing of a chunk still held (the whole ArrayBuffer, which may be a pooled
  // slab), the decoder's exact partial-frame storage and the parked route-control copies.
  // Frames a read produces are consumed synchronously and tracked as peakDecodeSliceBytes.
  #ingressBytes(): number {
    return (
      (this.#activeChunk?.buffer.byteLength ?? 0) +
      this.#decoder.storageBytes +
      this.#parkedRouteBytes
    );
  }

  // Every byte the worker owes the runtime except the one prepaid heartbeat frame (see
  // PIPE_HEARTBEAT_FRAME_BYTES), which is outside pipeQueuedBytes. Once the heartbeat has left
  // the writable's buffer but its callback has not run, subtracting it can undercount the other
  // frames by at most that one frame, so the outbound total stays within pipeQueuedBytes plus
  // PIPE_HEARTBEAT_FRAME_BYTES, the bound the runtime's ingress allows.
  #accountedBytes(): number {
    return Math.max(
      0,
      this.#reservedReplyBytes +
        this.#queuedBytes +
        this.#transportBytes() -
        this.#heartbeatOwedBytes(),
    );
  }

  #heartbeatOwedBytes(): number {
    for (const frame of this.#unsettledFrames) if (frame.heartbeat) return frame.bytes.byteLength;
    return 0;
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
    for (const frame of this.#unsettledFrames)
      if (!frame.control && !frame.heartbeat) bytes += frame.bytes.byteLength;
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
      : count === 0;
  }

  // The one slot for a reply nobody reserved a class for: a BUSY outside the ordinary window
  // or a duplicate-ID error. It also waits for route control to be idle, as it always has.
  // Route control itself does not wait for this slot: ordinary BUSY replies may legally be
  // refilled without pause, and a parked unsubscribe that had to wait for a moment with none
  // outstanding could be starved past its runtime deadline. Reply bytes stay bounded either
  // way, because every control reply still passes #replyCapacity or is deferred.
  #sharedReplySlotAvailable(): boolean {
    return (
      this.#slotAvailable("route") &&
      this.#extraResponseItems === 0 &&
      ![...this.#pending.values()].some((record) => record.role === "rejection")
    );
  }

  // Route records the runtime still counts against its PIPE_ROUTE_CONTROL_COMMANDS window. The
  // runtime frees a window slot as soon as it reads the reply, which it can do once the reply
  // frame is handed to the writable: the write callback may run later, since neither a stream
  // nor an OS pipe orders it before the peer's read. So a record whose reply frames have all
  // been handed off no longer counts here, although it keeps the route execution slot and its
  // reply's byte charge until the callback. Counting it until the callback made a conforming
  // runtime that promoted the next command on reading the reply look like an overflow, and the
  // worker failed closed (issue #96). Route execution is serial until that callback, so at
  // most one such record exists at a time.
  #routeWindowRecords(): number {
    let count = 0;
    for (const record of this.#pending.values())
      if (
        record.role === "route" &&
        !(
          record.phase === "response" &&
          [...record.frames].every((frame) => frame.state !== "queued")
        )
      )
        count++;
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
    if (this.#ingressActive) {
      void this.shutdown("overlapping-ingress");
      return;
    }
    if (
      chunk.buffer.byteLength + this.#ingressBytes() >
      ingressLimit(this.#hello?.effectiveBudgets.pipeQueuedBytes ?? M0_LIMITS.pipeQueuedBytes)
    ) {
      void this.shutdown("ingress-capacity-exceeded");
      return;
    }
    this.#activeChunk = chunk;
    this.#ingressActive = true;
    this.#activeOffset = 0;
    this.#processChunk();
  };

  #processChunk(): void {
    if (this.#processing || !this.#ingressActive) return;
    this.#processing = true;
    try {
      while (this.#ingressActive && this.#state !== "closing" && this.#state !== "closed") {
        if (!this.#activeChunk || this.#activeOffset === this.#activeChunk.byteLength) {
          this.#activeChunk = undefined;
          this.#ingressActive = false;
          this.#activeOffset = 0;
          if (this.#hello && !this.#blocked) this.#allowCommands = true;
          if (!this.#blocked) this.#readable.resume();
          break;
        }
        const { read, provenanceFailed } = this.#readActiveChunk(this.#activeChunk);
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
        if (provenanceFailed) {
          void this.shutdown("decoder-partial-provenance");
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

  // Reads the unconsumed rest of the chunk and settles its ownership before any returned frame is
  // handled, so the parked-admission check in #handleFrame counts only storage still owned:
  // - On a budget yield the decoder's unproduced tail is rewound into the chunk (it must have come
  //   from this read, after a produced frame; otherwise provenanceFailed) and the decoder reset,
  //   so those bytes are counted once, as chunk backing.
  // - Once every byte has moved into the decoder or the returned frames, the chunk is released.
  #readActiveChunk(chunk: Uint8Array): {
    read: ReturnType<ReturnType<typeof createPipeDecoder>["read"]>;
    provenanceFailed: boolean;
  } {
    const read = this.#decoder.read(chunk.subarray(this.#activeOffset));
    this.#activeOffset += read.consumedBytes;
    let provenanceFailed = false;
    const partial = read.status === "budget" ? this.#decoder.retainedBytes : 0;
    if (partial !== 0) {
      if (read.frames.length === 0 || partial > read.consumedBytes) {
        provenanceFailed = true;
      } else {
        this.#activeOffset -= partial;
        this.#decoder = createPipeDecoder();
      }
    }
    if (this.#activeOffset === chunk.byteLength) this.#activeChunk = undefined;
    return { read, provenanceFailed };
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
      if (this.#ingressBytes() > ingressLimit(metadata.effectiveBudgets.pipeQueuedBytes)) {
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
      this.#startHeartbeat();
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
      if (!parkedConflictSlot && !this.#sharedReplySlotAvailable()) {
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
    // counted until it reads each reply (see #routeWindowRecords). A count past the window
    // means the runtime broke the contract, and the pipe fails closed.
    if (role === "route" && (!this.#slotAvailable(role) || this.#parkedRouteControl.length)) {
      const metadata = frame.metadata.slice();
      if (
        this.#routeWindowRecords() >= PIPE_ROUTE_CONTROL_COMMANDS ||
        frame.payload.byteLength !== 0 ||
        this.#ingressBytes() + metadata.byteLength >
          ingressLimit(this.#hello.effectiveBudgets.pipeQueuedBytes)
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

  // A BUSY reply normally takes the shared reply slot, one at a time. An ordinary
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
    if (!this.#sharedReplySlotAvailable() && !this.#ordinaryRejectionFits(command)) {
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

  // The runtime's liveness signal (issue #103). A timer, not command execution, drives it, so it
  // keeps flowing while commands queue behind parsing on a saturated worker; only a worker whose
  // event loop stops for the runtime's whole liveness window (or whose process or pipe ends) is
  // declared lost. At most one heartbeat is unsettled at a time, in its own prepaid slot
  // (PIPE_HEARTBEAT_FRAME_BYTES): it neither borrows nor waits for the control reserve or
  // pipeQueuedBytes, so no command, however slow, can suppress it, and it can never displace a
  // reply whose capacity was reserved at admission. Only a blocked transport delays it: the
  // next beat waits until the previous one's write callback has run.
  #startHeartbeat(): void {
    const interval = this.#options.heartbeatIntervalMs ?? PIPE_HEARTBEAT_INTERVAL_MS;
    try {
      this.#loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
      this.#loopDelay.enable();
    } catch {
      this.#loopDelay = undefined;
    }
    this.#loadSampledAt = performance.now();
    this.#threadCpuMicros = threadCpuMicros();
    this.#heartbeatTimer = setInterval(() => this.#beat(), interval);
    // The worker's lifetime follows stdin, never this timer.
    this.#heartbeatTimer.unref?.();
  }

  #beat(): void {
    if (this.#state !== "ready" || this.#heartbeatUnsettled) return;
    const heartbeat: Heartbeat = {
      type: "heartbeat",
      worker: this.#hello!.worker,
      load: this.#sampleLoad(),
    };
    if (this.#enqueue(heartbeat, 2, false, undefined, false, true)) this.#heartbeatUnsettled = true;
  }

  // The worker's own load since the previous sample: event-loop delay (the main signal of a
  // saturated worker), its main thread's CPU share (supporting data only) and its backlog. A
  // sample is taken only when a heartbeat is sent, so a skipped beat folds into the next window.
  #sampleLoad(): WorkerLoad {
    const now = performance.now();
    const windowMs = loadMs(now - this.#loadSampledAt);
    this.#loadSampledAt = now;
    // The heartbeat timer's own lateness is one more delay sample. It matters most when the
    // loop is blocked so much that the histogram's sampling timer did not fire at all in the
    // window: an empty histogram then means the worst delay, not none. With few samples, p99 is
    // in effect the maximum, so the lateness raises it; with many, one sample cannot.
    const interval = this.#options.heartbeatIntervalMs ?? PIPE_HEARTBEAT_INTERVAL_MS;
    const lateMs = loadMs(windowMs - interval);
    const histogram = this.#loopDelay;
    const count = histogram?.count ?? 0;
    const histogramP99 = count > 0 ? loadMs(histogram!.percentile(99) / 1e6) : 0;
    const histogramMax = count > 0 ? loadMs(histogram!.max / 1e6) : 0;
    const eventLoopDelayP99Ms = count >= 100 ? histogramP99 : Math.max(histogramP99, lateMs);
    const eventLoopDelayMaxMs = Math.max(histogramMax, lateMs);
    histogram?.reset();
    const cpu = threadCpuMicros();
    const previous = this.#threadCpuMicros;
    this.#threadCpuMicros = cpu;
    const cpuPercent =
      cpu === undefined || previous === undefined || windowMs === 0
        ? null
        : Math.min(100, Math.max(0, Math.round((cpu - previous) / 10 / windowMs)));
    let parseBacklogBytes = 0;
    try {
      const bytes = this.#execution?.parseBacklogBytes?.() ?? 0;
      if (Number.isSafeInteger(bytes) && bytes >= 0) parseBacklogBytes = bytes;
    } catch {
      // A failing measurement reports no backlog rather than stopping the heartbeat.
    }
    let executingCommands = 0;
    for (const record of this.#pending.values())
      if (record.phase === "executing") executingCommands++;
    return {
      windowMs,
      eventLoopDelayP99Ms,
      eventLoopDelayMaxMs,
      cpuPercent,
      parseBacklogBytes,
      executingCommands: Math.min(65_536, executingCommands),
    };
  }

  #startExecution(record: RequestRecord, payload?: Uint8Array): void {
    record.phase = "executing";
    this.#reservedReplyBytes += MAX_REPLY_BYTES;
    this.#recordPeak();
    // Validated zero-length wire payloads are absent at the execution boundary.
    const executionPayload =
      record.command.type === "spawn" ||
      record.command.type === "input" ||
      record.command.type === "programmatic-input"
        ? payload
        : undefined;
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
    if (!this.#ingressActive) this.#readable.resume();
  }

  #enqueue(
    metadata: Ready | Heartbeat | PipeResult | PipeError,
    kind: 2 | 4,
    control: boolean,
    request?: RequestRecord,
    extra = false,
    heartbeat = false,
  ): boolean {
    const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
    if (!validatePipeFrame({ kind, metadata: metadataBytes, payload: emptyPayload }, metadata).ok)
      return false;
    const encoded = encodePipeFrame(kind, metadataBytes, emptyPayload);
    if (!encoded.ok || !this.#hello) return false;
    if (heartbeat) {
      // The prepaid slot: one frame of at most PIPE_HEARTBEAT_FRAME_BYTES, never charged to
      // the reserve or the queue bound (#beat ensures at most one is unsettled).
      if (encoded.value.byteLength > PIPE_HEARTBEAT_FRAME_BYTES) return false;
    } else {
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
    }
    const frame: OutboundFrame = {
      bytes: encoded.value,
      ...(request && { request }),
      control,
      extra,
      ...(heartbeat && { heartbeat }),
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
    if (frame.heartbeat) this.#heartbeatUnsettled = false;
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
    if (this.#hello && !this.#ingressActive) this.#allowCommands = true;
    this.#flush();
    this.#execution?.deliveryCapacity?.();
    this.#processChunk();
    if (!this.#ingressActive && this.#state === "ready") this.#readable.resume();
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
