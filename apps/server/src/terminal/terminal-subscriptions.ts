import { createHash } from "node:crypto";
import { domainError, type DomainError, type DomainErrorKind } from "@cove/protocol/errors";
import {
  OpaqueIdSchema,
  sameConnectionRef,
  sameRunRef,
  sameSubscriptionRef,
  sameWorkerRef,
  type SubscriptionRef,
  type WorkerRef,
} from "@cove/protocol/identity";
import { PROFILE, BASELINE_ENCODING } from "@cove/protocol/profile";
import {
  TerminalCommandSchema,
  validateTerminalResultForCommand,
  externalEventSubscription,
  HEADER_BYTES,
  MAX_METADATA_BYTES,
  type TerminalCommand,
  type TerminalError,
  type TerminalResult,
  type ExternalTerminalEvent,
  type WorkerHealth,
} from "@cove/protocol/terminal";
import type { PipeCommand, PipeEvent } from "@cove/protocol/pipe";
import type { RuntimeResult } from "@cove/protocol/runtime";
import { LocalRuntime } from "./local-runtime.js";
import { RuntimeComposition } from "./runtime-composition.js";
import type { ByteReservation } from "./runtime-retained-bytes.js";
import {
  PREPAID_DELIVERY_OVERHEAD,
  TerminalConnectionDelivery,
  type DeliveryFence,
} from "./terminal-connection-delivery.js";
import { TerminalDeliveryCredit } from "./terminal-delivery-credit.js";
import type { ResultHandoff } from "./worker-pipe-session.js";
import { ControlArbiter, type ControlCommand, type ControlJob } from "./control-arbiter.js";
import { publishPreview } from "./preview-transfer.js";
import type { PreviewPicture } from "./preview-cache.js";

// The record of one request while it is queued or executing.
const REQUEST_BYTES = 6 * 4096 + 2048;
// Route control (detach, applied-ack, baseline-progress) is never refused for capacity on a
// live subscription (issue #96). The client counts an ACK handed to the connection as covering
// the commands it sends after it, so the server must apply every ACK it receives in order;
// a refusal after the handoff could never be repaired. Each route therefore pays at attach for
// one unsettled record of each of the three types, the most a conforming client sends, and the
// worker pipe prepays their onward storage in the same way (see worker-pipe-session).
const ROUTE_CONTROL_BYTES = 3 * REQUEST_BYTES;
const PREPAID: ByteReservation = Object.freeze({ bytes: 0, release() {} });
// The result frames of those commands are prepaid too. Each route reserves ROUTE_RESULT_SLOTS
// result slots at attach, each enough for one result frame with its delivery record and
// backing. A result holds a slot from its delivery admission until the frame's write callback,
// which may run after the client has read the result and sent the next command. A result that
// finds every slot of its route taken waits in the route, still unsettled, until one frees;
// the per-route bound of one unsettled command per type therefore also bounds the waiting
// results. Results never draw on the connection's shared item or byte budgets, so other
// connections' output cannot make the server retire a route whose ACK the worker accepted.
const ROUTE_RESULT_SLOTS = 3;
// A worker-health event (issue #103) is informational and must never displace terminal data:
// admitted against the shared item and byte budgets, it could make the route's next output
// frame fail admission, which retires the route with RESYNC_REQUIRED. Each route therefore
// also reserves one slot of the same size at attach for its health events. At most one is in
// delivery at a time; changes meanwhile coalesce, because publishHealth() is level-triggered
// and sends the then-current value once the slot is back.
const ROUTE_HEALTH_SLOTS = 1;
const NORMAL_HEALTH: WorkerHealth = Object.freeze({ state: "normal", reasons: [] }) as WorkerHealth;
const RESULT_SLOT_BYTES = HEADER_BYTES + MAX_METADATA_BYTES + PREPAID_DELIVERY_OVERHEAD;

type Supported =
  | Extract<
      TerminalCommand,
      { type: "attach" | "recover" | "detach" | "applied-ack" | "baseline-progress" }
    >
  | ControlCommand;
type Reply = TerminalResult | TerminalError;
type Route = {
  ref: SubscriptionRef;
  worker: WorkerRef;
  attempt: number;
  phase: "opening" | "active" | "retired";
  failure?: DomainError | undefined;
  credit?: TerminalDeliveryCredit | undefined;
  deadline: number;
  // When an opening attempt with no marker yet is answered not-accepted (see markerDeadline()).
  markerDeadline: number;
  lease: ByteReservation;
  unsubscribeId: string;
  token: { current: boolean };
  teardownSent: boolean;
  teardown?: Promise<RuntimeResult> | undefined;
  queue: Request[];
  running: boolean;
  // Free prepaid result slots (see RESULT_SLOT_BYTES), the number handed to delivery, and the
  // route-control requests whose result waits for a slot. `dropped` is set once the route's
  // storage is released; a slot that comes back after that is released too.
  resultSlots: ByteReservation[];
  resultSlotsOut: number;
  waitingResults: Request[];
  dropped: boolean;
  // The worker health this route's client was last given, and the route's prepaid health slot
  // while it is free (undefined while delivery holds it; see publishHealth()).
  deliveredHealth: WorkerHealth;
  healthSlot: ByteReservation | undefined;
};
type Request = {
  command: Supported;
  internalId: string;
  route: Route;
  attempt: number;
  resolve: (reply: Reply) => void;
  marker?: TerminalResult;
  lease: ByteReservation;
  control: boolean;
  settled: boolean;
  domain?: ControlJob;
  // The result of a route-control request that waits for a result slot, and the gate the route
  // queue waits on until that result is admitted to delivery (see run()).
  waitingReply?: Reply | undefined;
  resultGate?: Promise<void>;
  openResultGate?: () => void;
  // A recover's deadlines, from its acceptance in handle() (the client starts timing it before
  // that), and whether it has started executing. A recover queued behind an unanswered ACK
  // must still be answered before the client's own deadline (see tick()).
  recoverDeadlines?: { deadline: number; markerDeadline: number };
  started?: boolean;
};

type Teardown = {
  route: Route;
  requestId: string;
  resolve: (result: RuntimeResult) => void;
  reject: (error: unknown) => void;
};

