import { domainError, type DomainError, type DomainErrorKind } from "@cove/protocol/errors";
import type { RunRef } from "@cove/protocol/identity";
import { OperationRecordSchema, type OperationRecord } from "@cove/protocol/rpc";
import {
  RunHistoryRecordSchema,
  TabCwdSchema,
  TabRecipeSchema,
  type RunHistoryRecord,
  type TabRecord,
} from "@cove/protocol/workspace";
import { tabReadFits } from "../../domain/tab-bounds.js";
import { deletionPending } from "./deletions.js";
import {
  checkedReceiptRecord,
  type DatabaseWriteRequest,
  type OperationResultData,
  type ReceiptLimits,
} from "../../operations/receipt-records.js";
import { Rollback, statement, type Connection } from "./statements.js";

// Tabs and their runs (docs/milestones/m1.md T4, D8; the domain rules are in domain/tabs.ts).
//
// A tab is a durable logical terminal of a task: its name, launch recipe and cwd choice. A run is
// one PTY instance (the runs table, shared with terminal.create runs, which have no tab). A run
// records, when it is accepted, the task, the workspace revision, the resolved cwd and the mount
// mapping of that moment; later binding changes never rewrite them, so a run keeps pointing at
// what it was started in (D3, T5).
//
// Revisions: tabs.revision grows whenever the tab's record changes, which is when it gets a new
// latest run (tabs.launch of a reopen) or loses one that never started (runs.notStarted).

type TabRow = {
  tab_id: string;
  task_id: string;
  revision: number;
  name: string;
  recipe_json: string;
  cwd_json: string;
  created_at_ms: number;
  latest_run_seq: number | null;
};

type RunRow = {
  run_seq: number;
  server_id: string;
  relay_instance_id: string;
  run_id: string;
  tab_id: string | null;
  task_id: string | null;
  workspace_revision: number | null;
  cwd: string;
  mounts_json: string;
  lifecycle: RunHistoryRecord["lifecycle"];
  verification: RunHistoryRecord["verification"];
  started_at_ms: number;
  ended_at_ms: number | null;
  last_observed_at_ms: number | null;
  exit_code: number | null;
  signal: string | null;
};

const TAB_COLUMNS =
  "tab_id, task_id, revision, name, recipe_json, cwd_json, created_at_ms, latest_run_seq";
const RUN_COLUMNS = `run_seq, server_id, relay_instance_id, run_id, tab_id, task_id,
  workspace_revision, cwd, mounts_json, lifecycle, verification, started_at_ms, ended_at_ms,
  last_observed_at_ms, exit_code, signal`;
// A run without an end record. After startup only runs of the current instance can be in these
// states (runs.interruptEarlier marks the others), so this is "alive as far as Cove knows": no
// exit fact was recorded. It is not proof that the process runs (the worker may be out of
// contact); domain/tabs.ts adds what the runtime currently knows.
const LIVE = "('starting', 'running')";

const refuse = (kind: DomainErrorKind): { error: DomainError } => ({ error: domainError(kind) });

// A stored value that no longer parses is corruption; it must not vanish from the record.
function storedRecipe(json: string): TabRecord["recipe"] {
  const result = TabRecipeSchema.safeParse(JSON.parse(json));
  if (!result.success) throw new Error("Stored tab recipe is invalid");
  return result.data;
}
function storedCwd(json: string): TabRecord["cwd"] {
  const result = TabCwdSchema.safeParse(JSON.parse(json));
  if (!result.success) throw new Error("Stored tab cwd is invalid");
  return result.data;
}

function runRef(row: Pick<RunRow, "server_id" | "relay_instance_id" | "run_id">): RunRef {
  return { serverId: row.server_id, relayInstanceId: row.relay_instance_id, runId: row.run_id };
}

export function toRunRecord(row: RunRow): RunHistoryRecord {
  return RunHistoryRecordSchema.parse({
    run: runRef(row),
    tabId: row.tab_id,
    taskId: row.task_id,
    workspaceRevision: row.workspace_revision,
    cwd: row.cwd,
    mounts: JSON.parse(row.mounts_json),
    lifecycle: row.lifecycle,
    verification: row.verification,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    lastObservedAtMs: row.last_observed_at_ms,
    exitCode: row.exit_code,
    signal: row.signal,
  });
}

