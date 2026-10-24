import {
  BUSINESS_LIMITS,
  BusinessFilterSchema,
  type BusinessFilter,
  type BusinessFrame,
} from "@cove/protocol/business-events";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import { OpaqueIdSchema } from "@cove/protocol/identity";
import {
  OperationRecordSchema,
  canonicalWriteIntent,
  isWriteRpcMethod,
  validateRpcMethodParams,
  type OperationRecord,
  type RpcMethod,
} from "@cove/protocol/rpc";
import {
  createClient,
  type CallOutcome,
  type Client,
  type ClientOptions,
  type OperationReference,
  type TerminalOpenOptions,
  type TerminalOpenOutcome,
} from "./client.js";
import {
  openBusinessEvents,
  type BusinessReader,
  type BusinessReaderOutcome,
} from "./business-events.js";
import {
  BusinessMirror,
  freezeBusinessValue,
  type BusinessIdentity,
  type BusinessMirrorSnapshot,
  type BusinessReadonly,
} from "./business-mirror.js";
import { Notifier } from "./notifier.js";
import type { ParamsFor, ResultFor } from "./rpc-calls.js";
import type { Disposable, Scheduler, TerminalPort, Utf8Codec } from "./transport-ports.js";

export interface VerifiedServerBinding extends Disposable {
  readonly identity: BusinessIdentity;
  readonly client: Omit<ClientOptions, "expectedServerId" | "expectedRelayInstanceId">;
  readonly events: TerminalPort;
}
export interface ServerBindingRequest extends Disposable {
  readonly result: Promise<VerifiedServerBinding>;
}
export interface ServerSessionOptions {
  readonly serverId: string;
  readonly scheduler: Scheduler;
  readonly codec: Utf8Codec;
  readonly filter?: BusinessFilter;
  // Verify the selected entry and peer BEFORE returning credential-bearing ports/options.
  // Cancellation stops only this request's owned resources, never a shared/default server.
  readonly bind: (request: {
    readonly serverId: string;
    readonly generation: number;
  }) => ServerBindingRequest;
}
export interface TrackedOperation {
  readonly reference: OperationReference;
  readonly delivery: "dispatching" | "unknown" | "not-sent" | "confirmed";
  readonly observation: "unqueried" | "record" | "not-found" | "unavailable";
  readonly record: BusinessReadonly<OperationRecord> | null;
}
export interface ServerSessionSnapshot {
  readonly status: "idle" | "connecting" | "current" | "stale" | "suspended" | "disposed";
  readonly generation: number;
  readonly identity: Readonly<BusinessIdentity> | null;
  readonly mirror: BusinessMirrorSnapshot;
  readonly operations: readonly TrackedOperation[];
  readonly lastError: string | null;
}
export type ServerSessionOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

type LocalOperation = {
  value: TrackedOperation;
  readonly intent: string;
  readonly bytes: number;
  query: number;
};
type Attempt = {
  readonly generation: number;
  readonly resolve: (outcome: ServerSessionOutcome) => void;
  settled: boolean;
  bindingRequest?: ServerBindingRequest;
  binding?: VerifiedServerBinding;
  client?: Client;
  reader?: BusinessReader;
  timer?: Disposable;
  clientListener?: Disposable;
  resetCount: number;
};

function safeDispose(value: Disposable | undefined): void {
  try {
    value?.dispose();
  } catch {
    /* Own cleanup never prevents fencing and settlement. */
  }
}
const failedCall = <T>(
  reason: "invalid-state" | "disposed" | "capacity" | "invalid-request" | "operation-conflict",
): CallOutcome<T> => ({ ok: false, kind: "local-error", error: { category: "local", reason } });

/** Owns one selected server's client resources, not its process, node, local navigation or PTYs. */
export class ServerSession implements Disposable {
  private status: ServerSessionSnapshot["status"] = "idle";
  private generation = 0;
  private lastError: string | undefined;
  private attempt: Attempt | undefined;
  private readonly mirror: BusinessMirror;
  private readonly filter: BusinessFilter;
  private readonly operations = new Map<string, LocalOperation>();
  private intentBytes = 0;
  private readonly notifier: Notifier<ServerSessionSnapshot, never>;
  private readonly mirrorListener: Disposable;

  constructor(private readonly options: ServerSessionOptions) {
    if (!OpaqueIdSchema.safeParse(options.serverId).success)
      throw new Error("Invalid server session identity");
    this.filter = freezeBusinessValue(BusinessFilterSchema.parse(options.filter ?? {}));
    this.mirror = new BusinessMirror({
      scheduler: options.scheduler,
      codec: options.codec,
      filter: this.filter,
    });
    this.notifier = new Notifier({ scheduler: options.scheduler, snapshot: () => this.snapshot() });
    this.mirrorListener = this.mirror.onState(() => this.notifier.markState());
  }