// One authenticated connection owns refs; the runtime still owns execution facts.
export class TerminalSubscriptions {
  private readonly routes = new Map<string, Route>();
  // Retired routes leave `routes` once their queue drained and their unsubscribe settled
  // (see reap()), so attach admission is bounded by live and retiring routes, never by the
  // connection's lifetime total. Commands for a dropped subscription still get refused:
  // subscription IDs are minted here with a per-connection sequence and never reused, so
  // an unknown ID is answered STALE_CONNECTION without remembering it. Only a route that
  // retired with a specific first cause (RECOVERY_EXPIRED, RESYNC_REQUIRED, ...) needs
  // memory to report that cause, and only within a bounded FIFO window of recent
  // failures; older ones fall back to STALE_CONNECTION, which is still a refusal.
  private readonly retiredFailures = new Map<
    string,
    { ref: SubscriptionRef; failure: DomainError; lease: ByteReservation | null }
  >();
  private readonly requests = new Map<string, Request>();
  private readonly teardownQueue: Teardown[] = [];
  private teardownActive = false;
  // Client request IDs are opaque, so the server cannot prove ordering. It rejects reuse
  // of an in-flight ID and of one in a bounded FIFO window of recently settled IDs; the
  // client mints a fresh ID per request, so an ID older than the window is never reused
  // legitimately. requestLimit bounds in-flight IDs and the window, never the lifetime
  // total: retaining every settled ID used to make a long-lived connection BUSY forever.
  private readonly externalIds = new Set<string>();
  private readonly settledIds = new Map<string, ByteReservation | null>();
  private readonly previewAttempts = new Set<{
    current: boolean;
    cancel(): void;
    fence: DeliveryFence;
  }>();
  // Leases of requests not yet removed from their route queue (or of in-flight
  // previews). Each is released once its request leaves the queue, so they are bounded
  // by pending work rather than accumulating for the connection's lifetime.
  private readonly requestLeases = new Set<ByteReservation>();
  private readonly listener: { dispose(): void };
  private readonly arena: ByteReservation;
  private closedState = false;
  private sequence = 0;
  private generating = false;
  private ordinaryPending = 0;
  private controlPending = 0;
  private lastNow = 0;
  private inFlight = 0;
  private released = false;
  private readonly requestNamespace: string;

  constructor(
    readonly composition: RuntimeComposition,
    readonly runtime: LocalRuntime,
    readonly delivery: TerminalConnectionDelivery,
    private readonly options: {
      createOpaqueId: () => string;
      now: () => number;
      identityLimit: number;
      requestLimit: number;
      arbiter?: ControlArbiter;
    },
  ) {
    if (
      runtime.composition !== composition ||
      (options.arbiter && options.arbiter.runtime !== runtime) ||
      delivery.composition !== composition ||
      delivery.closed ||
      !Number.isSafeInteger(options.identityLimit) ||
      options.identityLimit < 1 ||
      options.identityLimit > 4096 ||
      !Number.isSafeInteger(options.requestLimit) ||
      options.requestLimit < 1 ||
      options.requestLimit > 4096
    )
      throw new Error("Invalid subscription composition");
    const arena = composition.bytes.reserve(4096);
    if (!arena) throw new Error("Subscription capacity unavailable");
    this.arena = arena;
    this.requestNamespace = createHash("sha256")
      .update(JSON.stringify([delivery.connection.connectionId, delivery.connection.generation]))
      .digest("hex");
    try {
      this.listener = runtime.onEvent((event, bytes) => this.event(event, bytes));
    } catch (error) {
      arena.release();
      throw error;
    }
  }

  get closed(): boolean {
    return this.closedState;
  }
  private now(): number {
    const now = this.options.now();
    if (
      !Number.isSafeInteger(now) ||
      now < this.lastNow ||
      now > Number.MAX_SAFE_INTEGER - this.composition.budgets.recoveryDeadlineMs
    )
      throw new Error("Invalid monotonic subscription clock");
    this.lastNow = now;
    return now;
  }
  private id(role: string): string | null {
    if (
      this.closed ||
      this.delivery.closed ||
      this.generating ||
      this.sequence === Number.MAX_SAFE_INTEGER
    )
      return null;
    const suffix = `.${role}${++this.sequence}`;
    this.generating = true;
    try {
      const supplied = this.options.createOpaqueId();
      if (!OpaqueIdSchema.safeParse(supplied).success) return null;
      return role === "s"
        ? supplied.slice(0, 128 - suffix.length) + suffix
        : this.requestNamespace + suffix;
    } catch {
      return null;
    } finally {
      this.generating = false;
    }
  }
  private error(command: TerminalCommand, error: DomainError | DomainErrorKind): TerminalError {
    return {
      type: "error",
      requestId: command.requestId,
      run: structuredClone(command.run),
      commandType: command.type,
      error: typeof error === "string" ? domainError(error) : error,
    };
  }
  private reject(command: TerminalCommand, error: DomainError | DomainErrorKind): Promise<Reply> {
    const reply = this.error(command, error);
    if (!this.closed) this.delivery.admit(reply, new Uint8Array(), { control: true });
    return Promise.resolve(reply);
  }
  private find(command: Exclude<Supported, { type: "attach" }>): Route | undefined {
    const found = this.routes.get(command.subscription.subscriptionId);
    return found &&
      sameSubscriptionRef(found.ref, command.subscription) &&
      sameRunRef(command.run, found.ref.run) &&
      sameConnectionRef(found.ref.connection, this.delivery.connection)
      ? found
      : undefined;
  }
  private resumeValid(command: Extract<Supported, { type: "attach" | "recover" }>): boolean {
    if (
      command.type === "attach" &&
      (command.profile !== PROFILE || command.encoding !== BASELINE_ENCODING)
    )
      return false;
    if (!command.resume) return true;
    const geometry = this.runtime.registry.get(command.run)?.status.geometry;
    return (
      command.resume.profile === PROFILE &&
      command.resume.encoding === BASELINE_ENCODING &&
      command.resume.geometry.cols <= this.composition.budgets.maxCols &&
      command.resume.geometry.rows <= this.composition.budgets.maxRows &&
      geometry?.cols === command.resume.geometry.cols &&
      geometry.rows === command.resume.geometry.rows
    );
  }