function runBySeq(db: Connection, seq: number | null): RunRow | undefined {
  if (seq === null) return undefined;
  return statement(db, `SELECT ${RUN_COLUMNS} FROM runs WHERE run_seq = ?`).get(seq) as
    RunRow | undefined;
}

function tabRow(db: Connection, tabId: string): TabRow | undefined {
  return statement(db, `SELECT ${TAB_COLUMNS} FROM tabs WHERE tab_id = ?`).get(tabId) as
    TabRow | undefined;
}

function toTab(
  db: Connection,
  row: TabRow,
): { tab: TabRecord; latestRun: RunHistoryRecord | null } {
  const latest = runBySeq(db, row.latest_run_seq);
  return {
    tab: {
      tabId: row.tab_id,
      taskId: row.task_id,
      revision: row.revision,
      name: row.name,
      recipe: storedRecipe(row.recipe_json),
      cwd: storedCwd(row.cwd_json),
      createdAtMs: row.created_at_ms,
      latestRun: latest ? runRef(latest) : null,
    },
    latestRun: latest ? toRunRecord(latest) : null,
  };
}

function liveRunsOfTab(db: Connection, tabId: string): RunRef[] {
  return (
    statement(
      db,
      `SELECT server_id, relay_instance_id, run_id FROM runs
       WHERE tab_id = ? AND lifecycle IN ${LIVE} ORDER BY run_seq LIMIT 128`,
    ).all(tabId) as RunRow[]
  ).map(runRef);
}

// The task a launch belongs to, with the workspace its run snapshots.
type TaskRow = {
  task_id: string;
  archived: number;
  workspace_id: string;
  workspace_revision: number;
  entry_path: string;
};

function taskRow(db: Connection, taskId: string): TaskRow | undefined {
  return statement(
    db,
    `SELECT t.task_id, t.archived, w.workspace_id, w.revision AS workspace_revision, w.entry_path
     FROM tasks t JOIN workspaces w ON w.task_id = t.task_id WHERE t.task_id = ?`,
  ).get(taskId) as TaskRow | undefined;
}

type Cwd = TabRecord["cwd"];

// The directory a run of the tab starts in: the workspace entry, or the real path of one of its
// mounts. A mount must be recorded ready: a pending, failed or missing worktree has no directory
// a process could start in, and its path is not what the operator asked for.
function resolveCwd(
  db: Connection,
  task: TaskRow,
  cwd: Cwd,
): { path: string } | { error: DomainError } {
  if (cwd.kind === "entry") return { path: task.entry_path };
  const mount = statement(
    db,
    "SELECT path, state FROM mounts WHERE mount_id = ? AND workspace_id = ?",
  ).get(cwd.mountId, task.workspace_id) as { path: string; state: string } | undefined;
  if (!mount) return refuse("MOUNT_NOT_FOUND");
  // An accepted deletion holds its mount non-ready until it ends. A tab in that mount is refused
  // as a run in a worktree being deleted, like an entry tab or a terminal run there, so a client
  // can tell "retry once the deletion ended" from an invalid cwd (m1 T5, D10).
  if (mount.state !== "ready" && deletionPending(db, [mount.path])) {
    return refuse("OPERATION_EFFECTS_ACTIVE");
  }
  if (mount.state !== "ready") return refuse("INVALID_ARGUMENT");
  return { path: mount.path };
}

// The mount mapping a run records at start: every mount of the workspace, in the workspace's
// order. Mounts that are not ready are included too: a worktree being prepared is still part of
// what the workspace binds, and a guard that asks which runs use a path (T5) must see it.
function mountSnapshot(db: Connection, workspaceId: string): RunHistoryRecord["mounts"] {
  return statement(
    db,
    `SELECT name, source, path FROM mounts WHERE workspace_id = ? ORDER BY created_at_ms, rowid`,
  ).all(workspaceId) as RunHistoryRecord["mounts"];
}

export type NewTab = {
  tabId: string;
  taskId: string;
  name: string;
  recipe: TabRecord["recipe"];
  cwd: Cwd;
};

