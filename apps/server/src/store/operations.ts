import {
  OperationRecordSchema,
  type OperationReceiptKey,
  type OperationRecord,
  type StoredReceipt,
} from "@cove/protocol/rpc";
import type { DurableReceiptBackend } from "../operations/operation-receipts.js";
import type { Store } from "./database.js";

type Row = {
  server_id: string;
  principal_id: string;
  operation_id: string;
  canonical_intent: string;
  record_json: string;
};

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

// The operations table (migration 001) as the durable backend of OperationReceipts. The caller
// (OperationReceipts) validates every record before it reaches this class.
export class SqliteReceiptBackend implements DurableReceiptBackend {
  private readonly statements;
  constructor(
    private readonly store: Store,
    // The relay instance that accepts new receipts in this process.
    private readonly relayInstanceId: string,
    private readonly now: () => number = Date.now,
  ) {
    const db = store.db;
    this.statements = {
      get: db.prepare(
        `SELECT server_id, principal_id, operation_id, canonical_intent, record_json
         FROM operations WHERE server_id = ? AND principal_id = ? AND operation_id = ?`,
      ),
      insert: db.prepare(
        `INSERT INTO operations (server_id, principal_id, operation_id, method, canonical_intent,
           state, revision, record_json, accepted_by_instance_id, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ),
      replace: db.prepare(
        `UPDATE operations SET state = ?, revision = ?, record_json = ?, updated_at_ms = ?
         WHERE server_id = ? AND principal_id = ? AND operation_id = ? AND revision = ?`,
      ),
      unfinished: db.prepare(
        `SELECT server_id, principal_id, operation_id, canonical_intent, record_json
         FROM operations WHERE state IN ('accepted', 'running', 'recovering')
         ORDER BY created_at_ms, operation_id`,
      ),
    };
  }

  get(key: OperationReceiptKey): StoredReceipt | null {
    const row = this.statements.get.get(key.serverId, key.principalId, key.operationId) as
      Row | undefined;
    return row ? receipt(row) : null;
  }

  insert(stored: StoredReceipt): boolean {
    const at = this.now();
    const { key, record } = stored;
    return this.store.transaction(
      () =>
        this.statements.insert.run(
          key.serverId,
          key.principalId,
          key.operationId,
          record.method,
          stored.canonicalIntent,
          record.state,
          record.revision,
          JSON.stringify(record),
          this.relayInstanceId,
          at,
          at,
        ).changes === 1,
    );
  }

  replace(key: OperationReceiptKey, expectedRevision: number, record: OperationRecord): boolean {
    return this.store.transaction(
      () =>
        this.statements.replace.run(
          record.state,
          record.revision,
          JSON.stringify(record),
          this.now(),
          key.serverId,
          key.principalId,
          key.operationId,
          expectedRevision,
        ).changes === 1,
    );
  }

  unfinished(): StoredReceipt[] {
    return (this.statements.unfinished.all() as Row[]).map(receipt);
  }

  atomic<T>(fn: () => T): T {
    return this.store.transaction(fn);
  }
}