  handle(input: TerminalCommand, payload: Uint8Array = new Uint8Array()): Promise<Reply> {
    if (this.closed || this.delivery.closed) return this.reject(input, "STALE_CONNECTION");
    let now: number;
    try {
      now = this.now();
    } catch {
      this.close();
      return this.reject(input, "STALE_CONNECTION");
    }
    const parsed = TerminalCommandSchema.safeParse(input);
    if (!parsed.success) return this.reject(input, "CAPABILITY_UNAVAILABLE");
    const command = structuredClone(parsed.data);
    if (
      command.type !== "attach" &&
      command.type !== "recover" &&
      command.type !== "detach" &&
      command.type !== "applied-ack" &&
      command.type !== "baseline-progress" &&
      command.type !== "preview" &&
      (!this.options.arbiter || !this.isDomain(command))
    )
      return this.reject(command, "CAPABILITY_UNAVAILABLE");
    if (!this.composition.owns(command.run)) return this.reject(command, "INSTANCE_MISMATCH");
    if (this.knownId(command.requestId)) return this.reject(command, "COUNTER_EXHAUSTED");
    // Route control (detach, applied-ack, baseline-progress) is bounded per subscription, not
    // by request or byte capacity (see ROUTE_CONTROL_BYTES). A subscription holds at most one
    // unsettled command of each of these types (checked below once its route is known); the
    // client keeps at most one ACK and one progress report in flight per subscription and
    // folds newer ones into the latest, so a conforming client is never refused. The route
    // queue runs them one at a time, and the worker pipe holds any that find its window full
    // until a slot frees. A fixed connection-wide window of PIPE_ROUTE_CONTROL_COMMANDS used to
    // refuse the fifth streaming subscription's ACK with BUSY, ending it for good (issue #96).
    // Their identities may exceed requestLimit by at most three per route.
    const control =
      command.type === "detach" ||
      command.type === "applied-ack" ||
      command.type === "baseline-progress";
    if (
      !control &&
      (this.externalIds.size >= this.options.requestLimit ||
        this.ordinaryPending >= this.composition.budgets.pendingWorkerCommands)
    )
      return this.reject(command, "BUSY");
    if (command.type === "preview") return this.preview(command);
    let route: Route | undefined;
    if (command.type === "attach") {
      if (!sameConnectionRef(command.connection, this.delivery.connection))
        return this.reject(command, "STALE_CONNECTION");
      if (!this.resumeValid(command)) return this.reject(command, "PROFILE_UNSUPPORTED");
      if (
        this.routes.size >= this.options.identityLimit ||
        [...this.routes.values()].filter((value) => value.phase !== "retired").length >=
          this.composition.budgets.subscriptionsPerConnection
      )
        return this.reject(command, "BUSY");
      if (!this.runtime.registry.get(command.run)) return this.reject(command, "RUN_NOT_FOUND");
    } else {
      route = this.find(command);
      if (!route) return this.reject(command, this.retiredFailure(command) ?? "STALE_CONNECTION");
      if (route.phase === "retired")
        return this.reject(command, route.failure ?? "STALE_CONNECTION");
      // An ACK or progress report is cumulative and its successor covers it, but the client
      // sends the successor only after this one settles. A second unsettled one is refused,
      // not queued, so a route never holds more than one of each (see the admission above).
      if (
        control &&
        [...route.queue, ...route.waitingResults].some(
          (value) => !value.settled && value.command.type === command.type,
        )
      )
        return this.reject(command, "BUSY");
      if (
        command.type === "recover" &&
        (!this.resumeValid(command) ||
          route.phase !== "active" ||
          route.queue.some((value) => value.command.type === "recover"))
      )
        return this.reject(command, "RESYNC_REQUIRED");
    }
    const placement = this.runtime.pool.get(command.run);
    if (!placement || (route && !sameWorkerRef(route.worker, placement.worker)))
      return this.reject(command, "WORKER_UNAVAILABLE");
    const requestLease = control ? PREPAID : this.composition.bytes.reserve(REQUEST_BYTES);
    if (!requestLease) return this.reject(command, "BUSY");
    let internalId: string | null;
    if (command.type === "attach") {
      const lease = this.composition.bytes.reserve(8192 + ROUTE_CONTROL_BYTES);
      const resultSlots: ByteReservation[] = [];
      // The last slot becomes the route's health slot (see ROUTE_HEALTH_SLOTS).
      for (let index = 0; lease && index < ROUTE_RESULT_SLOTS + ROUTE_HEALTH_SLOTS; index++) {
        const slot = this.composition.bytes.reserve(RESULT_SLOT_BYTES);
        if (!slot) break;
        resultSlots.push(slot);
      }
      if (!lease || resultSlots.length < ROUTE_RESULT_SLOTS + ROUTE_HEALTH_SLOTS) {
        lease?.release();
        for (const slot of resultSlots) slot.release();
        requestLease.release();
        return this.reject(command, "BUSY");
      }
      const subscriptionId = this.id("s");
      const unsubscribeId = this.id("u");
      internalId = this.id("r");
      if (
        !subscriptionId ||
        !unsubscribeId ||
        !internalId ||
        this.closed ||
        this.delivery.closed ||
        this.routes.has(subscriptionId)
      ) {
        lease.release();
        for (const slot of resultSlots) slot.release();
        requestLease.release();
        return this.reject(command, "COUNTER_EXHAUSTED");
      }
      const healthSlot = resultSlots.pop()!;
      route = {
        ref: {
          run: structuredClone(command.run),
          connection: { ...this.delivery.connection },
          viewId: command.viewId,
          subscriptionId,
        },
        worker: placement.worker,
        attempt: 1,
        phase: "opening",
        deadline: now + this.composition.budgets.recoveryDeadlineMs,
        markerDeadline: now + this.markerDeadline(),
        lease,
        unsubscribeId,
        token: { current: true },
        teardownSent: false,
        queue: [],
        running: false,
        resultSlots,
        resultSlotsOut: 0,
        waitingResults: [],
        dropped: false,
        deliveredHealth: NORMAL_HEALTH,
        healthSlot,
      };
      this.routes.set(subscriptionId, route);
    } else internalId = this.id("r");
    if (!internalId || this.closed || this.delivery.closed) {
      requestLease.release();
      return this.reject(command, "COUNTER_EXHAUSTED");
    }
    let domain: ControlJob | undefined;
    if (this.isDomain(command)) {
      const attempt = route!.attempt;
      const token = route!.token;
      const current = () =>
        !this.closed &&
        !this.delivery.closed &&
        route!.phase === "active" &&
        route!.attempt === attempt &&
        token.current;
      const admitted = this.options.arbiter!.admit(
        command,
        {
          subscription: structuredClone(route!.ref),
          worker: structuredClone(route!.worker),
          requestId: internalId,
          releaseId: route!.unsubscribeId + ".c",
          current,
          installed: (atSeq = 0) => {
            const credit = route!.credit?.snapshot();
            return (
              current() &&
              !!credit?.installed &&
              credit.appliedSeq >= Math.max(route!.credit!.atSeq, atSeq)
            );
          },
          earlierPending: () => route!.queue.length > 0,
        },
        payload,
      );
      if (!("promise" in admitted)) {
        requestLease.release();
        return this.reject(command, admitted);
      }
      domain = admitted;
    }
    let resolve!: (reply: Reply) => void;
    const promise = new Promise<Reply>((done) => {
      resolve = done;
    });
    const request: Request = {
      command,
      internalId,
      route: route!,
      attempt: route!.attempt,
      resolve,
      lease: requestLease,
      control,
      settled: false,
      ...(domain ? { domain } : {}),
      ...(command.type === "recover" && {
        recoverDeadlines: {
          deadline: now + this.composition.budgets.recoveryDeadlineMs,
          markerDeadline: now + this.markerDeadline(),
        },
      }),
    };
    this.externalIds.add(command.requestId);
    this.requestLeases.add(requestLease);
    this.requests.set(internalId, request);
    if (control) this.controlPending++;
    else this.ordinaryPending++;
    route!.queue.push(request);
    void this.run(route!);
    return promise;
  }

