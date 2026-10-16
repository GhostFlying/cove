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
  PIPE_ROUTE_CONTROL_COMMANDS,
  PIPE_ROUTE_CONTROL_FRAME_BYTES,
  type PipeCommand,
  type PipeMetadata,
  type PipeEvent,
} from "@cove/protocol/pipe";
import { domainError, type DomainErrorKind } from "@cove/protocol/errors";
import type { EffectiveBudgets } from "@cove/protocol/budgets";
import {
  sameWorkerRef,
  sameRunRef,
  sameSubscriptionRef,
  type WorkerRef,
  type RunRef,
  type SubscriptionRef,
} from "@cove/protocol/identity";
import type { RuntimeResult } from "@cove/protocol/runtime";
import type { ByteReservation } from "./runtime-retained-bytes.js";
import { RuntimeComposition } from "./runtime-composition.js";

export const SESSION_CONTROL_RESERVE = 6 * (6 * MAX_METADATA_BYTES + 2048) + 64 * 1024;
// Route control (applied-ack, baseline-progress, unsubscribe) of a subscription the pipe knows is
// never refused for capacity (issue #96): an ACK the server refused after the client handed it
// off would break the client's rule that a handed-off ACK covers the commands sent after it.
// Its storage is therefore paid for in advance. Each subscription's pipe route reserves one
// waiting record for an ACK or progress report (its route queue sends them one at a time) and one
// for its unsubscribe; the session arena holds the identities of the PIPE_ROUTE_CONTROL_COMMANDS
// admitted ones and PIPE_ROUTE_CONTROL_COMMANDS transport slots for their frames. None of it
// draws on the shared control reserve, which stays for status, stop and replies.
//
// The window and the transport slots are separate because they end at different moments. A
// window slot ends when the worker's reply arrives, but the frame's bytes stay owned by the
// transport until its write callback, which may come later. A frame holds its transport slot
// from queueing until that callback, so a command waits until both a window slot and a
// transport slot are free. Prepaid frames stay outside pipeQueuedBytes and
// reservedControlBytes: ordinary traffic cannot consume their space, and the bytes queued or
// in transport stay within pipeQueuedBytes plus the transport slots.
const ROUTE_CONTROL_IDENTITY_BYTES = 6 * MAX_METADATA_BYTES + 2048;
// The worker's ingress bound counts the transport slots too (PIPE_PREPAID_ROUTE_CONTROL_BYTES).
const ROUTE_CONTROL_FRAME_BYTES = PIPE_ROUTE_CONTROL_FRAME_BYTES;
const ROUTE_CONTROL_WAIT_BYTES = ROUTE_CONTROL_FRAME_BYTES + MAX_METADATA_BYTES + 1024;
const PREPAID: ByteReservation = Object.freeze({ bytes: 0, release() {} });

export interface PipeByteTransport {
  // A transport must call `handing` immediately before its first lower write or delivery side
  // effect: from then on bytes may reach the worker (and a reply may arrive, even synchronously).
  // A write that throws before calling it delivered nothing.
  write(bytes: Uint8Array, settled: (error?: unknown) => void, handing: () => void): boolean;
}
export interface PipeCodec {
  encode(text: string): Uint8Array;
  decode(bytes: Uint8Array): string;
}
export type ResultHandoff = (result: RuntimeResult) => boolean;
export type PreviewResultSeal = (result: RuntimeResult) => void;
type Role = "ordinary" | "status" | "stop" | "progress";
type Pending = {
  command: PipeCommand;
  role: Role;
  deadline: number;
  resolve: (result: RuntimeResult) => void;
  handoff: ResultHandoff | undefined;
  previewSeal?: PreviewResultSeal;
  sent: boolean;
  // Called when the transport hands the frame over (`sent` becomes true); see request() and
  // PipeByteTransport.
  onSent?: () => void;
  admitted: boolean;
};
type Outgoing = {
  bytes: Uint8Array;
  lease: ByteReservation;
  role: Role;
  request: Pending | undefined;
  owned: boolean;
  // A prepaid route-control command waiting for a window slot holds its route's record.
  slot?: { route: Route; unsubscribe: boolean } | undefined;
  // A queued or handed prepaid frame holds one of the arena's transport slots.
  prepaid?: boolean;
};
// `unsubscribed` records that an unsubscribe for the ref settled, so the route can be
// reclaimed by whichever of that unsubscribe and the last pending opener settles last.
type Route = {
  ref: SubscriptionRef;
  active: boolean;
  unsubscribed: boolean;
  lease: ByteReservation;
  // The prepaid waiting records (see ROUTE_CONTROL_WAIT_BYTES) currently in use.
  waitingProgress: boolean;
  waitingUnsubscribe: boolean;
};

