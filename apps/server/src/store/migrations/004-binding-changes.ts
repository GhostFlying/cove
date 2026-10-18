// Migration 004: binding changes and deletions of managed worktrees (M1 T5; domain/bindings.ts,
// store/sql/bindings.ts).
//
// binding_conversions has one row per binding.convert, written in the transaction that accepts
// it: the attempt (migration 003) that prepares the target worktree, the checkout mount it will
// replace and that checkout's path, and the request as made (spec_*, as in worktree_preparations).
// The mount keeps its checkout binding while the row is pending (design §3: prepare, verify, then
// switch): the attempt has no worktree_preparations row, so settling it never touches the mount,
// and only the transaction that switches the binding once the target is verified ends the row
// `switched`. A failed or abandoned preparation ends it `failed` with the checkout still bound.
// While it is pending the mount is neither removed nor converted again.
//
// worktree_deletions has one row per binding.delete operation, written in the transaction that
// accepts it, before Git removes anything: the worktree it deletes (managed_worktrees.worktree_id),
// the mount bound to it and the mount state before the deletion (prior_state). While the row is
// pending the mount is recorded `pending`, so no tab gets it as its cwd, it is neither removed,
// retried, converted nor deleted a second time, and the manifest shows it in flux; no run is
// accepted whose cwd or mount mapping uses the worktree's path (store/sql/deletions.ts). The
// transaction that ends the deletion writes the operation's final receipt with it:
// - deleted: Git no longer has the worktree and its directory is gone; the mount is removed, its
//   binding unbound and the managed worktree recorded `deleted` (the branch is kept, D10);
// - restored: nothing was deleted, or Git refused (a locked worktree, something at the path Git
//   does not know): the mount is back in prior_state and the operation failed.
// A deletion still pending after a restart is requires_attention until an explicit continue runs
// it again from what it observes (the processes it recorded must have ended first).
//
// Neither table has a foreign key to operations: their rows are written by the write that
// receipts.write applies before it inserts the receipt, in the same transaction.
export const MIGRATION_004 = `
CREATE TABLE binding_conversions (
  attempt_id TEXT PRIMARY KEY REFERENCES worktree_attempts (attempt_id),
  mount_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  spec_branch TEXT,
  spec_base_ref TEXT,
  spec_no_fetch INTEGER NOT NULL CHECK (spec_no_fetch IN (0, 1)),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'switched', 'failed')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX binding_conversions_by_mount ON binding_conversions (mount_id, outcome);
CREATE TABLE worktree_deletions (
  operation_server_id TEXT NOT NULL,
  operation_principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  mount_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  prior_state TEXT NOT NULL CHECK (prior_state IN ('ready', 'failed', 'missing')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'deleted', 'restored')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (operation_server_id, operation_principal_id, operation_id)
) STRICT;
CREATE INDEX worktree_deletions_by_mount ON worktree_deletions (mount_id, outcome);
CREATE INDEX worktree_deletions_by_outcome ON worktree_deletions (outcome);
`;
