import {
  canonicalOperationIntent,
  RPC_METHODS,
  type OperationRecord,
  type OperationReceiptKey,
} from "@cove/protocol/rpc";
import { domainError, type DomainError } from "@cove/protocol/errors";
import { DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { OpaqueIdSchema, type RunRef } from "@cove/protocol/identity";
import type { RuntimeResult } from "@cove/protocol/runtime";
import { LocalRuntime } from "../terminal/local-runtime.js";
import { RuntimeComposition } from "../terminal/runtime-composition.js";
import { uncertainStoreOutcome } from "../store/store-errors.js";
import { storeReadError } from "./database-operations.js";
import { OperationReceipts } from "./operation-receipts.js";

export type OperationOutcome = { operation: OperationRecord } | { error: DomainError };

// Durable run records (store/runs.ts). Only the hook D9 needs: a run is recorded when accepted,
// marked running once spawned and dropped when the worker definitely refused it; exit facts are
// recorded by the server composition from runtime events.
export interface RunRecorder {
  started(run: RunRef, cwd: string, operationId: string): Promise<void>;
  spawned(run: RunRef): Promise<void>;
  notStarted(run: RunRef): Promise<void>;
}

const RESULT_UNKNOWN = (): OperationOutcome => ({
  error: domainError("RESULT_UNKNOWN", "unknown"),
});

export class TerminalOperations {
  private runCounter = 0;
  private requestCounter = 0;
  private disposed = false;
  constructor(
    private readonly options: {
      composition: RuntimeComposition;
      runtime: LocalRuntime;
      receipts: OperationReceipts;
      encodeUtf8: (text: string) => Uint8Array;
      runs?: RunRecorder;
    },
  ) {
    if (
      options.runtime.composition !== options.composition ||
      options.receipts.composition !== options.composition
    )
      throw new Error("Runtime composition mismatch");
    this.options = { ...options };
  }

  private key(principalId: string, operationId: string): OperationReceiptKey {
    return { serverId: this.options.composition.serverId, principalId, operationId };
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
    const intent = canonicalOperationIntent("terminal.create", params, this.options.encodeUtf8);
    if (!intent) return this.failure("CAPABILITY_UNAVAILABLE");
    // Look the receipt up before checking execution preconditions (m1 "操作身份跨重启"): a
    // same-intent resend returns the original record even when its run belongs to an earlier
    // instance, and a changed intent is a conflict. Only a request without a record is new work,
    // and only new work must target the current instance.
    const key = this.key(principalId, params.operationId);
    const found = await this.options.receipts.lookup(key, intent);
    if (found.kind === "existing") return { operation: found.record };
    if (found.kind === "conflict") return this.failure("OPERATION_ID_CONFLICT");
    if (params.expectedRelayInstanceId !== this.options.composition.relayInstanceId)
      return this.failure("INSTANCE_MISMATCH");
    if (found.kind !== "reserve") return this.failure("BUSY");
    if (this.runCounter === Number.MAX_SAFE_INTEGER) return this.failure("COUNTER_EXHAUSTED");
    const requestId = this.nextRequest();
    if (!requestId) return this.failure("COUNTER_EXHAUSTED");
    const preparation = await this.options.receipts.prepare(key, intent);
    if (!preparation) return this.failure("BUSY");
    if (this.disposed) {
      preparation.cancel();
      return this.failure("CAPABILITY_UNAVAILABLE");
    }
    const run: RunRef = {
      serverId: this.options.composition.serverId,
      relayInstanceId: this.options.composition.relayInstanceId,
      runId: `run-${++this.runCounter}`,
    };
    const worker = this.options.runtime.reserveRun(run, params.geometry);
    if (!worker) {
      preparation.cancel();
      return this.failure("BUSY");
    }
    const record: OperationRecord = {
      operationId: params.operationId,
      method: "terminal.create",
      revision: 0,
      state: "accepted",
      run,
    };
    const runs = this.options.runs;
    // Store ordering (each step is durable before the next starts): the run record, then the
    // receipt, then `running`, and only then the spawn. A PTY is never started for an operation
    // whose receipt or run record the store could not confirm, so a store failure can leave an
    // uncertain receipt but never an unrecorded process.
    try {
      await runs?.started(run, params.cwd, params.operationId);
    } catch {
      // No receipt was written: the operation was not accepted. When the store failed with the
      // record in flight, the record may exist as `starting`; the next start marks it interrupted.
      preparation.cancel();
      this.options.runtime.cancelRunReservation(run, worker);
      return this.failure("BUSY");
    }
    const abandon = async (): Promise<void> => {
      preparation.cancel();
      this.options.runtime.cancelRunReservation(run, worker);
      // Nothing was spawned. Best effort: a failed store keeps the record for the next start.
      await this.recordRun(() => runs?.notStarted(run));
    };
    let committed: boolean;
    try {
      committed = await preparation.commit(record);
    } catch (error) {
      await abandon();
      // The receipt may have been committed: the operation's outcome is unknown to the client,
      // and the next start moves such a receipt to requires_attention. Nothing ran.
      return uncertainStoreOutcome(error) ? RESULT_UNKNOWN() : this.failure("BUSY");
    }
    if (!committed) {
      await abandon();
      return this.failure("BUSY");
    }
    try {
      await this.options.receipts.update(key, { ...record, revision: 1, state: "running" });
    } catch {
      // The receipt is accepted, but the store cannot record progress: do not spawn.
      await abandon();
      return RESULT_UNKNOWN();
    }
    let result: RuntimeResult;
    try {
      result = await this.options.runtime.spawn({
        ...params,
        worker,
        run,
        requestId,
        appearance: params.appearance ?? DEFAULT_APPEARANCE,
        effectiveBudgets: this.options.composition.budgets,
        profile: PROFILE,
      });
    } catch {
      result = {
        type: "error",
        commandType: "spawn",
        worker,
        run,
        requestId,
        error: domainError("RESULT_UNKNOWN", "unknown"),
      };
    }
    const uncertain =
      (result.type === "error" && result.error.acceptance === "unknown") ||
      (result.type === "result" && result.outcome === "unknown");
    // An uncertain spawn keeps its `starting` record: the next start marks it interrupted.
    if (!uncertain)
      await this.recordRun(() =>
        result.type === "error" || result.outcome === "rejected"
          ? runs?.notStarted(run)
          : runs?.spawned(run),
      );
    return this.complete(key, result);
  }

  // Run records follow the terminal path; a failed record write never changes its outcome.
  private async recordRun(write: () => Promise<void> | undefined): Promise<void> {
    try {
      await write();
    } catch {
      /* The run keeps its previous record; a restart marks it interrupted. */
    }
  }

  async stop(principalId: string, input: unknown): Promise<OperationOutcome> {
    const parsed = RPC_METHODS["terminal.stop"].params.safeParse(input);
    if (this.disposed || !OpaqueIdSchema.safeParse(principalId).success || !parsed.success)
      return this.failure("CAPABILITY_UNAVAILABLE");
    const params = parsed.data;
    const intent = canonicalOperationIntent("terminal.stop", params, this.options.encodeUtf8);
    if (!intent) return this.failure("CAPABILITY_UNAVAILABLE");
    // Same order as create: the receipt decides before the stale-instance precondition.
    const key = this.key(principalId, params.operationId);
    const found = await this.options.receipts.lookup(key, intent);
    if (found.kind === "existing") return { operation: found.record };
    if (found.kind === "conflict") return this.failure("OPERATION_ID_CONFLICT");
    if (
      params.expectedRelayInstanceId !== this.options.composition.relayInstanceId ||
      params.run.serverId !== this.options.composition.serverId ||
      params.run.relayInstanceId !== this.options.composition.relayInstanceId
    )
      return this.failure("INSTANCE_MISMATCH");
    if (found.kind !== "reserve") return this.failure("BUSY");
    const entry = this.options.runtime.registry.get(params.run);
    if (!entry) return this.failure("RUN_NOT_FOUND");
    const requestId = this.nextRequest();
    if (!requestId) return this.failure("COUNTER_EXHAUSTED");
    const preparation = await this.options.receipts.prepare(key, intent);
    if (!preparation) return this.failure("BUSY");
    const record: OperationRecord = {
      operationId: params.operationId,
      method: "terminal.stop",
      revision: 0,
      state: "accepted",
      run: params.run,
    };
    // As in create: the stop is sent only after the store confirmed the receipt and `running`.
    let committed: boolean;
    try {
      committed = await preparation.commit(record);
    } catch (error) {
      preparation.cancel();
      return uncertainStoreOutcome(error) ? RESULT_UNKNOWN() : this.failure("BUSY");
    }
    if (!committed) {
      preparation.cancel();
      return this.failure("BUSY");
    }
    try {
      await this.options.receipts.update(key, { ...record, revision: 1, state: "running" });
    } catch {
      return RESULT_UNKNOWN();
    }
    let result: RuntimeResult;
    try {
      result = await this.options.runtime.stop({
        type: "stop",
        worker: entry.worker,
        run: params.run,
        requestId,
        operationId: params.operationId,
      });
    } catch {
      result = {
        type: "error",
        commandType: "stop",
        worker: entry.worker,
        run: params.run,
        requestId,
        error: domainError("RESULT_UNKNOWN", "unknown"),
      };
    }
    return this.complete(key, result);
  }

  // Records the runtime's answer. When the store cannot, the client learns that the outcome is
  // unknown; the receipt stays running and the next start moves it to requires_attention.
  private async complete(
    key: OperationReceiptKey,
    result: RuntimeResult,
  ): Promise<OperationOutcome> {
    try {
      return await this.recordOutcome(key, result);
    } catch {
      return RESULT_UNKNOWN();
    }
  }

  private async recordOutcome(
    key: OperationReceiptKey,
    result: RuntimeResult,
  ): Promise<OperationOutcome> {
    const record = await this.options.receipts.get(key);
    if (!record) return this.failure("OPERATION_NOT_FOUND");
    const uncertain =
      (result.type === "error" && result.error.acceptance === "unknown") ||
      (result.type === "result" && result.outcome === "unknown");
    const rejected = result.type === "error" || result.outcome === "rejected";
    const exited = result.type === "result" && result.runStatus?.status === "exited";
    const state = uncertain
      ? "requires_attention"
      : rejected
        ? "failed"
        : record.method === "terminal.create" || exited
          ? "succeeded"
          : "running";
    const next: OperationRecord = {
      ...record,
      revision: record.revision + 1,
      state,
      ...(uncertain
        ? { error: domainError("RESULT_UNKNOWN", "unknown") }
        : result.type === "error"
          ? { error: result.error }
          : {}),
      ...(state === "succeeded"
        ? {
            result: {
              run: record.run!,
              ...(exited
                ? {
                    exitCode: result.type === "result" ? result.runStatus!.exitCode : null,
                    signal: result.type === "result" ? result.runStatus!.signal : null,
                  }
                : {}),
            },
          }
        : {}),
    };
    await this.options.receipts.update(key, next);
    const stored = await this.options.receipts.get(key);
    return stored ? { operation: stored } : this.failure("OPERATION_NOT_FOUND");
  }

  // Queried by durable identity only; the record may reference a run of an earlier instance.
  async get(principalId: string, operationId: string): Promise<OperationOutcome> {
    const key = this.key(principalId, operationId);
    try {
      let record = await this.options.receipts.get(key);
      if (record?.method === "terminal.stop" && record.state === "running" && record.run) {
        const status = this.options.runtime.registry.get(record.run)?.status;
        if (status?.status === "exited") {
          await this.options.receipts.update(key, {
            ...record,
            revision: record.revision + 1,
            state: "succeeded",
            result: { run: record.run, exitCode: status.exitCode, signal: status.signal },
          });
          record = await this.options.receipts.get(key);
        }
      }
      return record ? { operation: record } : this.failure("OPERATION_NOT_FOUND");
    } catch (error) {
      return { error: storeReadError(error) };
    }
  }
  dispose(): void {
    this.disposed = true;
  }
}
