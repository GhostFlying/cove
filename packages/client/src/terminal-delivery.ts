import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError, type DomainError } from "@cove/protocol/errors";
import {
  nextCounter,
  sameRunRef,
  sameSubscriptionRef,
  type ConnectionRef,
  type SubscriptionRef,
} from "@cove/protocol/identity";
import {
  createTerminalDecoder,
  encodeTerminalFrame,
  externalEventSubscription,
  MAX_METADATA_BYTES,
  MAX_PAYLOAD_BYTES,
  validateTerminalFrame,
  validateTerminalResultForCommand,
  type ExternalTerminalEvent,
  type TerminalCommand,
  type TerminalError,
  type TerminalResult,
} from "@cove/protocol/terminal";
import type { ClientError, LocalErrorReason } from "./client.js";
import type { NegotiatedConnection } from "./connection-session.js";
import type { Disposable, Scheduler, TerminalConnection, Utf8Codec } from "./transport-ports.js";

// `sent` is true once the lane has entered `socket.send()` for the command, whatever send
// returned and whatever reply arrived (docs/terminal-architecture.md 4.4.6). Only a failure with
// `sent: false` proves the command never reached the connection, so only such a command may be
// deferred again or held; anything else keeps its real result and is never repeated.
export type CommandOutcome =
  | { readonly ok: true; readonly result: TerminalResult }
  | {
      readonly ok: false;
      readonly error: ClientError | DomainError;
      readonly uncertain: boolean;
      readonly sent: boolean;
    };

type CommandFailure = Omit<Extract<CommandOutcome, { ok: false }>, "sent">;

interface PendingCommand {
  readonly command: TerminalCommand;
  readonly bytes: Uint8Array;
  readonly resolve: (outcome: CommandOutcome) => void;
  readonly onHandoff: (() => void) | undefined;
  readonly onSettled: ((outcome: CommandOutcome) => void) | undefined;
  readonly beforeSend: (() => boolean) | undefined;
  timer?: Disposable;
  attempting: boolean;
  handedOff: boolean;
  handoffNotified: boolean;
  settled: boolean;
}

// See TerminalLane.retiredRefs.
const RECENT_RETIRED_REFS = 256;

function localError(reason: LocalErrorReason): ClientError {
  return { category: "local", reason };
}

function routeKey(ref: SubscriptionRef): string {
  const { run, connection, subscriptionId, viewId } = ref;
  return JSON.stringify([
    run.serverId,
    run.relayInstanceId,
    run.runId,
    connection.connectionId,
    connection.generation,
    subscriptionId,
    viewId,
  ]);
}

export interface TerminalLaneOwner {
  binding(): NegotiatedConnection | undefined;
  socket(): TerminalConnection | undefined;
  invalid(): void;
  preview(
    event: Extract<
      ExternalTerminalEvent,
      { type: "preview-start" | "preview-chunk" | "preview-end" }
    >,
    bytes: Uint8Array,
  ): "active" | "obsolete" | "unrouteable";
  previewReply(
    reply: Extract<TerminalResult, { type: "preview-result" }> | TerminalError,
  ): "active" | "obsolete" | "unrouteable";
}

