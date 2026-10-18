import { domainError, type DomainError, type DomainErrorKind } from "@cove/protocol/errors";
import { sameRunRef, type RunRef } from "@cove/protocol/identity";
import type { OperationReceiptKey, OperationRecord } from "@cove/protocol/rpc";
import { M1_LIMITS, type MountRecord } from "@cove/protocol/workspace";
import type { OperationResultData, ReceiptLimits } from "../../operations/receipt-records.js";
import { Rollback, statement, type Connection } from "./statements.js";
import { tabOperations } from "./tabs.js";
import { readable } from "./workspaces.js";
import {
  actable,
  attemptOperationOpen,
  attemptsOf,
  bumpWorkspace,
  insertConversionAttempt,
  managedAt,
  replaceReceipt,
  REUSABLE_MANAGED_STATES,
  runningReceipt,
  settledRecord,
  type ManagedState,
  type WorktreeSpec,
} from "./worktrees.js";

// Binding changes and managed worktree deletion (docs/milestones/m1.md T5; the domain rules are
// in domain/bindings.ts). Tables involved:
// - mounts and bindings (migration 001): a mount keeps its ID across a conversion; bindings keeps
//   one row per binding the mount had, the current one with unbound_at_ms NULL;
// - worktree_attempts (migration 003) and binding_conversions (migration 004): a conversion
//   records its target's attempt without a worktree_preparations row, so the T3b executor, its
//   restart verification and operation continue/abandon prepare the target while the mount keeps
//   its checkout binding; bindings.switch rebinds the mount once the target is verified;
// - managed_worktrees (migration 001): a deletion ends with the worktree `deleted`;
// - worktree_deletions (migration 004): a deletion between its acceptance and its outcome.
//
// The live-run guard. A conversion and a deletion are refused (LIVE_RUNS_PRESENT, with the runs)
// while a run without an end record uses the path (tabs.liveRunsUsing: its start cwd or its
// recorded mount mapping is the path or lies below it). The domain asks first (domain/tabs.ts
// liveRunsUsing, which leaves out runs whose exit the runtime observed but the store has not
// recorded yet) and passes those runs as `exited`; the accepting transaction asks the store again
// and refuses on any other run, so a run started between the domain's check and the commit (Cove's
// own overlapping work) is still seen.

type Applied = { result: OperationResultData; running?: true } | { error: DomainError };
const refuse = (kind: DomainErrorKind): { error: DomainError } => ({ error: domainError(kind) });

type MountRow = {
  mount_id: string;
  workspace_id: string;
  task_id: string;
  archived: number;
  workspace_revision: number;
  source: "checkout" | "worktree";
  state: Exclude<MountRecord["state"], "unavailable">;
  path: string;
  repo_id: string;
  branch: string | null;
};

function mountRow(db: Connection, taskId: string, mountId: string): MountRow | undefined {
  return statement(
    db,
    `SELECT m.mount_id, m.workspace_id, w.task_id, t.archived, w.revision AS workspace_revision,
       m.source, m.state, m.path, m.repo_id, m.branch
     FROM mounts m JOIN workspaces w ON w.workspace_id = m.workspace_id
       JOIN tasks t ON t.task_id = w.task_id
     WHERE m.mount_id = ? AND t.task_id = ?`,
  ).get(mountId, taskId) as MountRow | undefined;
}

function missing(db: Connection, taskId: string): { error: DomainError } {
  const task = statement(db, "SELECT 1 FROM tasks WHERE task_id = ?").get(taskId);
  return refuse(task ? "MOUNT_NOT_FOUND" : "TASK_NOT_FOUND");
}

// The runs without an end record that use `path` (of the task `taskId` when it is given), less
// those the runtime saw exit (see the header).
function liveRuns(
  db: Connection,
  path: string,
  exited: readonly RunRef[],
  taskId?: string,
): RunRef[] {
  return tabOperations["tabs.liveRunsUsing"](db, { path })
    .filter((run) => taskId === undefined || run.taskId === taskId)
    .map((run) => run.run)
    .filter((run) => !exited.some((other) => sameRunRef(run, other)));
}

