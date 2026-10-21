import { createHash } from "node:crypto";
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
// `secretRefused` is a defect, never an answer: the record the write produced held one of the
// request's secrets, so the transaction rolled back and nothing was stored (DatabaseWriteRequest
// `secrets`).
export type DatabaseWriteResult =
  | { operation: OperationRecord; committed?: true }
  | { error: DomainError }
  | { secretRefused: true };

// Receipt retention (m2 D13, #97; relay-protocol §11.3). A receipt that ended succeeded, failed or
// cancelled is purged once RECEIPT_RETENTION_MS have passed since it ended, by the wall clock;
// what remains is a permanent tombstone (migration 005), so its operation ID is never executed
// again. A receipt that has not ended (accepted, running, recovering, requires_attention) is never
// purged, whatever its age.
export const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// What a purged receipt leaves (migration 005 operation_tombstones): no params, result or secret.
export type ReceiptTombstone = {
  expired: true;
  key: OperationReceiptKey;
  method: string;
  state: "succeeded" | "failed" | "cancelled";
  intentDigest: string;
  endedAtMs: number;
};

// One batch of receipt retention (store/sql/receipts.ts receipts.purge): at most `limit` receipts
// due at `now` (wall clock, ms) under `retentionMs`; `highestRun` is the run-N high-water mark
// (runs.highestNumber) read before the pass. The answer says how many were purged and whether more
// may be due (the batch was full).
export type PurgeArgs = { now: number; retentionMs: number; limit: number; highestRun: number };
export type PurgeBatch = { purged: number; more: boolean };

// The digest a tombstone keeps of the canonical intent it replaced: hex of the first 16 bytes of
// its SHA-256. It only tells a resend of the same request (OPERATION_HISTORY_EXPIRED) from another
// request reusing the ID (OPERATION_ID_CONFLICT); both refuse, so a collision cannot execute
// anything.
export function intentDigest(canonicalIntent: string): string {
  return createHash("sha256").update(canonicalIntent, "utf8").digest("hex").slice(0, 32);
}

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
  // The secret values of the request, input and output (executeSecretWrite). The transaction
  // refuses to store a record in which any of them appears, so a secret can never become part of
  // what operation.get or a resend returns, however the write built its result.
  secrets?: readonly string[];
};