// The lane owns correlation and the only ordered terminal send path; controllers own parsing.
export class TerminalLane {
  private readonly pending = new Map<string, PendingCommand>();
  private readonly routes = new Map<
    string,
    (event: ExternalTerminalEvent, bytes: Uint8Array) => void
  >();
  // Late frames for a retired subscription are fenced by deleting its route: receive() drops
  // every event whose ref has no route. These tombstones fence nothing further; they only let
  // register() refuse a server that re-mints a ref this client just retired, so its old frames
  // cannot reach the new subscriber. The server mints subscription IDs from a per-connection
  // monotonic sequence and the key includes the connection generation, so a correct server
  // never reuses one. A recent FIFO window is therefore enough, and it must never refuse:
  // keeping every retired ref and refusing attach at a fixed count would stop a long-lived
  // connection from attaching after that many attach/detach cycles.
  private readonly retiredRefs = new Set<string>();
  private readonly outbound: PendingCommand[] = [];
  private readonly heldPreviewReservations = new Set<string>();
  private flushing = false;
  private retainedOutboundBytes = 0;
  private retainedIngressBytes = 0;
  private requestSequence = 0;
  private readonly focusSequences = new Map<string, number>();
  private readonly inputSequences = new Map<string, number>();
  private lastSentRoute: string | undefined;
  // Lane entry depth and the follow-up work registered while inside it (4.4.5). Sender and route
  // callbacks run inside lane entries and may only do their own command's bookkeeping; anything
  // else they start (another send, a cancellation, a controller failure or recovery) is passed to
  // afterward() and runs once the outermost entry has finished its own bookkeeping, in
  // registration order, and before the lane hands any further command to the socket.
  private depth = 0;
  private readonly followUps: (() => void)[] = [];
  private runningFollowUps = false;

  constructor(
    private readonly owner: TerminalLaneOwner,
    private readonly codec: Utf8Codec,
    private readonly scheduler: Scheduler,
    private readonly createOpaqueId: () => string,
  ) {}

  nextRequestId(generation: number): string | null {
    const next = this.requestSequence + 1;
    if (!Number.isSafeInteger(next)) return null;
    // Reserve the suffix before an injected ID supplier can synchronously reenter.
    this.requestSequence = next;
    let supplied: string;
    try {
      supplied = this.createOpaqueId();
    } catch {
      return null;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(supplied)) return null;
    const suffix = `.t${generation}.${next}`;
    return `${supplied.slice(0, 128 - suffix.length)}${suffix}`;
  }

  // The server checks focusSeq and inputSeq against counters it keeps per subscription, so
  // the client keys both per subscription too and releases them when the subscription retires
  // (a recovery keeps the same ref, its route and its counters). A counter exists only while
  // its ref is routed: an allocation for a ref that is not (already retired, for example by a
  // detach reentering from the injected request-ID supplier just before) returns undefined and
  // creates nothing, so no counter can outlive the cleanup in retire(). null still means the
  // counter is exhausted.
  nextFocusSeq(ref: SubscriptionRef): number | null | undefined {
    return this.nextSeq(this.focusSequences, ref);
  }

  nextInputSeq(ref: SubscriptionRef): number | null | undefined {
    return this.nextSeq(this.inputSequences, ref);
  }

  private nextSeq(counters: Map<string, number>, ref: SubscriptionRef): number | null | undefined {
    const key = routeKey(ref);
    if (!this.routes.has(key)) return undefined;
    const next = nextCounter(counters.get(key) ?? 0);
    if (next !== null) counters.set(key, next);
    return next;
  }

  // Runs `work` now when no lane entry is active, otherwise after the outermost one.
  afterward(work: () => void): void {
    this.followUps.push(work);
    if (this.depth === 0) this.runFollowUps();
  }

  private enter<T>(body: () => T): T {
    this.depth++;
    try {
      return body();
    } finally {
      this.depth--;
      if (this.depth === 0) this.runFollowUps();
    }
  }

  private runFollowUps(): void {
    if (this.runningFollowUps) return;
    this.runningFollowUps = true;
    try {
      while (this.followUps.length) {
        const work = this.followUps.shift()!;
        try {
          work();
        } catch {
          this.owner.invalid();
        }
      }
    } finally {
      this.runningFollowUps = false;
    }
  }

  send(
    command: TerminalCommand,
    deadlineMs: number,
    onHandoff?: () => void,
    onSettled?: (outcome: CommandOutcome) => void,
    beforeSend?: () => boolean,
    payload: Uint8Array = new Uint8Array(),
  ): Promise<CommandOutcome> {
    return this.enter(() =>
      this.sendInside(command, deadlineMs, onHandoff, onSettled, beforeSend, payload),
    );
  }