function liveRunsRefusal(runs: RunRef[]): { error: DomainError } {
  return {
    error: domainError("LIVE_RUNS_PRESENT", "not-accepted", undefined, {
      runs: runs.slice(0, 128),
    }),
  };
}

// A managed worktree a deletion may act on: recorded at the mount's path for this mount, either
// ready, or an intent a failed or abandoned preparation left in place (its outcome's `left`).
// Abandoned and deleted rows hold nothing any more.
function deletable(db: Connection, mount: MountRow) {
  const managed = managedAt(db, mount.path);
  if (!managed || managed.mountId !== mount.mount_id || REUSABLE_MANAGED_STATES.has(managed.state))
    return null;
  return managed;
}

// What the domain needs to know about a mount before it checks Git and the live runs.
export type DeleteSource =
  | { kind: "missing"; error: DomainError }
  | {
      kind: "found";
      workspaceId: string;
      source: "checkout" | "worktree";
      state: MountRow["state"];
      path: string;
      branch: string | null;
      // The operation of the mount's preparation, or a deletion, has not ended.
      busy: boolean;
      // The managed worktree there, null when none is left to delete.
      managed: { worktreeId: string; state: ManagedState } | null;
    };

export type DeletionRow = {
  operation: OperationReceiptKey;
  worktreeId: string;
  mountId: string;
  workspaceId: string;
  path: string;
  // The registered clone the worktree belongs to; null when the registration is gone.
  clone: string | null;
  priorState: "ready" | "failed" | "missing";
  outcome: "pending" | "deleted" | "restored";
};

function pendingDeletion(db: Connection, mountId: string): boolean {
  return (
    statement(
      db,
      "SELECT 1 FROM worktree_deletions WHERE mount_id = ? AND outcome = 'pending'",
    ).get(mountId) !== undefined
  );
}

function deletionRow(db: Connection, operation: OperationReceiptKey): DeletionRow | null {
  const row = statement(
    db,
    `SELECT d.*, g.path, r.path AS clone FROM worktree_deletions d
       JOIN managed_worktrees g ON g.worktree_id = d.worktree_id
       LEFT JOIN repos r ON r.repo_id = g.repo_id
     WHERE d.operation_server_id = ? AND d.operation_principal_id = ? AND d.operation_id = ?`,
  ).get(operation.serverId, operation.principalId, operation.operationId) as
    | {
        worktree_id: string;
        mount_id: string;
        workspace_id: string;
        prior_state: DeletionRow["priorState"];
        outcome: DeletionRow["outcome"];
        path: string;
        clone: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    operation,
    worktreeId: row.worktree_id,
    mountId: row.mount_id,
    workspaceId: row.workspace_id,
    path: row.path,
    clone: row.clone,
    priorState: row.prior_state,
    outcome: row.outcome,
  };
}

export type ConvertArgs = {
  operation: OperationReceiptKey;
  taskId: string;
  mountId: string;
  expectedWorkspaceRevision?: number;
  // The new worktree: `<entry>/<name>`, its branch (checked by Git's rules) and what was asked.
  path: string;
  branch: string;
  spec: WorktreeSpec;
  // The registration's common directory the domain planned with.
  commonDir: string;
  sourceChanges: { staged: number; unstaged: number; untracked: number };
  exited: RunRef[];
  responseBytes: number;
  at: number;
};

export type DeleteArgs = {
  operation: OperationReceiptKey;
  taskId: string;
  mountId: string;
  expectedWorkspaceRevision?: number;
  worktreeId: string;
  exited: RunRef[];
  at: number;
};

