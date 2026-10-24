import { domainError } from "@cove/protocol/errors";
import { OperationRecordSchema, type OperationReceiptKey } from "@cove/protocol/rpc";
import { checkedReceiptRecord, type ReceiptLimits } from "../../operations/receipt-records.js";
import { statement, type Connection } from "./statements.js";
const encoder = new TextEncoder();

// Receipt-only abandon: retain every byte/uncertainty fact and close tracking. It neither
// cancels PTY effects nor removes files. The enclosing receipts.write transaction also commits
// the abandon receipt, so a crash cannot expose just half of this state transition.
export const tabInputWrites = {
  "tab-input.abandon": (
    db: Connection,
    args: {
      target: OperationReceiptKey;
      expectedRevision: number;
      limits: ReceiptLimits;
      at: number;
    },
  ) => {
    const key = args.target;
    const row = statement(
      db,
      `SELECT record_json FROM operations WHERE server_id = ? AND principal_id = ? AND operation_id = ?`,
    ).get(key.serverId, key.principalId, key.operationId) as { record_json: string } | undefined;
    if (!row) return { error: domainError("OPERATION_NOT_FOUND") };
    const current = OperationRecordSchema.parse(JSON.parse(row.record_json));
    if (
      current.method !== "tab.send" ||
      current.state !== "requires_attention" ||
      current.revision !== args.expectedRevision
    )
      return { error: domainError("OPERATION_NOT_RESUMABLE") };
    const next = checkedReceiptRecord(
      key,
      { ...current, revision: current.revision + 1, state: "cancelled" },
      args.limits,
      (text) => encoder.encode(text),
    );
    if (!next) return { error: domainError("INVALID_ARGUMENT") };
    const changed = statement(
      db,
      `UPDATE operations SET state = ?, revision = ?, record_json = ?, updated_at_ms = ?
      WHERE server_id = ? AND principal_id = ? AND operation_id = ? AND revision = ? AND state = 'requires_attention'`,
    ).run(
      next.state,
      next.revision,
      JSON.stringify(next),
      args.at,
      key.serverId,
      key.principalId,
      key.operationId,
      current.revision,
    ).changes;
    if (changed !== 1) return { error: domainError("OPERATION_NOT_RESUMABLE") };
    return { result: { targetOperationId: key.operationId } };
  },
};