// One launch of a tab (tab.create with a first run, or tab.reopen), accepted in a single
// transaction: the receipt is looked up again, the tab is created or checked, the run is
// recorded `starting` with its snapshot, the tab points at it, and the receipt is inserted as
// accepted. The spawn follows only after this committed (operations/terminal-operations.ts), so a
// PTY never exists without its run record and receipt, and a crash after the commit leaves a
// `starting` run that the next start marks interrupted.
export type TabLaunchArgs = Omit<DatabaseWriteRequest, "apply"> & {
  method: "tab.create" | "tab.reopen";
  run: RunRef;
  launch: { create: NewTab } | { reopen: { tabId: string } };
  relayInstanceId: string;
  at: number;
  limits: ReceiptLimits;
  responseBytes: number;
};

export type TabLaunchResult =
  | {
      kind: "accepted";
      operation: OperationRecord;
      // The resolved launch: where the run starts and what it runs.
      cwd: string;
      recipe: TabRecord["recipe"];
      tabId: string;
      taskId: string;
    }
  | { kind: "existing"; operation: OperationRecord }
  | { kind: "refused"; error: DomainError };

function insertReceipt(db: Connection, args: TabLaunchArgs, record: OperationRecord): void {
  const inserted = statement(
    db,
    `INSERT INTO operations (server_id, principal_id, operation_id, method, canonical_intent,
       state, revision, record_json, accepted_by_instance_id, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(
    args.key.serverId,
    args.key.principalId,
    args.key.operationId,
    record.method,
    args.canonicalIntent,
    record.state,
    record.revision,
    JSON.stringify(record),
    args.relayInstanceId,
    args.at,
    args.at,
  );
  if (inserted.changes !== 1)
    throw new Rollback({ kind: "refused", error: domainError("BUSY") } satisfies TabLaunchResult);
}

const encoder = new TextEncoder();
const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

export const tabOperations = {
  "tabs.get": (
    db: Connection,
    args: { tabId: string },
  ): { tab: TabRecord; latestRun: RunHistoryRecord | null } | null => {
    const row = tabRow(db, args.tabId);
    return row ? toTab(db, row) : null;
  },

  // Tabs of a task in tabId order, one row beyond `limit` so the caller knows whether another page
  // follows. `afterTabId` need not exist any more. Null when the task does not exist.
  "tabs.list": (
    db: Connection,
    args: { taskId: string; afterTabId: string; limit: number },
  ): { tab: TabRecord; latestRun: RunHistoryRecord | null }[] | null => {
    if (!statement(db, "SELECT 1 FROM tasks WHERE task_id = ?").get(args.taskId)) return null;
    return (
      statement(
        db,
        `SELECT ${TAB_COLUMNS} FROM tabs WHERE task_id = ? AND tab_id > ? ORDER BY tab_id LIMIT ?`,
      ).all(args.taskId, args.afterTabId, args.limit + 1) as TabRow[]
    ).map((row) => toTab(db, row));
  },

  // Runs of a tab, newest first, one row beyond `limit`. `beforeRunId` names a run of this tab
  // (run IDs are unique per server, see TerminalOperations); an unknown one is refused, so a
  // client never silently restarts from the newest run. Null when the tab does not exist.
  "tabs.runs": (
    db: Connection,
    args: { tabId: string; beforeRunId?: string; limit: number },
  ): { runs: RunHistoryRecord[] } | { error: DomainError } | null => {
    if (!tabRow(db, args.tabId)) return null;
    let before = Number.MAX_SAFE_INTEGER;
    if (args.beforeRunId !== undefined) {
      const cursor = statement(
        db,
        "SELECT MAX(run_seq) AS seq FROM runs WHERE tab_id = ? AND run_id = ?",
      ).get(args.tabId, args.beforeRunId) as { seq: number | null };
      if (cursor.seq === null) return refuse("RUN_NOT_FOUND");
      before = cursor.seq;
    }
    return {
      runs: (
        statement(
          db,
          `SELECT ${RUN_COLUMNS} FROM runs WHERE tab_id = ? AND run_seq < ?
           ORDER BY run_seq DESC LIMIT ?`,
        ).all(args.tabId, before, args.limit + 1) as RunRow[]
      ).map(toRunRecord),
    };
  },

  // Runs without an end record, of any tab or none, whose start cwd or recorded mount mapping is
  // `path` or lies below it (D10: a managed worktree is in use while such a run exists). Compared
  // on the recorded real paths; the caller passes a real path too.
  "tabs.liveRunsUsing": (db: Connection, args: { path: string }): RunHistoryRecord[] => {
    const below = args.path.endsWith("/") ? args.path : `${args.path}/`;
    const uses = (candidate: string) => candidate === args.path || candidate.startsWith(below);
    return (
      statement(
        db,
        `SELECT ${RUN_COLUMNS} FROM runs WHERE lifecycle IN ${LIVE} ORDER BY run_seq`,
      ).all() as RunRow[]
    )
      .map(toRunRecord)
      .filter((run) => uses(run.cwd) || run.mounts.some((mount) => uses(mount.path)));
  },

  // See TabLaunchArgs.
  "tabs.launch": (db: Connection, args: TabLaunchArgs): TabLaunchResult => {
    const { key, limits } = args;
    if (key.serverId !== limits.serverId || args.run.serverId !== limits.serverId)
      return { kind: "refused", error: domainError("INVALID_ARGUMENT") };
    const existing = statement(
      db,
      `SELECT canonical_intent, record_json FROM operations
       WHERE server_id = ? AND principal_id = ? AND operation_id = ?`,
    ).get(key.serverId, key.principalId, key.operationId) as
      { canonical_intent: string; record_json: string } | undefined;
    if (existing)
      return existing.canonical_intent === args.canonicalIntent
        ? {
            kind: "existing",
            operation: OperationRecordSchema.parse(JSON.parse(existing.record_json)),
          }
        : { kind: "refused", error: domainError("OPERATION_ID_CONFLICT") };
    const fail = (kind: DomainErrorKind, error = domainError(kind)): never => {
      throw new Rollback({ kind: "refused", error } satisfies TabLaunchResult);
    };

    let tab: TabRow;
    if ("create" in args.launch) {
      const spec = args.launch.create;
      const task = taskRow(db, spec.taskId);
      if (!task) return fail("TASK_NOT_FOUND");
      statement(
        db,
        `INSERT INTO tabs (tab_id, task_id, revision, name, recipe_json, cwd_json, created_at_ms,
           latest_run_seq)
         VALUES (?, ?, 0, ?, ?, ?, ?, NULL)`,
      ).run(
        spec.tabId,
        spec.taskId,
        spec.name,
        JSON.stringify(spec.recipe),
        JSON.stringify(spec.cwd),
        args.at,
      );
      tab = tabRow(db, spec.tabId)!;
    } else {
      const found = tabRow(db, args.launch.reopen.tabId);
      if (!found) return fail("TAB_NOT_FOUND");
      // One run of a tab at a time: a run without an end record blocks a new one, also when
      // its worker is out of contact (that is not proof that it exited).
      const live = liveRunsOfTab(db, found.tab_id);
      if (live.length > 0)
        return fail(
          "LIVE_RUNS_PRESENT",
          domainError("LIVE_RUNS_PRESENT", "not-accepted", undefined, { runs: live }),
        );
      if (found.revision === Number.MAX_SAFE_INTEGER) return fail("COUNTER_EXHAUSTED");
      tab = found;
    }
    const task = taskRow(db, tab.task_id);
    if (!task) return fail("TASK_NOT_FOUND");
    // Archiving takes a task out of use (as for mount.add): its tabs get no new runs until it is
    // unarchived. Stopping and closing stay allowed.
    if (task.archived === 1) return fail("TASK_ARCHIVED");
    const cwd = resolveCwd(db, task, storedCwd(tab.cwd_json));
    if ("error" in cwd) return fail(cwd.error.kind);
    const mounts = mountSnapshot(db, task.workspace_id);
    // A worktree being deleted gets no new run (store/sql/deletions.ts): not in its cwd, and not
    // through the snapshot of an entry run, which maps every mount of the workspace.
    if (deletionPending(db, [cwd.path, ...mounts.map((mount) => mount.path)]))
      return fail("OPERATION_EFFECTS_ACTIVE");
    const runSeq = Number(
      statement(
        db,
        `INSERT INTO runs (server_id, relay_instance_id, run_id, tab_id, task_id,
           workspace_revision, cwd, mounts_json, operation_id, lifecycle, verification,
           started_at_ms, last_observed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', 'live', ?, ?)`,
      ).run(
        args.run.serverId,
        args.run.relayInstanceId,
        args.run.runId,
        tab.tab_id,
        task.task_id,
        task.workspace_revision,
        cwd.path,
        JSON.stringify(mounts),
        key.operationId,
        args.at,
        args.at,
      ).lastInsertRowid,
    );
    const revision = "create" in args.launch ? 0 : tab.revision + 1;
    statement(db, "UPDATE tabs SET revision = ?, latest_run_seq = ? WHERE tab_id = ?").run(
      revision,
      runSeq,
      tab.tab_id,
    );
    // Every read of the tab must fit one response; a launch whose run record could not be read
    // back (a workspace with very many very long mount paths) is refused before it commits.
    if (!tabReadFits(toTab(db, tabRow(db, tab.tab_id)!), args.responseBytes))
      return fail("INVALID_ARGUMENT");
    const result: OperationResultData = { resource: { kind: "tab", id: tab.tab_id, revision } };
    const accepted = checkedReceiptRecord(
      key,
      {
        operationId: key.operationId,
        method: args.method,
        revision: 0,
        state: "accepted",
        run: args.run,
        result,
      },
      limits,
      encodeUtf8,
    );
    if (!accepted) return fail("INVALID_ARGUMENT");
    insertReceipt(db, args, accepted);
    return {
      kind: "accepted",
      operation: accepted,
      cwd: cwd.path,
      recipe: storedRecipe(tab.recipe_json),
      tabId: tab.tab_id,
      taskId: task.task_id,
    };
  },
};

