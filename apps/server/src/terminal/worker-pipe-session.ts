import {
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
  validatePipeReadiness,
  validatePipeResultForCommand,
  PIPE_VERSION,
  MAX_FRAME_BYTES,
  MAX_READ_BYTES,
  MAX_METADATA_BYTES,
  type PipeCommand,
  type PipeMetadata,
  type PipeEvent,
} from "@cove/protocol/pipe";
import { domainError, type DomainErrorKind } from "@cove/protocol/errors";
import { validateEffectiveBudgets, type EffectiveBudgets } from "@cove/protocol/budgets";
import {
  sameWorkerRef,
  sameRunRef,
  sameSubscriptionRef,
  type WorkerRef,
  type RunRef,
  type SubscriptionRef,
} from "@cove/protocol/identity";
import type { RuntimeResult } from "@cove/protocol/runtime";
import { RuntimeRetainedBytes, type ByteReservation } from "./runtime-retained-bytes.js";

export const SESSION_CONTROL_RESERVE = 6 * (6 * MAX_METADATA_BYTES + 2048) + 64 * 1024;

export interface PipeByteTransport {
  write(bytes: Uint8Array, settled: (error?: unknown) => void): boolean;
}
export interface PipeCodec {
  encode(text: string): Uint8Array;
  decode(bytes: Uint8Array): string;
}
export type ResultHandoff = (result: RuntimeResult) => boolean;
type Role = "ordinary" | "status" | "stop" | "progress";
type Pending = {
  command: PipeCommand;
  role: Role;
  deadline: number;
  resolve: (result: RuntimeResult) => void;
  handoff: ResultHandoff | undefined;
  sent: boolean;
};
type Outgoing = {
  bytes: Uint8Array;
  lease: ByteReservation;
  role: Role;
  request: Pending | undefined;
  owned: boolean;
};
type Route = { ref: SubscriptionRef; active: boolean; lease: ByteReservation };

export class WorkerPipeSession {
  readonly worker: WorkerRef;
  private readonly hello: Extract<PipeMetadata, { type: "hello" }>;
  private readonly decoder = createPipeDecoder();
  private readonly arena: ByteReservation;
  private readonly identities = new Map<string, ByteReservation>();
  private readonly pending = new Map<string, Pending>();
  private readonly queue: Outgoing[] = [];
  private readonly handed = new Set<Outgoing>();
  private readonly runs = new Map<string, RunRef>();
  private readonly routes: Route[] = [];
  private readonly listeners = new Map<
    (event: PipeEvent, payload: Uint8Array) => void,
    ByteReservation
  >();
  private state: "new" | "hello" | "ready" | "closed" = "new";
  private blocked = false;
  private flushing = false;
  private drainGeneration = 0;
  private receiving = false;
  private queuedBytes = 0;
  private physicalBytes = 0;
  private ordinaryBytes = 0;
  private lastNow = 0;
  private handshakeDeadline = 0;
  private released = false;

  constructor(
    private readonly options: {
      worker: WorkerRef;
      budgets: EffectiveBudgets;
      buildVersion: string;
      bytes: RuntimeRetainedBytes;
      transport: PipeByteTransport;
      codec: PipeCodec;
      now: () => number;
      timeoutMs: number;
      identityLimit: number;
      contactLost?: (worker: WorkerRef) => void;
    },
  ) {
    if (
      !validateEffectiveBudgets(options.budgets) ||
      options.bytes.limit > options.budgets.runtimeBytes ||
      options.bytes.controlReserve < SESSION_CONTROL_RESERVE ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      !Number.isSafeInteger(options.identityLimit) ||
      options.identityLimit < 1 ||
      options.identityLimit > 4096
    )
      throw new Error("Invalid session limits");
    this.worker = Object.freeze({ ...options.worker });
    this.hello = {
      type: "hello",
      worker: this.worker,
      pipeVersion: PIPE_VERSION,
      effectiveBudgets: { ...options.budgets },
      buildVersion: options.buildVersion,
    };
    const arena = options.bytes.reserve(
      2 * MAX_READ_BYTES + 3 * MAX_FRAME_BYTES + 6 * MAX_METADATA_BYTES + 1024,
    );
    if (!arena) throw new Error("Session byte capacity unavailable");
    this.arena = arena;
  }

  get ready(): boolean {
    return this.state === "ready";
  }
  get closed(): boolean {
    return this.state === "closed";
  }

  private now(): number {
    const now = this.options.now();
    if (
      !Number.isSafeInteger(now) ||
      now < this.lastNow ||
      now > Number.MAX_SAFE_INTEGER - this.options.timeoutMs
    )
      throw new Error("Invalid monotonic clock");
    this.lastNow = now;
    return now;
  }

