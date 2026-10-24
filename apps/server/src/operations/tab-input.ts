import { randomUUID } from "node:crypto";
import { domainError } from "@cove/protocol/errors";
import { sameRunRef, type RunRef } from "@cove/protocol/identity";
import {
  canonicalWriteIntent,
  type OperationReceiptKey,
  type OperationRecord,
} from "@cove/protocol/rpc";
import {
  inputPartReceipt,
  TabSendParamsSchema,
  type TabControlObservation,
  type TabInputReceipt,
} from "@cove/protocol/workspace";
import type { Store } from "../store/database.js";
import { controlArbiter } from "../terminal/control-arbiter.js";
import type { LocalRuntime } from "../terminal/local-runtime.js";
import {
  executeDatabaseWrite,
  recordedWrite,
  storeReadError,
  storeFailureError,
} from "./database-operations.js";
import type { OperationReceipts } from "./operation-receipts.js";
import type { OperationOutcome } from "./terminal-operations.js";

const encoder = new TextEncoder();
const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);
type TargetParams = { operationId: string; targetOperationId: string };

// A durable intent and one entry-owned control queue. This service never retries native input,
// including after a failed receipt write: unfinished receipts become requires_attention on restart.
export class TabInputService {
  private readonly active = new Set<string>();
  constructor(
    private readonly options: { store: Store; runtime: LocalRuntime; receipts: OperationReceipts },
  ) {}
  private get context() {
    return {
      serverId: this.options.runtime.composition.serverId,
      receipts: this.options.receipts,
      encodeUtf8,
    };
  }
  private key(principalId: string, operationId: string): OperationReceiptKey {
    return { serverId: this.context.serverId, principalId, operationId };
  }
  private activeKey(key: OperationReceiptKey): string {
    return JSON.stringify(key);
  }
  async send(principalId: string, input: unknown): Promise<OperationOutcome> {
    const parsed = TabSendParamsSchema.safeParse(input);
    if (!parsed.success) return { error: domainError("INVALID_ARGUMENT") };
    const params = parsed.data;
    const intent = canonicalWriteIntent("tab.send", params, encodeUtf8);
    if (!intent) return { error: domainError("INVALID_ARGUMENT") };
    // This precedes even the current server-instance/run lookup. No live leaf may replace it.
    const recorded = await recordedWrite(this.context, principalId, "tab.send", params);
    if (recorded) return recorded;
    const { runtime, receipts, store } = this.options;
    const composition = runtime.composition;
    if (
      params.run.serverId !== composition.serverId ||
      params.run.relayInstanceId !== composition.relayInstanceId
    )
      return { error: domainError("INSTANCE_MISMATCH") };
    const key = this.key(principalId, params.operationId);
    const preparation = await receipts.prepare(key, intent);
    if (!preparation)
      return (
        (await recordedWrite(this.context, principalId, "tab.send", params)) ?? {
          error: domainError("BUSY"),
        }
      );
    let job: import("../terminal/control-arbiter.js").ProgrammaticJob | undefined;
    let running = false;
    let durable = false;
    try {
      const read = await store.call("tabs.get", { tabId: params.tabId });
      if (!read) return { error: domainError("TAB_NOT_FOUND") };
      if (!read.latestRun || !sameRunRef(read.latestRun.run, params.run))
        return { error: domainError("RUN_NOT_FOUND") };
      const entry = runtime.registry.get(params.run);
      const arbiter = controlArbiter(runtime);
      if (!entry || entry.status.status === "exited")
        return { error: domainError("WORKER_UNAVAILABLE") };
      if (!arbiter) return { error: domainError("CAPABILITY_UNAVAILABLE") };
      const bytes = encodeUtf8(params.text);
      const admitted = arbiter.admitProgrammatic(
        {
          type: "programmatic-input",
          worker: entry.worker,
          run: params.run,
          requestId: randomUUID(),
          operationId: params.operationId,
          epoch: params.ifControlEpoch,
          textBytes: bytes.byteLength,
          submit: params.submit,
        },
        bytes,
      );
      if (!("kind" in admitted) || admitted.kind !== "programmatic") return { error: admitted };
      job = admitted;
      const queued: TabInputReceipt = {
        text: inputPartReceipt(bytes.byteLength, 0, bytes.byteLength, "pending"),
        submit: params.submit ? inputPartReceipt(1, 0, 1, "pending") : null,
      };
      const accepted: OperationRecord = {
        operationId: params.operationId,
        method: "tab.send",
        revision: 0,
        state: "accepted",
        run: params.run,
        result: {
          resource: { kind: "tab", id: params.tabId, revision: read.tab.revision },
          input: queued,
        },
      };
      const record: OperationRecord = { ...accepted, revision: 1, state: "running" };
      let acceptanceError: ReturnType<typeof domainError> | undefined;
      const receipt = await arbiter.executeProgrammatic(job, async () => {
        try {
          if (!(await preparation.commit(accepted))) {
            acceptanceError = domainError("BUSY");
            return false;
          }
          durable = true;
          if (!(await receipts.update(key, record))) {
            acceptanceError = domainError("RESULT_UNKNOWN", "unknown");
            return false;
          }
          running = true;
          this.active.add(this.activeKey(key));
          return true;
        } catch (error) {
          acceptanceError = durable
            ? domainError("RESULT_UNKNOWN", "unknown")
            : storeFailureError(error);
          return false;
        }
      });
      if (!running) {
        const reason = receipt.text.reason ?? receipt.submit?.reason;
        return {
          error:
            acceptanceError ??
            domainError(
              reason === "controller-present"
                ? "CONTROL_HELD"
                : reason === "stale-control"
                  ? "STALE_CONTROL"
                  : reason === "control-unverifiable" || reason === "run-not-live"
                    ? "WORKER_UNAVAILABLE"
                    : "INPUT_REJECTED",
            ),
        };
      }
      const uncertain = receipt.text.unknownBytes > 0 || (receipt.submit?.unknownBytes ?? 0) > 0;
      const complete =
        receipt.text.status === "written" &&
        (!receipt.submit || receipt.submit.status === "written");
      const next: OperationRecord = {
        ...record,
        revision: record.revision + 1,
        state: complete ? "succeeded" : uncertain ? "requires_attention" : "failed",
        result: { ...record.result, input: receipt },
        ...(!complete
          ? {
              error: domainError(
                uncertain ? "RESULT_UNKNOWN" : "INPUT_REJECTED",
                uncertain
                  ? "unknown"
                  : receipt.text.writtenBytes > 0 || (receipt.submit?.writtenBytes ?? 0) > 0
                    ? "accepted"
                    : "not-accepted",
              ),
            }
          : {}),
      };
      // Ordinary update cannot revive cancelled/requires_attention; explicit abandon is final.
      if (!(await receipts.update(key, next)))
        return { error: domainError("RESULT_UNKNOWN", "unknown") };
      const stored = await receipts.get(key);
      return stored ? { operation: stored } : { error: domainError("RESULT_UNKNOWN", "unknown") };
    } catch (error) {
      return {
        error:
          durable || job?.dispatched
            ? domainError("RESULT_UNKNOWN", "unknown")
            : storeFailureError(error),
      };
    } finally {
      preparation.cancel();
      if (job && !job.ready)
        controlArbiter(runtime)?.cancelProgrammatic(job, "receipt-not-confirmed");
      this.active.delete(this.activeKey(key));
    }
  }
  async observe(run: RunRef | null): Promise<TabControlObservation> {
    const { runtime } = this.options;
    if (
      !run ||
      run.relayInstanceId !== runtime.composition.relayInstanceId ||
      run.serverId !== runtime.composition.serverId
    )
      return { state: "not-live", run };
    const entry = runtime.registry.get(run);
    if (entry?.status.status === "exited") return { state: "not-live", run };
    if (!entry) return { state: "unknown", run, reason: "worker-unavailable" };
    try {
      const result = await runtime.getStatus({
        type: "status",
        worker: entry.worker,
        run,
        requestId: randomUUID(),
      });
      if (
        result.type === "result" &&
        result.outcome === "accepted" &&
        result.runStatus?.status === "live"
      )
        return {
          state: "current",
          run,
          epoch: result.runStatus.controlEpoch,
          holder: result.runStatus.controlHolder,
        };
      if (result.type === "result" && result.runStatus?.status === "exited")
        return { state: "not-live", run };
      return { state: "unknown", run, reason: "control-unverifiable" };
    } catch {
      return { state: "unknown", run, reason: "control-unverifiable" };
    }
  }
  async act(
    principalId: string,
    method: "operation.continue" | "operation.abandon",
    params: TargetParams,
  ): Promise<OperationOutcome | null> {
    // Preserve the action's own deduplication before inspecting its target.
    const recorded = await recordedWrite(this.context, principalId, method, params);
    if (recorded) return recorded;
    const target = this.key(principalId, params.targetOperationId);
    let record: OperationRecord | null;
    try {
      record = await this.options.receipts.get(target);
    } catch (error) {
      return { error: storeReadError(error) };
    }
    if (record?.method !== "tab.send") return null;
    if (method === "operation.continue" || record.state !== "requires_attention")
      return { error: domainError("OPERATION_NOT_RESUMABLE") };
    if (this.active.has(this.activeKey(target)))
      return { error: domainError("OPERATION_EFFECTS_ACTIVE") };
    return executeDatabaseWrite(this.context, principalId, method, params, {
      name: "tab-input.abandon",
      args: {
        target,
        expectedRevision: record.revision,
        at: Date.now(),
        limits: {
          serverId: this.context.serverId,
          operationRecordBytes: this.options.runtime.composition.budgets.operationRecordBytes,
        },
      },
    });
  }
}
