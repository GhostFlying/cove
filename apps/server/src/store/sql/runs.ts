import type { RunRef } from "@cove/protocol/identity";
import { deletionPending } from "./deletions.js";
import { statement, type Connection } from "./statements.js";

export type LiveRunRecord = {
  run: RunRef;
  cwd: string;
  tabId: string | null;
  startedAtMs: number;
};

// Durable run records (D8, D9); see store/runs.ts for the lifecycle they implement.
export const runOperations = {
  // "refused", with nothing written, when the cwd is in a managed worktree being deleted
  // (store/sql/deletions.ts).
  "runs.started": (
    db: Connection,
    args: { run: RunRef; cwd: string; operationId: string | null; at: number },
  ): "recorded" | "refused" => {
    if (deletionPending(db, [args.cwd])) return "refused";
    statement(
      db,
      `INSERT INTO runs (server_id, relay_instance_id, run_id, cwd, mounts_json, operation_id,
         lifecycle, verification, started_at_ms, last_observed_at_ms)
       VALUES (?, ?, ?, ?, '[]', ?, 'starting', 'live', ?, ?)`,
    ).run(
      args.run.serverId,
      args.run.relayInstanceId,
      args.run.runId,
      args.cwd,
      args.operationId,
      args.at,
      args.at,
    );
    return "recorded";
  },

  "runs.spawned": (db: Connection, args: { run: RunRef; at: number }): void => {
    statement(
      db,
      `UPDATE runs SET lifecycle = 'running', last_observed_at_ms = ?
       WHERE relay_instance_id = ? AND run_id = ? AND server_id = ? AND lifecycle = 'starting'`,
    ).run(args.at, args.run.relayInstanceId, args.run.runId, args.run.serverId);
  },

  // No process ever existed for the run, so it leaves no history. A tab whose latest run it was
  // points at its previous run again (or none), with a new revision (T4).
  "runs.notStarted": (db: Connection, args: { run: RunRef }): void => {
    const row = statement(
      db,
      `SELECT run_seq, tab_id FROM runs WHERE relay_instance_id = ? AND run_id = ? AND server_id = ?
         AND lifecycle = 'starting'`,
    ).get(args.run.relayInstanceId, args.run.runId, args.run.serverId) as
      { run_seq: number; tab_id: string | null } | undefined;
    if (!row) return;
    if (row.tab_id !== null)
      statement(
        db,
        `UPDATE tabs SET revision = revision + 1, latest_run_seq = (
           SELECT MAX(run_seq) FROM runs WHERE tab_id = ? AND run_seq <> ?)
         WHERE tab_id = ? AND latest_run_seq = ?`,
      ).run(row.tab_id, row.run_seq, row.tab_id, row.run_seq);
    statement(db, "DELETE FROM runs WHERE run_seq = ?").run(row.run_seq);
  },

  // The highest number N among the run IDs of the form run-N this server ever handed out, 0 when
  // there is none. A new instance continues after it, so a run ID names one run of this server,
  // a tab's run history can page by run ID, and a client holding a run ID (the CLI's `--run` pin)
  // never matches a later run (TerminalOperations, T4).
  //
  // A run that never started leaves no row (runs.notStarted), so the run rows alone would let its
  // number be handed out again after a restart. Every run ID a client can hold came either from
  // a run row or from an operation receipt naming it (a launch's receipt records its run before
  // the spawn, and a refused one keeps it as a failed receipt), and receipts are never deleted,
  // so the maximum over both is a durable high-water mark. A future receipt retention must keep
  // the highest run number it removes (in a counter) before deleting receipts.
  "runs.highestNumber": (db: Connection): number => {
    const row = statement(
      db,
      `SELECT MAX(CAST(substr(id, 5) AS INTEGER)) AS n FROM (
         SELECT run_id AS id FROM runs
         UNION ALL
         SELECT json_extract(record_json, '$.run.runId') AS id FROM operations
       )
       WHERE id GLOB 'run-[1-9]*' AND id NOT GLOB 'run-*[^0-9]*'`,
    ).get() as { n: number | null };
    return row.n ?? 0;
  },

  "runs.exited": (
    db: Connection,
    args: { run: RunRef; exitCode: number | null; signal: string | null; at: number },
  ): void => {
    statement(
      db,
      `UPDATE runs SET lifecycle = 'exited', verification = 'final', ended_at_ms = ?,
         last_observed_at_ms = ?, exit_code = ?, signal = ?
       WHERE relay_instance_id = ? AND run_id = ? AND server_id = ?
         AND lifecycle IN ('starting', 'running')`,
    ).run(
      args.at,
      args.at,
      args.exitCode,
      args.signal,
      args.run.relayInstanceId,
      args.run.runId,
      args.run.serverId,
    );
  },

  "runs.live": (db: Connection, args: { relayInstanceId: string }): LiveRunRecord[] =>
    (
      statement(
        db,
        `SELECT server_id, relay_instance_id, run_id, cwd, tab_id, started_at_ms FROM runs
         WHERE relay_instance_id = ? AND lifecycle IN ('starting', 'running') ORDER BY run_seq`,
      ).all(args.relayInstanceId) as {
        server_id: string;
        relay_instance_id: string;
        run_id: string;
        cwd: string;
        tab_id: string | null;
        started_at_ms: number;
      }[]
    ).map((row) => ({
      run: { serverId: row.server_id, relayInstanceId: row.relay_instance_id, runId: row.run_id },
      cwd: row.cwd,
      tabId: row.tab_id,
      startedAtMs: row.started_at_ms,
    })),

  "runs.stoppedWithServer": (
    db: Connection,
    args: { relayInstanceId: string; verified: boolean; at: number },
  ): number =>
    statement(
      db,
      `UPDATE runs SET lifecycle = 'stopped-with-server', verification = ?, ended_at_ms = ?,
         last_observed_at_ms = ?
       WHERE relay_instance_id = ? AND lifecycle IN ('starting', 'running')`,
    ).run(args.verified ? "final" : "unverifiable", args.at, args.at, args.relayInstanceId).changes,

  "runs.interruptEarlier": (db: Connection, args: { currentRelayInstanceId: string }): number =>
    statement(
      db,
      `UPDATE runs SET lifecycle = 'interrupted', verification = 'unverifiable'
       WHERE relay_instance_id <> ? AND lifecycle IN ('starting', 'running')`,
    ).run(args.currentRelayInstanceId).changes,
};
