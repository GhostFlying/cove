import {
  domainError,
  DomainErrorSchema,
  type DomainError,
  type DomainErrorKind,
} from "@cove/protocol/errors";
import {
  M1_LIMITS,
  type MountRecord,
  type MountSource,
  type TaskRecord,
} from "@cove/protocol/workspace";
import type { OperationResultData } from "../../operations/receipt-records.js";
import { taskRecordFits } from "../../domain/record-bounds.js";
import { MANIFEST_NAME } from "../../workspace-fs/manifest.js";
import { statement, type Connection } from "./statements.js";

// Tasks, their single workspace and its mounts (docs/milestones/m1.md T3a; the domain rules are in
// domain/workspaces.ts). Reads are named store operations; the writes run inside receipts.write
// (store/sql/receipts.ts), in the transaction that rechecks and commits the operation receipt,
// so every precondition below (duplicate names, expected revisions, the managed-worktree
// refusal, an archived task, a record too large to read) is checked against the current rows.
//
// Revisions: tasks.revision grows on rename, archive and unarchive; workspaces.revision grows on
// every change of its mounts (add, remove). The entry
// directory and the manifest follow workspaces.revision (materialized_revision, migration 002).

type TaskRow = {
  task_id: string;
  revision: number;
  title: string;
  slug: string;
  archived: number;
  created_at_ms: number;
  workspace_id: string;
  workspace_revision: number;
  entry_path: string;
  materialized_revision: number | null;
};

type MountRow = {
  mount_id: string;
  name: string;
  source: MountSource;
  repo_id: string;
  path: string;
  entry_path: string | null;
  state: MountRecord["state"];
  branch: string | null;
  base_commit: string | null;
  error_json: string | null;
};

const TASK_SELECT = `SELECT t.task_id, t.revision, t.title, t.slug, t.archived, t.created_at_ms,
    w.workspace_id, w.revision AS workspace_revision, w.entry_path, w.materialized_revision
  FROM tasks t JOIN workspaces w ON w.task_id = t.task_id`;

const MOUNT_COLUMNS =
  "mount_id, name, source, repo_id, path, entry_path, state, branch, base_commit, error_json";

// A task as the database records it. The domain verifies the filesystem before it answers: the
// entry state, and whether each ready checkout is still the admitted binding, for which
// `checkouts` gives, per checkout mount, the current registration's Git common directory (null
// when it is gone) and whether its path is now recorded as a managed worktree.
export type StoredTask = {
  record: TaskRecord;
  workspaceId: string;
  materializedRevision: number | null;
  checkouts: Record<string, { commonDir: string | null; managed: boolean }>;
};

function storedError(json: string | null): DomainError | undefined {
  if (json === null) return undefined;
  const parsed = DomainErrorSchema.safeParse(JSON.parse(json));
  // A stored error that no longer parses is corruption; it must not vanish from the record.
  if (!parsed.success) throw new Error("Stored mount error is invalid");
  return parsed.data;
}

// Other tasks that mount the same checkout (D4: shown, never locked), archived ones included:
// archiving changes visibility only, so an archived task keeps its mount and may still have runs
// using the checkout. The relationship ends when that mount is removed.
function sharedWith(db: Connection, taskId: string, path: string): string[] {
  return (
    statement(
      db,
      `SELECT DISTINCT w.task_id FROM mounts m
         JOIN workspaces w ON w.workspace_id = m.workspace_id
       WHERE m.source = 'checkout' AND m.path = ? AND w.task_id <> ?
       ORDER BY w.task_id LIMIT ?`,
    ).all(path, taskId, M1_LIMITS.sharedTasks) as { task_id: string }[]
  ).map((row) => row.task_id);
}

function mountRows(db: Connection, workspaceId: string): MountRow[] {
  return statement(
    db,
    `SELECT ${MOUNT_COLUMNS} FROM mounts WHERE workspace_id = ? ORDER BY created_at_ms, rowid`,
  ).all(workspaceId) as MountRow[];
}