  start(): boolean {
    if (this.state !== "new") return false;
    const bytes = this.encode(this.hello, new Uint8Array());
    if (!bytes) {
      this.loseContact();
      return false;
    }
    this.state = "hello";
    this.handshakeDeadline = this.now() + this.options.timeoutMs;
    if (!this.enqueue(bytes, "status", undefined)) {
      this.loseContact();
      return false;
    }
    this.flush();
    return !this.closed;
  }

  registerRun(run: RunRef): boolean {
    if (
      this.closed ||
      run.serverId !== this.worker.serverId ||
      run.relayInstanceId !== this.worker.relayInstanceId
    )
      return false;
    const existing = this.runs.get(run.runId);
    if (existing) return sameRunRef(existing, run);
    if (this.runs.size >= this.options.budgets.maxRuns) return false;
    this.runs.set(run.runId, { ...run });
    return true;
  }

  forgetUnstartedRun(run: RunRef): boolean {
    const found = this.runs.get(run.runId);
    if (
      !found ||
      !sameRunRef(found, run) ||
      [...this.pending.values()].some((entry) => sameRunRef(entry.command.run, run))
    )
      return false;
    this.runs.delete(run.runId);
    return true;
  }

  private encode(metadata: PipeMetadata, payload: Uint8Array): Uint8Array | null {
    try {
      const encodedMetadata = this.options.codec.encode(JSON.stringify(metadata));
      const encoded = encodePipeFrame(1, encodedMetadata, payload);
      if (!encoded.ok) return null;
      const checked = validatePipeFrame({ kind: 1, metadata: encodedMetadata, payload }, metadata);
      return checked.ok ? encoded.value : null;
    } catch {
      return null;
    }
  }

  private error(command: PipeCommand, kind: DomainErrorKind, uncertain = false): RuntimeResult {
    return {
      type: "error",
      worker: { ...this.worker },
      run: { ...command.run },
      requestId: command.requestId,
      commandType: command.type,
      error: domainError(
        kind,
        uncertain ? "unknown" : "not-accepted",
        uncertain && command.type === "input" ? "input" : undefined,
      ),
    };
  }

  private role(command: PipeCommand): Role {
    if (command.type === "status" || command.type === "stop") return command.type;
    return command.type === "applied-ack" ||
      command.type === "baseline-progress" ||
      command.type === "unsubscribe"
      ? "progress"
      : "ordinary";
  }

  request(
    command: PipeCommand,
    payload: Uint8Array = new Uint8Array(),
    handoff?: ResultHandoff,
  ): Promise<RuntimeResult> {
    if (!this.ready || !sameWorkerRef(command.worker, this.worker))
      return Promise.resolve(this.error(command, "WORKER_UNAVAILABLE"));
    if (
      !this.runs.has(command.run.runId) ||
      !sameRunRef(this.runs.get(command.run.runId)!, command.run)
    )
      return Promise.resolve(this.error(command, "RUN_NOT_FOUND"));
    if (this.identities.has(command.requestId))
      return Promise.resolve(this.error(command, "COUNTER_EXHAUSTED"));
    const role = this.role(command);
    const count = [...this.pending.values()].filter((entry) => entry.role === role).length;
    const cap =
      role === "ordinary"
        ? this.options.budgets.pendingWorkerCommands
        : role === "progress"
          ? 4
          : 1;
    if (count >= cap || this.identities.size >= this.options.identityLimit)
      return Promise.resolve(this.error(command, "BUSY"));
    if ((command.type === "subscribe" || command.type === "recover") && !handoff)
      return Promise.resolve(this.error(command, "BUSY"));
    if (
      (command.type === "input" && payload.byteLength > this.options.budgets.inputQueueBytes) ||
      (command.type === "spawn" &&
        (command.geometry.cols > this.options.budgets.maxCols ||
          command.geometry.rows > this.options.budgets.maxRows)) ||
      payload.buffer.byteLength > MAX_FRAME_BYTES
    )
      return Promise.resolve(this.error(command, "BUSY"));
    if (
      command.type === "spawn" &&
      Object.keys(this.hello.effectiveBudgets).some(
        (key) =>
          command.effectiveBudgets[key as keyof EffectiveBudgets] !==
          this.hello.effectiveBudgets[key as keyof EffectiveBudgets],
      )
    )
      return Promise.resolve(this.error(command, "CAPABILITY_UNAVAILABLE"));
    const bytes = this.encode(command, payload);
    if (!bytes) return Promise.resolve(this.error(command, "CAPABILITY_UNAVAILABLE"));
    // Keep the encoded snapshot, never the caller's mutable command object.
    const snapshot = JSON.parse(
      this.options.codec.decode(bytes.subarray(16, bytes.byteLength - payload.byteLength)),
    ) as PipeCommand;
    const identityLease = this.options.bytes.reserve(
      6 * MAX_METADATA_BYTES + 2048,
      role !== "ordinary",
    );
    if (!identityLease) return Promise.resolve(this.error(command, "BUSY"));
    let route: Route | undefined;
    let newRoute = false;
    if (snapshot.type === "subscribe" || snapshot.type === "recover") {
      route = this.routes.find((entry) => sameSubscriptionRef(entry.ref, snapshot.subscription));
      if (!route) {
        if (
          this.routes.length >=
          this.options.budgets.maxRuns * this.options.budgets.subscriptionsPerConnection
        ) {
          identityLease.release();
          return Promise.resolve(this.error(command, "BUSY"));
        }
        const lease = this.options.bytes.reserve(4096);
        if (!lease) {
          identityLease.release();
          return Promise.resolve(this.error(command, "BUSY"));
        }
        route = { ref: structuredClone(snapshot.subscription), active: false, lease };
        this.routes.push(route);
        newRoute = true;
      }
    }
    const deadline = this.now() + this.options.timeoutMs;
    let resolve!: (result: RuntimeResult) => void;
    const promise = new Promise<RuntimeResult>((done) => {
      resolve = done;
    });
    const pending: Pending = { command: snapshot, role, deadline, resolve, handoff, sent: false };
    if (!this.enqueue(bytes, role, pending)) {
      if (newRoute && route) {
        this.routes.splice(this.routes.indexOf(route), 1);
        route.lease.release();
      }
      identityLease.release();
      return Promise.resolve(this.error(command, "BUSY"));
    }
    if (route) route.active = false;
    if (snapshot.type === "unsubscribe") {
      const retiring = this.routes.find((entry) =>
        sameSubscriptionRef(entry.ref, snapshot.subscription),
      );
      if (retiring) retiring.active = false;
    }
    this.identities.set(snapshot.requestId, identityLease);
    this.pending.set(snapshot.requestId, pending);
    this.flush();
    return promise;
  }