  private retiredFailure(command: Exclude<Supported, { type: "attach" }>): DomainError | undefined {
    const entry = this.retiredFailures.get(command.subscription.subscriptionId);
    return entry &&
      sameSubscriptionRef(entry.ref, command.subscription) &&
      sameRunRef(command.run, entry.ref.run)
      ? entry.failure
      : undefined;
  }

  // Drops a retired route once nothing can still reference it through this connection:
  // its queue has drained (each request holds the route directly until dequeued) and its
  // unsubscribe settled, so the worker no longer routes events to it and no teardown
  // still needs the record. The arbiter was already told at retirement. The route
  // lease, with its prepaid route-control records, is released with it.
  private reap(route: Route): void {
    const id = route.ref.subscriptionId;
    if (
      this.closed ||
      route.phase !== "retired" ||
      route.running ||
      route.queue.length ||
      route.waitingResults.length ||
      route.resultSlotsOut ||
      !route.teardownSent ||
      route.teardown ||
      this.routes.get(id) !== route
    )
      return;
    this.routes.delete(id);
    this.dropRoute(route);
    if (!route.failure) return;
    // As with settledIds, only the window size evicts; without byte capacity the entry
    // is remembered unaccounted (still bounded by identityLimit).
    while (this.retiredFailures.size >= this.options.identityLimit) {
      const oldest = this.retiredFailures.entries().next();
      if (oldest.done) break;
      this.retiredFailures.delete(oldest.value[0]);
      oldest.value[1].lease?.release();
    }
    this.retiredFailures.set(id, {
      ref: route.ref,
      failure: route.failure,
      lease: this.composition.bytes.reserve(1024),
    });
  }

  private isDomain(command: TerminalCommand): command is ControlCommand {
    return (
      command.type === "focus" ||
      command.type === "blur" ||
      command.type === "resize" ||
      command.type === "appearance" ||
      command.type === "input"
    );
  }

  private async preview(command: Extract<TerminalCommand, { type: "preview" }>): Promise<Reply> {
    if (!this.runtime.registry.get(command.run)) return this.reject(command, "RUN_NOT_FOUND");
    const lease = this.composition.bytes.reserve(6 * 4096 + 2048);
    if (!lease) return this.reject(command, "BUSY");
    // Capture ownership before ID/clock suppliers can reenter and create a picture.
    let unchanged: Pick<PreviewPicture, "version" | "worker" | "geometry"> | undefined;
    try {
      const admitted = this.runtime.previews.cache.acquire(command.run);
      if (admitted && admitted.picture.version === command.knownVersion)
        unchanged = {
          version: admitted.picture.version,
          worker: admitted.picture.worker,
          geometry: admitted.picture.geometry,
        };
      admitted?.release();
    } catch {
      lease.release();
      return this.reject(command, "BUSY");
    }
    const previewId = this.id("p");
    if (
      !previewId ||
      this.closed ||
      this.delivery.closed ||
      this.knownId(command.requestId) ||
      this.externalIds.size >= this.options.requestLimit ||
      this.ordinaryPending >= this.composition.budgets.pendingWorkerCommands
    ) {
      lease.release();
      return this.reject(command, "COUNTER_EXHAUSTED");
    }
    this.externalIds.add(command.requestId);
    this.requestLeases.add(lease);
    this.ordinaryPending++;
    this.inFlight++;
    const attempt = {
      current: true,
      cancel: () => {},
      fence: undefined as unknown as DeliveryFence,
    };
    const current = () => attempt.current && !this.closed && !this.delivery.closed;
    attempt.fence = { route: "preview." + previewId, attempt: 1, current };
    this.previewAttempts.add(attempt);
    try {
      const waiter = this.runtime.previews.request(command.run);
      attempt.cancel = waiter.cancel;
      if (!current()) waiter.cancel();
      const outcome = await waiter.promise;
      if (!current()) return this.error(command, "STALE_CONNECTION");
      if (!outcome.ok) return this.reject(command, outcome.error);
      const cache = this.runtime.previews.cache;
      if (cache.getRecord(command.run)?.preview.stale)
        return this.reject(command, "RECOVERY_UNAVAILABLE");
      const reader = cache.acquire(command.run);
      if (!reader) return this.reject(command, "BUSY");
      try {
        if (command.knownVersion !== undefined && command.knownVersion > reader.picture.version)
          return this.reject(command, "RESYNC_REQUIRED");
        const reply = publishPreview(
          this.delivery,
          reader,
          command.requestId,
          unchanged &&
            sameWorkerRef(unchanged.worker, reader.picture.worker) &&
            unchanged.geometry.cols === reader.picture.geometry.cols &&
            unchanged.geometry.rows === reader.picture.geometry.rows
            ? unchanged.version
            : undefined,
          previewId,
          attempt.fence,
        );
        if (reply) return reply;
        attempt.current = false;
        this.delivery.cancel(attempt.fence);
        return this.reject(command, domainError("RESULT_UNKNOWN", "unknown"));
      } finally {
        reader.release();
      }
    } catch {
      return this.reject(command, "BUSY");
    } finally {
      this.ordinaryPending--;
      this.inFlight--;
      this.settleId(command.requestId);
      if (this.requestLeases.delete(lease)) lease.release();
      // A settled attempt needs no close-time cancellation: its fence also reads
      // delivery.closed, so dropping it here keeps the set bounded by in-flight previews.
      this.previewAttempts.delete(attempt);
      this.releaseClosedRecords();
    }
  }

