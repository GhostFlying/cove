import type { RunRef, WorkerRef } from "@cove/protocol/identity";
import type { RunStatus } from "@cove/protocol/pipe";
import { RunRegistry } from "../terminal/run-registry.js";
import type { RuntimeComposition } from "../terminal/runtime-composition.js";
import type { RunLog } from "../store/runs.js";

// The run registry of a server with a store: every exit fact the registry accepts is also written
// to the durable run record (D9). The registry stays the only source of exit facts, so the terminal
// path is unchanged; a failed record write never affects the live run state.
//
// The write is not awaited (the registry's observers are synchronous). The store executes calls in
// the order they are made, so the exit is recorded after the run's start and spawn records, and
// before the stoppedWithServer of an orderly stop, which closes the store only after draining.
export class RecordingRunRegistry extends RunRegistry {
  constructor(
    composition: RuntimeComposition,
    private readonly runs: RunLog,
  ) {
    super(composition);
  }

  private record(run: RunRef): void {
    const status = this.get(run)?.status;
    if (status?.status !== "exited") return;
    this.runs.exited(run, status.exitCode, status.signal).catch(() => {
      /* The record stays live; the next start marks it interrupted rather than exited. */
    });
  }

  // A spawn the worker definitely refused started nothing, so its starting record is dropped
  // (runs.notStarted, which also points its tab back at the previous run). Terminal operations do
  // the same for a refusal that answers the launch in time; this covers one that arrives after the
  // launch was answered RESULT_UNKNOWN, which otherwise left the run starting and its tab
  // blocked. A second notStarted for the same run finds no starting row and changes nothing.
  override retireRefusedSpawn(run: RunRef, worker: WorkerRef): boolean {
    const retired = super.retireRefusedSpawn(run, worker);
    if (retired)
      this.runs.notStarted(run).catch(() => {
        /* The record stays starting; the next start marks it interrupted. */
      });
    return retired;
  }

  override observe(worker: WorkerRef, status: RunStatus): boolean {
    const accepted = super.observe(worker, status);
    if (accepted) this.record(status.run);
    return accepted;
  }

  override observeExit(
    worker: WorkerRef,
    run: RunRef,
    exit: Pick<RunStatus, "exitCode" | "signal">,
  ): boolean {
    const accepted = super.observeExit(worker, run, exit);
    if (accepted) this.record(run);
    return accepted;
  }
}
