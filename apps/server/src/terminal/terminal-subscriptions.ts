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
  type TerminalCommand,
  type TerminalError,
  type TerminalResult,
  type ExternalTerminalEvent,
} from "@cove/protocol/terminal";
import type { PipeCommand, PipeEvent } from "@cove/protocol/pipe";
import type { RuntimeResult } from "@cove/protocol/runtime";
import { LocalRuntime } from "./local-runtime.js";
import { RuntimeComposition } from "./runtime-composition.js";
import type { ByteReservation } from "./runtime-retained-bytes.js";
import { TerminalConnectionDelivery, type DeliveryFence } from "./terminal-connection-delivery.js";
import { TerminalDeliveryCredit } from "./terminal-delivery-credit.js";
import type { ResultHandoff } from "./worker-pipe-session.js";
import { ControlArbiter, type ControlCommand, type ControlJob } from "./control-arbiter.js";
import { publishPreview } from "./preview-transfer.js";
import type { PreviewPicture } from "./preview-cache.js";

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
  lease: ByteReservation;
  unsubscribeId: string;
  token: { current: boolean };
  teardownSent: boolean;
  teardown?: Promise<RuntimeResult> | undefined;
  queue: Request[];
  running: boolean;
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
  private readonly requests = new Map<string, Request>();
  private readonly teardownQueue: Teardown[] = [];
  private teardownActive = false;
  private backgroundTeardownActive = false;
  private progressInFlight = 0;
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
    const control =
      command.type === "detach" ||
      command.type === "applied-ack" ||
      command.type === "baseline-progress";
    if (
      this.externalIds.size >= this.options.requestLimit ||
      (control
        ? this.controlPending + (this.backgroundTeardownActive ? 1 : 0) >= 4
        : this.ordinaryPending >= this.composition.budgets.pendingWorkerCommands)
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
      if (!route) return this.reject(command, "STALE_CONNECTION");
      if (route.phase === "retired")
        return this.reject(command, route.failure ?? "STALE_CONNECTION");
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
    const requestLease = this.composition.bytes.reserve(6 * 4096 + 2048, control);
    if (!requestLease) return this.reject(command, "BUSY");
    let internalId: string | null;
    if (command.type === "attach") {
      const lease = this.composition.bytes.reserve(8192);
      if (!lease) {
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
        requestLease.release();
        return this.reject(command, "COUNTER_EXHAUSTED");
      }
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
        lease,
        unsubscribeId,
        token: { current: true },
        teardownSent: false,
        queue: [],
        running: false,
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
        const progress =
          request.command.type === "applied-ack" || request.command.type === "baseline-progress";
        this.inFlight++;
        if (progress) this.progressInFlight++;
        try {
          await this.execute(request);
        } catch {
          this.retire(route, domainError("RESULT_UNKNOWN", "unknown"));
          this.finish(request, this.error(request.command, route.failure!));
        } finally {
          this.inFlight--;
          if (progress) this.progressInFlight--;
          this.flushTeardown();
          this.releaseClosedRecords();
        }
        this.dequeue(route);
      }
    } finally {
      route.running = false;
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
      route.phase = "opening";
      route.deadline = this.now() + this.composition.budgets.recoveryDeadlineMs;
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
  private flushTeardown(): void {
    if (this.teardownActive || this.progressInFlight >= 4 || !this.teardownQueue.length) return;
    // Preserve the four-slot progress capacity without waiting for ordinary B2 results.
    const { route, requestId, resolve, reject } = this.teardownQueue.shift()!;
    this.teardownActive = true;
    this.backgroundTeardownActive = !this.requests.has(requestId);
    this.inFlight++;
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      route.teardown = undefined;
      this.teardownActive = false;
      this.backgroundTeardownActive = false;
      this.inFlight--;
      this.flushTeardown();
      this.releaseClosedRecords();
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
    request.settled = true;
    this.requests.delete(request.internalId);
    this.settleId(request.command.requestId);
    if (request.control) this.controlPending--;
    else this.ordinaryPending--;
    if (
      !published &&
      !this.closed &&
      !this.delivery.admit(reply, new Uint8Array(), { control: true })
    )
      this.retire(request.route, domainError("RESULT_UNKNOWN", "unknown"));
    request.resolve(structuredClone(reply));
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
      this.unsubscribe(route);
    }
    this.releaseClosedRecords();
  }
  private releaseClosedRecords(): void {
    if (!this.closed || this.inFlight || this.teardownQueue.length || this.released) return;
    this.released = true;
    for (const route of this.routes.values()) {
      route.lease.release();
      route.queue.length = 0;
    }
    this.routes.clear();
    for (const lease of this.requestLeases) lease.release();
    this.requestLeases.clear();
    this.externalIds.clear();
    for (const lease of this.settledIds.values()) lease?.release();
    this.settledIds.clear();
    this.previewAttempts.clear();
    this.arena.release();
  }
  snapshot(subscriptionId?: string) {
    const route = subscriptionId ? this.routes.get(subscriptionId) : undefined;
    return {
      routes: this.routes.size,
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
