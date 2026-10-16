import type { RunRef } from "@cove/protocol/identity";
import type { Store } from "./database.js";
import type { LiveRunRecord } from "./sql/runs.js";

export type { LiveRunRecord };

// Durable run records (D8, D9) for the runs this server starts. M1 T1 records the M0
// `terminal.create` runs and the restart semantics; T4 links tab runs, workspace revisions and
// mount snapshots to the same rows. The SQL is in store/sql/runs.ts.
//
// A run of an earlier relay instance is never shown as live (D9): an orderly stop records it as
// stopped-with-server; any other end of the instance leaves it to the next start, which records it
// as interrupted and unverifiable without probing old PIDs.
//
// The store executes calls in the order they are made, so records written for one run keep their
// order (started, then spawned or not started, then exited) even when a caller does not await
// each one, and an orderly stop's stoppedWithServer comes after every exit recorded before it.
export class RunLog {
  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  // Recorded when a run is accepted, before the spawn command reaches a worker, so a crash at any
  // later point still leaves a record for the next start to mark interrupted.
  started(run: RunRef, cwd: string, operationId: string | null): Promise<void> {
    return this.store.call("runs.started", { run, cwd, operationId, at: this.now() });
  }

  spawned(run: RunRef): Promise<void> {
    return this.store.call("runs.spawned", { run, at: this.now() });
  }

  // The worker definitely refused the spawn: no process ever existed for this run.
  notStarted(run: RunRef): Promise<void> {
    return this.store.call("runs.notStarted", { run });
  }

  exited(run: RunRef, exitCode: number | null, signal: string | null): Promise<void> {
    return this.store.call("runs.exited", { run, exitCode, signal, at: this.now() });
  }

  live(relayInstanceId: string): Promise<LiveRunRecord[]> {
    return this.store.call("runs.live", { relayInstanceId });
  }

  // Orderly stop of this instance: its runs end with the server. `verified` says whether the
  // worker reported its own exit, which ends every PTY it owned.
  stoppedWithServer(relayInstanceId: string, verified: boolean): Promise<number> {
    return this.store.call("runs.stoppedWithServer", {
      relayInstanceId,
      verified,
      at: this.now(),
    });
  }

  // Startup: runs of earlier instances that never recorded an end are interrupted and
  // unverifiable. Their last observation and instance stay as recorded; old PIDs are not probed.
  interruptEarlier(currentRelayInstanceId: string): Promise<number> {
    return this.store.call("runs.interruptEarlier", { currentRelayInstanceId });
  }
}