function toTask(db: Connection, row: TaskRow): StoredTask {
  const rows = mountRows(db, row.workspace_id);
  const checkouts: StoredTask["checkouts"] = {};
  for (const mount of rows)
    if (mount.source === "checkout")
      checkouts[mount.mount_id] = {
        commonDir:
          (
            statement(db, "SELECT common_dir FROM repos WHERE repo_id = ?").get(mount.repo_id) as
              { common_dir: string } | undefined
          )?.common_dir ?? null,
        managed: managedWorktree(db, mount.path),
      };
  const mounts = rows.map((mount): MountRecord => {
    const error = storedError(mount.error_json);
    return {
      mountId: mount.mount_id,
      name: mount.name,
      source: mount.source,
      repoId: mount.repo_id,
      path: mount.path,
      entryPath: mount.entry_path,
      state: mount.state,
      branch: mount.branch,
      baseCommit: mount.base_commit,
      sharedWithTaskIds: mount.source === "checkout" ? sharedWith(db, row.task_id, mount.path) : [],
      ...(error ? { error } : {}),
    };
  });
  return {
    record: {
      taskId: row.task_id,
      revision: row.revision,
      title: row.title,
      slug: row.slug,
      archived: row.archived === 1,
      createdAtMs: row.created_at_ms,
      workspace: {
        workspaceId: row.workspace_id,
        revision: row.workspace_revision,
        entryPath: row.entry_path,
        // Decided by the domain from materializedRevision and the filesystem.
        entryState: "pending",
        mounts,
      },
    },
    workspaceId: row.workspace_id,
    materializedRevision: row.materialized_revision,
    checkouts,
  };
}

function taskRow(db: Connection, taskId: string): TaskRow | undefined {
  return statement(db, `${TASK_SELECT} WHERE t.task_id = ?`).get(taskId) as TaskRow | undefined;
}

// What the entry's manifest is written from (domain/workspaces.ts).
export type ManifestSource = {
  taskId: string;
  workspaceId: string;
  revision: number;
  materializedRevision: number | null;
  // The latest revision whose publication of an absent entry was attempted (migration 002).
  attemptedRevision: number | null;
  entryPath: string;
  mounts: { name: string; path: string; source: MountSource; state: MountRecord["state"] }[];
};

// A checkout mount the domain resolved before the write: `path` is the real top level of the
// working tree the admission check found and `commonDir` the Git common directory it shares with
// the registered clone. Worktree mounts are refused before the write until T3b.
export type NewMount = {
  mountId: string;
  name: string;
  source: "checkout";
  repoId: string;
  path: string;
  commonDir: string;
};

// `responseBytes` is the read response budget every record of the workspace must fit
// (domain/record-bounds.ts).
export type TaskCreateArgs = {
  taskId: string;
  workspaceId: string;
  title: string;
  slug: string;
  entryPath: string;
  mounts: NewMount[];
  responseBytes: number;
  at: number;
};

export type MountAddArgs = {
  taskId: string;
  expectedWorkspaceRevision?: number;
  mount: NewMount;
  responseBytes: number;
  at: number;
};

export type MountRemoveArgs = {
  taskId: string;
  mountId: string;
  expectedWorkspaceRevision?: number;
  at: number;
};

export type TaskRenameArgs = { taskId: string; expectedRevision?: number; title: string };
export type TaskArchiveArgs = { taskId: string; expectedRevision?: number; archived: boolean };

const refuse = (kind: DomainErrorKind): { error: DomainError } => ({ error: domainError(kind) });

type Applied = { result: OperationResultData } | { error: DomainError };

// Whether `path` is recorded as a Cove-managed worktree, in any state and for any task, archived
// ones included (D2). The table keeps every worktree Cove created (T3b), also after its task was
// archived or the worktree deleted, so such a path is never mounted as a checkout.
function managedWorktree(db: Connection, path: string): boolean {
  return statement(db, "SELECT 1 FROM managed_worktrees WHERE path = ?").get(path) !== undefined;
}

