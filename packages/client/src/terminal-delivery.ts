import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError, type DomainError } from "@cove/protocol/errors";
import { sameRunRef, type ConnectionRef, type SubscriptionRef } from "@cove/protocol/identity";
import {
  createTerminalDecoder,
  encodeTerminalFrame,
  externalEventSubscription,
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
  timer?: Disposable;
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
  private readonly outbound: PendingCommand[] = [];
  private flushing = false;
  private retainedOutboundBytes = 0;
  private requestSequence = 0;

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

  send(
    command: TerminalCommand,
    deadlineMs: number,
    onHandoff?: () => void,
    onSettled?: (outcome: CommandOutcome) => void,
  ): Promise<CommandOutcome> {
    const binding = this.owner.binding();
    if (!binding || !this.owner.socket())
      return Promise.resolve({ ok: false, error: localError("invalid-state"), uncertain: false });
    if (this.pending.has(command.requestId) || this.pending.size >= M0_LIMITS.pendingWorkerCommands)
      return Promise.resolve({ ok: false, error: localError("capacity"), uncertain: false });
    let bytes: Uint8Array;
    try {
      const encoded = encodeTerminalFrame(
        1,
        this.codec.encode(JSON.stringify(command)),
        new Uint8Array(),
      );
      if (!encoded.ok) throw new Error("invalid command");
      bytes = encoded.value;
    } catch {
      return Promise.resolve({ ok: false, error: localError("invalid-request"), uncertain: false });
    }
    const cap =
      binding.effectiveBudgets.outboundConnectionBytes +
      binding.effectiveBudgets.reservedControlBytes;
    if (this.retainedOutboundBytes + bytes.byteLength > cap)
      return Promise.resolve({ ok: false, error: localError("capacity"), uncertain: false });

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
      handedOff: false,
      handoffNotified: false,
      settled: false,
    };
    this.pending.set(command.requestId, pending);
    this.retainedOutboundBytes += bytes.byteLength;
    try {
      const timer = this.scheduler.setTimer(deadlineMs, () => {
        this.finish(pending, {
          ok: false,
          error: domainError("RESULT_UNKNOWN", "unknown"),
          uncertain: true,
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
    if (this.routes.has(key)) return false;
    this.routes.set(key, receive);
    return true;
  }

  retire(ref: SubscriptionRef): void {
    this.routes.delete(routeKey(ref));
  }

  cancelUnsentControl(ref: SubscriptionRef): void {
    for (const pending of this.pending.values()) {
      const command = pending.command;
      if (
        (command.type === "applied-ack" || command.type === "baseline-progress") &&
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
  }

  close(reason: LocalErrorReason): void {
    this.routes.clear();
    for (const pending of [...this.pending.values()])
      this.finish(pending, { ok: false, error: localError(reason), uncertain: true });
    this.outbound.length = 0;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbound.length) {
        const pending = this.outbound.shift()!;
        if (pending.settled) continue;
        const socket = this.owner.socket();
        if (!socket) {
          this.finish(pending, { ok: false, error: localError("transport"), uncertain: true });
          continue;
        }
        let disposition: unknown;
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
                : domainError("RESULT_UNKNOWN", "unknown"),
            uncertain: disposition !== "not-sent",
          });
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private finish(pending: PendingCommand, outcome: CommandOutcome): void {
    if (pending.settled) return;
    pending.settled = true;
    this.pending.delete(pending.command.requestId);
    this.retainedOutboundBytes -= pending.bytes.byteLength;
    try {
      pending.timer?.dispose();
    } catch {
      /* The timer no longer owns settlement. */
    }
    try {
      pending.onSettled?.(outcome);
    } catch {
      this.owner.invalid();
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
