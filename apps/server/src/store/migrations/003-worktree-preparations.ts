// Migration 003: what a managed worktree mount was asked for, and which operation prepares it
// (M1 T3b; domain/worktrees.ts).
//
// worktree_preparations has one row per worktree mount. The spec_* columns hold the request as the
// operator made it (MountSpec: a branch of NULL means the default `cove/<slug>`, a base of NULL
// means the main branch resolved from the remote, D1), so `mount retry` without overrides repeats
// the original request. The operation_* columns name the operation preparing the mount now, or
// the one that prepared it last: task.create or mount.add first, mount.retry afterwards. base_ref
// and no_fetch are that attempt's options (a retry may override them for its attempt only), and
// position orders the mounts of one operation, which prepares them one after another.
//
// The row is the durable intent recorded before any Git side effect: startup verification and
// operation continue/abandon read it to know which mounts an unfinished operation owns and how to
// finish them. The managed_worktrees row (migration 001) follows once the base commit is known.
// A mount removed later takes its row with it (ON DELETE CASCADE); a mount whose preparation has
// not ended cannot be removed (store/sql/workspaces.ts).
export const MIGRATION_003 = `
CREATE TABLE worktree_preparations (
  mount_id TEXT PRIMARY KEY REFERENCES mounts (mount_id) ON DELETE CASCADE,
  spec_branch TEXT,
  spec_base_ref TEXT,
  spec_no_fetch INTEGER NOT NULL CHECK (spec_no_fetch IN (0, 1)),
  operation_server_id TEXT NOT NULL,
  operation_principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  base_ref TEXT,
  no_fetch INTEGER NOT NULL CHECK (no_fetch IN (0, 1))
) STRICT;
CREATE INDEX worktree_preparations_by_operation
  ON worktree_preparations (operation_server_id, operation_principal_id, operation_id, position);
CREATE INDEX managed_worktrees_by_mount ON managed_worktrees (mount_id);
`;
