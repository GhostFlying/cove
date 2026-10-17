import {
  domainError,
  DomainErrorSchema,
  type DomainError,
  type DomainErrorKind,
} from "@cove/protocol/errors";
import {
  OperationRecordSchema,
  type OperationReceiptKey,
  type OperationRecord,
} from "@cove/protocol/rpc";
import type { MountRecord } from "@cove/protocol/workspace";
import {
  checkedReceiptRecord,
  type OperationResultData,
  type ReceiptLimits,
} from "../../operations/receipt-records.js";
import { statement, type Connection } from "./statements.js";

// Managed worktree preparation (docs/milestones/m1.md T3b; the rules are in domain/worktrees.ts).
// Three tables are involved:
// - mounts: a worktree mount is `pending` while an operation prepares it, then `ready` or `failed`;
// - worktree_preparations (migration 003): what the mount was asked for and which operation
//   prepares it now;
// - managed_worktrees (migration 001): the intent of the Git steps (path, branch, base commit and
//   the owning operation), recorded before the first step, and kept for good once recorded: the
//   checkout admission check refuses every path in it (D2).
// Every change of a mount's state advances the workspace revision, so the entry's manifest
// (which lists the state) follows a new revision.

const encoder = new TextEncoder();
const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

export type ManagedState = "intent" | "ready" | "abandoned" | "deleted";

// A managed_worktrees row.
export type ManagedWorktree = {
  worktreeId: string;
  path: string;
  branch: string;
  baseCommit: string;
  commonDir: string;
  state: ManagedState;
  mountId: string | null;
  operation: OperationReceiptKey;
  completedSteps: string[];
};

// One worktree mount an operation prepares, with everything the executor and the verifier need.
// A mount state as recorded; "unavailable" is only ever a read's verdict.
type StoredMountState = Exclude<MountRecord["state"], "unavailable">;

export type Preparation = {
  mountId: string;
  name: string;
  mountState: StoredMountState;
  // The kind of the mount's recorded error (a failed mount's).
  errorKind: DomainErrorKind | null;
  branch: string;
  path: string;
  taskId: string;
  workspaceId: string;
  position: number;
  baseRef: string | null;
  noFetch: boolean;
  // The registration as it is now; null when it is gone.
  repo: { repoId: string; path: string; commonDir: string; mainBranch: string | null } | null;
  // The managed_worktrees row at the mount's path, whoever recorded it.
  managed: ManagedWorktree | null;
};

// A path a previous attempt left recorded may be taken by a new intent only when nothing of that
// attempt is there any more: it was abandoned (only exactly its own artifacts were removed, and
// none were left) or deleted (T5). An intent or a ready worktree holds its path.
export const REUSABLE_MANAGED_STATES: ReadonlySet<ManagedState> = new Set(["abandoned", "deleted"]);

type ManagedRow = {
  worktree_id: string;
  path: string;
  branch: string;
  base_commit: string;
  common_dir: string;
  state: ManagedState;
  mount_id: string | null;
  operation_server_id: string;
  operation_principal_id: string;
  operation_id: string;
  completed_steps_json: string;
};

function toManaged(row: ManagedRow): ManagedWorktree {
  return {
    worktreeId: row.worktree_id,
    path: row.path,
    branch: row.branch,
    baseCommit: row.base_commit,
    commonDir: row.common_dir,
    state: row.state,
    mountId: row.mount_id,
    operation: {
      serverId: row.operation_server_id,
      principalId: row.operation_principal_id,
      operationId: row.operation_id,
    },
    completedSteps: JSON.parse(row.completed_steps_json) as string[],
  };
}

export function managedAt(db: Connection, path: string): ManagedWorktree | null {
  const row = statement(db, "SELECT * FROM managed_worktrees WHERE path = ?").get(path) as
    ManagedRow | undefined;
  return row ? toManaged(row) : null;
}

