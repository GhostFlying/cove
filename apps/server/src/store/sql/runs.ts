import type { RunRef } from "@cove/protocol/identity";
import { statement, type Connection } from "./statements.js";

export type LiveRunRecord = {
  run: RunRef;
  cwd: string;
  tabId: string | null;
  startedAtMs: number;
};

// Durable run records (D8, D9); see store/runs.ts for the lifecycle they implement.
export const runOperations = {
  "runs.started": (
    db: Connection,
    args: { run: RunRef; cwd: string; operationId: string | null; at: number },
  ): void => {
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
  },

  "runs.spawned": (db: Connection, args: { run: RunRef; at: number }): void => {
    statement(
      db,
      `UPDATE runs SET lifecycle = 'running', last_observed_at_ms = ?
       WHERE relay_instance_id = ? AND run_id = ? AND server_id = ? AND lifecycle = 'starting'`,
    ).run(args.at, args.run.relayInstanceId, args.run.runId, args.run.serverId);
  },

  "runs.notStarted": (db: Connection, args: { run: RunRef }): void => {
    statement(
      db,
      `DELETE FROM runs WHERE relay_instance_id = ? AND run_id = ? AND server_id = ?
         AND lifecycle = 'starting' AND tab_id IS NULL`,
    ).run(args.run.relayInstanceId, args.run.runId, args.run.serverId);
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