  private fence(route: Route, attempt = route.attempt): DeliveryFence {
    const token = route.token;
    return { route: route.ref.subscriptionId, attempt, current: () => token.current };
  }

  private async run(route: Route): Promise<void> {
    if (route.running) return;
    route.running = true;
    try {
      while (route.queue.length) {
        const request = route.queue[0]!;
        if (this.closed || route.phase === "retired") {
          this.finish(request, this.error(request.command, route.failure ?? "STALE_CONNECTION"));
          this.dequeue(route);
          continue;
        }
        this.inFlight++;
        try {
          await this.execute(request);
          // A result waiting for a result slot keeps the route's order: the next command (a
          // recover, say) must not publish its result first. The client would then send an
          // ACK for the new attempt while this one is still unsettled, and get BUSY. The gate
          // opens once the result is admitted to delivery (not written), or the request ends.
          if (request.resultGate) await request.resultGate;
        } catch {
          this.retire(route, domainError("RESULT_UNKNOWN", "unknown"));
          this.finish(request, this.error(request.command, route.failure!));
        } finally {
          this.inFlight--;
          this.flushTeardown();
          this.releaseClosedRecords();
        }
        this.dequeue(route);
      }
    } finally {
      route.running = false;
      this.reap(route);
    }
  }

  // A request's lease covers its record while it is queued or executing, even after an
  // early finish (tick/close may settle it before execute returns).
  private dequeue(route: Route): void {
    const request = route.queue.shift();
    if (request && this.requestLeases.delete(request.lease)) request.lease.release();
  }

  private knownId(requestId: string): boolean {
    return this.externalIds.has(requestId) || this.settledIds.has(requestId);
  }

  // Moves a settled ID from the in-flight set into the recent window, evicting the oldest.
  // Only the window size evicts: byte pressure must never shrink the promised refusal
  // window, so without capacity the ID is remembered unaccounted (still bounded by
  // requestLimit) rather than displacing a newer one.
  private settleId(requestId: string): void {
    if (!this.externalIds.delete(requestId) || this.closed) return;
    while (this.settledIds.size >= this.options.requestLimit) this.evictSettledId();
    this.settledIds.set(requestId, this.composition.bytes.reserve(256));
  }

  private evictSettledId(): void {
    const oldest = this.settledIds.entries().next();
    if (oldest.done) return;
    this.settledIds.delete(oldest.value[0]);
    oldest.value[1]?.release();
  }

