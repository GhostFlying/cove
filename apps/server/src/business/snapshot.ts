import {
  BUSINESS_LIMITS,
  BusinessRuntimeFactSchema,
  businessRunId,
  type BusinessFilter,
  type BusinessRecord,
} from "@cove/protocol/business-events";
import { sameRunRef, sameWorkerRef, type RunRef } from "@cove/protocol/identity";
import type { RunStatus } from "@cove/protocol/pipe";
import type { Store } from "../store/database.js";
import type { LocalRuntime } from "../terminal/local-runtime.js";
import { BusinessEventStream } from "./event-stream.js";

type RuntimeObservation = { value: Extract<BusinessRecord, { kind: "runtime" }>; atSeq: number };

export class BusinessSnapshots {
  readonly stream: BusinessEventStream;
  private readonly facts = new Map<string, RuntimeObservation>();
  private readonly runtimeListener: { dispose(): void };
  private snapshots = 0;
  private closed = false;
  constructor(
    private readonly store: Store,
    private readonly runtime: LocalRuntime,
    private readonly defaultWorkspaceRoot: string,
    createId: () => string,
  ) {
    this.stream = new BusinessEventStream(runtime.composition, createId);
    const uncertain = () => this.stream.invalidate("publication-uncertain", store.failed);
    store.observeBusiness({
      publish: (publication) => {
        if ("reset" in publication) uncertain();
        else this.stream.publish(publication.changes);
      },
      uncertain,
    });
    runtime.registry.observeBusiness({
      changed: (run, _worker, status) => {
        if (status) this.observe(status);
        else {
          const id = businessRunId(run);
          if (this.facts.delete(id)) this.stream.publish([{ type: "delete", kind: "runtime", id }]);
        }
      },
      uncertain,
    });
    for (const status of runtime.registry.list()) this.observe(status);
    this.runtimeListener = runtime.onEvent((event) => {
      try {
        const terminal = event.terminal;
        if (terminal.type !== "control" && terminal.type !== "resize") return;
        const current = this.facts.get(businessRunId(event.run));
        const placement = runtime.registry.get(event.run);
        if (
          !current ||
          !placement ||
          !sameWorkerRef(placement.worker, event.worker) ||
          !sameRunRef(current.value.record.run, event.run) ||
          current.value.record.status === "exited" ||
          terminal.seq < current.atSeq
        )
          return;
        const fact = current.value.record;
        const status: RunStatus = {
          ...fact,
          status: "live",
          geometry: terminal.geometry,
          ...(terminal.type === "control"
            ? { controlEpoch: terminal.epoch, controlHolder: terminal.holder }
            : {}),
          receivedSeq: terminal.seq,
          parsedSeq: terminal.seq,
        };
        this.observe(status);
      } catch {
        uncertain();
      }
    });
  }
  private observe(status: RunStatus): void {
    const id = businessRunId(status.run);
    const previous = this.facts.get(id);
    if (previous?.value.record.status === "exited" && status.status !== "exited") return;
    const atSeq = status.parsedSeq ?? -1;
    let record = BusinessRuntimeFactSchema.parse(status);
    if (
      previous &&
      (atSeq < previous.atSeq || record.controlEpoch < previous.value.record.controlEpoch)
    ) {
      // Contact loss may invalidate a newer observation, and an exit may settle it, but an
      // older status response never rolls back a newer control/geometry boundary.
      record = {
        ...previous.value.record,
        status: record.status,
        recovery: record.recovery,
        ...(record.status === "exited" ? { exitCode: record.exitCode, signal: record.signal } : {}),
      };
    }
    const value: RuntimeObservation["value"] = { kind: "runtime", id, record };
    this.facts.set(id, { value, atSeq: Math.max(atSeq, previous?.atSeq ?? -1) });
    if (JSON.stringify(previous?.value) !== JSON.stringify(value))
      this.stream.publish([{ type: "upsert", value }]);
  }
  capture(filter: BusinessFilter) {
    if (this.closed || this.snapshots >= BUSINESS_LIMITS.concurrentSnapshots)
      return Promise.resolve({ error: "busy" as const });
    this.snapshots++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.snapshots--;
      }
    };
    return this.store
      .captureBusiness(this.defaultWorkspaceRoot, (result) => {
        if ("error" in result) {
          release();
          return result;
        }
        // This callback runs INSIDE Store.receive, before resolving the snapshot call. It must
        // stay synchronous: later worker results and runtime callbacks cannot interleave here.
        const captured = this.stream.capture(
          result.records,
          [...this.facts.values()].map((fact) => fact.value),
          filter,
        );
        const bytes = Buffer.byteLength(JSON.stringify(captured.records));
        if (
          bytes > BUSINESS_LIMITS.snapshotBytes ||
          captured.records.length > BUSINESS_LIMITS.snapshotItems
        ) {
          release();
          return { error: "snapshot-too-large" as const };
        }
        return { ...captured, release };
      })
      .catch((error: unknown) => {
        release();
        throw error;
      });
  }
  // Runtime facts are observations of the current instance. They never replace historical run
  // records or keep a second terminal/headless model; this cache has at most registry.maxRuns.
  fact(run: RunRef) {
    return this.facts.get(businessRunId(run))?.value;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.observeBusiness(undefined);
    this.runtime.registry.observeBusiness(undefined);
    this.runtimeListener.dispose();
    this.stream.close();
    this.facts.clear();
  }
}