// The Git common directory of the ready managed worktree bound to a mount, for the read-time
// verification of a ready worktree mount (domain/workspaces.ts); null when there is none.
export function readyWorktreeCommonDir(db: Connection, mountId: string): string | null {
  return (
    (
      statement(
        db,
        "SELECT common_dir FROM managed_worktrees WHERE mount_id = ? AND state = 'ready'",
      ).get(mountId) as { common_dir: string } | undefined
    )?.common_dir ?? null
  );
}

// What a new worktree mount was asked for (MountSpec), stored with it.
export type WorktreeSpec = { branch: string | null; baseRef: string | null; noFetch: boolean };

// Records the preparation of a new worktree mount by `operation` (called inside task.create and
// mount.add, store/sql/workspaces.ts).
export function insertPreparation(
  db: Connection,
  mountId: string,
  spec: WorktreeSpec,
  operation: OperationReceiptKey,
  position: number,
): void {
  statement(
    db,
    `INSERT INTO worktree_preparations (mount_id, spec_branch, spec_base_ref, spec_no_fetch,
       operation_server_id, operation_principal_id, operation_id, position, base_ref, no_fetch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mountId,
    spec.branch,
    spec.baseRef,
    spec.noFetch ? 1 : 0,
    operation.serverId,
    operation.principalId,
    operation.operationId,
    position,
    spec.baseRef,
    spec.noFetch ? 1 : 0,
  );
}

type PreparationRow = {
  mount_id: string;
  name: string;
  state: StoredMountState;
  error_json: string | null;
  branch: string | null;
  path: string;
  repo_id: string;
  workspace_id: string;
  task_id: string;
  position: number;
  base_ref: string | null;
  no_fetch: number;
};

function toPreparation(db: Connection, row: PreparationRow): Preparation {
  const repo = statement(
    db,
    "SELECT path, common_dir, main_branch FROM repos WHERE repo_id = ?",
  ).get(row.repo_id) as
    { path: string; common_dir: string; main_branch: string | null } | undefined;
  return {
    mountId: row.mount_id,
    name: row.name,
    mountState: row.state,
    errorKind:
      row.error_json === null ? null : DomainErrorSchema.parse(JSON.parse(row.error_json)).kind,
    branch: row.branch ?? "",
    path: row.path,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    position: row.position,
    baseRef: row.base_ref,
    noFetch: row.no_fetch === 1,
    repo: repo
      ? {
          repoId: row.repo_id,
          path: repo.path,
          commonDir: repo.common_dir,
          mainBranch: repo.main_branch,
        }
      : null,
    managed: managedAt(db, row.path),
  };
}

const PREPARATION_SELECT = `SELECT m.mount_id, m.name, m.state, m.error_json, m.branch, m.path, m.repo_id,
    m.workspace_id, w.task_id, p.position, p.base_ref, p.no_fetch
  FROM worktree_preparations p
    JOIN mounts m ON m.mount_id = p.mount_id
    JOIN workspaces w ON w.workspace_id = m.workspace_id`;

function preparations(db: Connection, operation: OperationReceiptKey): Preparation[] {
  return (
    statement(
      db,
      `${PREPARATION_SELECT}
       WHERE p.operation_server_id = ? AND p.operation_principal_id = ? AND p.operation_id = ?
       ORDER BY p.position, m.mount_id`,
    ).all(operation.serverId, operation.principalId, operation.operationId) as PreparationRow[]
  ).map((row) => toPreparation(db, row));
}

function sameOperation(a: OperationReceiptKey, b: OperationReceiptKey): boolean {
  return (
    a.serverId === b.serverId && a.principalId === b.principalId && a.operationId === b.operationId
  );
}

// The preparation row of a mount when `operation` owns it and the mount is still pending.
function ownedPending(
  db: Connection,
  operation: OperationReceiptKey,
  mountId: string,
): PreparationRow | undefined {
  return statement(
    db,
    `${PREPARATION_SELECT}
     WHERE p.mount_id = ? AND m.state = 'pending' AND p.operation_server_id = ?
       AND p.operation_principal_id = ? AND p.operation_id = ?`,
  ).get(mountId, operation.serverId, operation.principalId, operation.operationId) as
    PreparationRow | undefined;
}

function bumpWorkspace(db: Connection, workspaceId: string): number {
  const { revision } = statement(db, "SELECT revision FROM workspaces WHERE workspace_id = ?").get(
    workspaceId,
  ) as { revision: number };
  // The revision is a SequenceSchema value; a workspace at the limit stays there rather than
  // leaving a state change unrecorded (the manifest compares bytes as well).
  const next = revision === Number.MAX_SAFE_INTEGER ? revision : revision + 1;
  statement(db, "UPDATE workspaces SET revision = ? WHERE workspace_id = ?").run(next, workspaceId);
  return next;
}

function workspaceRevision(db: Connection, workspaceId: string): number {
  return (
    statement(db, "SELECT revision FROM workspaces WHERE workspace_id = ?").get(workspaceId) as {
      revision: number;
    }
  ).revision;
}

// The receipt `key` when its stored revision is `expectedRevision` and its state requires
// attention, the only state operation.continue and operation.abandon act on.
function attentionReceipt(
  db: Connection,
  key: OperationReceiptKey,
  expectedRevision: number,
): OperationRecord | null {
  const row = statement(
    db,
    `SELECT record_json, revision, state FROM operations
     WHERE server_id = ? AND principal_id = ? AND operation_id = ?`,
  ).get(key.serverId, key.principalId, key.operationId) as
    { record_json: string; revision: number; state: string } | undefined;
  if (!row || row.revision !== expectedRevision || row.state !== "requires_attention") return null;
  const parsed = OperationRecordSchema.safeParse(JSON.parse(row.record_json));
  if (!parsed.success) throw new Error("Stored operation record is invalid");
  return parsed.data;
}

// Replaces the target receipt with `next` (its successor), inside the caller's transaction.
function replaceTarget(
  db: Connection,
  key: OperationReceiptKey,
  current: OperationRecord,
  next: OperationRecord,
  limits: ReceiptLimits,
  at: number,
): boolean {
  const checked = checkedReceiptRecord(key, next, limits, encodeUtf8);
  if (!checked || checked.revision !== current.revision + 1 || checked.method !== current.method)
    return false;
  return (
    statement(
      db,
      `UPDATE operations SET state = ?, revision = ?, record_json = ?, updated_at_ms = ?
       WHERE server_id = ? AND principal_id = ? AND operation_id = ? AND revision = ?`,
    ).run(
      checked.state,
      checked.revision,
      JSON.stringify(checked),
      at,
      key.serverId,
      key.principalId,
      key.operationId,
      current.revision,
    ).changes === 1
  );
}

type Applied = { result: OperationResultData; running?: true } | { error: DomainError };
const refuse = (kind: Parameters<typeof domainError>[0]): { error: DomainError } => ({
  error: domainError(kind),
});

export type MountRetryArgs = {
  operation: OperationReceiptKey;
  taskId: string;
  mountId: string;
  branch: string;
  baseRef: string | null;
  noFetch: boolean;
  at: number;
};

export type TargetArgs = {
  target: OperationReceiptKey;
  expectedRevision: number;
  next: OperationRecord;
  limits: ReceiptLimits;
  at: number;
};

export type AbandonArgs = TargetArgs & {
  // Pending mounts of the target, ended as failed with this error.
  mounts: { mountId: string; error: DomainError }[];
  // managed_worktrees rows of the target whose recorded artifacts are all gone now.
  abandoned: string[];
};

// What a retry needs to know about the mount it names, before its transaction.
export type RetrySource = {
  taskId: string;
  archived: boolean;
  workspaceId: string;
  mountId: string;
  source: "checkout" | "worktree";
  state: StoredMountState;
  path: string;
  repoId: string;
  spec: WorktreeSpec | null;
};

export const worktreeOperations = {
  "worktrees.preparations": (
    db: Connection,
    args: { operation: OperationReceiptKey },
  ): Preparation[] => preparations(db, args.operation),

  "worktrees.retrySource": (
    db: Connection,
    args: { taskId: string; mountId: string },
  ): RetrySource | null => {
    const row = statement(
      db,
      `SELECT t.task_id, t.archived, w.workspace_id, m.mount_id, m.source, m.state, m.path,
         m.repo_id, p.spec_branch, p.spec_base_ref, p.spec_no_fetch
       FROM mounts m
         JOIN workspaces w ON w.workspace_id = m.workspace_id
         JOIN tasks t ON t.task_id = w.task_id
         LEFT JOIN worktree_preparations p ON p.mount_id = m.mount_id
       WHERE m.mount_id = ? AND t.task_id = ?`,
    ).get(args.mountId, args.taskId) as
      | {
          task_id: string;
          archived: number;
          workspace_id: string;
          mount_id: string;
          source: "checkout" | "worktree";
          state: StoredMountState;
          path: string;
          repo_id: string;
          spec_branch: string | null;
          spec_base_ref: string | null;
          spec_no_fetch: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      taskId: row.task_id,
      archived: row.archived === 1,
      workspaceId: row.workspace_id,
      mountId: row.mount_id,
      source: row.source,
      state: row.state,
      path: row.path,
      repoId: row.repo_id,
      spec:
        row.spec_no_fetch === null
          ? null
          : {
              branch: row.spec_branch,
              baseRef: row.spec_base_ref,
              noFetch: row.spec_no_fetch === 1,
            },
    };
  },

  // Records the intent of the Git steps before the first one (relay-protocol §11.4): the target
  // path, the branch, the base commit and the owning operation. Refused (false) unless the mount
  // is still pending and owned by `operation`, the registration still exists, and the path is
  // free in managed_worktrees (see REUSABLE_MANAGED_STATES).
  "worktrees.recordIntent": (
    db: Connection,
    args: {
      operation: OperationReceiptKey;
      mountId: string;
      worktreeId: string;
      baseCommit: string;
      at: number;
    },
  ): "recorded" | "taken" | "gone" => {
    const row = ownedPending(db, args.operation, args.mountId);
    if (!row || !row.branch) return "gone";
    const repo = statement(db, "SELECT common_dir FROM repos WHERE repo_id = ?").get(
      row.repo_id,
    ) as { common_dir: string } | undefined;
    if (!repo) return "gone";
    const existing = managedAt(db, row.path);
    if (existing && !REUSABLE_MANAGED_STATES.has(existing.state)) return "taken";
    // The path's earlier row is replaced: an abandoned intent left nothing behind, and a deleted
    // worktree's binding history is kept in bindings (T5).
    if (existing) statement(db, "DELETE FROM managed_worktrees WHERE path = ?").run(row.path);
    statement(
      db,
      `INSERT INTO managed_worktrees (worktree_id, path, repo_id, common_dir, branch, base_commit,
         task_id, workspace_id, mount_id, operation_server_id, operation_principal_id,
         operation_id, state, completed_steps_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', '[]', ?, ?)`,
    ).run(
      args.worktreeId,
      row.path,
      row.repo_id,
      repo.common_dir,
      row.branch,
      args.baseCommit,
      row.task_id,
      row.workspace_id,
      args.mountId,
      args.operation.serverId,
      args.operation.principalId,
      args.operation.operationId,
      args.at,
      args.at,
    );
    statement(db, "UPDATE mounts SET base_commit = ? WHERE mount_id = ?").run(
      args.baseCommit,
      args.mountId,
    );
    return "recorded";
  },

  // The Git steps observed complete (progress tokens, OperationProgressSchema).
  "worktrees.recordSteps": (
    db: Connection,
    args: { worktreeId: string; steps: string[]; at: number },
  ): void => {
    statement(
      db,
      `UPDATE managed_worktrees SET completed_steps_json = ?, updated_at_ms = ?
       WHERE worktree_id = ? AND state = 'intent'`,
    ).run(JSON.stringify(args.steps), args.at, args.worktreeId);
  },

  // Ends the preparation of one mount: ready (its intent becomes the ready managed worktree) or
  // failed with `error` (an intent whose artifacts were all removed becomes abandoned; one with
  // artifacts left keeps holding its path). Returns the new workspace revision, or null when the
  // mount is no longer pending under `operation`.
  "worktrees.settle": (
    db: Connection,
    args: {
      operation: OperationReceiptKey;
      mountId: string;
      state: "ready" | "failed";
      error?: DomainError;
      abandonIntent?: boolean;
      at: number;
    },
  ): number | null => {
    const row = ownedPending(db, args.operation, args.mountId);
    if (!row) return null;
    const managed = managedAt(db, row.path);
    const own = managed && sameOperation(managed.operation, args.operation) ? managed : null;
    if (args.state === "ready") {
      if (!own || own.state !== "intent") return null;
      statement(
        db,
        `UPDATE managed_worktrees SET state = 'ready', mount_id = ?, updated_at_ms = ?
         WHERE worktree_id = ?`,
      ).run(args.mountId, args.at, own.worktreeId);
      statement(
        db,
        "UPDATE mounts SET state = 'ready', error_json = NULL, base_commit = ? WHERE mount_id = ?",
      ).run(own.baseCommit, args.mountId);
    } else {
      if (own?.state === "intent" && args.abandonIntent)
        statement(
          db,
          "UPDATE managed_worktrees SET state = 'abandoned', updated_at_ms = ? WHERE worktree_id = ?",
        ).run(args.at, own.worktreeId);
      const error = DomainErrorSchema.parse(args.error ?? domainError("RESULT_UNKNOWN", "unknown"));
      statement(db, "UPDATE mounts SET state = 'failed', error_json = ? WHERE mount_id = ?").run(
        JSON.stringify(error),
        args.mountId,
      );
    }
    return bumpWorkspace(db, row.workspace_id);
  },

  "worktrees.workspaceRevision": (db: Connection, args: { workspaceId: string }): number =>
    workspaceRevision(db, args.workspaceId),

  // The principals under which an operation ID of this server is being verified at startup
  // (domain/worktrees.ts createWorktreeVerifier, which receives the record without its key).
  "worktrees.recoveringPrincipals": (
    db: Connection,
    args: { serverId: string; operationId: string },
  ): string[] =>
    (
      statement(
        db,
        `SELECT principal_id FROM operations
         WHERE server_id = ? AND operation_id = ? AND state = 'recovering'
         ORDER BY principal_id`,
      ).all(args.serverId, args.operationId) as { principal_id: string }[]
    ).map((row) => row.principal_id),
};