// Checks one new checkout mount against the current rows of its workspace and inserts it, ready,
// with its first binding at `revision`.
function insertMount(
  db: Connection,
  workspaceId: string,
  revision: number,
  mount: NewMount,
  at: number,
): { error: DomainError } | null {
  const repo = statement(db, "SELECT common_dir FROM repos WHERE repo_id = ?").get(mount.repoId) as
    { common_dir: string } | undefined;
  if (!repo) return refuse("REPO_NOT_FOUND");
  // The admission check found this common directory before the transaction; the registration
  // must still name the same clone.
  if (mount.commonDir !== repo.common_dir) return refuse("REPO_NOT_FOUND");
  if (managedWorktree(db, mount.path)) return refuse("MANAGED_WORKTREE_NOT_MOUNTABLE");
  // A mount cannot take the manifest's name, so a managed worktree `<entry>/<name>` (T3b) never
  // collides with it.
  if (mount.name === MANIFEST_NAME) return refuse("MOUNT_NAME_CONFLICT");
  const taken = statement(db, "SELECT 1 FROM mounts WHERE workspace_id = ? AND name = ?").get(
    workspaceId,
    mount.name,
  );
  if (taken) return refuse("MOUNT_NAME_CONFLICT");
  const count = statement(db, "SELECT COUNT(*) AS n FROM mounts WHERE workspace_id = ?").get(
    workspaceId,
  ) as { n: number };
  if (count.n >= M1_LIMITS.mountsPerWorkspace) return refuse("INVALID_ARGUMENT");
  statement(
    db,
    `INSERT INTO mounts (mount_id, workspace_id, name, source, repo_id, path, entry_path, state,
       branch, base_commit, error_json, created_at_ms)
     VALUES (?, ?, ?, 'checkout', ?, ?, NULL, 'ready', NULL, NULL, NULL, ?)`,
  ).run(mount.mountId, workspaceId, mount.name, mount.repoId, mount.path, at);
  statement(
    db,
    `INSERT INTO bindings (workspace_id, mount_id, workspace_revision, source, path, branch,
       bound_at_ms, unbound_at_ms)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
  ).run(workspaceId, mount.mountId, revision, mount.source, mount.path, at);
  return null;
}

// Whether the task as the transaction is about to commit it can always be read in one response
// (domain/record-bounds.ts). Checked on the rows themselves, so the refusal comes before the
// commit: a workspace whose record a read could not return is never accepted.
function readable(db: Connection, taskId: string, responseBytes: number): boolean {
  const row = taskRow(db, taskId);
  return row !== undefined && taskRecordFits(toTask(db, row).record, responseBytes);
}

function setWorkspaceRevision(db: Connection, workspaceId: string, revision: number): void {
  statement(db, "UPDATE workspaces SET revision = ? WHERE workspace_id = ?").run(
    revision,
    workspaceId,
  );
}

// The task an update applies to, after its expected-revision precondition.
function currentTask(
  db: Connection,
  taskId: string,
  expectedRevision: number | undefined,
): { row: TaskRow } | { error: DomainError } {
  const row = taskRow(db, taskId);
  if (!row) return refuse("TASK_NOT_FOUND");
  if (expectedRevision !== undefined && expectedRevision !== row.revision)
    return refuse("REVISION_CONFLICT");
  if (row.revision === Number.MAX_SAFE_INTEGER) return refuse("COUNTER_EXHAUSTED");
  return { row };
}

// The workspace a mount change applies to, after its expected-revision precondition.
function currentWorkspace(
  db: Connection,
  taskId: string,
  expectedRevision: number | undefined,
): { row: TaskRow } | { error: DomainError } {
  const row = taskRow(db, taskId);
  if (!row) return refuse("TASK_NOT_FOUND");
  if (expectedRevision !== undefined && expectedRevision !== row.workspace_revision)
    return refuse("REVISION_CONFLICT");
  if (row.workspace_revision === Number.MAX_SAFE_INTEGER) return refuse("COUNTER_EXHAUSTED");
  return { row };
}

function outcomeOf(mount: NewMount): NonNullable<OperationResultData["mounts"]>[number] {
  return { mountId: mount.mountId, state: "ready" };
}

export const workspaceOperations = {
  "tasks.get": (db: Connection, args: { taskId: string }): StoredTask | null => {
    const row = taskRow(db, args.taskId);
    return row ? toTask(db, row) : null;
  },

  // Pages in taskId order; `afterTaskId` need not exist any more. One row beyond the page tells
  // the caller whether another page follows.
  "tasks.list": (
    db: Connection,
    args: { afterTaskId: string; limit: number; archived: "exclude" | "include" | "only" },
  ): StoredTask[] => {
    const filter =
      args.archived === "include" ? "" : `AND t.archived = ${args.archived === "only" ? 1 : 0}`;
    return (
      statement(db, `${TASK_SELECT} WHERE t.task_id > ? ${filter} ORDER BY t.task_id LIMIT ?`).all(
        args.afterTaskId,
        args.limit + 1,
      ) as TaskRow[]
    ).map((row) => toTask(db, row));
  },

  // Advisory, before the Git checks: a path recorded as a managed worktree is refused even when
  // its directory is gone (Git could then not tell what it was). The write checks again.
  "workspaces.managedWorktree": (db: Connection, args: { paths: string[] }): boolean =>
    args.paths.some((path) => managedWorktree(db, path)),

  "workspaces.manifestSource": (
    db: Connection,
    args: { workspaceId: string },
  ): ManifestSource | null => {
    const row = statement(
      db,
      `SELECT task_id, workspace_id, revision, entry_path, materialized_revision,
         entry_attempted_revision
       FROM workspaces WHERE workspace_id = ?`,
    ).get(args.workspaceId) as
      | {
          task_id: string;
          workspace_id: string;
          revision: number;
          entry_path: string;
          materialized_revision: number | null;
          entry_attempted_revision: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      revision: row.revision,
      materializedRevision: row.materialized_revision,
      attemptedRevision: row.entry_attempted_revision,
      entryPath: row.entry_path,
      mounts: mountRows(db, row.workspace_id).map((mount) => ({
        name: mount.name,
        path: mount.path,
        source: mount.source,
        state: mount.state,
      })),
    };
  },

  // Records that the entry and manifest were written for `revision`. A compare-and-set: when the
  // workspace changed meanwhile, the newer revision still has to be written (false).
  "workspaces.markMaterialized": (
    db: Connection,
    args: { workspaceId: string; revision: number },
  ): boolean =>
    statement(
      db,
      "UPDATE workspaces SET materialized_revision = ? WHERE workspace_id = ? AND revision = ?",
    ).run(args.revision, args.workspaceId, args.revision).changes === 1,

  // Takes the one publication of an absent entry that `revision` is entitled to (migration 002):
  // true only while `revision` is still the workspace's revision and no publication of it was
  // attempted yet, and then records the attempt, durably and before the entry directory is
  // created. One statement, so two attempts cannot both take it.
  "workspaces.claimPublication": (
    db: Connection,
    args: { workspaceId: string; revision: number },
  ): boolean =>
    statement(
      db,
      `UPDATE workspaces SET entry_attempted_revision = ?
       WHERE workspace_id = ? AND revision = ?
         AND (entry_attempted_revision IS NULL OR entry_attempted_revision < ?)`,
    ).run(args.revision, args.workspaceId, args.revision, args.revision).changes === 1,

  // Gives the publication of `revision` back when it left nothing at the entry path, so a later
  // attempt may publish it.
  "workspaces.releasePublication": (
    db: Connection,
    args: { workspaceId: string; revision: number },
  ): void => {
    statement(
      db,
      `UPDATE workspaces SET entry_attempted_revision = NULL
       WHERE workspace_id = ? AND entry_attempted_revision = ?`,
    ).run(args.workspaceId, args.revision);
  },
};

// Writes applied inside receipts.write (store/sql/receipts.ts).
export const workspaceWrites = {
  // Creates the task, its workspace and its checkout mounts at revision 0.
  "task.create": (db: Connection, args: TaskCreateArgs): Applied => {
    // The entry path holds a random part of the task ID; a collision is refused as BUSY rather
    // than sharing a directory, and a resend (new IDs) succeeds.
    if (statement(db, "SELECT 1 FROM workspaces WHERE entry_path = ?").get(args.entryPath))
      return refuse("BUSY");
    statement(
      db,
      `INSERT INTO tasks (task_id, revision, title, slug, archived, created_at_ms, updated_at_ms)
       VALUES (?, 0, ?, ?, 0, ?, ?)`,
    ).run(args.taskId, args.title, args.slug, args.at, args.at);
    statement(
      db,
      `INSERT INTO workspaces (workspace_id, task_id, revision, entry_path, created_at_ms,
         materialized_revision)
       VALUES (?, ?, 0, ?, ?, NULL)`,
    ).run(args.workspaceId, args.taskId, args.entryPath, args.at);
    for (const mount of args.mounts) {
      const refused = insertMount(db, args.workspaceId, 0, mount, args.at);
      if (refused) return refused;
    }
    if (!readable(db, args.taskId, args.responseBytes)) return refuse("INVALID_ARGUMENT");
    return {
      result: {
        resource: { kind: "task", id: args.taskId, revision: 0 },
        workspaceRevision: 0,
        mounts: args.mounts.map(outcomeOf),
      },
    };
  },

  // Adds one mount; the workspace revision grows by one. Refused on an archived task: archiving
  // takes the task out of use, so its workspace gains nothing until it is unarchived.
  "mount.add": (db: Connection, args: MountAddArgs): Applied => {
    const found = currentWorkspace(db, args.taskId, args.expectedWorkspaceRevision);
    if ("error" in found) return found;
    if (found.row.archived === 1) return refuse("TASK_ARCHIVED");
    const revision = found.row.workspace_revision + 1;
    const refused = insertMount(db, found.row.workspace_id, revision, args.mount, args.at);
    if (refused) return refused;
    setWorkspaceRevision(db, found.row.workspace_id, revision);
    if (!readable(db, args.taskId, args.responseBytes)) return refuse("INVALID_ARGUMENT");
    return {
      result: {
        resource: { kind: "mount", id: args.mount.mountId, revision },
        workspaceRevision: revision,
        mounts: [outcomeOf(args.mount)],
      },
    };
  },

  // Removes one mount from the workspace; the workspace revision grows by one. Nothing on disk is
  // touched: a checkout is never Cove's to delete. Allowed on an archived task, which is how
  // mounts that hold a repo registration (REPO_IN_USE) are dropped without unarchiving.
  "mount.remove": (db: Connection, args: MountRemoveArgs): Applied => {
    const found = currentWorkspace(db, args.taskId, args.expectedWorkspaceRevision);
    if ("error" in found) return found;
    const mount = statement(db, "SELECT 1 FROM mounts WHERE mount_id = ? AND workspace_id = ?").get(
      args.mountId,
      found.row.workspace_id,
    );
    if (!mount) return refuse("MOUNT_NOT_FOUND");
    const revision = found.row.workspace_revision + 1;
    statement(db, "DELETE FROM mounts WHERE mount_id = ?").run(args.mountId);
    statement(
      db,
      `UPDATE bindings SET unbound_at_ms = ?
       WHERE workspace_id = ? AND mount_id = ? AND unbound_at_ms IS NULL`,
    ).run(args.at, found.row.workspace_id, args.mountId);
    setWorkspaceRevision(db, found.row.workspace_id, revision);
    return {
      result: {
        resource: { kind: "mount", id: args.mountId, revision },
        workspaceRevision: revision,
      },
    };
  },

  // Renames the task; its slug and directory never change (D1).
  "task.update": (db: Connection, args: TaskRenameArgs & { at: number }): Applied => {
    const found = currentTask(db, args.taskId, args.expectedRevision);
    if ("error" in found) return found;
    const revision = found.row.revision + 1;
    statement(
      db,
      "UPDATE tasks SET revision = ?, title = ?, updated_at_ms = ? WHERE task_id = ?",
    ).run(revision, args.title, args.at, args.taskId);
    return { result: { resource: { kind: "task", id: args.taskId, revision } } };
  },

  // Archives or unarchives the task. Archiving changes its visibility only (design §6): runs,
  // mounts, the entry directory and managed worktrees stay as they are. Archiving an archived
  // task is refused as TASK_ARCHIVED, unarchiving an active one as INVALID_ARGUMENT, so a stale
  // client learns that its view was wrong instead of getting a silent new revision.
  "task.archive": (db: Connection, args: TaskArchiveArgs & { at: number }): Applied => {
    const found = currentTask(db, args.taskId, args.expectedRevision);
    if ("error" in found) return found;
    if ((found.row.archived === 1) === args.archived)
      return refuse(args.archived ? "TASK_ARCHIVED" : "INVALID_ARGUMENT");
    const revision = found.row.revision + 1;
    statement(
      db,
      "UPDATE tasks SET revision = ?, archived = ?, updated_at_ms = ? WHERE task_id = ?",
    ).run(revision, args.archived ? 1 : 0, args.at, args.taskId);
    return { result: { resource: { kind: "task", id: args.taskId, revision } } };
  },
};