  private sendInside(
    command: TerminalCommand,
    deadlineMs: number,
    onHandoff: (() => void) | undefined,
    onSettled: ((outcome: CommandOutcome) => void) | undefined,
    beforeSend: (() => boolean) | undefined,
    payload: Uint8Array,
  ): Promise<CommandOutcome> {
    const rejectBeforeSend = (reason: LocalErrorReason): Promise<CommandOutcome> => {
      const outcome: CommandOutcome = {
        ok: false,
        error: localError(reason),
        uncertain: false,
        sent: false,
      };
      try {
        onSettled?.(outcome);
      } catch {
        this.owner.invalid();
      }
      return Promise.resolve(outcome);
    };
    const binding = this.owner.binding();
    if (!binding || !this.owner.socket()) return rejectBeforeSend("invalid-state");
    if (
      this.pending.has(command.requestId) ||
      this.heldPreviewReservations.has(command.requestId) ||
      this.pending.size + this.heldPreviewReservations.size >= M0_LIMITS.pendingWorkerCommands
    )
      return rejectBeforeSend("capacity");
    if (
      (command.type === "input" || command.type === "preview") &&
      this.heldPreviewReservations.size +
        [...this.pending.values()].filter(
          (pending) => pending.command.type === "input" || pending.command.type === "preview",
        ).length >=
        M0_LIMITS.pendingWorkerCommands - 32
    )
      return rejectBeforeSend("capacity");
    if (
      (command.type !== "input" && payload.byteLength !== 0) ||
      (command.type === "input" && payload.byteLength === 0) ||
      payload.byteLength > MAX_PAYLOAD_BYTES
    )
      return rejectBeforeSend("invalid-request");
    let bytes: Uint8Array;
    try {
      const encoded = encodeTerminalFrame(1, this.codec.encode(JSON.stringify(command)), payload);
      if (!encoded.ok) throw new Error("invalid command");
      bytes = encoded.value;
    } catch {
      return rejectBeforeSend("invalid-request");
    }
    const cap =
      binding.effectiveBudgets.outboundConnectionBytes +
      binding.effectiveBudgets.reservedControlBytes;
    if (
      this.retainedOutboundBytes + bytes.byteLength > cap ||
      ((command.type === "input" || command.type === "preview") &&
        this.retainedOutboundBytes + bytes.byteLength >
          binding.effectiveBudgets.outboundConnectionBytes)
    )
      return rejectBeforeSend("capacity");

    let resolve!: (value: CommandOutcome) => void;
    const promise = new Promise<CommandOutcome>((settle) => {
      resolve = settle;
    });
    const pending: PendingCommand = {
      command,
      bytes,
      resolve,
      onHandoff,
      onSettled,
      beforeSend,
      attempting: false,
      handedOff: false,
      handoffNotified: false,
      settled: false,
    };
    this.pending.set(command.requestId, pending);
    this.retainedOutboundBytes += bytes.byteLength;
    try {
      const timer = this.scheduler.setTimer(deadlineMs, () => {
        const uncertain = pending.attempting || pending.handedOff;
        this.finishOutside(pending, {
          ok: false,
          error: uncertain
            ? domainError(
                "RESULT_UNKNOWN",
                "unknown",
                pending.command.type === "input" ? "input" : undefined,
              )
            : localError("timeout"),
          uncertain,
        });
      });
      pending.timer = timer;
      if (pending.settled) timer.dispose();
    } catch {
      this.finish(pending, { ok: false, error: localError("invalid-state"), uncertain: false });
      return promise;
    }
    if (!pending.settled) {
      this.outbound.push(pending);
      this.flush();
    }
    return promise;
  }

  register(
    ref: SubscriptionRef,
    receive: (event: ExternalTerminalEvent, bytes: Uint8Array) => void,
  ): boolean {
    const key = routeKey(ref);
    if (this.routes.has(key) || this.retiredRefs.has(key)) return false;
    this.routes.set(key, receive);
    return true;
  }

