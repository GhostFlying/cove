import { domainError, type DomainError, type DomainErrorKind } from "@cove/protocol/errors";
import {
  sameConnectionRef,
  sameRunRef,
  sameSubscriptionRef,
  sameWorkerRef,
  type RunRef,
  type SubscriptionRef,
  type WorkerRef,
} from "@cove/protocol/identity";
import {
  MAX_FRAME_BYTES,
  type TerminalCommand,
  type TerminalResult,
  type TerminalError,
} from "@cove/protocol/terminal";
import { validateAppearance, type Geometry } from "@cove/protocol/profile";
import type { PipeCommand, RunStatus } from "@cove/protocol/pipe";
import type { RuntimeResult } from "@cove/protocol/runtime";
import { LocalRuntime } from "./local-runtime.js";
import type { ByteReservation } from "./runtime-retained-bytes.js";

export type ControlCommand = Extract<
  TerminalCommand,
  { type: "focus" | "blur" | "resize" | "appearance" | "input" }
>;
type Reply = TerminalResult | TerminalError;
type Holder = NonNullable<RunStatus["controlHolder"]>;
export interface ControlRouteContext {
  readonly subscription: SubscriptionRef;
  readonly worker: WorkerRef;
  readonly requestId: string;
  readonly releaseId: string;
  current(): boolean;
  installed(atSeq?: number): boolean;
}
type Counter = {
  ref: SubscriptionRef;
  worker: WorkerRef;
  focus: number;
  input: number;
  grantEpoch: number;
  grantAtSeq: number;
  retired: boolean;
  releaseId: string;
  cleanup: "none" | "pending" | "unknown";
  cleanupEpoch: number;
  lease: ByteReservation;
};
type Boundary = { epoch: number; holder: Holder | null; geometry: Geometry; atSeq: number };
type Run = {
  ref: RunRef;
  worker: WorkerRef;
  boundary?: Boundary;
  uncertain: boolean;
  queue: ControlJob[];
  counters: Map<string, Counter>;
  running: boolean;
  lease: ByteReservation;
};
export type ControlJob = {
  command: ControlCommand;
  context: ControlRouteContext;
  run: Run;
  counter: Counter;
  payload: Uint8Array;
  leases: ByteReservation[];
  ready: boolean;
  dispatched: boolean;
  resolve: (reply: Reply) => void;
  promise: Promise<Reply>;
};
const arbiters = new WeakMap<LocalRuntime, ControlArbiter>();
const key = (ref: SubscriptionRef) => JSON.stringify(ref);
const holder = (ref: SubscriptionRef): Holder => ({
  connection: { ...ref.connection },
  viewId: ref.viewId,
  subscriptionId: ref.subscriptionId,
});
const matches = (value: Holder | null, ref: SubscriptionRef) =>
  value !== null &&
  sameConnectionRef(value.connection, ref.connection) &&
  value.viewId === ref.viewId &&
  value.subscriptionId === ref.subscriptionId;

