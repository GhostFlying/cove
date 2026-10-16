import type { DomainError } from "@cove/protocol/errors";
import {
  validateOperationRecord,
  type OperationReceiptKey,
  type OperationRecord,
  type WriteRpcMethod,
} from "@cove/protocol/rpc";
import type { DatabaseWrites } from "../store/sql/writes.js";

// Receipt-record rules that hold wherever a receipt is written: in OperationReceipts on the main
// thread, and inside the store's receipts.write operation (store/sql/receipts.ts), which runs
// where the database connection lives. This module is pure so both can import it.

export type OperationResultData = NonNullable<OperationRecord["result"]>;
export type DatabaseWriteOutcome = { operation: OperationRecord } | { error: DomainError };
// What a receipt-checked database write answers (store/sql/receipts.ts receipts.write):
// `committed` is set only when this call applied the change and inserted the receipt, never when
// the in-transaction recheck found the receipt of an identical request that committed first. A
// domain whose write is followed by work outside the database (an entry on disk) does that work
// only for its own commit; a resend must not repeat it.
export type DatabaseWriteResult =
  { operation: OperationRecord; committed?: true } | { error: DomainError };

// The limits a stored record must respect.
export type ReceiptLimits = { serverId: string; operationRecordBytes: number };

// The record when it may be stored under `key`: a valid operation record within the byte budget,
// naming the key's operation and, when it references a run, a run of this server. Whether a new
// run may be bound to the current instance is the caller's execution precondition.
export function checkedReceiptRecord(
  key: OperationReceiptKey,
  record: OperationRecord,
  limits: ReceiptLimits,
  encodeUtf8: (text: string) => Uint8Array,
): OperationRecord | null {
  const checked = validateOperationRecord(record, encodeUtf8);
  if (
    !checked ||
    encodeUtf8(JSON.stringify(checked)).byteLength > limits.operationRecordBytes ||
    checked.operationId !== key.operationId ||
    (checked.run !== undefined && checked.run.serverId !== limits.serverId)
  )
    return null;
  return checked;
}

export type DatabaseWriteName = keyof DatabaseWrites;
// A named database write and its arguments (store/sql/writes.ts). Arguments must be
// structured-clone-safe: they travel to the store worker.
export type DatabaseWriteApply = {
  [N in DatabaseWriteName]: { name: N; args: Parameters<DatabaseWrites[N]>[1] };
}[DatabaseWriteName];

// One receipt-checked database write (operations/database-operations.ts): the store looks the
// receipt up again, applies `apply` and commits the receipt in a single transaction.
export type DatabaseWriteRequest = {
  key: OperationReceiptKey;
  canonicalIntent: string;
  method: WriteRpcMethod;
  apply: DatabaseWriteApply;
};