// Receipt-checked writes (store/sql/writes.ts).
export const worktreeWrites = {
  // Starts a new attempt at a failed worktree mount: the mount becomes pending under this
  // operation with this attempt's options, and the workspace revision grows by one.
  "mount.retry": (db: Connection, args: MountRetryArgs): Applied => {
    const row = statement(
      db,
      `SELECT m.state, m.source, m.path, m.workspace_id, t.archived
       FROM mounts m JOIN workspaces w ON w.workspace_id = m.workspace_id
         JOIN tasks t ON t.task_id = w.task_id
       WHERE m.mount_id = ? AND t.task_id = ?`,
    ).get(args.mountId, args.taskId) as
      | { state: string; source: string; path: string; workspace_id: string; archived: number }
      | undefined;
    if (!row) {
      const task = statement(db, "SELECT 1 FROM tasks WHERE task_id = ?").get(args.taskId);
      return refuse(task ? "MOUNT_NOT_FOUND" : "TASK_NOT_FOUND");
    }
    if (row.archived === 1) return refuse("TASK_ARCHIVED");
    if (row.source !== "worktree" || row.state !== "failed") return refuse("INVALID_ARGUMENT");
    const prepared = statement(db, "SELECT 1 FROM worktree_preparations WHERE mount_id = ?").get(
      args.mountId,
    );
    if (!prepared) return refuse("INVALID_ARGUMENT");
    const managed = managedAt(db, row.path);
    if (managed && !REUSABLE_MANAGED_STATES.has(managed.state))
      return refuse("MOUNT_NAME_CONFLICT");
    statement(
      db,
      `UPDATE mounts SET state = 'pending', branch = ?, base_commit = NULL, error_json = NULL
       WHERE mount_id = ?`,
    ).run(args.branch, args.mountId);
    statement(
      db,
      `UPDATE bindings SET branch = ? WHERE mount_id = ? AND unbound_at_ms IS NULL`,
    ).run(args.branch, args.mountId);
    statement(
      db,
      `UPDATE worktree_preparations SET operation_server_id = ?, operation_principal_id = ?,
         operation_id = ?, position = 0, base_ref = ?, no_fetch = ?
       WHERE mount_id = ?`,
    ).run(
      args.operation.serverId,
      args.operation.principalId,
      args.operation.operationId,
      args.baseRef,
      args.noFetch ? 1 : 0,
      args.mountId,
    );
    const revision = bumpWorkspace(db, row.workspace_id);
    return {
      result: {
        resource: { kind: "mount", id: args.mountId, revision },
        workspaceRevision: revision,
        mounts: [{ mountId: args.mountId, state: "pending" }],
      },
      running: true,
    };
  },

  // Moves a requires_attention target back to running (its executor then finishes it), in the
  // transaction that commits the continue operation itself. The revision the caller inspected
  // must still be the target's, so a decision made on a stale view is refused.
  "operation.continue": (db: Connection, args: TargetArgs): Applied => {
    const current = attentionReceipt(db, args.target, args.expectedRevision);
    if (!current) return refuse("OPERATION_NOT_RESUMABLE");
    if (args.next.state !== "running") return refuse("INVALID_ARGUMENT");
    if (!replaceTarget(db, args.target, current, args.next, args.limits, args.at))
      return refuse("OPERATION_NOT_RESUMABLE");
    return { result: { targetOperationId: args.target.operationId } };
  },

  // Ends a requires_attention target as cancelled after the caller removed exactly the artifacts
  // that matched its intent: its pending mounts become failed, the intents left with no artifact
  // become abandoned, and the workspace revision grows by one for each workspace touched.
  "operation.abandon": (db: Connection, args: AbandonArgs): Applied => {
    const current = attentionReceipt(db, args.target, args.expectedRevision);
    if (!current) return refuse("OPERATION_NOT_RESUMABLE");
    if (args.next.state !== "cancelled") return refuse("INVALID_ARGUMENT");
    const workspaces = new Set<string>();
    for (const mount of args.mounts) {
      const row = ownedPending(db, args.target, mount.mountId);
      if (!row) continue;
      statement(db, "UPDATE mounts SET state = 'failed', error_json = ? WHERE mount_id = ?").run(
        JSON.stringify(DomainErrorSchema.parse(mount.error)),
        mount.mountId,
      );
      workspaces.add(row.workspace_id);
    }
    for (const worktreeId of args.abandoned)
      statement(
        db,
        `UPDATE managed_worktrees SET state = 'abandoned', updated_at_ms = ?
         WHERE worktree_id = ? AND state = 'intent' AND operation_server_id = ?
           AND operation_principal_id = ? AND operation_id = ?`,
      ).run(
        args.at,
        worktreeId,
        args.target.serverId,
        args.target.principalId,
        args.target.operationId,
      );
    for (const workspaceId of workspaces) bumpWorkspace(db, workspaceId);
    if (!replaceTarget(db, args.target, current, args.next, args.limits, args.at))
      return refuse("OPERATION_NOT_RESUMABLE");
    return { result: { targetOperationId: args.target.operationId } };
  },
};
