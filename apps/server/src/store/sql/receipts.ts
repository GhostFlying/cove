import { domainError, type DomainError } from "@cove/protocol/errors";
import {
  OperationRecordSchema,
  type OperationReceiptKey,
  type OperationRecord,
  type StoredReceipt,
} from "@cove/protocol/rpc";
import {
  checkedReceiptRecord,
  type DatabaseWriteOutcome,
  type DatabaseWriteRequest,
  type OperationResultData,
  type ReceiptLimits,
} from "../../operations/receipt-records.js";
import { Rollback, statement, type Connection } from "./statements.js";
import { DATABASE_WRITES } from "./writes.js";

type Row = {
  server_id: string;
  principal_id: string;
  operation_id: string;
  canonical_intent: string;
  record_json: string;
};

const encoder = new TextEncoder();
const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

function receipt(row: Row): StoredReceipt {
  const parsed = OperationRecordSchema.safeParse(JSON.parse(row.record_json));
  // A stored record that no longer parses is corruption, never an absent receipt: treating it as
  // absent would let a resend execute the operation a second time.
  if (!parsed.success) throw new Error("Stored operation record is invalid");
  return {
    key: {
      serverId: row.server_id,
      principalId: row.principal_id,
      operationId: row.operation_id,
    },
    canonicalIntent: row.canonical_intent,
    record: parsed.data,
  };
}

function get(db: Connection, key: OperationReceiptKey): StoredReceipt | null {
  const row = statement(
    db,
    `SELECT server_id, principal_id, operation_id, canonical_intent, record_json
     FROM operations WHERE server_id = ? AND principal_id = ? AND operation_id = ?`,
  ).get(key.serverId, key.principalId, key.operationId) as Row | undefined;
  return row ? receipt(row) : null;
}

function insert(
  db: Connection,
  stored: StoredReceipt,
  relayInstanceId: string,
  at: number,
): boolean {
  const { key, record } = stored;
  return (
    statement(
      db,
      `INSERT INTO operations (server_id, principal_id, operation_id, method, canonical_intent,
         state, revision, record_json, accepted_by_instance_id, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).run(
      key.serverId,
      key.principalId,
      key.operationId,
      record.method,
      stored.canonicalIntent,
      record.state,
      record.revision,
      JSON.stringify(record),
      relayInstanceId,
      at,
      at,
    ).changes === 1
  );
}

// A compare-and-set on the stored revision, so two writers can never both advance one record.
function replace(
  db: Connection,
  key: OperationReceiptKey,
  expectedRevision: number,
  record: OperationRecord,
  at: number,
): boolean {
  return (
    statement(
      db,
      `UPDATE operations SET state = ?, revision = ?, record_json = ?, updated_at_ms = ?
       WHERE server_id = ? AND principal_id = ? AND operation_id = ? AND revision = ?`,
    ).run(
      record.state,
      record.revision,
      JSON.stringify(record),
      at,
      key.serverId,
      key.principalId,
      key.operationId,
      expectedRevision,
    ).changes === 1
  );
}

// The operations table (migration 001), the durable backend of OperationReceipts
// (store/operations.ts). Callers validate every record before it reaches insert or replace.
export const receiptOperations = {
  "receipts.get": (db: Connection, args: { key: OperationReceiptKey }): StoredReceipt | null =>
    get(db, args.key),

  "receipts.insert": (
    db: Connection,
    args: { receipt: StoredReceipt; relayInstanceId: string; at: number },
  ): boolean => insert(db, args.receipt, args.relayInstanceId, args.at),

  "receipts.replace": (
    db: Connection,
    args: {
      key: OperationReceiptKey;
      expectedRevision: number;
      record: OperationRecord;
      at: number;
    },
  ): boolean => replace(db, args.key, args.expectedRevision, args.record, args.at),

  // Receipts left accepted, running or recovering, oldest first.
  "receipts.unfinished": (db: Connection): StoredReceipt[] =>
    (
      statement(
        db,
        `SELECT server_id, principal_id, operation_id, canonical_intent, record_json
         FROM operations WHERE state IN ('accepted', 'running', 'recovering')
         ORDER BY created_at_ms, operation_id`,
      ).all() as Row[]
    ).map(receipt),

  // A write whose whole effect is a database change (operations/database-operations.ts). In one
  // transaction: the receipt is looked up again (the caller's earlier lookup is outside this
  // transaction), so a same-intent request that committed meanwhile returns its record and a
  // changed intent is OPERATION_ID_CONFLICT; otherwise the named write checks its preconditions
  // against the current rows and applies its change, and the receipt is inserted as accepted and
  // advanced to succeeded. A refusal rolls everything back and leaves no receipt. A crash leaves
  // either the change and the receipt or neither, so such an operation is never left accepted or
  // running for startup verification.
  "receipts.write": (
    db: Connection,
    args: DatabaseWriteRequest & { relayInstanceId: string; at: number; limits: ReceiptLimits },
  ): DatabaseWriteOutcome => {
    const { key, limits } = args;
    if (key.serverId !== limits.serverId) return { error: domainError("INVALID_ARGUMENT") };
    const existing = get(db, key);
    if (existing)
      return existing.canonicalIntent === args.canonicalIntent
        ? { operation: existing.record }
        : { error: domainError("OPERATION_ID_CONFLICT") };
    if (!Object.hasOwn(DATABASE_WRITES, args.apply.name)) throw new Error("Unknown database write");
    const write = DATABASE_WRITES[args.apply.name] as (
      db: Connection,
      args: unknown,
    ) => { result: OperationResultData } | { error: DomainError };
    const applied = write(db, args.apply.args);
    if ("error" in applied) throw new Rollback({ error: applied.error });
    const busy = new Rollback({ error: domainError("BUSY") });
    const accepted = checkedReceiptRecord(
      key,
      { operationId: key.operationId, method: args.method, revision: 0, state: "accepted" },
      limits,
      encodeUtf8,
    );
    if (
      !accepted ||
      !insert(
        db,
        { key, canonicalIntent: args.canonicalIntent, record: accepted },
        args.relayInstanceId,
        args.at,
      )
    )
      throw busy;
    const succeeded = checkedReceiptRecord(
      key,
      { ...accepted, revision: 1, state: "succeeded", result: applied.result },
      limits,
      encodeUtf8,
    );
    if (!succeeded || !replace(db, key, 0, succeeded, args.at)) throw busy;
    return { operation: succeeded };
  },
};
