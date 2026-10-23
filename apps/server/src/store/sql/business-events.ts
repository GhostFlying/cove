import { BUSINESS_LIMITS, type BusinessRecord } from "@cove/protocol/business-events";
import { OperationRecordSchema } from "@cove/protocol/rpc";
import { configOperations } from "./config.js";
import { entryOperations } from "./entry.js";
import { findRepo } from "./repos.js";
import { tabOperations, toRunRecord } from "./tabs.js";
import { workspaceOperations } from "./workspaces.js";
import { statement, type Connection } from "./statements.js";

type Kind = Exclude<BusinessRecord["kind"], "runtime">;
export type DirtyBusinessRecord = { kind: Kind; id: string };
const LIVE = "('starting','running')";

// These are stored projections only, not domain reads that inspect/recreate a filesystem entry.
// All projection queries run on the worker connection in the SAME transaction as their writes.
export function projectBusinessRecord(
  db: Connection,
  key: DirtyBusinessRecord,
  defaultRoot: string,
): BusinessRecord | null {
  const { kind, id } = key;
  switch (kind) {
    case "repo": {
      const repo = findRepo(db, id);
      return repo ? { kind, id, record: repo.record } : null;
    }
    case "task": {
      const task = workspaceOperations["tasks.get"](db, { taskId: id });
      if (!task) return null;
      const record = task.record;
      return {
        kind,
        id,
        filesystem: "unobserved",
        record: { ...record, workspace: { ...record.workspace, entryState: "unavailable" } },
      };
    }
    case "tab": {
      const tab = tabOperations["tabs.get"](db, { tabId: id });
      return tab ? { kind, id, record: tab.tab } : null;
    }
    case "run": {
      const [instance, run] = JSON.parse(id) as [string, string];
      const row = statement(
        db,
        "SELECT * FROM runs WHERE relay_instance_id = ? AND run_id = ?",
      ).get(instance, run) as Parameters<typeof toRunRecord>[0] | undefined;
      return row ? { kind, id, record: toRunRecord(row) } : null;
    }
    case "operation": {
      const row = statement(db, "SELECT record_json FROM operations WHERE operation_id = ?").get(
        id,
      ) as { record_json: string } | undefined;
      return row
        ? { kind, id, record: OperationRecordSchema.parse(JSON.parse(row.record_json)) }
        : null;
    }
    case "config": {
      if (id === "entry") {
        const { revision, ...settings } = entryOperations["entry.read"](db);
        return { kind, id, record: { revision, settings } };
      }
      const state = configOperations["config.read"](db);
      return {
        kind,
        id: "server",
        record: {
          revision: state.revision,
          settings: {
            workspaceRoot: {
              value: state.workspaceRoot ?? defaultRoot,
              isDefault: state.workspaceRoot === null,
            },
          },
        },
      };
    }
  }
}

export type BusinessSnapshotResult =
  { records: BusinessRecord[] } | { error: "snapshot-too-large" };

export function businessSnapshot(db: Connection, defaultRoot: string): BusinessSnapshotResult {
  const records: BusinessRecord[] = [];
  let bytes = 0;
  const add = (key: DirtyBusinessRecord): boolean => {
    const value = projectBusinessRecord(db, key, defaultRoot);
    if (!value) return true;
    bytes += Buffer.byteLength(JSON.stringify(value));
    if (records.length >= BUSINESS_LIMITS.snapshotItems || bytes > BUSINESS_LIMITS.snapshotBytes)
      return false;
    records.push(value);
    return true;
  };
  // Iterate, rather than .all(), so an oversized existing database cannot force unbounded
  // allocation before the honest snapshot-too-large result. No pagination transaction is left
  // open across worker messages; the entire retained immutable view is captured in this call.
  for (const [kind, sql] of [
    ["repo", "SELECT repo_id AS id FROM repos ORDER BY repo_id"],
    ["task", "SELECT task_id AS id FROM tasks ORDER BY task_id"],
    ["tab", "SELECT tab_id AS id FROM tabs ORDER BY tab_id"],
    [
      "run",
      `SELECT json_array(relay_instance_id,run_id) AS id FROM runs WHERE lifecycle IN ${LIVE} OR run_seq IN (SELECT latest_run_seq FROM tabs WHERE latest_run_seq IS NOT NULL) ORDER BY run_seq`,
    ],
    [
      "operation",
      "SELECT operation_id AS id FROM operations WHERE state NOT IN ('succeeded','failed','cancelled') ORDER BY operation_id",
    ],
    ["config", "SELECT 'server' AS id FROM config"],
    ["config", "SELECT 'entry' AS id FROM entry_config"],
  ] as const) {
    for (const row of statement(db, sql).iterate() as Iterable<{ id: string }>)
      if (!add({ kind, id: row.id })) return { error: "snapshot-too-large" };
  }
  return { records };
}

// Snapshot is a complete current-resource view, with an explicitly bounded history selection.
// A client retains its own unresolved IDs and queries operation.get even when absent here.
export const businessOperations = {
  "business.snapshot": (
    db: Connection,
    args: { defaultWorkspaceRoot: string },
  ): BusinessSnapshotResult => businessSnapshot(db, args.defaultWorkspaceRoot),
};
