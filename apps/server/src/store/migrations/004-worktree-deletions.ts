// Migration 004: deletions of managed worktrees (M1 T5, binding.delete; domain/bindings.ts,
// store/sql/bindings.ts).
//
// One row per binding.delete operation, written in the transaction that accepts it, before Git
// removes anything: the worktree it deletes (managed_worktrees.worktree_id), the mount bound to
// it and the mount state before the deletion (prior_state). While the row is pending the mount is
// recorded `pending`, so no tab gets it as its cwd, it is neither removed, retried, converted nor
// deleted a second time, and the manifest shows it in flux. The transaction that ends the
// deletion writes the operation's final receipt with it:
// - deleted: Git no longer has the worktree and its directory is gone; the mount is removed, its
//   binding unbound and the managed worktree recorded `deleted` (the branch is kept, D10);
// - restored: nothing was deleted, or Git refused (a locked worktree, something at the path Git
//   does not know): the mount is back in prior_state and the operation failed.
// A deletion still pending after a restart is requires_attention until an explicit continue runs
// it again from what it observes (the processes it recorded must have ended first).
export const MIGRATION_004 = `
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
  -- No foreign key to operations: the row is written by the write that receipts.write applies
  -- before it inserts the receipt, in the same transaction.
  PRIMARY KEY (operation_server_id, operation_principal_id, operation_id)
) STRICT;
CREATE INDEX worktree_deletions_by_mount ON worktree_deletions (mount_id, outcome);
`;