  private async execute(request: Request): Promise<void> {
    const { command, route, internalId } = request;
    request.started = true;
    if (request.domain) {
      const reply = await this.options.arbiter!.execute(request.domain);
      this.finish(
        request,
        reply,
        this.closed ||
          this.delivery.closed ||
          route.phase === "retired" ||
          route.attempt !== request.attempt,
      );
      return;
    }
    if (command.type === "recover") {
      // A recover that waited in the route queue (behind an ACK the worker answered late) may
      // reach this point after its marker deadline, before any tick expired it. Sending it now
      // could still activate a recovery the client has already given up on, so it ends here
      // as the tick would have ended it: never sent, so definitely not accepted.
      if (this.now() >= request.recoverDeadlines!.markerDeadline) {
        this.expireRecovery(route);
        return;
      }
      if (route.attempt === Number.MAX_SAFE_INTEGER) {
        this.retire(route, domainError("COUNTER_EXHAUSTED"));
        this.finish(request, this.error(command, route.failure!));
        return;
      }
      this.delivery.cancel(this.fence(route));
      route.token.current = false;
      route.token = { current: true };
      route.credit?.retire();
      route.credit = undefined;
      route.attempt++;
      request.attempt = route.attempt;
      // The new attempt's fence drops a health event still queued for the old one, and the
      // client resets its copy when it starts a recovery; publishHealth() resends a change.
      route.deliveredHealth = NORMAL_HEALTH;
      route.phase = "opening";
      // Counted from acceptance, not from now: the recover may have waited in the route queue.
      route.deadline = request.recoverDeadlines!.deadline;
      route.markerDeadline = request.recoverDeadlines!.markerDeadline;
    }
    const common = {
      worker: route.worker,
      run: route.ref.run,
      subscription: route.ref,
      requestId: internalId,
    };
    let result: RuntimeResult;
    if (command.type === "attach" || command.type === "recover") {
      // Bind correlation before dispatch: receive() can hand off result and N+1 synchronously.
      const pipe: Extract<PipeCommand, { type: "subscribe" | "recover" }> =
        command.type === "attach"
          ? { ...common, type: "subscribe", atSeq: command.resume?.appliedSeq ?? 0 }
          : {
              ...common,
              type: "recover",
              ...(command.resume ? { appliedSeq: command.resume.appliedSeq } : {}),
            };
      result = await this.runtime.openSubscription(pipe);
    } else if (command.type === "detach") {
      this.retire(route);
      const teardown = this.unsubscribe(route, internalId);
      if (!teardown) {
        this.finish(request, this.error(command, route.failure ?? "STALE_CONNECTION"));
        return;
      }
      result = await teardown;
    } else if (command.type === "applied-ack") {
      if (!route.credit?.ack(command.appliedSeq)) {
        this.finish(request, this.error(command, "RESYNC_REQUIRED"));
        return;
      }
      this.delivery.wake();
      if (this.closed || this.delivery.closed || route.phase === "retired") {
        this.finish(request, this.error(command, route.failure ?? "STALE_CONNECTION"));
        return;
      }
      result = await this.runtime.ackApplied({
        ...common,
        type: "applied-ack",
        appliedSeq: command.appliedSeq,
      });
    } else if (command.type === "baseline-progress") {
      if (!route.credit?.progress(command.baselineId, command.lastParsedOrdinal)) {
        this.finish(request, this.error(command, "RESYNC_REQUIRED"));
        return;
      }
      this.delivery.wake();
      if (this.closed || this.delivery.closed || route.phase === "retired") {
        this.finish(request, this.error(command, route.failure ?? "STALE_CONNECTION"));
        return;
      }
      result = await this.runtime.ackBaselineProgress({
        ...common,
        type: "baseline-progress",
        baselineId: command.baselineId,
        lastParsedOrdinal: command.lastParsedOrdinal,
      });
    } else {
      this.finish(request, this.error(command, "CAPABILITY_UNAVAILABLE"));
      return;
    }
    if (request.settled) return;
    if ((command.type === "attach" || command.type === "recover") && request.marker) {
      this.finish(request, request.marker, true);
      return;
    }
    if (result.type === "error") {
      this.retire(route, result.error);
      this.finish(request, this.error(command, route.failure ?? result.error));
      return;
    }
    if (result.outcome !== "accepted") {
      const error = domainError(
        result.outcome === "unknown" ? "RESULT_UNKNOWN" : "RESYNC_REQUIRED",
        result.outcome === "unknown" ? "unknown" : "not-accepted",
      );
      this.retire(route, error);
      this.finish(request, this.error(command, error));
      return;
    }
    const correlated = {
      requestId: command.requestId,
      run: route.ref.run,
      subscription: route.ref,
    };
    const reply: TerminalResult | undefined =
      command.type === "detach"
        ? { ...correlated, type: "detach-result", detached: true }
        : command.type === "applied-ack"
          ? { ...correlated, type: "applied-ack-result", appliedSeq: command.appliedSeq }
          : command.type === "baseline-progress"
            ? {
                ...correlated,
                type: "baseline-progress-result",
                baselineId: command.baselineId,
                lastParsedOrdinal: command.lastParsedOrdinal,
              }
            : undefined;
    if (!reply) {
      this.retire(route, domainError("RESULT_UNKNOWN", "unknown"));
      this.finish(request, this.error(command, route.failure!));
      return;
    }
    this.finish(request, reply);
  }

  readonly handoff: ResultHandoff = (result) => {
    const request = this.requests.get(result.requestId);
    if (
      !request ||
      request.settled ||
      request.marker ||
      result.type !== "result" ||
      result.outcome !== "accepted" ||
      this.closed ||
      this.delivery.closed
    )
      return false;
    const { route, command } = request;
    if (
      (command.type !== "attach" && command.type !== "recover") ||
      route.phase !== "opening" ||
      route.attempt !== request.attempt ||
      !sameWorkerRef(result.worker, route.worker) ||
      !sameRunRef(result.run, route.ref.run) ||
      result.commandType !== (command.type === "attach" ? "subscribe" : "recover") ||
      result.recoveryMode === undefined ||
      result.atSeq === undefined
    )
      return false;
    const marker: Extract<TerminalResult, { type: "attach-result" | "recover-result" }> = {
      type: command.type === "attach" ? "attach-result" : "recover-result",
      requestId: command.requestId,
      run: route.ref.run,
      subscription: route.ref,
      mode: result.recoveryMode,
      atSeq: result.atSeq,
    };
    if (!validateTerminalResultForCommand(command, marker)) return false;
    // The worker's acceptance can arrive after the marker deadline but before the tick that
    // would expire the attempt. Admitting the marker then would activate a subscription the
    // client is about to time out (it started timing earlier); refusing the handoff instead
    // leaves the worker route inactive and fenced, and the attempt ends as the tick would end
    // it. The pending attach/recover is settled here, so execute() returns without a reply.
    if (this.now() >= route.markerDeadline) {
      this.expireRecovery(route);
      return false;
    }
    const credit = new TerminalDeliveryCredit(
      this.composition,
      route.attempt,
      marker.mode,
      marker.atSeq,
      command.resume?.appliedSeq,
    );
    const admitted = this.delivery.admit(marker, new Uint8Array(), {
      control: true,
      fence: this.fence(route),
      admitted: () => {
        route.credit = credit;
        request.marker = marker;
        route.phase = "active";
      },
    });
    if (!admitted || !this.fence(route, request.attempt).current()) {
      credit.retire();
      this.retire(route, domainError("RESULT_UNKNOWN", "unknown"));
      return false;
    }
    return true;
  };

  private event(event: PipeEvent, bytes: Uint8Array): void {
    if (this.closed || this.delivery.closed || !event.subscription) return;
    const route = this.routes.get(event.subscription.subscriptionId);
    if (
      !route ||
      route.phase !== "active" ||
      !sameSubscriptionRef(event.subscription, route.ref) ||
      !sameRunRef(event.run, route.ref.run) ||
      !sameWorkerRef(event.worker, route.worker)
    )
      return;
    const terminal = event.terminal;
    const external: ExternalTerminalEvent =
      "seq" in terminal
        ? { type: "run-event", subscription: route.ref, event: terminal }
        : (terminal as ExternalTerminalEvent);
    const ref = externalEventSubscription(external);
    if (!ref || !sameSubscriptionRef(ref, route.ref)) {
      this.retire(route, domainError("RESYNC_REQUIRED"));
      return;
    }
    const credit = route.credit!;
    const fence = this.fence(route);
    const accepted = this.delivery.admit(external, bytes, {
      control: false,
      fence,
      prepare: (encodedBytes) => {
        const record = credit.record(external, encodedBytes, bytes.byteLength);
        return record
          ? { eligible: () => credit.eligible(record), handoff: () => credit.handoff(record) }
          : null;
      },
    });
    if (!accepted && fence.current()) this.retire(route, domainError("RESYNC_REQUIRED"));
  }