// One runtime owns the accepted order; per-connection queues cannot arbitrate a run.
export class ControlArbiter {
  private readonly runs = new Map<string, Run>();
  private pending = 0;
  private disposed = false;
  private readonly listener: { dispose(): void };
  constructor(readonly runtime: LocalRuntime) {
    if (arbiters.has(runtime)) throw new Error("Runtime already has a control arbiter");
    this.listener = runtime.onEvent((event) => {
      const run = this.runs.get(event.run.runId);
      const fact = event.terminal;
      if (
        !run ||
        !sameRunRef(run.ref, event.run) ||
        !sameWorkerRef(run.worker, event.worker) ||
        !("seq" in fact)
      )
        return;
      if (run.boundary && fact.seq <= run.boundary.atSeq) return;
      if (fact.type === "control")
        run.boundary = {
          epoch: fact.epoch,
          holder: structuredClone(fact.holder),
          geometry: { ...fact.geometry },
          atSeq: fact.seq,
        };
      else if (fact.type === "resize" && run.boundary)
        run.boundary = { ...run.boundary, geometry: { ...fact.geometry }, atSeq: fact.seq };
      else if (fact.type === "exit") run.uncertain = true;
    });
    arbiters.set(runtime, this);
  }
  get composition() {
    return this.runtime.composition;
  }
  private error(command: ControlCommand, error: DomainError | DomainErrorKind): TerminalError {
    return {
      type: "error",
      requestId: command.requestId,
      run: structuredClone(command.run),
      commandType: command.type,
      error: typeof error === "string" ? domainError(error) : error,
    };
  }
  admit(
    command: ControlCommand,
    context: ControlRouteContext,
    bytes: Uint8Array,
  ): ControlJob | DomainError {
    const budgets = this.composition.budgets;
    if (this.disposed || !context.current()) return domainError("STALE_CONNECTION");
    if (!context.installed()) return domainError("RESYNC_REQUIRED");
    if (
      "geometry" in command &&
      (command.geometry.cols > budgets.maxCols || command.geometry.rows > budgets.maxRows)
    )
      return domainError("INVALID_SIZE");
    if ("appearance" in command && command.appearance && !validateAppearance(command.appearance))
      return domainError("CAPABILITY_UNAVAILABLE");
    if (
      !(bytes instanceof Uint8Array) ||
      (command.type === "input"
        ? bytes.byteLength < 1 ||
          bytes.byteLength > Math.min(65_536, budgets.inputQueueBytes) ||
          bytes.buffer.byteLength > MAX_FRAME_BYTES
        : bytes.byteLength !== 0)
    )
      return domainError("INPUT_REJECTED");
    if (this.pending >= budgets.pendingWorkerCommands) return domainError("BUSY");
    let run = this.runs.get(command.run.runId);
    if (run && (!sameRunRef(run.ref, command.run) || !sameWorkerRef(run.worker, context.worker)))
      return domainError("WORKER_UNAVAILABLE");
    let newRun = false;
    if (!run) {
      if (this.runs.size >= budgets.maxRuns) return domainError("BUSY");
      const lease = this.composition.bytes.reserve(8192);
      if (!lease) return domainError("BUSY");
      run = {
        ref: structuredClone(command.run),
        worker: structuredClone(context.worker),
        uncertain: false,
        queue: [],
        counters: new Map(),
        running: false,
        lease,
      };
      newRun = true;
    }
    const rollbackRun = () => {
      if (newRun) run!.lease.release();
    };
    let counter = run.counters.get(key(context.subscription));
    let newCounter = false;
    if (!counter) {
      if (run.counters.size >= budgets.authenticatedSockets * budgets.subscriptionsPerConnection) {
        rollbackRun();
        return domainError("BUSY");
      }
      const lease = this.composition.bytes.reserve(4096);
      if (!lease) {
        rollbackRun();
        return domainError("BUSY");
      }
      counter = {
        ref: structuredClone(context.subscription),
        worker: structuredClone(context.worker),
        focus: 0,
        input: 0,
        grantEpoch: 0,
        grantAtSeq: 0,
        retired: false,
        cleanup: "none",
        cleanupEpoch: 0,
        releaseId: context.releaseId,
        lease,
      };
      newCounter = true;
    }
    const rollback = () => {
      if (newCounter) counter!.lease.release();
      rollbackRun();
    };
    if (
      counter.retired ||
      (command.type === "focus" && command.focusSeq <= counter.focus) ||
      (command.type === "input" && command.inputSeq <= counter.input)
    ) {
      rollback();
      return domainError("COUNTER_EXHAUSTED");
    }
    const lease = this.composition.bytes.reserve(1024);
    const leases: ByteReservation[] = lease ? [lease] : [];
    let payload = new Uint8Array();
    if (lease && command.type === "input") {
      const backing = this.composition.bytes.retainBacking(bytes);
      const copy = backing ? this.composition.bytes.reserve(bytes.byteLength + 256) : null;
      if (backing) leases.push(backing);
      if (copy) {
        leases.push(copy);
        payload = new Uint8Array(bytes);
      } else {
        for (const item of leases) item.release();
        rollback();
        return domainError("BUSY");
      }
    }
    if (!lease) {
      rollback();
      return domainError("BUSY");
    }
    if (!context.current()) {
      for (const item of leases) item.release();
      rollback();
      return domainError("STALE_CONNECTION");
    }
    if (command.type === "focus") counter.focus = command.focusSeq;
    if (command.type === "input") counter.input = command.inputSeq;
    if (newRun) this.runs.set(command.run.runId, run);
    if (newCounter) run.counters.set(key(context.subscription), counter);
    let resolve!: (reply: Reply) => void;
    const promise = new Promise<Reply>((done) => {
      resolve = done;
    });
    const job: ControlJob = {
      command,
      context,
      run,
      counter,
      payload,
      leases,
      ready: false,
      dispatched: false,
      resolve,
      promise,
    };
    run.queue.push(job);
    this.pending++;
    return job;
  }
  execute(job: ControlJob): Promise<Reply> {
    job.ready = true;
    void this.drain(job.run);
    return job.promise;
  }
  retire(ref: SubscriptionRef): void {
    const run = this.runs.get(ref.run.runId);
    const counter = run?.counters.get(key(ref));
    if (!run || !counter || !sameSubscriptionRef(counter.ref, ref)) return;
    counter.retired = true;
    for (const job of run.queue) if (job.counter === counter) job.ready = true;
    if (matches(run.boundary?.holder ?? null, ref)) {
      counter.cleanup = "pending";
      counter.cleanupEpoch = run.boundary!.epoch;
    }
    void this.drain(run);
  }
  private async drain(run: Run): Promise<void> {
    if (run.running) return;
    run.running = true;
    try {
      while (run.queue[0]?.ready) {
        const job = run.queue[0]!;
        let reply: Reply;
        try {
          reply = await this.perform(job);
        } catch {
          run.uncertain = true;
          reply = this.error(
            job.command,
            domainError(
              "RESULT_UNKNOWN",
              "unknown",
              job.command.type === "input" ? "input" : undefined,
            ),
          );
        }
        run.queue.shift();
        this.pending--;
        for (const lease of job.leases) lease.release();
        job.leases.length = 0;
        job.payload = new Uint8Array();
        job.resolve(reply);
      }
      if (!run.queue.length) await this.cleanup(run);
    } finally {
      run.running = false;
      if (this.disposed && !run.queue.length) this.release(run);
      else if (run.queue[0]?.ready) void this.drain(run);
    }
  }
  private current(job: ControlJob): boolean {
    const placement = this.runtime.pool.get(job.command.run);
    return (
      !this.disposed &&
      !job.counter.retired &&
      job.context.current() &&
      !!placement &&
      sameWorkerRef(placement.worker, job.context.worker)
    );
  }
  private async boundary(job: ControlJob): Promise<DomainError | undefined> {
    const run = job.run;
    if (run.boundary && !run.uncertain) return;
    const result = await this.runtime.getStatus({
      type: "status",
      worker: run.worker,
      run: run.ref,
      requestId: job.context.requestId + ".s",
    });
    if (!this.current(job)) return domainError("STALE_CONNECTION");
    if (result.type === "error") return result.error;
    if (
      result.outcome !== "accepted" ||
      !result.runStatus ||
      result.runStatus.status !== "live" ||
      result.runStatus.parsedSeq === null
    )
      return domainError("WORKER_UNAVAILABLE");
    const status = result.runStatus;
    if (run.boundary && run.boundary.atSeq > status.parsedSeq!) return domainError("STALE_CONTROL");
    run.boundary = {
      epoch: status.controlEpoch,
      holder: structuredClone(status.controlHolder),
      geometry: { ...status.geometry },
      atSeq: status.parsedSeq!,
    };
    run.uncertain = false;
  }
  private failure(result: RuntimeResult, command: ControlCommand): DomainError | undefined {
    if (result.type === "error") return result.error;
    if (result.outcome === "accepted") return;
    return domainError(
      result.outcome === "unknown" ? "RESULT_UNKNOWN" : "STALE_CONTROL",
      result.outcome === "unknown" ? "unknown" : "not-accepted",
      result.outcome === "unknown" && command.type === "input" ? "input" : undefined,
    );
  }
  private async perform(job: ControlJob): Promise<Reply> {
    const { command, context, run } = job;
    if (!this.current(job)) return this.error(command, "STALE_CONNECTION");
    if (!context.installed()) return this.error(command, "RESYNC_REQUIRED");
    const failure = await this.boundary(job);
    if (failure) return this.error(command, failure);
    if (!this.current(job)) return this.error(command, "STALE_CONNECTION");
    const boundary = run.boundary!;
    const common = { worker: run.worker, run: run.ref, requestId: context.requestId };
    let pipe: PipeCommand;
    if (command.type === "focus") {
      if (boundary.epoch === Number.MAX_SAFE_INTEGER)
        return this.error(command, "COUNTER_EXHAUSTED");
      pipe = {
        ...common,
        type: "set-control",
        expectedEpoch: boundary.epoch,
        nextEpoch: boundary.epoch + 1,
        holder: holder(context.subscription),
        geometry: command.geometry,
        ...(command.appearance ? { appearance: command.appearance } : {}),
      };
    } else {
      if (
        !matches(boundary.holder, context.subscription) ||
        boundary.epoch !== command.epoch ||
        job.counter.grantEpoch !== command.epoch
      )
        return this.error(command, "STALE_CONTROL");
      if (
        command.type !== "blur" &&
        !context.installed(Math.max(boundary.atSeq, job.counter.grantAtSeq))
      )
        return this.error(command, "RESYNC_REQUIRED");
      pipe =
        command.type === "blur"
          ? {
              ...common,
              type: "set-control",
              expectedEpoch: boundary.epoch,
              nextEpoch: boundary.epoch,
              holder: null,
              geometry: boundary.geometry,
            }
          : command.type === "input"
            ? {
                ...common,
                type: "input",
                subscription: context.subscription,
                epoch: command.epoch,
                inputSeq: command.inputSeq,
              }
            : command.type === "resize"
              ? {
                  ...common,
                  type: "resize",
                  subscription: context.subscription,
                  epoch: command.epoch,
                  geometry: command.geometry,
                }
              : {
                  ...common,
                  type: "appearance",
                  subscription: context.subscription,
                  epoch: command.epoch,
                  appearance: command.appearance,
                };
    }
    // No callback or await may intervene between the final authority fence and dispatch.
    if (
      !this.current(job) ||
      !context.installed(
        command.type === "focus" || command.type === "blur" ? undefined : boundary.atSeq,
      )
    )
      return this.error(command, "STALE_CONNECTION");
    job.dispatched = true;
    const result = await (pipe.type === "set-control"
      ? this.runtime.setControl(pipe)
      : pipe.type === "input"
        ? this.runtime.writeInput(pipe, job.payload)
        : pipe.type === "resize"
          ? this.runtime.resize(pipe)
          : this.runtime.setAppearance(pipe as Extract<PipeCommand, { type: "appearance" }>));
    const error = this.failure(result, command);
    if (error) {
      if (
        command.type !== "input" &&
        (error.acceptance === "unknown" || error.kind === "STALE_CONTROL")
      )
        run.uncertain = true;
      return this.error(command, error);
    }
    if (result.type !== "result") return this.error(command, "RESULT_UNKNOWN");
    const correlated = {
      requestId: command.requestId,
      run: command.run,
      subscription: context.subscription,
    };
    if (command.type === "input") {
      if (
        !result.writtenBytes ||
        result.writtenBytes > job.payload.byteLength ||
        result.inputSeq !== command.inputSeq
      )
        return this.error(command, domainError("RESULT_UNKNOWN", "unknown", "input"));
      // A written prefix remains written even if the route closed during its receipt.
      return {
        ...correlated,
        type: "input-result",
        epoch: command.epoch,
        inputSeq: command.inputSeq,
        status: "written",
        writtenBytes: result.writtenBytes,
      };
    }
    if (result.atSeq === undefined || result.atSeq < boundary.atSeq) {
      run.uncertain = true;
      return this.error(command, domainError("RESULT_UNKNOWN", "unknown"));
    }
    if (run.boundary && run.boundary.atSeq > result.atSeq)
      return this.error(command, "STALE_CONTROL");
    if (command.type === "focus") {
      run.boundary = {
        epoch: boundary.epoch + 1,
        holder: holder(context.subscription),
        geometry: { ...command.geometry },
        atSeq: result.atSeq,
      };
      job.counter.grantEpoch = run.boundary.epoch;
      job.counter.grantAtSeq = result.atSeq;
      if (job.counter.retired) {
        job.counter.cleanup = "pending";
        job.counter.cleanupEpoch = run.boundary.epoch;
      }
    } else if (command.type === "blur")
      run.boundary = { ...boundary, holder: null, atSeq: result.atSeq };
    else
      run.boundary = {
        ...boundary,
        ...(command.type === "resize" ? { geometry: { ...command.geometry } } : {}),
        atSeq: result.atSeq,
      };
    if (!this.current(job)) return this.error(command, "STALE_CONNECTION");
    return {
      ...correlated,
      type: `${command.type}-result`,
      epoch: run.boundary.epoch,
      atSeq: result.atSeq,
    };
  }
  private async cleanup(run: Run): Promise<void> {
    for (const counter of run.counters.values()) {
      if (counter.cleanup !== "pending") continue;
      const boundary = run.boundary;
      if (
        !boundary ||
        !matches(boundary.holder, counter.ref) ||
        boundary.epoch !== counter.cleanupEpoch
      ) {
        counter.cleanup = "none";
        continue;
      }
      if (run.uncertain || this.disposed) continue;
      const placement = this.runtime.pool.get(run.ref);
      if (!placement || !sameWorkerRef(placement.worker, counter.worker)) continue;
      let result: RuntimeResult;
      try {
        result = await this.runtime.setControl({
          type: "set-control",
          requestId: counter.releaseId,
          worker: counter.worker,
          run: run.ref,
          expectedEpoch: boundary.epoch,
          nextEpoch: boundary.epoch,
          holder: null,
          geometry: boundary.geometry,
        });
      } catch {
        counter.cleanup = "unknown";
        run.uncertain = true;
        continue;
      }
      if (
        result.type === "error" &&
        result.error.acceptance === "not-accepted" &&
        result.error.kind === "BUSY"
      )
        continue;
      counter.cleanup = "none";
      if (
        result.type === "result" &&
        result.outcome === "accepted" &&
        result.atSeq !== undefined &&
        result.atSeq >= boundary.atSeq
      ) {
        if (run.boundary === boundary || run.boundary!.atSeq <= result.atSeq)
          run.boundary = { ...boundary, holder: null, atSeq: result.atSeq };
      } else {
        counter.cleanup = "unknown";
        run.uncertain = true;
      }
    }
  }
  tick(): void {
    for (const run of this.runs.values()) void this.drain(run);
  }
  private release(run: Run): void {
    if (!this.runs.delete(run.ref.runId)) return;
    for (const counter of run.counters.values()) counter.lease.release();
    run.counters.clear();
    run.lease.release();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listener.dispose();
    for (const run of this.runs.values()) {
      for (const job of run.queue) job.ready = true;
      if (!run.running && !run.queue.length) this.release(run);
      else void this.drain(run);
    }
  }
  snapshot(runId: string) {
    const run = this.runs.get(runId);
    return {
      pending: this.pending,
      runs: this.runs.size,
      boundary: run?.boundary ? structuredClone(run.boundary) : undefined,
      uncertain: run?.uncertain,
      counters: run?.counters.size,
      cleanup: run
        ? [...run.counters.values()].filter((counter) => counter.cleanup === "pending").length
        : 0,
    };
  }
}
