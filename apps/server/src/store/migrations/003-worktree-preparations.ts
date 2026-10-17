// Migration 003: what a managed worktree mount was asked for, and every attempt at preparing it
// (M1 T3b; domain/worktrees.ts, store/sql/worktrees.ts).
//
// worktree_preparations has one row per worktree mount. The spec_* columns hold the request as the
// operator made it (MountSpec: a branch of NULL means the default `cove/<slug>`, a base of NULL
// means the main branch resolved from the remote, D1), so `mount retry` without overrides repeats
// the original request. attempt_id names the mount's current attempt. A mount removed later takes
// its row with it (ON DELETE CASCADE); a mount whose current attempt belongs to an operation that
// has not ended cannot be removed (store/sql/workspaces.ts).
//
// worktree_attempts has one row per attempt: the first by task.create or mount.add, one more per
// mount.retry. An attempt is the durable record of everything Cove did for it, written before and
// after each effect, and it is never deleted, not even with its mount (there is deliberately no
// foreign key to mounts): its operation's outcome is computed from its attempts, so removing a
// mount can never change or lose an outcome that was recorded.
// - operation_* and position: the operation the attempt belongs to, which prepares its attempts
//   one after another in this order.
// - branch, base_ref, no_fetch: this attempt's options (a retry may override the spec's).
// - phase: how far the preparation got before the Git steps: planned, fetched (the fetch ended
//   with status 0, or none was asked for), resolved (base_commit holds the resolved base) and
//   intent (worktree_id names the managed_worktrees row of the intent). A continue resumes from
//   the recorded phase and never repeats a fetch or a base resolution that completed.
// - entry_identity: the device and inode of the workspace entry when the attempt first verified
//   it; any later difference stops the attempt as requires_attention.
// - steps_json: every Git or filesystem effect, appended before it starts (`started`) and
//   updated with what was observed of it (see StepEntry in store/sql/worktrees.ts).
// - outcome and error_json: pending until the attempt settles, then ready or failed for good.
// - abandon_*: the operation.abandon that claimed the attempt; set once, in the transaction that
//   accepts that abandon, and from then on only that operation acts on the attempt.
export const MIGRATION_003 = `
CREATE TABLE worktree_attempts (
  attempt_id TEXT PRIMARY KEY,
  operation_server_id TEXT NOT NULL,
  operation_principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  mount_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_ref TEXT,
  no_fetch INTEGER NOT NULL CHECK (no_fetch IN (0, 1)),
  phase TEXT NOT NULL CHECK (phase IN ('planned', 'fetched', 'resolved', 'intent')),
  entry_identity TEXT,
  base_commit TEXT,
  worktree_id TEXT,
  steps_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'ready', 'failed')),
  error_json TEXT,
  abandon_server_id TEXT,
  abandon_principal_id TEXT,
  abandon_operation_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX worktree_attempts_by_operation
  ON worktree_attempts (operation_server_id, operation_principal_id, operation_id, position);
CREATE INDEX worktree_attempts_by_abandon
  ON worktree_attempts (abandon_server_id, abandon_principal_id, abandon_operation_id);
CREATE TABLE worktree_preparations (
  mount_id TEXT PRIMARY KEY REFERENCES mounts (mount_id) ON DELETE CASCADE,
  spec_branch TEXT,
  spec_base_ref TEXT,
  spec_no_fetch INTEGER NOT NULL CHECK (spec_no_fetch IN (0, 1)),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES worktree_attempts (attempt_id)
) STRICT;
CREATE INDEX managed_worktrees_by_mount ON managed_worktrees (mount_id);
`;
