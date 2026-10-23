import { BUSINESS_LIMITS, type BusinessChange } from "@cove/protocol/business-events";
import type { Connection } from "./sql/statements.js";
import { projectBusinessRecord, type DirtyBusinessRecord } from "./sql/business-events.js";

export type StoreBusinessPublication = { changes: BusinessChange[] } | { reset: true };

// The TEMP journal is per-connection memory, never a durable outbox or a database migration.
// SQLite triggers cover background paths and cascades as well as RPC writes; their additions
// roll back with the operation. The capped journal never refuses a legitimate business write:
// saturation marks the publication uncertain, requiring a new snapshot after the commit.
export class BusinessJournal {
  constructor(
    private readonly db: Connection,
    private readonly defaultRoot: string,
  ) {
    db.exec(`CREATE TEMP TABLE cove_business_dirty(kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id)) WITHOUT ROWID;
      CREATE TEMP TABLE cove_business_overflow(value INTEGER NOT NULL);
      INSERT INTO cove_business_overflow VALUES(0);`);
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((row) => row.name),
    );
    const mark = (kind: string, select: string) => `
      INSERT OR IGNORE INTO cove_business_dirty SELECT '${kind}', id FROM (${select})
        LIMIT max(0, ${BUSINESS_LIMITS.journalItems}-(SELECT count(*) FROM cove_business_dirty));
      UPDATE cove_business_overflow SET value=1 WHERE (SELECT count(*) FROM cove_business_dirty)>=${BUSINESS_LIMITS.journalItems};`;
    const task = (row: string, table: string) =>
      table === "tasks"
        ? `SELECT ${row}.task_id AS id`
        : table === "workspaces" || table === "managed_worktrees"
          ? `SELECT ${row}.task_id AS id`
          : table === "mounts"
            ? `SELECT w.task_id AS id FROM workspaces w WHERE w.workspace_id=${row}.workspace_id
          UNION SELECT w.task_id AS id FROM mounts m JOIN workspaces w ON w.workspace_id=m.workspace_id WHERE m.path=${row}.path`
            : `SELECT w.task_id AS id FROM workspaces w WHERE w.workspace_id=${row}.workspace_id`;
    for (const table of [
      "repos",
      "tasks",
      "workspaces",
      "mounts",
      "managed_worktrees",
      "bindings",
      "tabs",
      "runs",
      "operations",
      "config",
      "entry_config",
    ]) {
      if (!tables.has(table)) continue;
      for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
        const row = action === "DELETE" ? "OLD" : "NEW";
        let body: string;
        if (["tasks", "workspaces", "mounts", "managed_worktrees", "bindings"].includes(table)) {
          body = mark("task", task(row, table));
          // Moving/removing a shared checkout changes the derived sharedWithTaskIds of both
          // the former and new siblings without necessarily increasing their own revisions.
          if (table === "mounts" && action === "UPDATE") body += mark("task", task("OLD", table));
        } else if (table === "runs")
          body = mark("run", `SELECT json_array(${row}.relay_instance_id,${row}.run_id) AS id`);
        else
          body = mark(
            table === "repos"
              ? "repo"
              : table === "tabs"
                ? "tab"
                : table === "operations"
                  ? "operation"
                  : "config",
            `SELECT ${table === "config" ? "'server'" : table === "entry_config" ? "'entry'" : `${row}.${table === "repos" ? "repo_id" : table === "tabs" ? "tab_id" : "operation_id"}`} AS id`,
          );
        db.exec(
          `CREATE TEMP TRIGGER cove_business_${table}_${action} AFTER ${action} ON main.${table} BEGIN ${body} END;`,
        );
      }
    }
  }
  clear(): void {
    this.db.exec("DELETE FROM cove_business_dirty; UPDATE cove_business_overflow SET value=0");
  }
  collect(): StoreBusinessPublication {
    try {
      if (
        (this.db.prepare("SELECT value FROM cove_business_overflow").get() as { value: number })
          .value
      )
        return { reset: true };
      const keys = this.db
        .prepare("SELECT kind,id FROM cove_business_dirty ORDER BY kind,id")
        .all() as DirtyBusinessRecord[];
      const changes: BusinessChange[] = [];
      let bytes = 0;
      for (const key of keys) {
        const value = projectBusinessRecord(this.db, key, this.defaultRoot);
        const change: BusinessChange = value
          ? { type: "upsert", value }
          : { type: "delete", ...key };
        bytes += Buffer.byteLength(JSON.stringify(change));
        if (bytes > BUSINESS_LIMITS.windowBytes) return { reset: true };
        changes.push(change);
      }
      return { changes };
    } catch {
      // Projection failure cannot turn a committed business effect into a false refusal. Commit
      // the original operation and invalidate publication; later reads expose the real error.
      return { reset: true };
    }
  }
}
