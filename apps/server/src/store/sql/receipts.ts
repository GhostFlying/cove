import { domainError, type DomainError } from "@cove/protocol/errors";
import {
  OperationRecordSchema,
  holdsSecret,
  type OperationReceiptKey,
  type OperationRecord,
  type StoredReceipt,
} from "@cove/protocol/rpc";
import {
  checkedReceiptRecord,
  intentDigest,
  type DatabaseWriteResult,
  type DatabaseWriteRequest,
  type OperationResultData,
  type PurgeArgs,
  type PurgeBatch,
  type ReceiptLimits,
  type ReceiptTombstone,
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

type TombstoneRow = {
  server_id: string;
  principal_id: string;
  operation_id: string;
  method: string;
  state: ReceiptTombstone["state"];
  intent_digest: string;
  ended_at_ms: number;
};

// The tombstone a purged receipt left under `key` (migration 005), or null.
function tombstone(db: Connection, key: OperationReceiptKey): ReceiptTombstone | null {
  const row = statement(
    db,
    `SELECT server_id, principal_id, operation_id, method, state, intent_digest, ended_at_ms
     FROM operation_tombstones WHERE server_id = ? AND principal_id = ? AND operation_id = ?`,
  ).get(key.serverId, key.principalId, key.operationId) as TombstoneRow | undefined;
  if (!row) return null;
  return {
    expired: true,
    key: { serverId: row.server_id, principalId: row.principal_id, operationId: row.operation_id },
    method: row.method,
    state: row.state,
    intentDigest: row.intent_digest,
    endedAtMs: row.ended_at_ms,
  };
}

// The answer to a request under a tombstoned key: the same request is OPERATION_HISTORY_EXPIRED,
// another one reusing the ID is OPERATION_ID_CONFLICT (relay-protocol §11.3). Neither executes.
function tombstoneRefusal(gone: ReceiptTombstone, canonicalIntent: string): DomainError {
  return domainError(
    gone.intentDigest === intentDigest(canonicalIntent)
      ? "OPERATION_HISTORY_EXPIRED"
      : "OPERATION_ID_CONFLICT",
  );
}

type PurgeRow = {
  server_id: string;
  principal_id: string;
  operation_id: string;
  method: string;
  state: ReceiptTombstone["state"];
  canonical_intent: string;
  updated_at_ms: number;
};

// See receipts.purge.
function purge(db: Connection, args: PurgeArgs): PurgeBatch {
  if (
    !Number.isSafeInteger(args.now) ||
    !Number.isSafeInteger(args.retentionMs) ||
    args.retentionMs <= 0 ||
    !Number.isSafeInteger(args.limit) ||
    args.limit <= 0 ||
    !Number.isSafeInteger(args.highestRun) ||
    args.highestRun < 0
  )
    throw new Error("Invalid receipt purge arguments");
  // Due: ended succeeded, failed or cancelled at least retentionMs ago by the wall clock
  // (updated_at_ms is when a terminal receipt ended: it never changes again). A clock that went
  // back only makes receipts look younger, so it delays a purge and never brings one forward; a
  // receipt that ended "in the future" of the current clock waits until the clock passes its end
  // plus the retention. A clock set forward does purge early: the full record is gone sooner, but
  // its tombstone still refuses the ID, so nothing is ever executed twice.
  //
  // Never purged while live state still consults the receipt row itself; each of these readers
  // would misread a missing row (a purged receipt is not "ended" to them, only absent):
  // - the current attempt of a worktree mount (worktree_preparations) naming it as its operation
  //   or as the abandon that claimed it: store/sql/worktrees.ts attemptOperationOpen reads that
  //   receipt's state and takes a missing one for an operation that has not ended, which would
  //   block the mount's removal and retries for good. The receipt becomes due once the mount is
  //   removed (its preparation goes with it) or a retry makes another attempt current. Earlier
  //   attempts are read for their ledgers and processes, never for their receipt's state;
  // - a recorded process of the operation that was never observed to have ended (operation
  //   continue/abandon and restart verification rely on that attribution, and its foreign key
  //   needs the receipt);
  // - a receipt naming a run run-N with N >= highestRun. runs.highestNumber, the mark a new
  //   instance continues after, is the maximum over the run rows and the receipts naming a run;
  //   a receipt may be the only holder of that maximum (a run that never started leaves no run
  //   row), and purging it would let the number be handed out again after a restart. The mark
  //   only grows (a launch's receipt names its run before the run row exists and outlives it), so
  //   with highestRun read before the pass, the current maximum is at least highestRun and every
  //   receipt that may hold it is kept; receipts of later runs are young anyway. Reading the mark
  //   once per pass keeps its full scan out of every batch.
  // These conditions are part of the statement that picks the batch, inside the batch's
  // transaction, so a receipt is never tombstoned while one of them holds.
  const rows = statement(
    db,
    `SELECT o.server_id, o.principal_id, o.operation_id, o.method, o.state, o.canonical_intent,
       o.updated_at_ms
     FROM operations o
     WHERE o.state IN ('succeeded', 'failed', 'cancelled') AND o.updated_at_ms <= ?
       AND NOT EXISTS (
         SELECT 1 FROM worktree_attempts a
           JOIN worktree_preparations p ON p.attempt_id = a.attempt_id
         WHERE a.operation_server_id = o.server_id AND a.operation_principal_id = o.principal_id
           AND a.operation_id = o.operation_id)
       AND NOT EXISTS (
         SELECT 1 FROM worktree_attempts a
           JOIN worktree_preparations p ON p.attempt_id = a.attempt_id
         WHERE a.abandon_server_id = o.server_id AND a.abandon_principal_id = o.principal_id
           AND a.abandon_operation_id = o.operation_id)
       AND NOT EXISTS (
         SELECT 1 FROM operation_processes p
         WHERE p.operation_server_id = o.server_id AND p.operation_principal_id = o.principal_id
           AND p.operation_id = o.operation_id AND p.ended_at_ms IS NULL)
       AND NOT coalesce(
         json_extract(o.record_json, '$.run.runId') GLOB 'run-[1-9]*'
           AND json_extract(o.record_json, '$.run.runId') NOT GLOB 'run-*[^0-9]*'
           AND CAST(substr(json_extract(o.record_json, '$.run.runId'), 5) AS INTEGER) >= ?,
         0)
     ORDER BY o.updated_at_ms, o.server_id, o.principal_id, o.operation_id
     LIMIT ?`,
  ).all(args.now - args.retentionMs, args.highestRun, args.limit) as PurgeRow[];
  for (const row of rows) {
    // The tombstone, then the receipt, in this one transaction: a crash at any point of the batch
    // leaves each of its receipts either whole or replaced by its tombstone, never neither. A
    // tombstone already present is kept as it is; tombstones are never rewritten or deleted.
    statement(
      db,
      `INSERT INTO operation_tombstones (server_id, principal_id, operation_id, method, state,
         intent_digest, ended_at_ms, purged_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).run(
      row.server_id,
      row.principal_id,
      row.operation_id,
      row.method,
      row.state,
      intentDigest(row.canonical_intent),
      row.updated_at_ms,
      args.now,
    );
    // Only ended process attributions are left here: an unended one kept the receipt out.
    statement(
      db,
      `DELETE FROM operation_processes
       WHERE operation_server_id = ? AND operation_principal_id = ? AND operation_id = ?`,
    ).run(row.server_id, row.principal_id, row.operation_id);
    const removed = statement(
      db,
      `DELETE FROM operations
       WHERE server_id = ? AND principal_id = ? AND operation_id = ? AND state = ?`,
    ).run(row.server_id, row.principal_id, row.operation_id, row.state).changes;
    if (removed !== 1) throw new Error("Receipt purge lost its row");
  }
  return { purged: rows.length, more: rows.length === args.limit };
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
  // The receipt of a key, the tombstone its purge left (m2 D13), or null when the key was never
  // used. Both tables are read in this one transaction, so a purge can never make a used key look
  // unused to a caller.
  "receipts.get": (
    db: Connection,
    args: { key: OperationReceiptKey },
  ): StoredReceipt | ReceiptTombstone | null => get(db, args.key) ?? tombstone(db, args.key),

  // One bounded batch of receipt retention (m2 D13, #97) in one transaction: at most `limit`
  // receipts due at `now` (the main thread's wall clock) are replaced by their tombstones; purge
  // above says which receipts are due and which are kept. A batch holds the connection briefly;
  // the caller (OperationReceipts.purgeExpired) runs batches one after another while `more`, and
  // other store calls are served in between. A crash or a lost answer is harmless: the batch
  // committed whole or not at all, and the next pass purges whatever is still due.
  "receipts.purge": (db: Connection, args: PurgeArgs): PurgeBatch => purge(db, args),

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
  // running for startup verification, except a write whose result says `running` (see below).
  "receipts.write": (
    db: Connection,
    args: DatabaseWriteRequest & { relayInstanceId: string; at: number; limits: ReceiptLimits },
  ): DatabaseWriteResult => {
    const { key, limits } = args;
    if (key.serverId !== limits.serverId) return { error: domainError("INVALID_ARGUMENT") };
    const existing = get(db, key);
    if (existing)
      return existing.canonicalIntent === args.canonicalIntent
        ? { operation: existing.record }
        : { error: domainError("OPERATION_ID_CONFLICT") };
    // A purged key (m2 D13) stays used for good. The caller's lookup already refuses it; this
    // keeps the transaction itself from executing under it.
    const gone = tombstone(db, key);
    if (gone) return { error: tombstoneRefusal(gone, args.canonicalIntent) };
    if (!Object.hasOwn(DATABASE_WRITES, args.apply.name)) throw new Error("Unknown database write");
    const write = DATABASE_WRITES[args.apply.name] as (
      db: Connection,
      args: unknown,
    ) => { result: OperationResultData; running?: true } | { error: DomainError };
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
    // A write that only starts its work (managed worktree creation, T3b: the transaction records
    // the intent and the Git steps follow outside it) is committed as running instead. Its
    // executor, or after a restart its startup verifier (operations/recovery-verifiers.ts), brings
    // it to its outcome; nothing else ever reports it as succeeded.
    const succeeded = checkedReceiptRecord(
      key,
      {
        ...accepted,
        revision: 1,
        state: applied.running ? "running" : "succeeded",
        result: applied.result,
      },
      limits,
      encodeUtf8,
    );
    if (!succeeded) throw busy;
    // The durable secret boundary (m2 "秘密与操作记录的分界"): checked on the record about to be
    // stored, inside the transaction, so a record holding a secret rolls back together with the
    // change and leaves no receipt to be read or replayed later.
    if (holdsSecret(succeeded, args.secrets ?? [])) throw new Rollback({ secretRefused: true });
    if (!replace(db, key, 0, succeeded, args.at)) throw busy;
    return { operation: succeeded, committed: true };
  },
};