export class WorkerPipeSession {
  readonly worker: WorkerRef;
  readonly composition: RuntimeComposition;
  private readonly hello: Extract<PipeMetadata, { type: "hello" }>;
  private readonly decoder = createPipeDecoder();
  private readonly arena: ByteReservation;
  // Request identities of commands still awaiting their worker reply. An identity
  // lives exactly as long as its pending entry: it is released when the reply
  // arrives or when contact loss settles the request. Every server caller mints
  // these IDs from a monotonic per-owner counter (the control-release ID is only
  // resent after a not-accepted BUSY), so an executed ID is never issued again and
  // retaining it would only exhaust identityLimit (formerly wedging the whole worker
  // with BUSY after identityLimit lifetime requests). identityLimit therefore
  // bounds concurrent in-flight requests, never the lifetime total, and does not count
  // prepaid route control (see ownedIdentities()). Duplicate in-flight IDs are still
  // refused, and a reply for a settled ID still loses contact.
  private readonly identities = new Map<string, ByteReservation>();
  private readonly pending = new Map<string, Pending>();
  private readonly queue: Outgoing[] = [];
  private readonly waitingProgress: Outgoing[] = [];
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
  private promoting = false;
  private prepaidIdentities = 0;
  // Prepaid route-control frames queued or awaiting their write callback, and their bytes.
  // They are not part of queuedBytes or physicalBytes (see ROUTE_CONTROL_FRAME_BYTES).
  private prepaidFrames = 0;
  private prepaidBytes = 0;