  snapshot(): ServerSessionSnapshot {
    return Object.freeze({
      status: this.status,
      generation: this.generation,
      identity: this.attempt?.binding?.identity ?? null,
      mirror: this.mirror.snapshot(),
      operations: Object.freeze([...this.operations.values()].map((operation) => operation.value)),
      lastError: this.lastError ?? null,
    });
  }
  onState(listener: (snapshot: ServerSessionSnapshot) => void): Disposable {
    if (this.notifier.listenerCount >= 64) throw new Error("Server session listener capacity");
    return this.notifier.onState(listener);
  }

  connect(): Promise<ServerSessionOutcome> {
    return this.reconnect();
  }

  reconnect(): Promise<ServerSessionOutcome> {
    if (this.status === "disposed") return Promise.resolve({ ok: false, reason: "disposed" });
    const generation = this.retire("reconnect");
    if (this.generation !== generation) return Promise.resolve({ ok: false, reason: "superseded" });
    this.status = "connecting";
    this.lastError = undefined;
    let resolve!: Attempt["resolve"];
    const result = new Promise<ServerSessionOutcome>((settle) => {
      resolve = settle;
    });
    const attempt: Attempt = {
      generation: this.generation,
      resolve,
      settled: false,
      resetCount: 0,
    };
    this.attempt = attempt;
    this.notifier.markState();
    try {
      const timer = this.options.scheduler.setTimer(BUSINESS_LIMITS.progressTimeoutMs, () => {
        if (this.current(attempt)) this.fail(attempt, "entry-timeout");
      });
      if (!this.current(attempt)) safeDispose(timer);
      else attempt.timer = timer;
    } catch {
      this.fail(attempt, "entry-unavailable");
      return result;
    }
    // Start on a later microtask, so dispose/reconnect can cancel even a pending keychain read.
    void Promise.resolve()
      .then(() => {
        if (!this.current(attempt)) return;
        const request = this.options.bind(
          Object.freeze({ serverId: this.options.serverId, generation: attempt.generation }),
        );
        if (!this.current(attempt)) safeDispose(request);
        else attempt.bindingRequest = request;
        void request.result.then(
          (binding) => {
            void this.adopt(attempt, binding).catch(() => {
              if (this.current(attempt)) this.fail(attempt, "entry-unavailable");
              else safeDispose(binding);
            });
          },
          () => {
            if (this.current(attempt)) this.fail(attempt, "entry-unavailable");
          },
        );
      })
      .catch(() => {
        if (this.current(attempt)) this.fail(attempt, "entry-unavailable");
      });
    return result;
  }

  suspend(): void {
    if (this.status === "disposed") return;
    const generation = this.retire("suspended");
    if (this.generation !== generation) return;
    this.status = "suspended";
    this.notifier.markState();
  }

  async call<M extends RpcMethod>(
    method: M,
    params: ParamsFor<M>,
  ): Promise<CallOutcome<ResultFor<M>>> {
    const attempt = this.attempt;
    if (this.status === "disposed") return failedCall("disposed");
    if (!attempt?.client || this.status !== "current") return failedCall("invalid-state");
    const parsed = validateRpcMethodParams(method, params);
    if (!parsed || parsed.method !== method) return failedCall("invalid-request");
    let local: LocalOperation | undefined;
    if (isWriteRpcMethod(method)) {
      const operationId = (parsed.params as { operationId: string }).operationId;
      // Explicit writes require an unused local ID. Unknown writes are reconciled by read,
      // never silently re-dispatched even if the caller repeats a button callback.
      if (this.operations.has(operationId)) return failedCall("operation-conflict");
      let intent: string | null;
      let bytes: number;
      try {
        intent = canonicalWriteIntent(method, parsed.params, (text) =>
          this.options.codec.encode(text),
        );
        bytes = intent ? this.options.codec.encode(intent).byteLength : 0;
      } catch {
        return failedCall("invalid-request");
      }
      if (!intent) return failedCall("invalid-request");
      if (this.operations.size >= 256 || this.intentBytes + bytes > M0_LIMITS.rpcRequestBytes)
        return failedCall("capacity");
      if (!this.current(attempt) || this.status !== "current") return failedCall("invalid-state");
      local = {
        intent,
        bytes,
        query: 0,
        value: freezeBusinessValue({
          reference: {
            method,
            operationId,
            relayInstanceId: attempt.binding!.identity.relayInstanceId,
          },
          delivery: "dispatching",
          observation: "unqueried",
          record: null,
        }),
      };
      this.operations.set(operationId, local);
      this.intentBytes += bytes;
      this.notifier.markState();
    }
    const outcome = await attempt.client.call(method, parsed.params as ParamsFor<M>);
    if (!this.current(attempt)) {
      if (!local) return failedCall("invalid-state");
      if (
        !outcome.ok &&
        (outcome.kind === "operation-not-sent" || outcome.kind === "local-error")
      ) {
        this.updateOperation(local, { delivery: "not-sent" });
        return { ok: false, kind: "operation-not-sent", operation: local.value.reference };
      }
      // retire() has retained this ID as unknown. A late successful HTTP response cannot
      // overwrite facts confirmed through a newer session generation.
      return {
        ok: false,
        kind: "operation-unknown",
        operation: local.value.reference,
        error: domainError("RESULT_UNKNOWN", "unknown"),
      };
    }
    if (local) {
      const record =
        outcome.ok && outcome.value && typeof outcome.value === "object"
          ? OperationRecordSchema.safeParse((outcome.value as { operation?: unknown }).operation)
          : undefined;
      const observed =
        record?.success && record.data.operationId === local.value.reference.operationId
          ? record.data
          : undefined;
      this.updateOperation(local, {
        delivery: outcome.ok
          ? "confirmed"
          : outcome.kind === "operation-unknown"
            ? "unknown"
            : "not-sent",
        ...(observed ? { observation: "record", record: observed } : {}),
      });
    }
    return outcome;
  }