  private retire(route: Route, error?: DomainError): void {
    if (route.phase === "retired") {
      if (!route.failure && error) route.failure = error;
      return;
    }
    this.delivery.cancel(this.fence(route));
    route.phase = "retired";
    route.token.current = false;
    route.failure ??= error;
    route.credit?.retire();
    route.credit = undefined;
    this.options.arbiter?.retire(route.ref);
    if (error) this.unsubscribe(route);
  }
  private unsubscribe(
    route: Route,
    requestId = route.unsubscribeId,
  ): Promise<RuntimeResult> | undefined {
    if (route.teardownSent) return route.teardown;
    route.teardownSent = true;
    let resolve!: (result: RuntimeResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<RuntimeResult>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    // Close has no result consumer; detach still receives the original rejection.
    void promise.catch(() => {});
    route.teardown = promise;
    this.teardownQueue.push({ route, requestId, resolve, reject });
    this.flushTeardown();
    return promise;
  }
  // Unsubscribes leave one at a time. They need no share of the worker's route-control window
  // reserved here: the worker pipe holds a route-control command that finds the window full
  // until a slot frees, in arrival order, so a teardown neither waits for this connection's
  // ACKs to drain nor is refused for them.
  private flushTeardown(): void {
    if (this.teardownActive || !this.teardownQueue.length) return;
    const { route, requestId, resolve, reject } = this.teardownQueue.shift()!;
    this.teardownActive = true;
    this.inFlight++;
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      route.teardown = undefined;
      this.teardownActive = false;
      this.inFlight--;
      this.flushTeardown();
      this.releaseClosedRecords();
      this.reap(route);
    };
    try {
      void this.runtime
        .closeSubscription({
          type: "unsubscribe",
          requestId,
          worker: structuredClone(route.worker),
          run: structuredClone(route.ref.run),
          subscription: structuredClone(route.ref),
        })
        .then(
          (result) => {
            resolve(result);
            complete();
          },
          (error: unknown) => {
            reject(error);
            complete();
          },
        );
    } catch (error) {
      reject(error);
      complete();
    }
  }
  private finish(request: Request, reply: Reply, published = false): void {
    if (request.settled) return;
    const route = request.route;
    const deliver = !published && !this.closed;
    // A route-control result is delivered in a prepaid slot (see RESULT_SLOT_BYTES). Without a
    // free one it waits, unsettled, until returnResultSlot hands it the next. A closed delivery
    // refuses every result, so nothing waits for it.
    let slot: ByteReservation | undefined;
    if (deliver && request.control && !route.dropped && !this.delivery.closed) {
      const lease = route.resultSlots.pop();
      if (!lease) {
        if (request.waitingReply === undefined) {
          request.waitingReply = reply;
          request.resultGate = new Promise((open) => {
            request.openResultGate = open;
          });
          route.waitingResults.push(request);
        }
        return;
      }
      route.resultSlotsOut++;
      let owned = true;
      slot = {
        bytes: lease.bytes,
        release: () => {
          if (!owned) return;
          owned = false;
          this.returnResultSlot(route, lease);
        },
      };
    }
    request.settled = true;
    this.requests.delete(request.internalId);
    this.settleId(request.command.requestId);
    if (request.control) this.controlPending--;
    else this.ordinaryPending--;
    if (
      deliver &&
      !this.delivery.admit(reply, new Uint8Array(), {
        control: true,
        ...(slot ? { prepaid: slot } : {}),
      })
    )
      this.retire(route, domainError("RESULT_UNKNOWN", "unknown"));
    request.resolve(structuredClone(reply));
    request.openResultGate?.();
  }

  // A result slot comes back when its frame's write callback runs, or when delivery cancels or
  // refuses the frame. It goes to the oldest waiting result of the route, or back to the
  // route's free slots; once the route's storage is released, it is released as well.
  private returnResultSlot(route: Route, lease: ByteReservation): void {
    route.resultSlotsOut--;
    if (route.dropped) {
      lease.release();
      return;
    }
    route.resultSlots.push(lease);
    const next = route.waitingResults.shift();
    if (next) {
      const reply = next.waitingReply!;
      next.waitingReply = undefined;
      this.finish(next, reply);
    }
    this.reap(route);
  }

  // Releases a route's lease and free result and health slots. Slots still held by delivery are
  // released when they come back.
  private dropRoute(route: Route): void {
    if (route.dropped) return;
    route.dropped = true;
    route.lease.release();
    for (const slot of route.resultSlots.splice(0)) slot.release();
    route.healthSlot?.release();
    route.healthSlot = undefined;
  }
  // Half of recoveryDeadlineMs: the client times the same attach with recoveryDeadlineMs from
  // before it was sent, and an attach it times out itself is unknown, which makes it retire the
  // whole connection with every other subscription on it. Half leaves the other half for the
  // reply to cross a slow transport and a busy server, and for the baseline transfer after a
  // marker that does arrive in time (route.deadline still bounds the whole recovery).
  private markerDeadline(): number {
    return Math.floor(this.composition.budgets.recoveryDeadlineMs / 2);
  }

  // Ends an attach or recover attempt whose marker deadline passed with no marker admitted:
  // RECOVERY_EXPIRED (not-accepted) for the route and the requests it still owes an answer
  // (see tick() for why the outcome is definite). Retirement fences the route's events, so a
  // late acceptance from the worker is never activated, and unsubscribes the worker route.
  private expireRecovery(route: Route): void {
    this.retire(route, domainError("RECOVERY_EXPIRED"));
    this.failQueued(route);
  }

  // Answers the requests of a route that just retired with its failure, except those whose
  // effect already happened: a route-control command that started executing has advanced the
  // route's credit and was sent to the worker (an ACK the busy worker answers late, say), and
  // dispatched input reached the PTY. Those keep their real result, which still arrives:
  // the worker answers in order, before the unsubscribe that retirement sent. Reporting them
  // not-accepted would tell the client an applied ACK was not applied.
  private failQueued(route: Route): void {
    for (const request of route.queue) {
      const type = request.command.type;
      if (
        request.started &&
        (type === "applied-ack" || type === "baseline-progress" || type === "detach")
      )
        continue;
      if (type === "input" && request.domain?.dispatched) continue;
      this.finish(request, this.error(request.command, route.failure!));
    }
  }