export const bindingOperations = {
  "bindings.deleteSource": (
    db: Connection,
    args: { taskId: string; mountId: string },
  ): DeleteSource => {
    const mount = mountRow(db, args.taskId, args.mountId);
    if (!mount) return { kind: "missing", error: missing(db, args.taskId).error };
    const managed = mount.source === "worktree" ? deletable(db, mount) : null;
    return {
      kind: "found",
      workspaceId: mount.workspace_id,
      source: mount.source,
      state: mount.state,
      path: mount.path,
      branch: mount.branch,
      busy: attemptOperationOpen(db, mount.mount_id) || pendingDeletion(db, mount.mount_id),
      managed: managed ? { worktreeId: managed.worktreeId, state: managed.state } : null,
    };
  },

  "bindings.deletion": (
    db: Connection,
    args: { operation: OperationReceiptKey },
  ): DeletionRow | null => deletionRow(db, args.operation),

  // The binding history of a mount, oldest first; the mount itself may have been removed or
  // deleted since. Null when the task does not exist, [] when it never had that mount.
  "bindings.history": (
    db: Connection,
    args: { taskId: string; mountId: string },
  ):
    | {
        workspaceRevision: number;
        mountId: string;
        source: "checkout" | "worktree";
        path: string;
        branch: string | null;
        boundAtMs: number;
        unboundAtMs: number | null;
      }[]
    | null => {
    const workspace = statement(db, "SELECT workspace_id FROM workspaces WHERE task_id = ?").get(
      args.taskId,
    ) as { workspace_id: string } | undefined;
    if (!workspace) return null;
    // A mount ID is never reused and gains a row only when it is added or converted, so there are
    // at most two; the bound is the schema's all the same (the latest ones).
    const rows = statement(
      db,
      `SELECT workspace_revision, mount_id, source, path, branch, bound_at_ms, unbound_at_ms
       FROM bindings WHERE workspace_id = ? AND mount_id = ?
       ORDER BY binding_seq DESC LIMIT ?`,
    ).all(workspace.workspace_id, args.mountId, M1_LIMITS.bindingHistory) as {
      workspace_revision: number;
      mount_id: string;
      source: "checkout" | "worktree";
      path: string;
      branch: string | null;
      bound_at_ms: number;
      unbound_at_ms: number | null;
    }[];
    return rows.reverse().map((row) => ({
      workspaceRevision: row.workspace_revision,
      mountId: row.mount_id,
      source: row.source,
      path: row.path,
      branch: row.branch,
      boundAtMs: row.bound_at_ms,
      unboundAtMs: row.unbound_at_ms,
    }));
  },

  // The pending conversion whose target attempt `attemptId` is (migration 004), or null.
  "bindings.conversion": (
    db: Connection,
    args: { attemptId: string },
  ): { taskId: string; mountId: string; workspaceId: string; sourcePath: string } | null => {
    const row = statement(
      db,
      `SELECT c.mount_id, c.workspace_id, c.source_path, w.task_id FROM binding_conversions c
         JOIN workspaces w ON w.workspace_id = c.workspace_id
       WHERE c.attempt_id = ? AND c.outcome = 'pending'`,
    ).get(args.attemptId) as
      { mount_id: string; workspace_id: string; source_path: string; task_id: string } | undefined;
    return row
      ? {
          taskId: row.task_id,
          mountId: row.mount_id,
          workspaceId: row.workspace_id,
          sourcePath: row.source_path,
        }
      : null;
  },

  // Switches a converted mount to its verified target in one transaction (design §3; D3), with
  // the operation's final receipt: the preconditions are checked again with the current rows (the
  // mount is still the same ready checkout of an active task, and no run of the task without an
  // end record uses the checkout, less `exited`), then the mount becomes the ready worktree mount
  // at the target, the checkout binding is unbound and the worktree binding recorded at the new
  // revision, the target's intent becomes the ready managed worktree, the attempt ends ready and
  // the conversion `switched`. "refused", with nothing written, when a precondition does not hold
  // any more: the target stays prepared and the operation is left for an explicit continue or
  // abandon. Null when the attempt is not pending and actable by its own operation, its intent is
  // not the attempt's, or the receipt is not running.
  "bindings.switch": (
    db: Connection,
    args: {
      attemptId: string;
      actor: OperationReceiptKey;
      exited: RunRef[];
      responseBytes: number;
      limits: ReceiptLimits;
      at: number;
    },
  ):
    | { kind: "switched"; workspaceId: string; revision: number }
    | { kind: "refused"; error: DomainError }
    | null => {
    const attempt = actable(db, args.attemptId, args.actor);
    if (!attempt || attempt.abandon_operation_id !== null) return null;
    const conversion = statement(
      db,
      `SELECT mount_id, workspace_id, source_path, spec_branch, spec_base_ref, spec_no_fetch
       FROM binding_conversions WHERE attempt_id = ? AND outcome = 'pending'`,
    ).get(args.attemptId) as
      | {
          mount_id: string;
          workspace_id: string;
          source_path: string;
          spec_branch: string | null;
          spec_base_ref: string | null;
          spec_no_fetch: number;
        }
      | undefined;
    if (!conversion) return null;
    const owner = {
      serverId: attempt.operation_server_id,
      principalId: attempt.operation_principal_id,
      operationId: attempt.operation_id,
    };
    const receipt = runningReceipt(db, owner);
    if (!receipt) return null;
    const managed = managedAt(db, attempt.path);
    if (!managed || managed.state !== "intent" || managed.worktreeId !== attempt.worktree_id)
      return null;
    const mount = statement(
      db,
      `SELECT m.mount_id, m.workspace_id, w.task_id, t.archived, w.revision AS workspace_revision,
         m.source, m.state, m.path, m.repo_id, m.branch
       FROM mounts m JOIN workspaces w ON w.workspace_id = m.workspace_id
         JOIN tasks t ON t.task_id = w.task_id
       WHERE m.mount_id = ?`,
    ).get(conversion.mount_id) as MountRow | undefined;
    // A pending conversion keeps the mount from being removed or converted again
    // (attemptOperationOpen), so these are not expected; they are refused all the same.
    if (!mount) return { kind: "refused", error: domainError("MOUNT_NOT_FOUND") };
    if (mount.archived === 1) return { kind: "refused", error: domainError("TASK_ARCHIVED") };
    if (
      mount.source !== "checkout" ||
      mount.state !== "ready" ||
      mount.path !== conversion.source_path
    )
      return { kind: "refused", error: domainError("INVALID_ARGUMENT") };
    const live = liveRuns(db, mount.path, args.exited, mount.task_id);
    if (live.length) return { kind: "refused", ...liveRunsRefusal(live) };
    const revision = bumpWorkspace(db, mount.workspace_id);
    statement(
      db,
      `UPDATE mounts SET source = 'worktree', path = ?, entry_path = ?, state = 'ready',
         branch = ?, base_commit = ?, error_json = NULL
       WHERE mount_id = ?`,
    ).run(attempt.path, attempt.path, attempt.branch, managed.baseCommit, mount.mount_id);
    statement(
      db,
      `UPDATE bindings SET unbound_at_ms = ?
       WHERE workspace_id = ? AND mount_id = ? AND unbound_at_ms IS NULL`,
    ).run(args.at, mount.workspace_id, mount.mount_id);
    statement(
      db,
      `INSERT INTO bindings (workspace_id, mount_id, workspace_revision, source, path, branch,
         bound_at_ms, unbound_at_ms)
       VALUES (?, ?, ?, 'worktree', ?, ?, ?, NULL)`,
    ).run(mount.workspace_id, mount.mount_id, revision, attempt.path, attempt.branch, args.at);
    // From now on the mount is an ordinary worktree mount whose current attempt is this one, as
    // after mount.add (a later delete, remove or retry finds it there).
    statement(
      db,
      `INSERT INTO worktree_preparations (mount_id, spec_branch, spec_base_ref, spec_no_fetch,
         attempt_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      mount.mount_id,
      conversion.spec_branch,
      conversion.spec_base_ref,
      conversion.spec_no_fetch,
      args.attemptId,
    );
    statement(
      db,
      `UPDATE managed_worktrees SET state = 'ready', mount_id = ?, completed_steps_json = ?,
         updated_at_ms = ?
       WHERE worktree_id = ?`,
    ).run(
      mount.mount_id,
      JSON.stringify(["intent", "branch", "worktree", "checkout"]),
      args.at,
      managed.worktreeId,
    );
    statement(
      db,
      "UPDATE worktree_attempts SET outcome = 'ready', updated_at_ms = ? WHERE attempt_id = ?",
    ).run(args.at, args.attemptId);
    statement(
      db,
      `UPDATE binding_conversions SET outcome = 'switched', updated_at_ms = ?
       WHERE attempt_id = ?`,
    ).run(args.at, args.attemptId);
    // Every read of the task must fit one response (domain/record-bounds.ts).
    if (!readable(db, mount.task_id, args.responseBytes))
      throw new Rollback({ kind: "refused", error: domainError("INVALID_ARGUMENT") });
    const final = settledRecord(receipt, attemptsOf(db, owner), revision);
    if (!final || !replaceReceipt(db, owner, receipt, final, args.limits, args.at))
      throw new Rollback(null);
    return { kind: "switched", workspaceId: mount.workspace_id, revision };
  },

  // Ends a pending deletion in one transaction with its operation's final receipt (see migration
  // 004): `deleted` removes the mount, unbinds it and records the worktree deleted; `restored`
  // puts the mount back in its prior state and fails the operation with `error`. Either way the
  // workspace revision grows by one. Null, with nothing written, when the deletion is not pending
  // or its receipt is not running.
  "bindings.finishDelete": (
    db: Connection,
    args: {
      operation: OperationReceiptKey;
      outcome: "deleted" | "restored";
      error?: DomainError;
      limits: ReceiptLimits;
      at: number;
    },
  ): { workspaceId: string; revision: number } | null => {
    const deletion = deletionRow(db, args.operation);
    const receipt = runningReceipt(db, args.operation);
    if (!deletion || deletion.outcome !== "pending" || !receipt) return null;
    if (args.outcome === "deleted") {
      statement(db, "DELETE FROM mounts WHERE mount_id = ?").run(deletion.mountId);
      statement(
        db,
        `UPDATE bindings SET unbound_at_ms = ?
         WHERE workspace_id = ? AND mount_id = ? AND unbound_at_ms IS NULL`,
      ).run(args.at, deletion.workspaceId, deletion.mountId);
      statement(
        db,
        `UPDATE managed_worktrees SET state = 'deleted', mount_id = NULL, updated_at_ms = ?
         WHERE worktree_id = ?`,
      ).run(args.at, deletion.worktreeId);
    } else
      statement(db, "UPDATE mounts SET state = ? WHERE mount_id = ?").run(
        deletion.priorState,
        deletion.mountId,
      );
    statement(
      db,
      `UPDATE worktree_deletions SET outcome = ?, updated_at_ms = ?
       WHERE operation_server_id = ? AND operation_principal_id = ? AND operation_id = ?`,
    ).run(
      args.outcome,
      args.at,
      args.operation.serverId,
      args.operation.principalId,
      args.operation.operationId,
    );
    const revision = bumpWorkspace(db, deletion.workspaceId);
    const { progress: _progress, error: _error, ...rest } = receipt;
    const final: OperationRecord = {
      ...rest,
      revision: receipt.revision + 1,
      state: args.outcome === "deleted" ? "succeeded" : "failed",
      result: {
        resource: { kind: "mount", id: deletion.mountId, revision },
        workspaceRevision: revision,
      },
      ...(args.outcome === "restored"
        ? { error: args.error ?? domainError("RESULT_UNKNOWN", "unknown") }
        : {}),
    };
    if (!replaceReceipt(db, args.operation, receipt, final, args.limits, args.at))
      throw new Rollback(null);
    return { workspaceId: deletion.workspaceId, revision };
  },
};

// Receipt-checked writes (store/sql/writes.ts).
export const bindingWrites = {
  // Accepts the conversion of a ready checkout mount to a new managed worktree (D3) without
  // changing the mount (design §3: prepare, verify, then switch): the target's attempt is
  // recorded for the T3b executor with the target path `<entry>/<name>`, and the conversion with
  // the checkout's path and the request (migration 004). The mount keeps its checkout binding and
  // the workspace revision is unchanged; bindings.switch rebinds the mount once the target is
  // verified. The receipt stays running until then, or until the attempt fails or is abandoned.
  // The source checkout is never written to.
  "binding.convert": (db: Connection, args: ConvertArgs): Applied => {
    const mount = mountRow(db, args.taskId, args.mountId);
    if (!mount) return missing(db, args.taskId);
    if (
      args.expectedWorkspaceRevision !== undefined &&
      args.expectedWorkspaceRevision !== mount.workspace_revision
    )
      return refuse("REVISION_CONFLICT");
    if (mount.workspace_revision === Number.MAX_SAFE_INTEGER) return refuse("COUNTER_EXHAUSTED");
    if (mount.archived === 1) return refuse("TASK_ARCHIVED");
    if (mount.source !== "checkout" || mount.state !== "ready") return refuse("INVALID_ARGUMENT");
    if (attemptOperationOpen(db, args.mountId)) return refuse("OPERATION_EFFECTS_ACTIVE");
    const repo = statement(db, "SELECT common_dir FROM repos WHERE repo_id = ?").get(
      mount.repo_id,
    ) as { common_dir: string } | undefined;
    if (!repo || repo.common_dir !== args.commonDir) return refuse("REPO_NOT_FOUND");
    const live = liveRuns(db, mount.path, args.exited, args.taskId);
    if (live.length) return liveRunsRefusal(live);
    const earlier = managedAt(db, args.path);
    if (earlier && !REUSABLE_MANAGED_STATES.has(earlier.state))
      return refuse("MOUNT_NAME_CONFLICT");
    const attemptId = insertConversionAttempt(
      db,
      args.mountId,
      args.path,
      args.branch,
      args.spec,
      args.operation,
      args.at,
    );
    statement(
      db,
      `INSERT INTO binding_conversions (attempt_id, mount_id, workspace_id, source_path,
         spec_branch, spec_base_ref, spec_no_fetch, outcome, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      attemptId,
      args.mountId,
      mount.workspace_id,
      mount.path,
      args.spec.branch,
      args.spec.baseRef,
      args.spec.noFetch ? 1 : 0,
      args.at,
      args.at,
    );
    return {
      result: {
        resource: { kind: "mount", id: args.mountId, revision: mount.workspace_revision },
        workspaceRevision: mount.workspace_revision,
        mounts: [{ mountId: args.mountId, state: "pending" }],
        sourceChanges: args.sourceChanges,
      },
      running: true,
    };
  },

  // Accepts the deletion of a mount's managed worktree before Git removes anything (migration
  // 004): the mount is recorded pending (no new tab may use it as its cwd, and nothing else acts
  // on it), the deletion with the mount's prior state, and the workspace revision grows by one.
  // The receipt stays running until bindings.finishDelete.
  "binding.delete": (db: Connection, args: DeleteArgs): Applied => {
    const mount = mountRow(db, args.taskId, args.mountId);
    if (!mount) return missing(db, args.taskId);
    if (
      args.expectedWorkspaceRevision !== undefined &&
      args.expectedWorkspaceRevision !== mount.workspace_revision
    )
      return refuse("REVISION_CONFLICT");
    if (mount.workspace_revision === Number.MAX_SAFE_INTEGER) return refuse("COUNTER_EXHAUSTED");
    // A checkout is never Cove's to delete.
    if (mount.source !== "worktree") return refuse("INVALID_ARGUMENT");
    if (
      mount.state === "pending" ||
      attemptOperationOpen(db, args.mountId) ||
      pendingDeletion(db, args.mountId)
    )
      return refuse("OPERATION_EFFECTS_ACTIVE");
    const managed = deletable(db, mount);
    if (!managed || managed.worktreeId !== args.worktreeId) return refuse("INVALID_ARGUMENT");
    const live = liveRuns(db, mount.path, args.exited);
    if (live.length) return liveRunsRefusal(live);
    statement(db, "UPDATE mounts SET state = 'pending' WHERE mount_id = ?").run(args.mountId);
    statement(
      db,
      `INSERT INTO worktree_deletions (operation_server_id, operation_principal_id, operation_id,
         worktree_id, mount_id, workspace_id, prior_state, outcome, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      args.operation.serverId,
      args.operation.principalId,
      args.operation.operationId,
      managed.worktreeId,
      args.mountId,
      mount.workspace_id,
      mount.state,
      args.at,
      args.at,
    );
    const revision = bumpWorkspace(db, mount.workspace_id);
    return {
      result: {
        resource: { kind: "mount", id: args.mountId, revision },
        workspaceRevision: revision,
      },
      running: true,
    };
  },
};
