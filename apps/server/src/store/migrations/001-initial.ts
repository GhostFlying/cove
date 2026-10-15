// Migration 001: every M1 table (docs/milestones/m1.md, "数据库 schema"). Later tasks add new
// numbered migrations; this file never changes once merged, because a database records only the
// number of the last migration it applied (PRAGMA user_version).
//
// Conventions:
// - Times are integer milliseconds since the Unix epoch.
// - Resource IDs follow ResourceIdSchema; operation and run IDs follow OpaqueIdSchema.
// - JSON columns hold values already validated against the protocol schemas they name.
// - `revision` columns start at 0 and grow by one on every change of that resource.
export const MIGRATION_001 = `
-- Persistent server identity (relay-protocol §11.3). Exactly one row; serverId never changes.
CREATE TABLE server_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_id TEXT NOT NULL,
  -- The durable local owner principal; operation receipts are keyed by it.
  local_principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('local-owner')),
  created_at_ms INTEGER NOT NULL
) STRICT;

-- Every relay instance that ever owned this database. A run records the instance that started it;
-- an instance without stopped_at_ms ended without an orderly stop (crash, kill -9, power loss).
CREATE TABLE relay_instances (
  relay_instance_id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  stopped_at_ms INTEGER
) STRICT;

-- Server configuration (server-architecture §9). One row; a NULL setting means the default.
-- workspace_root applies to workspaces created afterwards only.
CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  workspace_root TEXT,
  updated_at_ms INTEGER NOT NULL
) STRICT;

-- Registered clones (T2). path is the canonical real top level; common_dir is the real Git common
-- directory, so one clone is registered once however it is spelled. main_branch is Cove's
-- main-branch setting (D1); NULL means resolve it from the remote.
CREATE TABLE repos (
  repo_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  common_dir TEXT NOT NULL UNIQUE,
  main_branch TEXT,
  registered_at_ms INTEGER NOT NULL
) STRICT;

-- Tasks and their single workspace (T3a). The slug is fixed at creation (D1).
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks (task_id),
  -- Grows on every binding change, including conversion to a worktree.
  revision INTEGER NOT NULL,
  -- <workspaceRoot>/<slug>-<short id>, resolved from the workspaceRoot setting at creation.
  entry_path TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
) STRICT;

-- Current mounts of a workspace (T3a, T3b). repo_id has no foreign key: whether a registration
-- may be removed while mounted is a T2/T3a rule, not a storage constraint.
CREATE TABLE mounts (
  mount_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (workspace_id),
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('checkout', 'worktree')),
  repo_id TEXT NOT NULL,
  -- Real directory of the binding: the checkout itself or the managed worktree.
  path TEXT NOT NULL,
  entry_path TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed', 'missing')),
  branch TEXT,
  base_commit TEXT,
  -- DomainError JSON of the last failed preparation.
  error_json TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
) STRICT;
CREATE INDEX mounts_by_path ON mounts (path);

-- Every Git worktree Cove created (T3b), kept after its task is archived and after deletion, so
-- the checkout admission check (T3a, D2: MANAGED_WORKTREE_NOT_MOUNTABLE) can refuse any path Cove
-- manages. The intent is recorded before any Git side effect (relay-protocol §11.4): target path,
-- repo, branch, base commit and the owning operation are the ownership evidence a restart checks.
CREATE TABLE managed_worktrees (
  worktree_id TEXT PRIMARY KEY,
  -- Real path of the worktree directory.
  path TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL,
  -- Real Git common directory of the source clone.
  common_dir TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (workspace_id),
  -- Mount currently bound to it; NULL once the mount was removed or converted away.
  mount_id TEXT REFERENCES mounts (mount_id) ON DELETE SET NULL,
  -- Key of the operation that created it (operations table).
  operation_server_id TEXT NOT NULL,
  operation_principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  -- intent: recorded, Git steps may be partly done; ready: checked out and recorded complete;
  -- abandoned: operation.abandon removed exactly the recorded artifacts; deleted: removed by
  -- binding.delete (the branch is kept, D10).
  state TEXT NOT NULL CHECK (state IN ('intent', 'ready', 'abandoned', 'deleted')),
  -- Progress tokens (OperationProgressSchema) of the Git steps observed complete.
  completed_steps_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX managed_worktrees_by_task ON managed_worktrees (task_id);

-- Binding history of a mount (T5): one row per binding; the current one has unbound_at_ms NULL.
CREATE TABLE bindings (
  binding_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces (workspace_id),
  mount_id TEXT NOT NULL,
  workspace_revision INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('checkout', 'worktree')),
  path TEXT NOT NULL,
  branch TEXT,
  bound_at_ms INTEGER NOT NULL,
  unbound_at_ms INTEGER
) STRICT;
CREATE INDEX bindings_by_mount ON bindings (workspace_id, mount_id, binding_seq);

-- Logical terminals of a task (T4, D8). recipe_json is TabRecipeSchema, cwd_json TabCwdSchema.
CREATE TABLE tabs (
  tab_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  recipe_json TEXT NOT NULL,
  cwd_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  -- runs.run_seq of the latest run, alive or not.
  latest_run_seq INTEGER REFERENCES runs (run_seq)
) STRICT;
CREATE INDEX tabs_by_task ON tabs (task_id, tab_id);

-- One PTY run (D8, D9), whether started by a tab or by terminal.create (tab_id NULL). A run ID is
-- unique only within its relay instance, so the instance is part of the identity; run_seq orders
-- history newest-first. The workspace revision, cwd and mount mapping are snapshots taken at start
-- and never rewritten by later binding changes.
CREATE TABLE runs (
  run_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  relay_instance_id TEXT NOT NULL REFERENCES relay_instances (relay_instance_id),
  run_id TEXT NOT NULL,
  tab_id TEXT REFERENCES tabs (tab_id) ON DELETE SET NULL,
  task_id TEXT,
  workspace_revision INTEGER,
  cwd TEXT NOT NULL,
  -- Array of {name, source, path} (RunHistoryRecordSchema.mounts).
  mounts_json TEXT NOT NULL,
  -- The operation that started the run.
  operation_id TEXT,
  lifecycle TEXT NOT NULL
    CHECK (lifecycle IN ('starting', 'running', 'exited', 'stopped-with-server', 'interrupted')),
  verification TEXT NOT NULL CHECK (verification IN ('live', 'unverifiable', 'final')),
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  last_observed_at_ms INTEGER,
  exit_code INTEGER,
  signal TEXT,
  UNIQUE (relay_instance_id, run_id)
) STRICT;
CREATE INDEX runs_by_tab ON runs (tab_id, run_seq);
CREATE INDEX runs_by_lifecycle ON runs (lifecycle);

-- Durable operation receipts (relay-protocol §11.3): the key is (server, principal, operation),
-- never the relay instance. canonical_intent is the fingerprint compared on a resend; record_json
-- is the OperationRecordSchema value returned to clients. state and revision duplicate the record
-- so that startup verification and guarded updates need no JSON parsing.
CREATE TABLE operations (
  server_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  method TEXT NOT NULL,
  canonical_intent TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'accepted', 'running', 'recovering', 'requires_attention', 'succeeded', 'failed', 'cancelled'
    )
  ),
  revision INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  -- The relay instance that accepted the operation.
  accepted_by_instance_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (server_id, principal_id, operation_id)
) STRICT;
CREATE INDEX operations_by_state ON operations (state);

-- Subprocesses an operation started that may outlive the server (T3b: each Git command runs in a
-- process group of its own). A restarted server refuses operation.continue/abandon while a recorded
-- process may still run (S8), so the record identifies the exact process, not a reusable PID:
-- start_identity is the operating system's start identity of pid (boot plus start time, see
-- store/processes.ts). Recorded before the server waits for the process; ended_at_ms is set once it
-- was observed to have ended.
CREATE TABLE operation_processes (
  process_id TEXT PRIMARY KEY,
  operation_server_id TEXT NOT NULL,
  operation_principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  pid INTEGER NOT NULL CHECK (pid > 0),
  -- Process group the command leads; it may hold children after the leader ended.
  pgid INTEGER NOT NULL CHECK (pgid > 0),
  start_identity TEXT NOT NULL,
  started_by_instance_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  UNIQUE (pid, start_identity),
  FOREIGN KEY (operation_server_id, operation_principal_id, operation_id)
    REFERENCES operations (server_id, principal_id, operation_id)
) STRICT;
CREATE INDEX operation_processes_by_operation
  ON operation_processes (operation_server_id, operation_principal_id, operation_id);
`;
