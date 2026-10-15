import type { RunRef } from "@cove/protocol/identity";
import type { Store } from "./database.js";

export type LiveRunRecord = {
  run: RunRef;
  cwd: string;
  tabId: string | null;
  startedAtMs: number;
};

// Durable run records (D8, D9) for the runs this server starts. M1 T1 records the M0
// `terminal.create` runs and the restart semantics; T4 links tab runs, workspace revisions and
// mount snapshots to the same rows.
//
// A run of an earlier relay instance is never shown as live (D9): an orderly stop records it as
// stopped-with-server; any other end of the instance leaves it to the next start, which records it
// as interrupted and unverifiable without probing old PIDs.
export class RunLog {
  private readonly statements;
  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    const db = store.db;
    this.statements = {
      start: db.prepare(
        `INSERT INTO runs (server_id, relay_instance_id, run_id, cwd, mounts_json, operation_id,
           lifecycle, verification, started_at_ms, last_observed_at_ms)
         VALUES (?, ?, ?, ?, '[]', ?, 'starting', 'live', ?, ?)`,
      ),
      running: db.prepare(
        `UPDATE runs SET lifecycle = 'running', last_observed_at_ms = ?
         WHERE relay_instance_id = ? AND run_id = ? AND server_id = ? AND lifecycle = 'starting'`,
      ),
      discard: db.prepare(
        `DELETE FROM runs WHERE relay_instance_id = ? AND run_id = ? AND server_id = ?
           AND lifecycle = 'starting' AND tab_id IS NULL`,
      ),
      exited: db.prepare(
        `UPDATE runs SET lifecycle = 'exited', verification = 'final', ended_at_ms = ?,
           last_observed_at_ms = ?, exit_code = ?, signal = ?
         WHERE relay_instance_id = ? AND run_id = ? AND server_id = ?
           AND lifecycle IN ('starting', 'running')`,
      ),
      live: db.prepare(
        `SELECT server_id, relay_instance_id, run_id, cwd, tab_id, started_at_ms FROM runs
         WHERE relay_instance_id = ? AND lifecycle IN ('starting', 'running') ORDER BY run_seq`,
      ),
      stopped: db.prepare(
        `UPDATE runs SET lifecycle = 'stopped-with-server', verification = ?, ended_at_ms = ?,
           last_observed_at_ms = ?
         WHERE relay_instance_id = ? AND lifecycle IN ('starting', 'running')`,
      ),
      interrupted: db.prepare(
        `UPDATE runs SET lifecycle = 'interrupted', verification = 'unverifiable'
         WHERE relay_instance_id <> ? AND lifecycle IN ('starting', 'running')`,
      ),
    };
  }

  // Recorded when a run is accepted, before the spawn command reaches a worker, so a crash at any
  // later point still leaves a record for the next start to mark interrupted.
  started(run: RunRef, cwd: string, operationId: string | null): void {
    const at = this.now();
    this.store.transaction(() =>
      this.statements.start.run(
        run.serverId,
        run.relayInstanceId,
        run.runId,
        cwd,
        operationId,
        at,
        at,
      ),
    );
  }

  spawned(run: RunRef): void {
    this.store.transaction(() =>
      this.statements.running.run(this.now(), run.relayInstanceId, run.runId, run.serverId),
    );
  }

  // The worker definitely refused the spawn: no process ever existed for this run.
  notStarted(run: RunRef): void {
    this.store.transaction(() =>
      this.statements.discard.run(run.relayInstanceId, run.runId, run.serverId),
    );
  }

  exited(run: RunRef, exitCode: number | null, signal: string | null): void {
    const at = this.now();
    this.store.transaction(() =>
      this.statements.exited.run(
        at,
        at,
        exitCode,
        signal,
        run.relayInstanceId,
        run.runId,
        run.serverId,
      ),
    );
  }

  live(relayInstanceId: string): LiveRunRecord[] {
    return (
      this.statements.live.all(relayInstanceId) as {
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
    }));
  }

  // Orderly stop of this instance: its runs end with the server. `verified` says whether the
  // worker reported its own exit, which ends every PTY it owned.
  stoppedWithServer(relayInstanceId: string, verified: boolean): number {
    const at = this.now();
    return this.store.transaction(
      () =>
        this.statements.stopped.run(verified ? "final" : "unverifiable", at, at, relayInstanceId)
          .changes,
    );
  }

  // Startup: runs of earlier instances that never recorded an end are interrupted and
  // unverifiable. Their last observation and instance stay as recorded; old PIDs are not probed.
  interruptEarlier(currentRelayInstanceId: string): number {
    return this.store.transaction(
      () => this.statements.interrupted.run(currentRelayInstanceId).changes,
    );
  }
}