type Applied = { result: OperationResultData } | { error: DomainError };

// Writes applied inside receipts.write (store/sql/receipts.ts).
export const tabWrites = {
  // tab.create with `start: false`: the tab is recorded without a run.
  "tab.create": (db: Connection, args: NewTab & { at: number; responseBytes: number }): Applied => {
    const task = taskRow(db, args.taskId);
    if (!task) return refuse("TASK_NOT_FOUND");
    if (task.archived === 1) return refuse("TASK_ARCHIVED");
    const cwd = resolveCwd(db, task, args.cwd);
    if ("error" in cwd) return cwd;
    statement(
      db,
      `INSERT INTO tabs (tab_id, task_id, revision, name, recipe_json, cwd_json, created_at_ms,
         latest_run_seq)
       VALUES (?, ?, 0, ?, ?, ?, ?, NULL)`,
    ).run(
      args.tabId,
      args.taskId,
      args.name,
      JSON.stringify(args.recipe),
      JSON.stringify(args.cwd),
      args.at,
    );
    if (!tabReadFits(toTab(db, tabRow(db, args.tabId)!), args.responseBytes))
      return refuse("INVALID_ARGUMENT");
    return { result: { resource: { kind: "tab", id: args.tabId, revision: 0 } } };
  },

  // Deletes the tab record, refused while a run of it has no end record (D8). Its runs stay in
  // the history (runs.tab_id becomes NULL, their task and snapshots remain).
  "tab.close": (db: Connection, args: { tabId: string }): Applied => {
    const tab = tabRow(db, args.tabId);
    if (!tab) return refuse("TAB_NOT_FOUND");
    const live = liveRunsOfTab(db, args.tabId);
    if (live.length > 0)
      return {
        error: domainError("LIVE_RUNS_PRESENT", "not-accepted", undefined, { runs: live }),
      };
    if (tab.revision === Number.MAX_SAFE_INTEGER) return refuse("COUNTER_EXHAUSTED");
    statement(db, "UPDATE tabs SET latest_run_seq = NULL WHERE tab_id = ?").run(args.tabId);
    statement(db, "DELETE FROM tabs WHERE tab_id = ?").run(args.tabId);
    return { result: { resource: { kind: "tab", id: args.tabId, revision: tab.revision + 1 } } };
  },
};