  /** Reconciliation only reads operation.get with the original ID, even after an instance restart. */
  async reconcileOperations(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt?.client || this.status !== "current") return;
    for (const [operationId, local] of this.operations) {
      if (!this.current(attempt) || this.status !== "current") return;
      if (local.value.delivery === "dispatching" || local.value.delivery === "not-sent") continue;
      const query = ++local.query;
      const outcome = await attempt.client.getOperation(operationId);
      if (
        !this.current(attempt) ||
        local.query !== query ||
        this.operations.get(operationId) !== local
      )
        return;
      if (
        outcome.ok &&
        outcome.value.operation.method === local.value.reference.method &&
        outcome.value.operation.operationId === operationId
      ) {
        this.updateOperation(local, {
          delivery: "confirmed",
          observation: "record",
          record: outcome.value.operation,
        });
      } else {
        const missing =
          !outcome.ok &&
          outcome.kind === "rpc-error" &&
          "kind" in outcome.error &&
          outcome.error.kind === "OPERATION_NOT_FOUND";
        this.updateOperation(local, { observation: missing ? "not-found" : "unavailable" });
      }
    }
  }

  forgetOperation(operationId: string): boolean {
    const local = this.operations.get(operationId);
    if (
      !local ||
      (local.value.delivery !== "not-sent" &&
        !(
          local.value.delivery === "confirmed" &&
          local.value.record &&
          ["succeeded", "failed", "cancelled"].includes(local.value.record.state)
        ))
    )
      return false;
    this.operations.delete(operationId);
    this.intentBytes -= local.bytes;
    this.notifier.markState();
    return true;
  }

  openTerminal(options: TerminalOpenOptions): TerminalOpenOutcome {
    const attempt = this.attempt;
    return attempt?.client && this.status === "current"
      ? attempt.client.openTerminal(options)
      : {
          ok: false,
          error: {
            category: "local",
            reason: this.status === "disposed" ? "disposed" : "invalid-state",
          },
        };
  }

  dispose(): void {
    if (this.status === "disposed") return;
    this.status = "disposed";
    this.retire("disposed");
    safeDispose(this.mirrorListener);
    this.mirror.dispose();
    this.notifier.markState();
    this.notifier.closeWhenIdle(() => true);
  }

  private async adopt(attempt: Attempt, binding: VerifiedServerBinding): Promise<void> {
    if (!this.current(attempt)) {
      safeDispose(binding);
      return;
    }
    if (
      binding.identity.serverId !== this.options.serverId ||
      !OpaqueIdSchema.safeParse(binding.identity.relayInstanceId).success
    ) {
      safeDispose(binding);
      this.fail(attempt, "entry-identity");
      return;
    }
    const identity = Object.freeze({ ...binding.identity });
    attempt.binding = { ...binding, identity, dispose: () => binding.dispose() };
    const client = createClient({
      ...binding.client,
      expectedServerId: identity.serverId,
      expectedRelayInstanceId: identity.relayInstanceId,
    });
    if (!this.current(attempt)) {
      client.dispose();
      return;
    }
    attempt.client = client;
    attempt.clientListener = client.onState((snapshot) => {
      if (
        this.current(attempt) &&
        snapshot.status !== "connected" &&
        snapshot.status !== "connecting"
      )
        this.fail(attempt, "client-disconnected");
    });
    const connected = await client.connect();
    if (!this.current(attempt)) return;
    if (!connected.ok) {
      this.fail(attempt, "client-connect");
      return;
    }
    safeDispose(attempt.timer);
    delete attempt.timer;
    this.startReader(attempt, false);
  }

  private startReader(attempt: Attempt, fresh: boolean): void {
    if (!this.current(attempt)) return;
    const binding = attempt.binding!;
    const since = fresh ? undefined : this.mirror.resumeCursor(binding.identity);
    if (!this.mirror.begin(binding.identity, since).ok) {
      this.fail(attempt, "mirror-identity");
      return;
    }
    const reader = openBusinessEvents({
      target: binding.identity,
      buildVersion: binding.client.buildVersion,
      credentials: binding.client.credentials,
      codec: this.options.codec,
      scheduler: this.options.scheduler,
      port: binding.events,
      request: { type: "subscribe", filter: this.filter, ...(since ? { since } : {}) },
      frame: (frame) => this.receive(attempt, frame),
    });
    if (!this.current(attempt)) {
      reader.dispose();
      return;
    }
    attempt.reader = reader;
    void reader.done.then((outcome) => this.readerEnded(attempt, reader, outcome));
  }

  private receive(attempt: Attempt, frame: BusinessFrame): void {
    if (!this.current(attempt)) return;
    const accepted = this.mirror.accept(frame);
    if (!accepted.ok && frame.type !== "reset" && frame.type !== "error") {
      this.fail(attempt, `mirror-${accepted.reason}`);
      return;
    }
    // Only sequenced event facts may update the confirmed operation mirror. Local query
    // observations remain alongside their original intent, never merged into resource maps.
    if (frame.type === "changes") {
      for (const change of frame.changes) {
        if (change.type !== "upsert" || change.value.kind !== "operation") continue;
        const local = this.operations.get(change.value.id);
        if (local && local.value.reference.method === change.value.record.method)
          this.updateOperation(local, {
            delivery: "confirmed",
            observation: "record",
            record: change.value.record,
          });
      }
    }
    if (frame.type === "ready") {
      this.status = "current";
      this.lastError = undefined;
      this.settle(attempt, { ok: true });
      void this.reconcileOperations();
    }
    this.notifier.markState();
  }

  private readerEnded(
    attempt: Attempt,
    reader: BusinessReader,
    outcome: BusinessReaderOutcome,
  ): void {
    if (!this.current(attempt) || attempt.reader !== reader) return;
    delete attempt.reader;
    if (outcome.kind === "reset" && attempt.resetCount++ === 0) {
      // One fresh snapshot on this verified binding; repeated resets are explicit stale state.
      // No RPC, terminal input, focus, resize or entry migration is part of this recovery.
      this.status = "connecting";
      this.startReader(attempt, true);
    } else
      this.fail(
        attempt,
        outcome.kind === "reset" || outcome.kind === "refused"
          ? `events-${outcome.reason}`
          : outcome.kind === "error"
            ? outcome.message
            : "events-disposed",
      );
  }

  private updateOperation(
    local: LocalOperation,
    update: Partial<Omit<TrackedOperation, "reference">>,
  ): void {
    if (
      local.value.delivery === "confirmed" &&
      local.value.record &&
      update.delivery &&
      update.delivery !== "confirmed"
    )
      update = { ...update, delivery: "confirmed" };
    if (update.record && local.value.record && update.record.revision < local.value.record.revision)
      update = { ...update, record: local.value.record };
    local.value = freezeBusinessValue({ ...local.value, ...update });
    this.notifier.markState();
  }
  private current(attempt: Attempt): boolean {
    return this.attempt === attempt && attempt.generation === this.generation;
  }
  private settle(attempt: Attempt, outcome: ServerSessionOutcome): void {
    if (!attempt.settled) {
      attempt.settled = true;
      attempt.resolve(Object.freeze(outcome));
    }
  }
  private fail(attempt: Attempt, reason: string): void {
    if (!this.current(attempt)) return;
    const generation = this.retire(reason);
    if (this.generation !== generation) return;
    this.status = "stale";
    this.lastError = reason;
    this.notifier.markState();
  }
  private retire(reason: string): number {
    const attempt = this.attempt;
    this.attempt = undefined;
    this.generation++;
    const generation = this.generation;
    this.mirror.stale(reason);
    for (const local of this.operations.values()) {
      local.query++;
      if (local.value.delivery === "dispatching")
        this.updateOperation(local, { delivery: "unknown" });
    }
    if (!attempt) return generation;
    // Clear current ownership before adapter cleanup can reenter the public lifecycle.
    this.settle(attempt, { ok: false, reason });
    safeDispose(attempt.timer);
    safeDispose(attempt.clientListener);
    safeDispose(attempt.reader);
    safeDispose(attempt.client);
    safeDispose(attempt.bindingRequest);
    safeDispose(attempt.binding);
    return generation;
  }
}

export function createServerSession(options: ServerSessionOptions): ServerSession {
  return new ServerSession(options);
}
