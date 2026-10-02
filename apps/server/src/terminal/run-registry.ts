import { sameRunRef, sameWorkerRef, type RunRef, type WorkerRef } from "@cove/protocol/identity";
import { RunStatusSchema, type RunStatus } from "@cove/protocol/pipe";
import type { Geometry } from "@cove/protocol/profile";
import type { ByteReservation } from "./runtime-retained-bytes.js";
import { RuntimeComposition } from "./runtime-composition.js";

type Entry = {
  run: RunRef;
  worker: WorkerRef;
  status: RunStatus;
  capacityOwned: boolean;
  dispatched: boolean;
  lease: ByteReservation;
};
const copy = (status: RunStatus): RunStatus => structuredClone(status);

export class RunRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(
    readonly composition: RuntimeComposition,
    readonly maxRuns: number = composition.budgets.maxRuns,
  ) {
    if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > composition.budgets.maxRuns)
      throw new Error("Invalid run limit");
  }

  private get bytes() {
    return this.composition.bytes;
  }

  reserve(run: RunRef, worker: WorkerRef, geometry: Geometry): boolean {
    if (
      !this.composition.owns(run) ||
      !this.composition.owns(worker) ||
      this.entries.has(run.runId) ||
      this.entries.size >= this.maxRuns
    )
      return false;
    const status = RunStatusSchema.safeParse({
      run,
      geometry,
      status: "unverifiable",
      controlEpoch: 0,
      controlHolder: null,
      receivedSeq: null,
      parsedSeq: null,
      recovery: "unavailable",
      exitCode: null,
      signal: null,
    });
    if (!status.success) return false;
    const lease = this.bytes.reserve(8192);
    if (!lease) return false;
    this.entries.set(run.runId, {
      run: { ...run },
      worker: { ...worker },
      status: copy(status.data),
      capacityOwned: true,
      dispatched: false,
      lease,
    });
    return true;
  }

  get(run: RunRef): { worker: WorkerRef; status: RunStatus; capacityOwned: boolean } | null {
    const entry = this.entries.get(run.runId);
    return entry && sameRunRef(run, entry.run)
      ? {
          worker: { ...entry.worker },
          status: copy(entry.status),
          capacityOwned: entry.capacityOwned,
        }
      : null;
  }

  observe(worker: WorkerRef, status: RunStatus): boolean {
    const parsed = RunStatusSchema.safeParse(status);
    const entry = this.entries.get(status.run.runId);
    if (
      !parsed.success ||
      !entry ||
      !sameRunRef(entry.run, status.run) ||
      !sameWorkerRef(entry.worker, worker)
    )
      return false;
    // A run cannot be resurrected by a delayed status reply.
    if (entry.status.status === "exited") return status.status === "exited";
    entry.status = copy(parsed.data);
    return true;
  }

  contactLost(worker: WorkerRef): void {
    for (const entry of this.entries.values()) {
      if (sameWorkerRef(entry.worker, worker) && entry.status.status !== "exited") {
        entry.status = { ...entry.status, status: "unverifiable", recovery: "unavailable" };
      }
    }
  }

  markDispatched(run: RunRef, worker: WorkerRef): boolean {
    const entry = this.entries.get(run.runId);
    if (!entry || !sameRunRef(run, entry.run) || !sameWorkerRef(worker, entry.worker)) return false;
    entry.dispatched = true;
    return true;
  }

  cancelReservation(run: RunRef, worker: WorkerRef): boolean {
    const entry = this.entries.get(run.runId);
    if (
      !entry ||
      !sameRunRef(run, entry.run) ||
      !sameWorkerRef(worker, entry.worker) ||
      entry.dispatched
    )
      return false;
    this.entries.delete(run.runId);
    entry.lease.release();
    return true;
  }

  releaseCapacity(run: RunRef, worker: WorkerRef): boolean {
    const entry = this.entries.get(run.runId);
    if (
      !entry ||
      !sameRunRef(run, entry.run) ||
      !sameWorkerRef(worker, entry.worker) ||
      !entry.capacityOwned
    )
      return false;
    entry.capacityOwned = false;
    return true;
  }

  list(): readonly RunStatus[] {
    return [...this.entries.values()].map((entry) => copy(entry.status));
  }
  get count(): number {
    return this.entries.size;
  }
  dispose(): void {
    for (const entry of this.entries.values()) entry.lease.release();
    this.entries.clear();
  }
}