  tick(): void {
    this.options.arbiter?.tick();
    if (this.closed) return;
    if (this.delivery.closed) {
      this.close();
      return;
    }
    const now = this.now();
    for (const route of this.routes.values())
      if (
        (route.phase === "opening" && now >= route.markerDeadline) ||
        (route.phase === "active" &&
          route.queue.some(
            (request) =>
              !request.started &&
              !request.settled &&
              request.recoverDeadlines &&
              now >= request.recoverDeadlines.markerDeadline,
          ))
      ) {
        // A slow worker has not produced this attempt's marker (issue #103). No marker was
        // admitted to delivery (admission moves the route out of "opening" synchronously), so
        // the client cannot know this subscription, and retiring it here keeps it that way: the
        // fence drops its events, the pipe refuses to activate a late acceptance, and the worker
        // route is unsubscribed. The outcome is therefore definite (not-accepted), so the client
        // fails this view alone and need not fence its whole connection, as it must for an
        // attach whose outcome is unknown. It must reach the client before the client's own
        // deadline for the same attach, which started earlier; see markerDeadline().
        //
        // The second case is a recover still queued behind earlier route commands (an ACK the
        // busy worker has not answered, say) at its half deadline, counted from its acceptance.
        // It was never sent to the worker, so its outcome is just as definite, and the route
        // ends the same way: the client asked to recover it, so it cannot simply continue.
        //
        // The tick is only one of the places this is decided: the deadline can pass between
        // ticks, so execute() checks it before a queued recover is dispatched and handoff
        // checks it before a marker is admitted, with the same outcome.
        this.expireRecovery(route);
      } else if (
        route.phase !== "retired" &&
        (!route.credit?.snapshot().installed ||
          route.credit.snapshot().appliedSeq < route.credit.atSeq) &&
        now >= route.deadline
      ) {
        this.retire(route, domainError("RECOVERY_EXPIRED", "unknown"));
        for (const request of route.queue)
          if (!(request.command.type === "input" && request.domain?.dispatched))
            this.finish(request, this.error(request.command, route.failure!));
      }
    this.publishHealth();
  }
  // Tells each active route's client the current health of the worker serving it (issue #103;
  // informational only). Level-triggered: a route records the health its client was last
  // given, and a differing current value is published on a later tick. The event takes no
  // credit and needs no ACK. It travels only in the route's prepaid health slot, as a prepaid
  // control item, so it is outside the connection's item limit, its byte budgets and the
  // ordinary-output counts: it can never make terminal output fail admission. While the slot is
  // in delivery (or when delivery refuses the event, which returns the slot) the route simply
  // waits for a later tick, so changes coalesce and nothing here ever retires a route. A route
  // starts at "normal", which the client assumes, so a healthy worker adds no event.
  private publishHealth(): void {
    for (const route of this.routes.values()) {
      if (this.closed || this.delivery.closed) return;
      if (route.phase !== "active" || !route.healthSlot) continue;
      const health = this.runtime.workerHealth(route.ref.run);
      if (
        !health ||
        (health.state === route.deliveredHealth.state &&
          health.reasons.join() === route.deliveredHealth.reasons.join())
      )
        continue;
      const lease = route.healthSlot;
      route.healthSlot = undefined;
      let owned = true;
      // Delivery releases this exactly once: on refusal, cancellation or the write callback.
      const slot: ByteReservation = {
        bytes: lease.bytes,
        release: () => {
          if (!owned) return;
          owned = false;
          if (route.dropped) lease.release();
          else route.healthSlot = lease;
        },
      };
      const admitted = this.delivery.admit(
        {
          type: "worker-health",
          run: structuredClone(route.ref.run),
          subscription: structuredClone(route.ref),
          health,
        },
        new Uint8Array(),
        { control: true, fence: this.fence(route), prepaid: slot },
      );
      if (admitted) route.deliveredHealth = health;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closedState = true;
    for (const attempt of this.previewAttempts) {
      attempt.current = false;
      attempt.cancel();
      this.delivery.cancel(attempt.fence);
    }
    this.listener.dispose();
    this.delivery.close();
    for (const route of this.routes.values()) {
      this.retire(route, domainError("STALE_CONNECTION"));
      for (const request of route.queue)
        if (!(request.command.type === "input" && request.domain?.dispatched))
          this.finish(request, this.error(request.command, route.failure!));
      // The worker applied these; their results can no longer be delivered.
      for (const request of route.waitingResults.splice(0)) {
        const reply = request.waitingReply!;
        request.waitingReply = undefined;
        this.finish(request, reply);
      }
      this.unsubscribe(route);
    }
    this.releaseClosedRecords();
  }
  private releaseClosedRecords(): void {
    if (!this.closed || this.inFlight || this.teardownQueue.length || this.released) return;
    this.released = true;
    for (const route of this.routes.values()) {
      this.dropRoute(route);
      route.queue.length = 0;
    }
    this.routes.clear();
    for (const lease of this.requestLeases) lease.release();
    this.requestLeases.clear();
    this.externalIds.clear();
    for (const lease of this.settledIds.values()) lease?.release();
    this.settledIds.clear();
    for (const entry of this.retiredFailures.values()) entry.lease?.release();
    this.retiredFailures.clear();
    this.previewAttempts.clear();
    this.arena.release();
  }
  snapshot(subscriptionId?: string) {
    const route = subscriptionId ? this.routes.get(subscriptionId) : undefined;
    return {
      routes: this.routes.size,
      retiredFailures: this.retiredFailures.size,
      previews: this.previewAttempts.size,
      active: [...this.routes.values()].filter((entry) => entry.phase !== "retired").length,
      identities: this.externalIds.size + this.settledIds.size,
      pending: this.requests.size,
      route: route
        ? {
            subscription: structuredClone(route.ref),
            attempt: route.attempt,
            phase: route.phase,
            failure: route.failure,
            credit: route.credit?.snapshot(),
          }
        : undefined,
    };
  }
}