  retire(ref: SubscriptionRef): void {
    const key = routeKey(ref);
    this.routes.delete(key);
    this.focusSequences.delete(key);
    this.inputSequences.delete(key);
    if (this.retiredRefs.has(key)) return;
    while (this.retiredRefs.size >= RECENT_RETIRED_REFS) {
      const oldest = this.retiredRefs.values().next();
      if (oldest.done) break;
      this.retiredRefs.delete(oldest.value);
    }
    this.retiredRefs.add(key);
  }

  // Cancellation scans a snapshot of the commands present when it began: a settlement callback
  // may send new commands, and those belong to the operation that sent them, not to this sweep.
  cancelUnsentControl(ref: SubscriptionRef): void {
    this.enter(() => this.cancelUnsentControlInside(ref));
  }

  private cancelUnsentControlInside(ref: SubscriptionRef): void {
    for (const pending of [...this.pending.values()]) {
      const command = pending.command;
      if (
        (command.type === "applied-ack" || command.type === "baseline-progress") &&
        !pending.attempting &&
        !pending.handedOff &&
        routeKey(command.subscription) === routeKey(ref)
      )
        this.finish(pending, {
          ok: false,
          error: localError("invalid-state"),
          uncertain: false,
        });
    }
  }

  cancelUnsent(ref: SubscriptionRef, types: readonly TerminalCommand["type"][]): void {
    this.enter(() => this.cancelUnsentInside(ref, types));
  }

  private cancelUnsentInside(
    ref: SubscriptionRef,
    types: readonly TerminalCommand["type"][],
  ): void {
    for (const pending of [...this.pending.values()]) {
      const command = pending.command;
      if (
        "subscription" in command &&
        sameSubscriptionRef(command.subscription, ref) &&
        types.includes(command.type) &&
        !pending.attempting &&
        !pending.handedOff
      )
        this.finish(pending, {
          ok: false,
          error: localError("invalid-state"),
          uncertain: false,
        });
    }
  }

  cancelPreview(requestId: string): void {
    this.enter(() => this.cancelPreviewInside(requestId));
  }

  private cancelPreviewInside(requestId: string): void {
    this.heldPreviewReservations.delete(requestId);
    const pending = this.pending.get(requestId);
    if (!pending || pending.command.type !== "preview") return;
    this.finish(pending, {
      ok: false,
      error: localError("invalid-state"),
      uncertain: pending.attempting || pending.handedOff,
    });
  }

  // Leases survive lane closure while retired view calls still retain their payloads.
  reserveIngress(bytes: number): boolean {
    const budgets = this.owner.binding()?.effectiveBudgets;
    const cap = budgets ? budgets.outboundConnectionBytes + budgets.reservedControlBytes : 0;
    if (
      !cap ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.retainedIngressBytes + bytes > cap
    )
      return false;
    this.retainedIngressBytes += bytes;
    return true;
  }

  releaseIngress(bytes: number): void {
    this.retainedIngressBytes -= bytes;
    if (this.retainedIngressBytes < 0) throw new Error("ingress lease underflow");
  }

  receive(message: Uint8Array, connection: ConnectionRef): void {
    this.enter(() => this.receiveInside(message, connection));
  }

