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
  PIPE_HEARTBEAT_INTERVAL_MS,
  PIPE_LIVENESS_MIN_HEARTBEATS,
  PIPE_LIVENESS_WINDOW_MS,
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
import type { WorkerStatus } from "@cove/protocol/rpc";
import type { WorkerHealth } from "@cove/protocol/terminal";
import { RuntimeComposition } from "./runtime-composition.js";
import { WorkerHealthMonitor } from "./worker-health.js";

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
  // A write that throws before calling it delivered nothing. `handing` throws when the session
  // refuses the handover (its command was already answered as never sent); the transport must
  // then not write, as for any throw before its lower write.
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
  // The runtime clock when the transport handed the frame over (health's command age).
  sentAt?: number;
  // The transport took the frame (flush() called its write) but has not handed it over.
  offered?: boolean;
  // Answered as never sent at its deadline while offered (see expire()); a later handover of
  // its frame is refused.
  withdrawn?: boolean;
  admitted: boolean;
  // Its deadline passed while the worker was live and the caller already has RESULT_UNKNOWN; the
  // correlation stays until the worker's late reply (see expire()).
  abandoned: boolean;
  // A status read from requestStatus(): its caller's eligibility is checked again until the
  // frame is handed over, together with `deadline` (see refuseStatusHandover()).
  statusGuard?: { eligible: (() => boolean) | undefined };
  // Answered BUSY at its handover instead of being sent; its frame must never be written.
  refused?: boolean;
};
// Thrown from `handing` for a status read refused at its handover (refuseStatusHandover()). The
// transport must then not write, as for any refusal; unlike other refusals it is not a contact
// failure, because the caller already has a definite not-accepted answer.
class StatusHandoverRefused extends Error {}
// Whether a status read's caller still wants it. A throwing predicate counts as no.
function statusEligible(eligible: (() => boolean) | undefined): boolean {
  try {
    return eligible?.() ?? true;
  } catch {
    return false;
  }
}
// A status read waiting for the worker's single status window (see requestStatus()).
type StatusWaiter = {
  command: Extract<PipeCommand, { type: "status" }>;
  // Absolute, fixed when the read was requested: waiting spends the read's own deadline.
  deadline: number;
  eligible: (() => boolean) | undefined;
  resolve: (result: RuntimeResult) => void;
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
  private readonly statusWaiters: StatusWaiter[] = [];
  private statusPromotionScheduled = false;
  private promotingStatus = false;
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
  private released = false;
  private promoting = false;
  private prepaidIdentities = 0;
  // Prepaid route-control frames queued or awaiting their write callback, and their bytes.
  // They are not part of queuedBytes or physicalBytes (see ROUTE_CONTROL_FRAME_BYTES).
  private prepaidFrames = 0;
  private prepaidBytes = 0;
  // Liveness (issue #103): the worker is lost after livenessWindowMs without any frame from it,
  // not when one command is slow. `heard` records a frame since the last tick; `silentMs` is the
  // silence the runtime itself observed, at most PIPE_HEARTBEAT_INTERVAL_MS per tick, so a
  // stall of the runtime's own event loop (whose unread frames wait in the OS pipe) is not
  // charged to the worker. The window therefore bounds runtime-observed silence, not wall-clock
  // time: recurring runtime stalls stretch the wall-clock time to detection.
  private readonly livenessWindowMs: number;
  // Informational health (worker-health.ts): a heartbeat since the last tick, and the
  // runtime-observed time since the latest heartbeat, accrued like `silentMs`.
  private health: WorkerHealthMonitor | undefined;
  private heardHeartbeat = false;
  private sinceHeartbeatMs = 0;
  private readonly healthListeners = new Map<(health: WorkerHealth) => void, ByteReservation>();
  private heard = false;
  private silentMs = 0;
  private lastTick: number | undefined;

  constructor(
    private readonly options: {
      worker: WorkerRef;
      composition: RuntimeComposition;
      buildVersion: string;
      transport: PipeByteTransport;
      codec: PipeCodec;
      now: () => number;
      // Each command's deadline (recoveryDeadlineMs in production): past it the command alone
      // ends with an explicit outcome while the worker stays live.
      timeoutMs: number;
      // Runtime-observed silence after which the worker is lost, and the handshake deadline.
      // Defaults to PIPE_LIVENESS_WINDOW_MS; independent of timeoutMs (issue #103).
      livenessWindowMs?: number;
      identityLimit: number;
      contactLost?: (worker: WorkerRef) => void;
    },
  ) {
    if (
      !options.composition.owns(options.worker) ||
      options.composition.bytes.controlReserve < SESSION_CONTROL_RESERVE ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      !Number.isSafeInteger(options.livenessWindowMs ?? PIPE_LIVENESS_WINDOW_MS) ||
      (options.livenessWindowMs ?? PIPE_LIVENESS_WINDOW_MS) <
        PIPE_LIVENESS_MIN_HEARTBEATS * PIPE_HEARTBEAT_INTERVAL_MS ||
      !Number.isSafeInteger(options.identityLimit) ||
      options.identityLimit < 1 ||
      options.identityLimit > 4096
    )
      throw new Error("Invalid session limits");
    this.composition = options.composition;
    this.livenessWindowMs = options.livenessWindowMs ?? PIPE_LIVENESS_WINDOW_MS;
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
      now > Number.MAX_SAFE_INTEGER - Math.max(this.options.timeoutMs, this.livenessWindowMs)
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
    this.health = new WorkerHealthMonitor(this.now());
    // A worker that never says ready is silent: the liveness window bounds the handshake too,
    // measured like any other silence (see tick()), so it starts here.
    this.lastTick = this.now();
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

  // A status read that waits for the worker's single status window instead of being refused
  // (issue #115). The runtime has two readers of that window: preview refresh, which reads every
  // run's status in the background, and the control arbiter, which reads a run's control
  // boundary when it does not know it. request() refuses a status while another holds the
  // window, which made a user's focus fail BUSY whenever a background read was in flight.
  //
  // Waiters are served in arrival order, and each keeps the deadline it got here: time spent
  // waiting is part of its deadline (terminal-architecture 3.3), so it is admitted with only the
  // remaining budget. Until its frame is handed to the transport, a status read is answered BUSY
  // (not-accepted) and never sent once its deadline passes or `eligible` (its caller's lifetime:
  // the control job's route, the preview job) is false or throws. That is checked when it is
  // requested, while it waits (on every tick and at its turn), while it is admitted but queued
  // behind a backpressured transport (on every tick), and finally inside `handing`, immediately
  // before the frame is marked sent (see refuseStatusHandover()). Contact loss answers every
  // waiter WORKER_UNAVAILABLE. Once handed over, a status is unchanged: if it then expires it is
  // RESULT_UNKNOWN and keeps the window until the worker's late reply (see expire()); each waiter
  // is then answered BUSY, the overload signal, and nothing is retried.
  requestStatus(
    command: Extract<PipeCommand, { type: "status" }>,
    eligible?: () => boolean,
  ): Promise<RuntimeResult> {
    if (!statusEligible(eligible)) return Promise.resolve(this.error(command, "BUSY"));
    if (!this.statusWaiters.length && !this.statusHolder())
      return this.admit(command, new Uint8Array(), undefined, undefined, undefined, {
        eligible,
      });
    if (!this.ready) return Promise.resolve(this.error(command, "WORKER_UNAVAILABLE"));
    // The callers bound the queue (one boundary read and one refresh per run at a time); this
    // cap only keeps a misbehaving caller from growing it.
    if (this.statusWaiters.length >= this.options.identityLimit)
      return Promise.resolve(this.error(command, "BUSY"));
    const deadline = this.now() + this.options.timeoutMs;
    const promise = new Promise<RuntimeResult>((resolve) => {
      this.statusWaiters.push({ command: structuredClone(command), deadline, eligible, resolve });
    });
    this.promoteStatus();
    return promise;
  }

  // The admitted status that holds the worker's status window, if any.
  private statusHolder(): Pending | undefined {
    for (const entry of this.pending.values())
      if (entry.role === "status" && entry.admitted) return entry;
    return undefined;
  }

  // Settlement runs inside receive(), expire() or contact loss, so the next waiter is handled
  // from a microtask rather than from inside it.
  private scheduleStatusPromotion(): void {
    if (this.statusPromotionScheduled || !this.statusWaiters.length) return;
    this.statusPromotionScheduled = true;
    queueMicrotask(() => {
      this.statusPromotionScheduled = false;
      this.promoteStatus();
    });
  }

  // Answers waiters that can no longer be sent and dispatches the head once the window is free.
  private promoteStatus(): void {
    if (this.promotingStatus) return;
    this.promotingStatus = true;
    try {
      while (this.statusWaiters.length) {
        const head = this.statusWaiters[0]!;
        if (this.closed) {
          this.statusWaiters.shift();
          head.resolve(this.error(head.command, "WORKER_UNAVAILABLE"));
          continue;
        }
        const live = this.statusLive(head.deadline, head.eligible);
        const holder = this.statusHolder();
        if (live && holder && !holder.abandoned) {
          // Later waiters may already be dead; they are answered without waiting their turn.
          this.dropDeadStatusWaiters();
          break;
        }
        this.statusWaiters.shift();
        if (!live || holder) head.resolve(this.error(head.command, "BUSY"));
        else
          void this.admit(head.command, new Uint8Array(), undefined, undefined, undefined, {
            deadlineAt: head.deadline,
            eligible: head.eligible,
          }).then(head.resolve);
      }
    } finally {
      this.promotingStatus = false;
    }
  }

  private dropDeadStatusWaiters(): void {
    for (let index = this.statusWaiters.length - 1; index >= 1; index--) {
      const waiter = this.statusWaiters[index]!;
      if (this.statusLive(waiter.deadline, waiter.eligible)) continue;
      this.statusWaiters.splice(index, 1);
      waiter.resolve(this.error(waiter.command, "BUSY"));
    }
  }

  // Whether an unsent status read may still be sent: before its deadline, and still wanted by its
  // caller. An invalid clock or a throwing predicate counts as no.
  private statusLive(
    deadline: number,
    eligible: (() => boolean) | undefined,
    at?: number,
  ): boolean {
    let now: number;
    try {
      now = at ?? this.now();
    } catch {
      return false;
    }
    return now < deadline && statusEligible(eligible);
  }

  // The last check before an admitted status read is handed over (see `handing` in flush()):
  // a read whose deadline passed or whose caller is gone since its admission (a backpressured
  // transport can hold it queued past either, and drain() runs without a tick) is answered BUSY
  // (not-accepted) here and never reaches the transport. Its correlation and the status window
  // are released, so the next waiter can go; nothing is unknown and nothing is retried.
  private refuseStatusHandover(request: Pending, at: number): boolean {
    if (!request.statusGuard || this.statusLive(request.deadline, request.statusGuard.eligible, at))
      return false;
    request.refused = true;
    const requestId = request.command.requestId;
    if (this.pending.get(requestId) === request) this.settle(requestId);
    request.resolve(this.error(request.command, "BUSY"));
    return true;
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

  // Hands waiting route-control commands their window and transport slots, in arrival order.
  // Route control has no reply deadline while the worker is live (issue #103): timing out an
  // ACK would retire a healthy subscription, so it waits for the worker's reply and ends only
  // with contact loss. A reentrant call returns at once and leaves the work to this loop.
  private promoteProgress(): void {
    if (this.closed || this.promoting) return;
    this.promoting = true;
    try {
      while (!this.closed && this.waitingProgress.length && this.progressSlotFree()) {
        const item = this.waitingProgress.shift()!;
        if (item.slot) {
          if (item.slot.unsubscribe) item.slot.route.waitingUnsubscribe = false;
          else item.slot.route.waitingProgress = false;
          item.slot = undefined;
        }
        item.request!.admitted = true;
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
    // A status read from requestStatus(): `deadlineAt` is the absolute deadline fixed when it was
    // requested (a read that waited for its window gets only what remains of it), and
    // `eligible` is its caller's lifetime, checked again up to the handover.
    status?: { deadlineAt?: number; eligible: (() => boolean) | undefined },
  ): Promise<RuntimeResult> {
    const deadlineAt = status?.deadlineAt;
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
    const now = this.now();
    // Expired before admission: never sent, so definitely not accepted.
    if (deadlineAt !== undefined && now >= deadlineAt)
      return Promise.resolve(this.error(command, "BUSY"));
    const deadline = Math.min(now + this.options.timeoutMs, deadlineAt ?? Number.MAX_SAFE_INTEGER);
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
      abandoned: false,
      ...(status ? { statusGuard: { eligible: status.eligible } } : {}),
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
          if (request.refused) throw new StatusHandoverRefused("Status read refused at handover");
          // The command's age starts at the real handover. drain() and result-driven promotion
          // run without a tick, so the last tick's clock may predate a runtime stall; a fresh,
          // validated sample is taken here. The clock is foreign code and may reenter, so the
          // once-only transition and the refusals below are checked after sampling.
          let at: number | undefined;
          try {
            at = this.now();
          } catch {
            // An invalid clock fails closed below, before anything is sent.
          }
          if (request.sent) return;
          if (at === undefined || this.closed || request.withdrawn) {
            // Nothing may be delivered once its caller was, or is about to be, told it was not:
            // an invalid clock, contact already lost (its command ended not-accepted), or a late
            // handover of a frame whose expiry answered it as never sent. Contact is lost, and
            // the throw stops the transport's lower write.
            this.loseContact();
            throw new Error(
              request.withdrawn ? "Late handover of a withdrawn frame" : "Frame handover refused",
            );
          }
          // The last check for a status read, with the clock just sampled (issue #115).
          if (this.refuseStatusHandover(request, at))
            throw new StatusHandoverRefused("Status read refused at handover");
          request.sent = true;
          request.sentAt = at;
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
          // A write that returns (or settles) without calling `handing` has not handed the frame
          // over; expire() may then answer it as never sent.
          if (request && !request.sent) request.offered = true;
          if (!writable && drainGeneration === this.drainGeneration) this.blocked = true;
        } catch (error) {
          // A status read refused at its handover wrote nothing and is already answered; the
          // session takes its frame back. Any other throw is a transport failure.
          if (error instanceof StatusHandoverRefused && request?.refused) this.release(item);
          else this.loseContact();
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
        // Any valid frame is contact (issue #103); see `heard`.
        this.heard = true;
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
        if (value.type === "heartbeat") {
          this.heardHeartbeat = true;
          this.health?.heartbeat(value.load);
          continue;
        }
        if (value.type === "result" || value.type === "error") {
          const pending = this.pending.get(value.requestId);
          if (!pending || !pending.sent || !validatePipeResultForCommand(pending.command, value)) {
            this.loseContact();
            break;
          }
          const command = pending.command;
          if (pending.abandoned) {
            // The late reply of a command whose caller already has RESULT_UNKNOWN: it was valid,
            // so it only ends the correlation. Nothing is handed off, sealed or activated; an
            // accepted subscribe's route stays inactive, so its events stay fenced until the
            // unsubscribe the subscription layer sent when it gave up on the attach.
            this.settle(value.requestId);
            if (
              command.type === "unsubscribe" ||
              command.type === "subscribe" ||
              command.type === "recover"
            )
              this.forgetRoute(command.subscription, command.type === "unsubscribe");
            continue;
          }
          if (command.type === "preview-refresh") pending.previewSeal?.(structuredClone(value));
          if (this.closed || !this.pending.has(value.requestId)) break;
          if (
            (command.type === "subscribe" || command.type === "recover") &&
            value.type === "result" &&
            value.outcome === "accepted"
          ) {
            // This synchronous acknowledgement is the ingress activation barrier: only a route
            // whose marker the consumer admitted is activated. A refusal is the consumer's own
            // state (its subscription retired at its recovery deadline or with its connection,
            // and it unsubscribes), not a worker fault, so the route merely stays inactive and
            // its events stay fenced; the caller gets the result. Losing contact here turned a
            // slow attach into the loss of every terminal on the worker (issue #103).
            const activated = !!pending.handoff?.(structuredClone(value));
            if (this.closed || !this.pending.has(value.requestId)) break;
            if (activated)
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

  // Liveness and command deadlines (issue #103, docs/terminal-architecture.md 3.3 "worker 存活与
  // 命令期限"). A busy worker is not a lost one: the worker is lost only after livenessWindowMs of
  // runtime-observed silence (its heartbeat keeps coming while commands queue behind parsing), besides
  // process, pipe and protocol failures handled elsewhere. A command past its own deadline ends
  // alone, with an explicit outcome (see expire()). Route control has no deadline while the
  // worker is live.
  tick(): void {
    if (this.closed) return;
    const now = this.now();
    const elapsed = this.lastTick === undefined ? 0 : now - this.lastTick;
    this.lastTick = now;
    if (this.state !== "hello" && !this.ready) return;
    // The handshake is timed the same way as a ready worker's silence: an absolute deadline
    // would charge a runtime stall right after hello to the worker, and the first late tick
    // could then run before the buffered ready frame is read and lose a healthy worker.
    if (this.heard) {
      this.heard = false;
      this.silentMs = 0;
    } else this.silentMs += Math.min(elapsed, PIPE_HEARTBEAT_INTERVAL_MS);
    if (this.silentMs >= this.livenessWindowMs) {
      this.loseContact();
      return;
    }
    if (!this.ready) return;
    if (this.heardHeartbeat) {
      this.heardHeartbeat = false;
      this.sinceHeartbeatMs = 0;
    } else this.sinceHeartbeatMs += Math.min(elapsed, PIPE_HEARTBEAT_INTERVAL_MS);
    this.evaluateHealth(now);
    if (this.closed) return;
    for (const [requestId, entry] of [...this.pending]) {
      if (this.closed) return;
      if (
        entry.role !== "progress" &&
        entry.admitted &&
        !entry.abandoned &&
        (now >= entry.deadline ||
          // An admitted status read still unsent (queued behind a backpressured transport) whose
          // caller is gone is withdrawn like one past its deadline (issue #115).
          (!!entry.statusGuard && !entry.sent && !statusEligible(entry.statusGuard.eligible))) &&
        this.pending.get(requestId) === entry
      )
        this.expire(requestId, entry);
    }
    if (this.closed) return;
    // Waiting status reads whose deadline passed or whose caller is gone end on the tick too,
    // not only when the window frees.
    this.promoteStatus();
  }

  private evaluateHealth(now: number): void {
    if (!this.health) return;
    let oldest: number | undefined;
    for (const entry of this.pending.values())
      if (entry.sent && entry.sentAt !== undefined && entry.command.type !== "stop")
        oldest = Math.max(oldest ?? 0, now - entry.sentAt);
    const changed = this.health.evaluate(now, {
      heartbeatGapMs: this.sinceHeartbeatMs,
      oldestCommandAgeMs: oldest,
    });
    if (!changed) return;
    // Listeners are foreign code (logging, subscription publication) and may reenter.
    for (const listener of [...this.healthListeners.keys()]) {
      if (this.closed) return;
      if (!this.healthListeners.has(listener)) continue;
      try {
        listener({ state: changed.state, reasons: [...changed.reasons] });
      } catch {
        // Health is informational; a failing observer never affects the worker.
      }
    }
  }

  // The worker's current health, "normal" until it is ready; undefined once it is lost.
  get workerHealth(): WorkerHealth | undefined {
    if (this.closed) return undefined;
    return this.health?.health ?? { state: "normal", reasons: [] };
  }

  workerStatus(): WorkerStatus | undefined {
    if (!this.ready || !this.health) return undefined;
    return this.health.status(this.lastNow, this.worker.workerId);
  }

  onHealth(listener: (health: WorkerHealth) => void): { dispose(): void } {
    if (this.closed || this.healthListeners.size >= 32 || this.healthListeners.has(listener))
      throw new Error("Health listener capacity unavailable");
    const lease = this.composition.bytes.reserve(512);
    if (!lease) throw new Error("Health listener byte capacity unavailable");
    this.healthListeners.set(listener, lease);
    return {
      dispose: () => {
        if (this.healthListeners.get(listener) !== lease) return;
        this.healthListeners.delete(listener);
        lease.release();
      },
    };
  }

  // Ends one command whose deadline passed while the worker is live, keeping the worker.
  // - Still queued in the runtime (the transport is backpressured): the frame is withdrawn, so
  //   the worker never sees it, and the caller gets BUSY (not-accepted).
  // - Taken by the transport but never handed over (its write returned or settled without
  //   calling `handing`): nothing reached the worker either, so the caller gets BUSY too, and
  //   the correlation, identity and window slot are released, as no reply can come. The
  //   transport still owns the frame's bytes until it settles them (see release()); a late
  //   handover of the frame is refused and fails closed (see flush()).
  // - Already handed to the transport: the worker may have applied it, so the caller gets
  //   RESULT_UNKNOWN (input with subject "input"; never replayed). The correlation, identity and
  //   window slot stay until the worker's late reply, which is still validated (a protocol
  //   violation fails closed) and then discarded in receive(). Keeping the slot keeps every
  //   window bounded: overload shows as BUSY for later commands, not as unbounded growth.
  private expire(requestId: string, entry: Pending): void {
    if (!entry.sent) {
      const index = this.queue.findIndex((item) => item.request === entry);
      const item = this.queue[index];
      if (item && !item.prepaid) {
        this.queue.splice(index, 1);
        this.queuedBytes -= item.bytes.buffer.byteLength;
        if (item.role === "ordinary") this.ordinaryBytes -= item.bytes.buffer.byteLength;
        item.owned = false;
        item.lease.release();
        this.settle(requestId);
        const command = entry.command;
        // A withdrawn opener leaves its route to the unsubscribe its owner sends on the refusal.
        if (command.type === "subscribe" || command.type === "recover")
          this.forgetRoute(command.subscription, false);
        entry.resolve(this.error(command, "BUSY"));
        return;
      }
      if (!item && entry.offered) {
        entry.withdrawn = true;
        this.settle(requestId);
        const command = entry.command;
        if (command.type === "subscribe" || command.type === "recover")
          this.forgetRoute(command.subscription, false);
        entry.resolve(this.error(command, "BUSY"));
        return;
      }
    }
    entry.abandoned = true;
    entry.resolve(this.error(entry.command, "RESULT_UNKNOWN", true));
    // An abandoned status keeps the window until its late reply; the waiters are answered BUSY.
    if (entry.role === "status") this.scheduleStatusPromotion();
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
    // Waiting status reads were never sent.
    for (const waiter of this.statusWaiters.splice(0))
      waiter.resolve(this.error(waiter.command, "WORKER_UNAVAILABLE"));
    for (const pending of this.pending.values())
      if (!pending.abandoned)
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
    for (const lease of this.healthListeners.values()) lease.release();
    this.healthListeners.clear();
    this.releaseClosedRecords();
    this.options.contactLost?.(this.worker);
  }

  // Settlement ends both the correlation and its identity; see `identities`.
  private settle(requestId: string): void {
    const settled = this.pending.get(requestId);
    this.pending.delete(requestId);
    // A freed status window serves the next waiting status read.
    if (settled?.role === "status") this.scheduleStatusPromotion();
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