  private enqueue(bytes: Uint8Array, role: Role, request: Pending | undefined): boolean {
    const control = role !== "ordinary";
    const size = bytes.buffer.byteLength;
    if (
      size > this.options.budgets.pipeQueuedBytes - this.queuedBytes - this.physicalBytes ||
      (!control &&
        size >
          this.options.budgets.pipeQueuedBytes -
            this.options.budgets.reservedControlBytes -
            this.ordinaryBytes)
    )
      return false;
    const lease = this.options.bytes.reserve(size, control);
    if (!lease) return false;
    this.queuedBytes += size;
    if (!control) this.ordinaryBytes += size;
    this.queue.push({ bytes, lease, role, request, owned: true });
    return true;
  }

  private release(item: Outgoing): void {
    if (!item.owned) return;
    item.owned = false;
    this.handed.delete(item);
    this.physicalBytes -= item.bytes.buffer.byteLength;
    if (item.role === "ordinary") this.ordinaryBytes -= item.bytes.buffer.byteLength;
    item.lease.release();
    this.releaseClosedRecords();
  }

  private flush(): void {
    if (this.flushing || this.blocked || this.closed) return;
    this.flushing = true;
    try {
      while (this.queue.length && !this.blocked && !this.closed) {
        // Preserve FIFO: progress gets admission reserve, not permission to pass a prior write.
        const item = this.queue.shift()!;
        this.queuedBytes -= item.bytes.buffer.byteLength;
        this.physicalBytes += item.bytes.buffer.byteLength;
        this.handed.add(item);
        if (item.request) item.request.sent = true;
        try {
          const drainGeneration = this.drainGeneration;
          const writable = this.options.transport.write(item.bytes, (error) => {
            this.release(item);
            if (error !== undefined) this.loseContact();
          });
          if (!writable && drainGeneration === this.drainGeneration) this.blocked = true;
        } catch {
          this.loseContact();
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  drain(): void {
    this.drainGeneration++;
    this.blocked = false;
    this.flush();
  }

  receive(bytes: Uint8Array): number {
    if (this.closed) return 0;
    if (this.receiving || bytes.buffer.byteLength > MAX_READ_BYTES) {
      this.loseContact();
      return 0;
    }
    this.receiving = true;
    let consumed = 0;
    try {
      const read = this.decoder.read(bytes);
      consumed = read.consumedBytes;
      for (const frame of read.frames) {
        if (this.closed) break;
        let metadata: unknown;
        try {
          metadata = JSON.parse(this.options.codec.decode(frame.metadata));
        } catch {
          this.loseContact();
          break;
        }
        const checked = validatePipeFrame(frame, metadata);
        if (!checked.ok) {
          this.loseContact();
          break;
        }
        const value = checked.value;
        if (value.type === "ready") {
          if (this.state !== "hello" || !validatePipeReadiness(this.hello, value)) {
            this.loseContact();
            break;
          }
          this.state = "ready";
          continue;
        }
        if (!this.ready || !sameWorkerRef(this.worker, value.worker)) {
          this.loseContact();
          break;
        }
        if (value.type === "result" || value.type === "error") {
          const pending = this.pending.get(value.requestId);
          if (!pending || !pending.sent || !validatePipeResultForCommand(pending.command, value)) {
            this.loseContact();
            break;
          }
          const command = pending.command;
          if (
            (command.type === "subscribe" || command.type === "recover") &&
            value.type === "result" &&
            value.outcome === "accepted"
          ) {
            // This synchronous acknowledgement is the ingress activation barrier.
            if (
              !pending.handoff?.(structuredClone(value)) ||
              this.closed ||
              !this.pending.has(value.requestId)
            ) {
              this.loseContact();
              break;
            }
            this.routes.find((entry) =>
              sameSubscriptionRef(entry.ref, command.subscription),
            )!.active = true;
          }
          this.pending.delete(value.requestId);
          pending.resolve(value);
        } else if (value.type === "terminal-event") {
          const run = this.runs.get(value.run.runId);
          if (!run || !sameRunRef(run, value.run)) {
            this.loseContact();
            break;
          }
          if (
            value.subscription &&
            !this.routes.some(
              (entry) => entry.active && sameSubscriptionRef(entry.ref, value.subscription!),
            )
          )
            continue;
          for (const listener of [...this.listeners.keys()]) {
            if (this.closed) break;
            if (this.listeners.has(listener)) listener(value, frame.payload);
          }
        } else {
          this.loseContact();
          break;
        }
      }
      if (read.status === "error") this.loseContact();
    } catch {
      this.loseContact();
    } finally {
      this.receiving = false;
      this.releaseClosedRecords();
    }
    return consumed;
  }

  tick(): void {
    if (this.closed) return;
    const now = this.now();
    if (
      (this.state === "hello" && now >= this.handshakeDeadline) ||
      [...this.pending.values()].some((entry) => now >= entry.deadline)
    )
      this.loseContact();
  }

  onEvent(listener: (event: PipeEvent, payload: Uint8Array) => void): { dispose(): void } {
    if (this.closed || this.listeners.size >= 32 || this.listeners.has(listener))
      throw new Error("Event listener capacity unavailable");
    const lease = this.options.bytes.reserve(512);
    if (!lease) throw new Error("Event listener byte capacity unavailable");
    this.listeners.set(listener, lease);
    return {
      dispose: () => {
        if (this.listeners.get(listener) !== lease) return;
        this.listeners.delete(listener);
        lease.release();
      },
    };
  }

  loseContact(): void {
    if (this.closed) return;
    this.state = "closed";
    this.decoder.finish();
    for (const item of this.queue.splice(0)) {
      this.queuedBytes -= item.bytes.buffer.byteLength;
      if (item.role === "ordinary") this.ordinaryBytes -= item.bytes.buffer.byteLength;
      item.owned = false;
      item.lease.release();
    }
    for (const pending of this.pending.values())
      pending.resolve(
        this.error(
          pending.command,
          pending.sent ? "RESULT_UNKNOWN" : "WORKER_UNAVAILABLE",
          pending.sent,
        ),
      );
    this.pending.clear();
    for (const route of this.routes) {
      route.active = false;
      route.lease.release();
    }
    this.routes.length = 0;

    for (const lease of this.listeners.values()) lease.release();
    this.listeners.clear();
    this.releaseClosedRecords();
    this.options.contactLost?.(this.worker);
  }

  private releaseClosedRecords(): void {
    if (!this.closed || this.receiving || this.handed.size || this.released) return;
    this.released = true;
    for (const lease of this.identities.values()) lease.release();
    this.identities.clear();
    this.arena.release();
  }

  // Only a carrier's definitive backing-release receipt permits early retirement.
  transportReleased(): void {
    if (!this.closed) this.loseContact();
    for (const item of [...this.handed]) this.release(item);
  }

  snapshot(): { pending: number; identities: number; queuedBytes: number; physicalBytes: number } {
    return {
      pending: this.pending.size,
      identities: this.identities.size,
      queuedBytes: this.queuedBytes,
      physicalBytes: this.physicalBytes,
    };
  }
}