  private receiveInside(message: Uint8Array, connection: ConnectionRef): void {
    const binding = this.owner.binding();
    if (
      !binding ||
      message.byteLength < 1 ||
      message.byteLength >
        binding.effectiveBudgets.outboundConnectionBytes +
          binding.effectiveBudgets.reservedControlBytes
    ) {
      this.owner.invalid();
      return;
    }
    // FrameDecoder temporarily owns a body and sliced metadata/payload beside input.
    // This worst-case reservation precedes all decoder allocations and caller reentry.
    const frameLease = message.byteLength * 3 + MAX_METADATA_BYTES * 3;
    if (!this.reserveIngress(frameLease)) {
      this.owner.invalid();
      return;
    }
    try {
      const decoder = createTerminalDecoder();
      const read = decoder.read(message);
      if (
        read.status === "error" ||
        read.consumedBytes !== message.byteLength ||
        read.frames.length !== 1 ||
        !decoder.finish().ok
      ) {
        this.owner.invalid();
        return;
      }
      const frame = read.frames[0]!;
      let metadata: unknown;
      try {
        metadata = JSON.parse(this.codec.decodeFatal(frame.metadata));
      } catch {
        this.owner.invalid();
        return;
      }
      const checked = validateTerminalFrame(frame, metadata, connection);
      if (!checked.ok || frame.kind === 1) {
        this.owner.invalid();
        return;
      }
      const value = checked.value;
      if (frame.kind === 3) {
        const event = value as ExternalTerminalEvent;
        const ref = externalEventSubscription(event);
        if (!ref) {
          let route: "active" | "obsolete" | "unrouteable";
          try {
            route = this.owner.preview(
              event as Extract<
                ExternalTerminalEvent,
                { type: "preview-start" | "preview-chunk" | "preview-end" }
              >,
              frame.payload,
            );
          } catch {
            this.owner.invalid();
            return;
          }
          if (route === "unrouteable") this.owner.invalid();
          return;
        }
        try {
          this.routes.get(routeKey(ref))?.(event, frame.payload);
        } catch {
          this.owner.invalid();
        }
        return;
      }
      if (frame.kind !== 2 && frame.kind !== 4) {
        this.owner.invalid();
        return;
      }
      const reply = value as TerminalResult | TerminalError;
      const pending = this.pending.get(reply.requestId);
      if (!pending || pending.settled) {
        const previewReply =
          frame.kind === 2
            ? (reply as TerminalResult).type === "preview-result"
            : (reply as TerminalError).commandType === "preview";
        if (previewReply) {
          let route: "active" | "obsolete" | "unrouteable";
          try {
            route = this.owner.previewReply(
              reply as Extract<TerminalResult, { type: "preview-result" }> | TerminalError,
            );
          } catch {
            this.owner.invalid();
            return;
          }
          if (route === "unrouteable") this.owner.invalid();
        }
        return;
      }
      if (frame.kind === 4) {
        const error = reply as TerminalError;
        if (
          error.commandType !== pending.command.type ||
          !sameRunRef(error.run, pending.command.run)
        ) {
          this.owner.invalid();
          return;
        }
        this.finish(pending, {
          ok: false,
          error: error.error,
          uncertain: error.error.acceptance === "unknown",
        });
        return;
      }
      const result = reply as TerminalResult;
      if (!validateTerminalResultForCommand(pending.command, result)) {
        this.owner.invalid();
        return;
      }
      this.notifyHandoff(pending);
      this.finish(pending, { ok: true, result });
    } finally {
      this.releaseIngress(frameLease);
    }
  }

  close(reason: LocalErrorReason): void {
    this.enter(() => this.closeInside(reason));
  }

  private closeInside(reason: LocalErrorReason): void {
    this.routes.clear();
    this.retiredRefs.clear();
    this.focusSequences.clear();
    this.inputSequences.clear();
    this.lastSentRoute = undefined;
    for (const pending of [...this.pending.values()]) {
      const uncertain = pending.attempting || pending.handedOff;
      this.finish(pending, {
        ok: false,
        error:
          uncertain && pending.command.type === "input"
            ? domainError("RESULT_UNKNOWN", "unknown", "input")
            : localError(reason),
        uncertain,
      });
    }
    this.heldPreviewReservations.clear();
    this.outbound.length = 0;
  }

  get pendingCount(): number {
    return this.pending.size + this.heldPreviewReservations.size;
  }