  constructor(
    private readonly options: {
      worker: WorkerRef;
      composition: RuntimeComposition;
      buildVersion: string;
      transport: PipeByteTransport;
      codec: PipeCodec;
      now: () => number;
      timeoutMs: number;
      identityLimit: number;
      contactLost?: (worker: WorkerRef) => void;
    },
  ) {
    if (
      !options.composition.owns(options.worker) ||
      options.composition.bytes.controlReserve < SESSION_CONTROL_RESERVE ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      !Number.isSafeInteger(options.identityLimit) ||
      options.identityLimit < 1 ||
      options.identityLimit > 4096
    )
      throw new Error("Invalid session limits");
    this.composition = options.composition;
    this.worker = Object.freeze({ ...options.worker });
    this.hello = {
      type: "hello",
      worker: this.worker,
      pipeVersion: PIPE_VERSION,
      effectiveBudgets: { ...options.composition.budgets },
      buildVersion: options.buildVersion,
    };
    const arena = options.composition.bytes.reserve(
      2 * MAX_READ_BYTES +
        3 * MAX_FRAME_BYTES +
        6 * MAX_METADATA_BYTES +
        1024 +
        PIPE_ROUTE_CONTROL_COMMANDS * (ROUTE_CONTROL_IDENTITY_BYTES + ROUTE_CONTROL_FRAME_BYTES),
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
    if (this.runs.size >= this.composition.budgets.maxRuns) return false;
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

  // `onSent` runs synchronously when the transport calls `handing` for the command's frame, just
  // before its first lower write or delivery: the first point from which the worker may execute
  // it, and before any reply. A command that settles without it was never delivered and never
  // will be: refused at admission, refused by the transport before handing over, or withdrawn
  // unsent when contact was lost (which drops the whole queue).
  request(
    command: PipeCommand,
    payload: Uint8Array = new Uint8Array(),
    handoff?: ResultHandoff,
    onSent?: () => void,
  ): Promise<RuntimeResult> {
    return this.admit(command, payload, handoff, undefined, onSent);
  }

  requestUnsubscribe(
    command: Extract<PipeCommand, { type: "unsubscribe" }>,
  ): Promise<RuntimeResult> {
    return this.admit(command, new Uint8Array(), undefined);
  }

  requestPreview(
    command: Extract<PipeCommand, { type: "preview-refresh" }>,
    seal: PreviewResultSeal,
  ): Promise<RuntimeResult> {
    return this.admit(command, new Uint8Array(), undefined, seal);
  }

  private progressCount(): number {
    return [...this.pending.values()].filter((entry) => entry.role === "progress" && entry.admitted)
      .length;
  }

  // Whether a prepaid route-control command can be admitted now: it needs a window slot and a
  // transport slot (see ROUTE_CONTROL_FRAME_BYTES).
  private progressSlotFree(): boolean {
    return (
      this.progressCount() < PIPE_ROUTE_CONTROL_COMMANDS &&
      this.prepaidFrames < PIPE_ROUTE_CONTROL_COMMANDS
    );
  }

  // Queues a prepaid frame in a free transport slot. It needs no budget check: the arena pays
  // for the slot, and ordinary traffic cannot use it.
  private queuePrepaid(item: Outgoing): void {
    item.prepaid = true;
    this.prepaidFrames++;
    this.prepaidBytes += item.bytes.buffer.byteLength;
    this.queue.push(item);
  }

  // A waiting command has not reached the worker, so the time it spent waiting is no evidence
  // of lost contact: the admitted commands ahead of it carry the liveness deadline (tick()
  // ignores waiting ones), and a transport slot is held only by a frame already handed to the
  // transport. Its own deadline therefore starts when it takes a slot, read from the clock at
  // that moment. The clock supplier may reenter (and promote, or close the session) or fail; a
  // reentrant call returns at once and leaves the work to this loop, which rechecks its
  // condition after the read, and an invalid clock fails the session closed as tick() does.
  private promoteProgress(): void {
    if (this.closed || this.promoting) return;
    this.promoting = true;
    try {
      while (!this.closed && this.waitingProgress.length && this.progressSlotFree()) {
        let now: number;
        try {
          now = this.now();
        } catch {
          this.loseContact();
          return;
        }
        if (this.closed || !this.waitingProgress.length || !this.progressSlotFree()) break;
        const item = this.waitingProgress.shift()!;
        if (item.slot) {
          if (item.slot.unsubscribe) item.slot.route.waitingUnsubscribe = false;
          else item.slot.route.waitingProgress = false;
          item.slot = undefined;
        }
        item.request!.admitted = true;
        item.request!.deadline = now + this.options.timeoutMs;
        this.queuePrepaid(item);
      }
    } finally {
      this.promoting = false;
    }
    if (!this.receiving) this.flush();
  }

  private admit(
    command: PipeCommand,
    payload: Uint8Array,
    handoff: ResultHandoff | undefined,
    previewSeal?: PreviewResultSeal,
    onSent?: () => void,
  ): Promise<RuntimeResult> {
    if (!this.ready || !sameWorkerRef(command.worker, this.worker))
      return Promise.resolve(this.error(command, "WORKER_UNAVAILABLE"));
    if (
      !this.runs.has(command.run.runId) ||
      !sameRunRef(this.runs.get(command.run.runId)!, command.run)
    )
      return Promise.resolve(this.error(command, "RUN_NOT_FOUND"));
    const role = this.role(command);
    if (role === "progress") this.promoteProgress();
    if (!this.ready) return Promise.resolve(this.error(command, "WORKER_UNAVAILABLE"));
    if (this.identities.has(command.requestId))
      return Promise.resolve(this.error(command, "COUNTER_EXHAUSTED"));
    const count = [...this.pending.values()].filter(
      (entry) => entry.role === role && entry.admitted,
    ).length;
    const cap =
      role === "ordinary"
        ? this.composition.budgets.pendingWorkerCommands
        : role === "progress"
          ? // The worker's route-control queue bound; exceeding it shuts the worker down.
            PIPE_ROUTE_CONTROL_COMMANDS
          : 1;
    // Route control of a subscription this pipe knows (see ROUTE_CONTROL_WAIT_BYTES) is never
    // refused for a full window or for capacity: it waits unsent, in arrival order, and takes
    // the next free slot (see promoteProgress). Refusing an ACK here used to retire a healthy
    // subscription whenever more than PIPE_ROUTE_CONTROL_COMMANDS streaming subscriptions shared
    // this worker (issue #96). The wait is bounded by the routes' prepaid records: each
    // subscription's ACKs and progress reports reach this pipe one at a time from its route
    // queue (TerminalSubscriptions), and it sends one unsubscribe. A second waiting command in
    // an occupied record is refused; a conforming caller never sends one. Route control for a
    // subscription the pipe does not know (it was never opened here, or already released) has
    // no worker route to protect, so it is only admitted into a free slot, as before.
    const known = role === "progress" ? this.routeFor(command) : undefined;
    if (
      (role !== "progress" && count >= cap) ||
      (!known && role === "progress" && (count >= cap || this.waitingProgress.length > 0)) ||
      (!known && this.ownedIdentities() >= this.options.identityLimit)
    )
      return Promise.resolve(this.error(command, "BUSY"));
    if ((command.type === "subscribe" || command.type === "recover") && !handoff)
      return Promise.resolve(this.error(command, "BUSY"));
    if (
      (command.type === "input" && payload.byteLength > this.composition.budgets.inputQueueBytes) ||
      (command.type === "spawn" &&
        (command.geometry.cols > this.composition.budgets.maxCols ||
          command.geometry.rows > this.composition.budgets.maxRows)) ||
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
    const deadline = this.now() + this.options.timeoutMs;
    // Encoding and clock suppliers can reenter; validate admission again before ownership.
    if (!this.ready) return Promise.resolve(this.error(command, "WORKER_UNAVAILABLE"));
    if (this.identities.has(snapshot.requestId))
      return Promise.resolve(this.error(command, "COUNTER_EXHAUSTED"));
    const currentCount = [...this.pending.values()].filter(
      (entry) => entry.role === role && entry.admitted,
    ).length;
    const prepaid = role === "progress" ? this.routeFor(snapshot) : undefined;
    if (prepaid && bytes.buffer.byteLength > ROUTE_CONTROL_FRAME_BYTES)
      return Promise.resolve(this.error(command, "CAPABILITY_UNAVAILABLE"));
    // A command also waits behind an earlier waiting one, so it can never overtake it.
    const waiting =
      !!prepaid &&
      (currentCount >= cap ||
        this.prepaidFrames >= PIPE_ROUTE_CONTROL_COMMANDS ||
        this.waitingProgress.length > 0);
    const unsubscribe = snapshot.type === "unsubscribe";
    if (
      (!waiting && currentCount >= cap) ||
      (!prepaid && role === "progress" && this.waitingProgress.length > 0) ||
      (!prepaid && this.ownedIdentities() >= this.options.identityLimit) ||
      (waiting && (unsubscribe ? prepaid.waitingUnsubscribe : prepaid.waitingProgress))
    )
      return Promise.resolve(this.error(command, "BUSY"));
    const identityLease = prepaid
      ? PREPAID
      : this.composition.bytes.reserve(ROUTE_CONTROL_IDENTITY_BYTES, role !== "ordinary");
    if (!identityLease) return Promise.resolve(this.error(command, "BUSY"));
    let route: Route | undefined;
    let newRoute = false;
    if (snapshot.type === "subscribe" || snapshot.type === "recover") {
      route = this.routes.find((entry) => sameSubscriptionRef(entry.ref, snapshot.subscription));
      if (!route) {
        if (
          this.routes.length >=
          this.composition.budgets.maxRuns * this.composition.budgets.subscriptionsPerConnection
        ) {
          identityLease.release();
          return Promise.resolve(this.error(command, "BUSY"));
        }
        const lease = this.composition.bytes.reserve(4096 + 2 * ROUTE_CONTROL_WAIT_BYTES);
        if (!lease) {
          identityLease.release();
          return Promise.resolve(this.error(command, "BUSY"));
        }
        route = {
          ref: structuredClone(snapshot.subscription),
          active: false,
          unsubscribed: false,
          lease,
          waitingProgress: false,
          waitingUnsubscribe: false,
        };
        this.routes.push(route);
        newRoute = true;
      }
    }
    let resolve!: (result: RuntimeResult) => void;
    const promise = new Promise<RuntimeResult>((done) => {
      resolve = done;
    });
    const pending: Pending = {
      command: snapshot,
      role,
      deadline,
      resolve,
      handoff,
      ...(previewSeal ? { previewSeal } : {}),
      sent: false,
      ...(onSent ? { onSent } : {}),
      admitted: !waiting,
    };
    if (prepaid) {
      if (waiting) {
        // Held in the route's prepaid record; it joins the queue's budget on promotion.
        if (unsubscribe) prepaid.waitingUnsubscribe = true;
        else prepaid.waitingProgress = true;
        this.waitingProgress.push({
          bytes,
          lease: PREPAID,
          role,
          request: pending,
          owned: true,
          slot: { route: prepaid, unsubscribe },
        });
      } else this.queuePrepaid({ bytes, lease: PREPAID, role, request: pending, owned: true });
    } else if (!this.enqueue(bytes, role, pending)) {
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
    if (identityLease === PREPAID) this.prepaidIdentities++;
    this.pending.set(snapshot.requestId, pending);
    // A command that queued only to stay behind an earlier waiting one may find a slot that a
    // reentrant settlement freed meanwhile; promotion hands it over in order.
    if (waiting) this.promoteProgress();
    this.flush();
    return promise;
  }

  // The pipe route that holds a route-control command's prepaid records, if the pipe knows it.
  private routeFor(command: PipeCommand): Route | undefined {
    if (this.role(command) !== "progress" || !("subscription" in command)) return undefined;
    return this.routes.find((entry) => sameSubscriptionRef(entry.ref, command.subscription));
  }

  private queueBudget(bytes: Uint8Array, role: Role): boolean {
    const size = bytes.buffer.byteLength;
    return !(
      size > this.composition.budgets.pipeQueuedBytes - this.queuedBytes - this.physicalBytes ||
      (role === "ordinary" &&
        size >
          this.composition.budgets.pipeQueuedBytes -
            this.composition.budgets.reservedControlBytes -
            this.ordinaryBytes)
    );
  }

  private enqueue(bytes: Uint8Array, role: Role, request: Pending | undefined): boolean {
    const control = role !== "ordinary";
    const size = bytes.buffer.byteLength;
    if (!this.queueBudget(bytes, role)) return false;
    const lease = this.composition.bytes.reserve(size, control);
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
    if (item.prepaid) {
      this.prepaidFrames--;
      this.prepaidBytes -= item.bytes.buffer.byteLength;
    } else this.physicalBytes -= item.bytes.buffer.byteLength;
    if (item.role === "ordinary") this.ordinaryBytes -= item.bytes.buffer.byteLength;
    item.lease.release();
    this.releaseClosedRecords();
    // A freed transport slot may admit a waiting route-control command.
    if (item.prepaid && !this.receiving) this.promoteProgress();
  }

  private flush(): void {
    if (this.flushing || this.blocked || this.closed) return;
    this.flushing = true;
    try {
      while (this.queue.length && !this.blocked && !this.closed) {
        // Preserve FIFO: progress gets admission reserve, not permission to pass a prior write.
        const item = this.queue.shift()!;
        if (!item.prepaid) {
          this.queuedBytes -= item.bytes.buffer.byteLength;
          this.physicalBytes += item.bytes.buffer.byteLength;
        }
        this.handed.add(item);
        const request = item.request;
        const handing = (): void => {
          if (!request || request.sent) return;
          request.sent = true;
          request.onSent?.();
        };
        try {
          const drainGeneration = this.drainGeneration;
          const writable = this.options.transport.write(
            item.bytes,
            (error) => {
              this.release(item);
              if (error !== undefined) this.loseContact();
            },
            handing,
          );
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
          if (command.type === "preview-refresh") pending.previewSeal?.(structuredClone(value));
          if (this.closed || !this.pending.has(value.requestId)) break;
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
          this.settle(value.requestId);
          if (
            command.type === "unsubscribe" ||
            command.type === "subscribe" ||
            command.type === "recover"
          )
            this.forgetRoute(command.subscription, command.type === "unsubscribe");
          pending.resolve(value);
        } else if (value.type === "terminal-event") {
          const run = this.runs.get(value.run.runId);
          if (!run || !sameRunRef(run, value.run)) {
            this.loseContact();
            break;
          }
          if (
            value.subscription &&
            !value.terminal.type.startsWith("preview-") &&
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
      // Release shared slots before promise consumers can admit more progress work.
      this.promoteProgress();
      this.releaseClosedRecords();
    }
    return consumed;
  }

  // A route is dropped once its unsubscribe settled, whatever the outcome, and no subscribe
  // or recover for the same ref is still pending. Keeping inactive routes until the pipe
  // closed made the whole worker refuse every attach with BUSY after maxRuns ×
  // subscriptionsPerConnection lifetime subscriptions. An inactive route only filters
  // events, and an absent route filters them identically, so a worker that still emits for
  // an uncertain unsubscribe stays fenced. Subscription refs are never reused, so no later
  // subscribe can need the record.
  //
  // The two settlements can arrive in either order: a connection closing while an attach's
  // baseline capture runs can see the worker accept the unsubscribe first and fail the
  // cancelled subscribe afterwards. So the unsubscribe only marks the route, and every
  // settlement of an unsubscribe or an opener for the ref retries the release; the last one
  // to settle reclaims it. An opener accepted after the unsubscribe does not revive the
  // route: the ref was already withdrawn, and dropping it fences that producer's events.
  private forgetRoute(ref: SubscriptionRef, unsubscribed: boolean): void {
    const index = this.routes.findIndex((entry) => sameSubscriptionRef(entry.ref, ref));
    const route = this.routes[index];
    if (!route) return;
    if (unsubscribed) route.unsubscribed = true;
    if (
      !route.unsubscribed ||
      [...this.pending.values()].some(
        (entry) =>
          (entry.command.type === "subscribe" || entry.command.type === "recover") &&
          sameSubscriptionRef(entry.command.subscription, ref),
      )
    )
      return;
    this.routes.splice(index, 1);
    route.lease.release();
  }

  tick(): void {
    if (this.closed) return;
    const now = this.now();
    if (
      (this.state === "hello" && now >= this.handshakeDeadline) ||
      [...this.pending.values()].some((entry) => entry.admitted && now >= entry.deadline)
    )
      this.loseContact();
  }

  onEvent(listener: (event: PipeEvent, payload: Uint8Array) => void): { dispose(): void } {
    if (this.closed || this.listeners.size >= 32 || this.listeners.has(listener))
      throw new Error("Event listener capacity unavailable");
    const lease = this.composition.bytes.reserve(512);
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
      if (item.prepaid) {
        this.prepaidFrames--;
        this.prepaidBytes -= item.bytes.buffer.byteLength;
      } else this.queuedBytes -= item.bytes.buffer.byteLength;
      if (item.role === "ordinary") this.ordinaryBytes -= item.bytes.buffer.byteLength;
      item.owned = false;
      item.lease.release();
    }
    // Waiting commands live in their routes' prepaid records, outside the queue's budget.
    for (const item of this.waitingProgress.splice(0)) {
      item.owned = false;
      item.slot = undefined;
    }
    for (const pending of this.pending.values())
      pending.resolve(
        this.error(
          pending.command,
          pending.sent ? "RESULT_UNKNOWN" : "WORKER_UNAVAILABLE",
          pending.sent,
        ),
      );
    for (const requestId of [...this.pending.keys()]) this.settle(requestId);
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

  // Settlement ends both the correlation and its identity; see `identities`.
  private settle(requestId: string): void {
    this.pending.delete(requestId);
    const lease = this.identities.get(requestId);
    if (lease === PREPAID) this.prepaidIdentities--;
    lease?.release();
    this.identities.delete(requestId);
  }

  // Identities that hold their own reservation. Prepaid route control (see
  // ROUTE_CONTROL_WAIT_BYTES) is bounded by the routes instead, so it never takes an identity
  // another command needs.
  private ownedIdentities(): number {
    return this.identities.size - this.prepaidIdentities;
  }

  private releaseClosedRecords(): void {
    if (!this.closed || this.receiving || this.handed.size || this.released) return;
    this.released = true;
    for (const lease of this.identities.values()) lease.release();
    this.identities.clear();
    this.prepaidIdentities = 0;
    this.arena.release();
  }

  // Only a carrier's definitive backing-release receipt permits early retirement.
  transportReleased(): void {
    if (!this.closed) this.loseContact();
    for (const item of [...this.handed]) this.release(item);
  }

  snapshot(): {
    pending: number;
    identities: number;
    routes: number;
    queuedBytes: number;
    physicalBytes: number;
    prepaidFrames: number;
    prepaidBytes: number;
  } {
    return {
      pending: this.pending.size,
      identities: this.identities.size,
      routes: this.routes.length,
      queuedBytes: this.queuedBytes,
      physicalBytes: this.physicalBytes,
      prepaidFrames: this.prepaidFrames,
      prepaidBytes: this.prepaidBytes,
    };
  }
}
