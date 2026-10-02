import { sameWorkerRef, type RunRef, type WorkerRef } from "@cove/protocol/identity";
import type { ByteReservation } from "./runtime-retained-bytes.js";
import { RuntimeComposition } from "./runtime-composition.js";
import { SESSION_CONTROL_RESERVE, type WorkerPipeSession } from "./worker-pipe-session.js";

type Placement = { worker: WorkerRef; session: WorkerPipeSession; run: RunRef };
type WorkerEntry = {
  worker: WorkerRef;
  session: WorkerPipeSession;
  runs: Set<string>;
  lease: ByteReservation;
};

export class WorkerPool {
  private readonly workers: WorkerEntry[] = [];
  private readonly placements = new Map<string, Placement>();
  constructor(
    readonly composition: RuntimeComposition,
    readonly maxWorkers: number,
    readonly runsPerWorker: number,
  ) {
    if (
      this.bytes.controlReserve < maxWorkers * SESSION_CONTROL_RESERVE ||
      !Number.isSafeInteger(maxWorkers) ||
      maxWorkers < 1 ||
      maxWorkers > this.budgets.maxRuns ||
      !Number.isSafeInteger(runsPerWorker) ||
      runsPerWorker < 1 ||
      runsPerWorker > this.budgets.maxRuns
    )
      throw new Error("Invalid pool limits");
  }

  get budgets() {
    return this.composition.budgets;
  }
  private get bytes() {
    return this.composition.bytes;
  }

  accepts(session: WorkerPipeSession): boolean {
    return session.composition === this.composition && this.composition.owns(session.worker);
  }

  add(session: WorkerPipeSession): boolean {
    if (
      !this.accepts(session) ||
      this.workers.length >= this.maxWorkers ||
      this.workers.some((entry) => entry.worker.workerId === session.worker.workerId)
    )
      return false;
    const lease = this.bytes.reserve(4096);
    if (!lease) return false;
    this.workers.push({ worker: { ...session.worker }, session, runs: new Set(), lease });
    return true;
  }

  reserve(run: RunRef): Placement | null {
    if (this.placements.has(run.runId) || this.placements.size >= this.budgets.maxRuns) return null;
    let selected: WorkerEntry | undefined;
    for (const entry of this.workers) {
      if (
        !entry.session.ready ||
        entry.worker.serverId !== run.serverId ||
        entry.worker.relayInstanceId !== run.relayInstanceId ||
        entry.runs.size >= this.runsPerWorker
      )
        continue;
      if (!selected || entry.runs.size < selected.runs.size) selected = entry;
    }
    if (!selected) return null;
    const placement = {
      worker: { ...selected.worker },
      session: selected.session,
      run: { ...run },
    };
    selected.runs.add(run.runId);
    this.placements.set(run.runId, placement);
    return { ...placement, worker: { ...placement.worker }, run: { ...placement.run } };
  }

  get(run: RunRef): Placement | null {
    const found = this.placements.get(run.runId);
    return found &&
      found.run.serverId === run.serverId &&
      found.run.relayInstanceId === run.relayInstanceId
      ? { ...found, worker: { ...found.worker }, run: { ...found.run } }
      : null;
  }

  release(run: RunRef, worker: WorkerRef): boolean {
    const found = this.get(run);
    if (!found || !sameWorkerRef(found.worker, worker)) return false;
    this.placements.delete(run.runId);
    this.workers.find((entry) => sameWorkerRef(entry.worker, worker))!.runs.delete(run.runId);
    return true;
  }

  sessions(): readonly WorkerPipeSession[] {
    return this.workers.map((entry) => entry.session);
  }
  snapshot(): { workers: number; runs: number; readyWorkers: number } {
    return {
      workers: this.workers.length,
      runs: this.placements.size,
      readyWorkers: this.workers.filter((entry) => entry.session.ready).length,
    };
  }
  dispose(): void {
    for (const entry of this.workers) entry.lease.release();
    this.workers.length = 0;
    this.placements.clear();
  }
}