  get retiredCount(): number {
    return this.retiredRefs.size;
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbound.length) {
        // Work registered by the previous command's callbacks runs before the next handoff.
        this.runFollowUps();
        if (!this.outbound.length) break;
        const pending = this.takeNextOutbound();
        if (pending.settled) continue;
        if (pending.beforeSend) {
          let eligible = false;
          try {
            eligible = pending.beforeSend();
          } catch {
            /* A failed authority check cannot authorize a handoff. */
          }
          if (!eligible) {
            this.finish(pending, {
              ok: false,
              error: localError("invalid-state"),
              uncertain: false,
            });
            continue;
          }
        }
        const socket = this.owner.socket();
        if (!socket) {
          this.finish(pending, { ok: false, error: localError("transport"), uncertain: false });
          continue;
        }
        let disposition: unknown;
        pending.attempting = true;
        if ("subscription" in pending.command)
          this.lastSentRoute = routeKey(pending.command.subscription);
        try {
          disposition = socket.send(pending.bytes);
        } catch {
          disposition = "unknown";
        }
        if (disposition === "handed-off" && !pending.settled) {
          this.notifyHandoff(pending);
        } else if (!pending.settled) {
          // Once send() was entered the frame may have reached the server whatever send returns:
          // an adapter can forward synchronously and still report "not-sent" or throw. Only a
          // command that never entered send is proven unsent (4.4.6).
          this.finish(pending, {
            ok: false,
            error: domainError(
              "RESULT_UNKNOWN",
              "unknown",
              pending.command.type === "input" ? "input" : undefined,
            ),
            uncertain: true,
          });
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private takeNextOutbound(): PendingCommand {
    const firstByRoute = new Map<string, number>();
    for (let index = 0; index < this.outbound.length; index++) {
      const pending = this.outbound[index]!;
      const key =
        "subscription" in pending.command
          ? routeKey(pending.command.subscription)
          : `request:${pending.command.requestId}`;
      if (!firstByRoute.has(key)) firstByRoute.set(key, index);
    }
    const candidates = [...firstByRoute].filter(([, index]) => !this.outbound[index]!.settled);
    const preferred = candidates.filter(([key]) => key !== this.lastSentRoute);
    const pool = preferred.length ? preferred : candidates;
    const control = pool.find(([, index]) => {
      const type = this.outbound[index]!.command.type;
      return type !== "input" && type !== "preview";
    });
    const index = (control ?? pool[0])?.[1] ?? 0;
    return this.outbound.splice(index, 1)[0]!;
  }

  // Settlement from outside any lane entry (a deadline timer) is itself a lane entry.
  private finishOutside(pending: PendingCommand, failure: CommandFailure): void {
    this.enter(() => this.finish(pending, failure));
  }

  private finish(pending: PendingCommand, failureOrResult: CommandFailure | CommandOutcome): void {
    if (pending.settled) return;
    pending.settled = true;
    const outcome: CommandOutcome = failureOrResult.ok
      ? failureOrResult
      : { ...failureOrResult, sent: pending.attempting || pending.handedOff };
    // The result can retire its frame while the preview still owns an ordinary slot.
    if (
      pending.command.type === "preview" &&
      outcome.ok &&
      outcome.result.type === "preview-result" &&
      outcome.result.status === "transfer"
    )
      this.heldPreviewReservations.add(pending.command.requestId);
    this.pending.delete(pending.command.requestId);
    this.retainedOutboundBytes -= pending.bytes.byteLength;
    try {
      pending.onSettled?.(outcome);
    } catch {
      this.owner.invalid();
    }
    // The deadline timer's dispose() is foreign code and may reenter. It runs as follow-up work,
    // after the follow-ups the settlement callback registered (for example the connection fence
    // an accepted or unknown attach result requires).
    const timer = pending.timer;
    if (timer)
      this.afterward(() => {
        try {
          timer.dispose();
        } catch {
          /* The timer no longer owns settlement. */
        }
      });
    pending.resolve(outcome);
  }

  private notifyHandoff(pending: PendingCommand): void {
    pending.handedOff = true;
    if (pending.handoffNotified) return;
    pending.handoffNotified = true;
    try {
      pending.onHandoff?.();
    } catch {
      this.owner.invalid();
    }
  }
}
