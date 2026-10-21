// Migration 005: operation receipt retention (m2 D13, #97; relay-protocol §11.3).
//
// A receipt (operations, migration 001) of an operation that ended succeeded, failed or cancelled
// is purged 30 days after it ended (store/sql/receipts.ts receipts.purge). Purging replaces it,
// in one transaction, with a row of operation_tombstones that is never deleted: the operation ID
// stays known for good, so a resend under it is refused with OPERATION_HISTORY_EXPIRED (or
// OPERATION_ID_CONFLICT for another intent) and never executed again. A tombstone that could
// expire too would reopen the ID after its own deadline (D13 option C, not chosen). A tombstone is
// about a hundred bytes and holds no params, result or secret:
// - the receipt key (server, principal, operation);
// - method and the terminal state the operation ended in;
// - intent_digest: hex of the first 16 bytes of SHA-256 over the receipt's canonical intent, so
//   that a resend of the same request (expired) can be told from another request reusing the ID
//   (conflict). Either answer refuses; a digest collision could only pick the other refusal;
// - ended_at_ms: the receipt's updated_at_ms, the wall-clock time of its last change, which for
//   a terminal receipt is when it ended (terminal receipts never change again);
// - purged_at_ms: when it was purged.
//
// operations_tombstoned refuses a receipt for a tombstoned key at the database itself, whichever
// store operation inserts it (receipts.insert, receipts.write, tabs.launch). The receipt lookup
// that precedes every execution already answers a tombstoned key without executing; the trigger
// keeps that true even for a path that would skip it, since every execution inserts its receipt
// before any side effect starts (relay-protocol §11.3 item 5).
//
// operations_by_end serves the purge's scan of terminal receipts by end time.
export const MIGRATION_005 = `
CREATE TABLE operation_tombstones (
  server_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  method TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('succeeded', 'failed', 'cancelled')),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 32),
  ended_at_ms INTEGER NOT NULL,
  purged_at_ms INTEGER NOT NULL,
  PRIMARY KEY (server_id, principal_id, operation_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX operations_by_end ON operations (state, updated_at_ms);
CREATE TRIGGER operations_tombstoned BEFORE INSERT ON operations
WHEN EXISTS (
  SELECT 1 FROM operation_tombstones t
  WHERE t.server_id = NEW.server_id AND t.principal_id = NEW.principal_id
    AND t.operation_id = NEW.operation_id
)
BEGIN
  SELECT RAISE(ABORT, 'operation history expired');
END;
`;
