import {
  canonicalOperationIntent, RPC_METHODS, type OperationRecord, type OperationReceiptKey,
} from "@cove/protocol/rpc";
import { domainError, type DomainError } from "@cove/protocol/errors";
import { DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { OpaqueIdSchema, type RunRef } from "@cove/protocol/identity";
import type { EffectiveBudgets } from "@cove/protocol/budgets";
import type { RuntimeResult } from "@cove/protocol/runtime";
import { LocalRuntime } from "../terminal/local-runtime.js";
import { OperationReceipts } from "./operation-receipts.js";

export type OperationOutcome = { operation: OperationRecord } | { error: DomainError };

export class TerminalOperations {
  private runCounter = 0;
  private requestCounter = 0;
  private disposed = false;
  constructor(private readonly options: {
    serverId: string; relayInstanceId: string; budgets: EffectiveBudgets;
    runtime: LocalRuntime; receipts: OperationReceipts; encodeUtf8: (text: string) => Uint8Array;
  }) {}

  private key(principalId: string, operationId: string): OperationReceiptKey {
    return { serverId: this.options.serverId, relayInstanceId: this.options.relayInstanceId,
      principalId, operationId };
  }
  private failure(kind: Parameters<typeof domainError>[0]): OperationOutcome {
    return { error: domainError(kind) };
  }
  private nextRequest(): string | null {
    if (this.requestCounter === Number.MAX_SAFE_INTEGER) return null;
    return `runtime-${++this.requestCounter}`;
  }

  async create(principalId: string, input: unknown): Promise<OperationOutcome> {
    const parsed = RPC_METHODS["terminal.create"].params.safeParse(input);
    if (this.disposed || !OpaqueIdSchema.safeParse(principalId).success || !parsed.success)
      return this.failure("CAPABILITY_UNAVAILABLE");
    const params = parsed.data;
    if (params.expectedRelayInstanceId !== this.options.relayInstanceId)
      return this.failure("INSTANCE_MISMATCH");
    const intent = canonicalOperationIntent("terminal.create", params, this.options.encodeUtf8);
    if (!intent) return this.failure("CAPABILITY_UNAVAILABLE");
    const key = this.key(principalId, params.operationId);
    const found = this.options.receipts.lookup(key, intent);
    if (found.kind === "existing") return { operation: found.record };
    if (found.kind === "conflict") return this.failure("OPERATION_ID_CONFLICT");
    if (found.kind !== "reserve") return this.failure("BUSY");
    if (this.runCounter === Number.MAX_SAFE_INTEGER) return this.failure("COUNTER_EXHAUSTED");
    const requestId = this.nextRequest();
    if (!requestId) return this.failure("COUNTER_EXHAUSTED");
    const preparation = this.options.receipts.prepare(key, intent);
    if (!preparation) return this.failure("BUSY");
    const run: RunRef = { serverId: this.options.serverId,
      relayInstanceId: this.options.relayInstanceId, runId: `run-${++this.runCounter}` };
    const worker = this.options.runtime.reserveRun(run, params.geometry);
    if (!worker) { preparation.cancel(); return this.failure("BUSY"); }
    const record: OperationRecord = { operationId: params.operationId, method: "terminal.create",
      revision: 0, state: "accepted", run };
    if (!preparation.commit(record)) {
      preparation.cancel(); this.options.runtime.cancelRunReservation(run, worker);
      return this.failure("BUSY");
    }
    this.options.receipts.update(key, { ...record, revision: 1, state: "running" });
    let result: RuntimeResult;
    try {
      result = await this.options.runtime.spawn({ ...params, worker, run, requestId,
        appearance: params.appearance ?? DEFAULT_APPEARANCE,
        effectiveBudgets: this.options.budgets, profile: PROFILE });
    } catch {
      result = { type: "error", commandType: "spawn", worker, run, requestId,
        error: domainError("RESULT_UNKNOWN", "unknown") };
    }
    return this.complete(key, result);
  }

  async stop(principalId: string, input: unknown): Promise<OperationOutcome> {
    const parsed = RPC_METHODS["terminal.stop"].params.safeParse(input);
    if (this.disposed || !OpaqueIdSchema.safeParse(principalId).success || !parsed.success)
      return this.failure("CAPABILITY_UNAVAILABLE");
    const params = parsed.data;
    if (params.expectedRelayInstanceId !== this.options.relayInstanceId ||
        params.run.serverId !== this.options.serverId ||
        params.run.relayInstanceId !== this.options.relayInstanceId)
      return this.failure("INSTANCE_MISMATCH");
    const intent = canonicalOperationIntent("terminal.stop", params, this.options.encodeUtf8);
    if (!intent) return this.failure("CAPABILITY_UNAVAILABLE");
    const key = this.key(principalId, params.operationId);
    const found = this.options.receipts.lookup(key, intent);
    if (found.kind === "existing") return { operation: found.record };
    if (found.kind === "conflict") return this.failure("OPERATION_ID_CONFLICT");
    if (found.kind !== "reserve") return this.failure("BUSY");
    const entry = this.options.runtime.registry.get(params.run);
    if (!entry) return this.failure("RUN_NOT_FOUND");
    const requestId = this.nextRequest();
    if (!requestId) return this.failure("COUNTER_EXHAUSTED");
    const preparation = this.options.receipts.prepare(key, intent);
    if (!preparation) return this.failure("BUSY");
    const record: OperationRecord = { operationId: params.operationId, method: "terminal.stop",
      revision: 0, state: "accepted", run: params.run };
    if (!preparation.commit(record)) { preparation.cancel(); return this.failure("BUSY"); }
    this.options.receipts.update(key, { ...record, revision: 1, state: "running" });
    let result: RuntimeResult;
    try {
      result = await this.options.runtime.stop({ type: "stop", worker: entry.worker,
        run: params.run, requestId, operationId: params.operationId });
    } catch {
      result = { type: "error", commandType: "stop", worker: entry.worker, run: params.run,
        requestId, error: domainError("RESULT_UNKNOWN", "unknown") };
    }
    return this.complete(key, result);
  }

  private complete(key: OperationReceiptKey, result: RuntimeResult): OperationOutcome {
    const record = this.options.receipts.get(key);
    if (!record) return this.failure("OPERATION_NOT_FOUND");
    const uncertain = (result.type === "error" && result.error.acceptance === "unknown") ||
      (result.type === "result" && result.outcome === "unknown");
    const rejected = result.type === "error" || result.outcome === "rejected";
    const exited = result.type === "result" && result.runStatus?.status === "exited";
    const state = uncertain ? "requires_attention" : rejected ? "failed" :
      record.method === "terminal.create" || exited ? "succeeded" : "running";
    const next: OperationRecord = { ...record, revision: record.revision + 1, state,
      ...(uncertain ? { error: domainError("RESULT_UNKNOWN", "unknown") } :
        result.type === "error" ? { error: result.error } : {}),
      ...(state === "succeeded" ? { result: { run: record.run!,
        ...(exited ? { exitCode: result.type === "result" ? result.runStatus!.exitCode : null,
          signal: result.type === "result" ? result.runStatus!.signal : null } : {}) } } : {}),
    };
    this.options.receipts.update(key, next);
    return { operation: this.options.receipts.get(key)! };
  }

  get(principalId: string, operationId: string, expectedRelayInstanceId: string): OperationOutcome {
    if (expectedRelayInstanceId !== this.options.relayInstanceId) return this.failure("INSTANCE_MISMATCH");
    const key = this.key(principalId, operationId);
    let record = this.options.receipts.get(key);
    if (record?.method === "terminal.stop" && record.state === "running" && record.run) {
      const status = this.options.runtime.registry.get(record.run)?.status;
      if (status?.status === "exited") {
        this.options.receipts.update(key, { ...record, revision: record.revision + 1, state: "succeeded",
          result: { run: record.run, exitCode: status.exitCode, signal: status.signal } });
        record = this.options.receipts.get(key);
      }
    }
    return record ? { operation: record } : this.failure("OPERATION_NOT_FOUND");
  }
  dispose(): void { this.disposed = true; }
}
