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

export type CommandOutcome =
  | { readonly ok: true; readonly result: TerminalResult }
  | { readonly ok: false; readonly error: ClientError | DomainError; readonly uncertain: boolean };

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
}

// The lane owns correlation and the only ordered terminal send path; controllers own parsing.
export class TerminalLane {
  private readonly pending = new Map<string, PendingCommand>();
  private readonly routes = new Map<
    string,
    (event: ExternalTerminalEvent, bytes: Uint8Array) => void
  >();
  private readonly retiredRefs = new Set<string>();
  private readonly outbound: PendingCommand[] = [];
  private flushing = false;
  private retainedOutboundBytes = 0;
  private retainedIngressBytes = 0;
  private requestSequence = 0;
  private readonly focusSequences = new Map<string, number>();
  private readonly inputSequences = new Map<string, number>();
  private lastSentRoute: string | undefined;

  constructor(
    private readonly owner: TerminalLaneOwner,
    private readonly codec: Utf8Codec,
    private readonly scheduler: Scheduler,
    private readonly createOpaqueId: () => string,
  ) {}

  nextRequestId(generation: number): string | null {
    const next = this.requestSequence + 1;
    if (!Number.isSafeInteger(next)) return null;
    let supplied: string;
    try {
      supplied = this.createOpaqueId();
    } catch {
      return null;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(supplied)) return null;
    this.requestSequence = next;
    const suffix = `.t${generation}.${next}`;
    return `${supplied.slice(0, 128 - suffix.length)}${suffix}`;
  }

  nextFocusSeq(ref: SubscriptionRef): number | null {
    const { connection, viewId } = ref;
    const key = JSON.stringify([connection.connectionId, connection.generation, viewId]);
    const next = nextCounter(this.focusSequences.get(key) ?? 0);
    if (next !== null) this.focusSequences.set(key, next);
    return next;
  }

  nextInputSeq(ref: SubscriptionRef): number | null {
    const key = routeKey(ref);
    const next = nextCounter(this.inputSequences.get(key) ?? 0);
    if (next !== null) this.inputSequences.set(key, next);
    return next;
  }

  send(
    command: TerminalCommand,
    deadlineMs: number,
    onHandoff?: () => void,
    onSettled?: (outcome: CommandOutcome) => void,
    beforeSend?: () => boolean,
    payload: Uint8Array = new Uint8Array(),
  ): Promise<CommandOutcome> {
    const rejectBeforeSend = (reason: LocalErrorReason): Promise<CommandOutcome> => {
      const outcome: CommandOutcome = {
        ok: false,
        error: localError(reason),
        uncertain: false,
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
    if (this.pending.has(command.requestId) || this.pending.size >= M0_LIMITS.pendingWorkerCommands)
      return rejectBeforeSend("capacity");
    if (
      command.type === "input" &&
      [...this.pending.values()].filter((pending) => pending.command.type === "input").length >=
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
      (command.type === "input" &&
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
        this.finish(pending, {
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

  retire(ref: SubscriptionRef): boolean {
    const key = routeKey(ref);
    this.routes.delete(key);
    if (!this.retiredRefs.has(key) && this.retiredRefs.size >= 256) return false;
    this.retiredRefs.add(key);
    return true;
  }

  cancelUnsentControl(ref: SubscriptionRef): void {
    for (const pending of this.pending.values()) {
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
    for (const pending of this.pending.values()) {
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
        if (!ref) return; // Preview belongs to the later P3d slice.
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
      if (!pending || pending.settled) return; // A retired command may finish late.
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
    this.outbound.length = 0;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get retiredCount(): number {
    return this.retiredRefs.size;
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbound.length) {
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
          this.finish(pending, {
            ok: false,
            error:
              disposition === "not-sent"
                ? localError("transport")
                : domainError(
                    "RESULT_UNKNOWN",
                    "unknown",
                    pending.command.type === "input" ? "input" : undefined,
                  ),
            uncertain: disposition !== "not-sent",
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
    const control = pool.find(([, index]) => this.outbound[index]!.command.type !== "input");
    const index = (control ?? pool[0])?.[1] ?? 0;
    return this.outbound.splice(index, 1)[0]!;
  }

  private finish(pending: PendingCommand, outcome: CommandOutcome): void {
    if (pending.settled) return;
    pending.settled = true;
    this.pending.delete(pending.command.requestId);
    this.retainedOutboundBytes -= pending.bytes.byteLength;
    try {
      pending.onSettled?.(outcome);
    } catch {
      this.owner.invalid();
    }
    // A remote accepted/unknown result must fence connection authority before timer disposal can reenter.
    try {
      pending.timer?.dispose();
    } catch {
      /* The timer no longer owns settlement. */
    }
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
