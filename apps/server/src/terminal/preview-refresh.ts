import { domainError, type DomainError } from "@cove/protocol/errors";
import { sameRunRef, sameWorkerRef, type RunRef, type WorkerRef } from "@cove/protocol/identity";
import type { RuntimeResult } from "@cove/protocol/runtime";
import type { LocalRuntime } from "./local-runtime.js";
import { PreviewCache } from "./preview-cache.js";
import { PreviewCollector } from "./preview-transfer.js";
import type { ByteReservation } from "./runtime-retained-bytes.js";

export type PreviewPolicy = {
  now: () => number;
  wallNow: () => number;
  cadenceMs: number;
  staggerMs: number;
  expiryMs: number;
  waiterLimit: number;
  identityLimit: number;
};
export type PreviewOutcome = { ok: true } | { ok: false; error: DomainError };
type Waiter = { lease: ByteReservation; resolve: (outcome: PreviewOutcome) => void };
type Schedule = { run: RunRef; due: number; lease: ByteReservation; freshUntil?: number };
type Job = {
  run: RunRef;
  worker: WorkerRef;
  requestPrefix: string;
  deadline: number;
  lease: ByteReservation;
  waiters: Set<Waiter>;
  collector?: PreviewCollector;
  outcome?: PreviewOutcome;
  retired: boolean;
};

export class PreviewRefresh {
  readonly cache: PreviewCache;
  readonly policy: Readonly<PreviewPolicy>;
  private readonly jobs = new Map<string, Job>();
  private readonly schedule = new Map<string, Schedule>();
  private readonly transferIds = new Map<string, ByteReservation>();
  private readonly listener: { dispose(): void };
  private readonly arena: ByteReservation;
  private sequence = 0;
  private lastNow = 0;
  private nextTurn = 0;
  private lastRunId = "";
  private disposed = false;
  private ticking = false;

  constructor(
    readonly runtime: LocalRuntime,
    options: Partial<PreviewPolicy> = {},
  ) {
    const budgets = runtime.composition.budgets;
    this.policy = Object.freeze({
      now: () => Math.floor(performance.now()),
      wallNow: () => Date.now(),
      cadenceMs: 1000,
      staggerMs: 50,
      expiryMs: budgets.recoveryDeadlineMs,
      waiterLimit: Math.min(16, budgets.pendingWorkerCommands),
      identityLimit: 4096,
      ...options,
    });
    const p = this.policy;
    if (
      ![p.cadenceMs, p.staggerMs, p.expiryMs, p.waiterLimit, p.identityLimit].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      p.staggerMs > p.cadenceMs ||
      p.expiryMs > budgets.recoveryDeadlineMs ||
      p.waiterLimit > budgets.pendingWorkerCommands ||
      p.identityLimit > 4096
    )
      throw new Error("Invalid preview policy");
    const arena = runtime.composition.bytes.reserve(4096);
    if (!arena) throw new Error("Preview owner capacity unavailable");
    this.arena = arena;
    this.cache = new PreviewCache(runtime);
    try {
      this.listener = runtime.onEvent((event, payload) =>
        this.jobs.get(event.run.runId)?.collector?.event(event, payload),
      );
    } catch (error) {
      arena.release();
      throw error;
    }
  }

  private now(): number {
    const now = this.policy.now();
    if (
      !Number.isSafeInteger(now) ||
      now < this.lastNow ||
      now > Number.MAX_SAFE_INTEGER - Math.max(this.policy.expiryMs, this.policy.cadenceMs)
    )
      throw new Error("Invalid preview monotonic clock");
    this.lastNow = now;
    return now;
  }
  private wall(): number {
    const wall = this.policy.wallNow();
    if (!Number.isSafeInteger(wall) || wall < 0) throw new Error("Invalid preview wall clock");
    return wall;
  }
  private current(job: Job): boolean {
    const current = this.runtime.registry.get(job.run);
    const placement = this.runtime.pool.get(job.run);
    return (
      !this.disposed &&
      !job.retired &&
      !job.outcome &&
      this.jobs.get(job.run.runId) === job &&
      !!current &&
      !!placement &&
      placement.session.ready &&
      sameWorkerRef(current.worker, job.worker) &&
      sameWorkerRef(placement.worker, job.worker)
    );
  }
  private failure(error = domainError("RECOVERY_UNAVAILABLE")): PreviewOutcome {
    return { ok: false, error };
  }
  private finish(job: Job, outcome: PreviewOutcome): void {
    if (job.outcome) return;
    job.outcome = outcome;
    const scheduled = this.schedule.get(job.run.runId);
    if (outcome.ok && scheduled) {
      scheduled.due = this.lastNow + this.policy.cadenceMs;
      scheduled.freshUntil = this.lastNow + this.policy.expiryMs;
    }
    if (!outcome.ok) {
      this.cache.stale(job.run);
      job.collector?.dispose();
    }
    for (const waiter of job.waiters) {
      waiter.lease.release();
      waiter.resolve(outcome);
    }
    job.waiters.clear();
  }
  private retire(job: Job): void {
    if (job.retired) return;
    job.retired = true;
    job.collector?.dispose();
    if (this.jobs.get(job.run.runId) === job) this.jobs.delete(job.run.runId);
    job.lease.release();
    if (this.disposed && !this.jobs.size) this.arena.release();
  }
  private claimId(job: Job, previewId: string): boolean {
    const key = JSON.stringify([job.run, job.worker, previewId]);
    if (this.transferIds.has(key) || this.transferIds.size >= this.policy.identityLimit)
      return false;
    const lease = this.runtime.composition.bytes.reserve(2048);
    if (!lease) return false;
    this.transferIds.set(key, lease);
    return true;
  }

  private admit(run: RunRef, now: number): Job | null {
    if (
      this.disposed ||
      this.jobs.has(run.runId) ||
      this.jobs.size >= this.runtime.composition.budgets.previewRefreshes ||
      this.sequence >= this.policy.identityLimit
    )
      return null;
    const record = this.runtime.registry.get(run);
    const placement = this.runtime.pool.get(run);
    if (!record || !placement || !sameWorkerRef(record.worker, placement.worker)) return null;
    const lease = this.runtime.composition.bytes.reserve(8192);
    if (!lease) return null;
    if (!this.schedule.has(run.runId)) {
      const recordLease = this.runtime.composition.bytes.reserve(1024);
      if (!recordLease) {
        lease.release();
        return null;
      }
      this.schedule.set(run.runId, { run: { ...run }, due: now, lease: recordLease });
    }
    const requestPrefix = `${run.serverId.slice(0, 24)}.${run.relayInstanceId.slice(0, 24)}.pv${++this.sequence}`;
    const job: Job = {
      run: { ...run },
      worker: { ...record.worker },
      requestPrefix,
      deadline: now + this.policy.expiryMs,
      lease,
      waiters: new Set(),
      retired: false,
    };
    this.jobs.set(run.runId, job);
    // Starting on a microtask gives the first caller its waiter before a reentrant pipe reply.
    void Promise.resolve().then(() => this.execute(job));
    return job;
  }

  request(run: RunRef): { promise: Promise<PreviewOutcome>; cancel(): void } {
    let now: number;
    try {
      now = this.now();
    } catch {
      this.dispose();
      return { promise: Promise.resolve(this.failure()), cancel() {} };
    }
    let job = this.jobs.get(run.runId);
    if (
      job &&
      (!sameRunRef(job.run, run) || job.outcome || job.waiters.size >= this.policy.waiterLimit)
    )
      return { promise: Promise.resolve(this.failure(domainError("BUSY"))), cancel() {} };
    const lease = this.runtime.composition.bytes.reserve(512);
    if (!lease) return { promise: Promise.resolve(this.failure(domainError("BUSY"))), cancel() {} };
    job ??= this.admit(run, now) ?? undefined;
    if (!job || this.disposed) {
      lease.release();
      return { promise: Promise.resolve(this.failure(domainError("BUSY"))), cancel() {} };
    }
    let resolve!: (outcome: PreviewOutcome) => void;
    const promise = new Promise<PreviewOutcome>((done) => {
      resolve = done;
    });
    const waiter: Waiter = { lease, resolve };
    const owner = job;
    owner.waiters.add(waiter);
    return {
      promise,
      cancel: () => {
        if (!owner.waiters.delete(waiter)) return;
        lease.release();
        resolve(this.failure(domainError("STALE_CONNECTION")));
      },
    };
  }
  refresh(run: RunRef): Promise<PreviewOutcome> {
    return this.request(run).promise;
  }

  private async execute(job: Job): Promise<void> {
    try {
      if (!this.current(job)) {
        this.finish(job, this.failure(domainError("WORKER_UNAVAILABLE")));
        return;
      }
      const prefix = job.requestPrefix;
      const statusResult = await this.runtime.getStatus({
        type: "status",
        run: job.run,
        worker: job.worker,
        requestId: prefix + ".s",
      });
      if (
        statusResult.type !== "result" ||
        statusResult.outcome !== "accepted" ||
        !statusResult.runStatus
      ) {
        this.finish(job, this.fromResult(statusResult));
        return;
      }
      if (!this.current(job)) {
        this.finish(job, this.failure(domainError("WORKER_UNAVAILABLE")));
        return;
      }
      if (this.now() > job.deadline) {
        this.finish(job, this.failure(domainError("RECOVERY_EXPIRED", "unknown")));
        return;
      }
      const status = this.runtime.registry.get(job.run)!.status;
      if (status.status === "unverifiable") {
        this.finish(job, this.failure(domainError("WORKER_UNAVAILABLE")));
        return;
      }
      if (this.cache.matches(job.run, job.worker, status)) {
        const wall = this.wall();
        if (!this.current(job)) return;
        this.finish(job, this.cache.checked(job.run, status, wall) ? { ok: true } : this.failure());
        return;
      }
      const old = this.cache.acquire(job.run);
      const knownVersion =
        old &&
        old.picture.geometry.cols === status.geometry.cols &&
        old.picture.geometry.rows === status.geometry.rows &&
        (status.parsedSeq === null || old.picture.version <= status.parsedSeq)
          ? old.picture.version
          : undefined;
      old?.release();
      const requestId = prefix + ".p";
      job.collector = new PreviewCollector(
        this.cache,
        job.run,
        job.worker,
        requestId,
        status,
        () => this.current(job),
        (id) => this.claimId(job, id),
      );
      const result = await this.runtime.requestPreviewSealed(
        {
          type: "preview-refresh",
          run: job.run,
          worker: job.worker,
          requestId,
          ...(knownVersion === undefined ? {} : { knownVersion }),
        },
        (result) => {
          const now = this.now();
          const wall = this.wall();
          // At equality a prior tick still wins through current(job)'s outcome guard.
          if (!this.current(job) || now > job.deadline) {
            this.finish(job, this.failure(domainError("RECOVERY_EXPIRED", "unknown")));
            return;
          }
          const accepted = job.collector!.seal(result, wall);
          this.finish(job, accepted ? { ok: true } : this.fromResult(result));
        },
      );
      if (!job.outcome) this.finish(job, this.fromResult(result));
    } catch {
      this.finish(job, this.failure());
    } finally {
      if (!job.outcome) this.finish(job, this.failure());
      this.retire(job);
    }
  }
  private fromResult(result: RuntimeResult): PreviewOutcome {
    return this.failure(
      result.type === "error"
        ? result.error
        : result.outcome === "unknown"
          ? domainError("RESULT_UNKNOWN", "unknown")
          : domainError("RECOVERY_UNAVAILABLE"),
    );
  }

  tick(): void {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      if (this.disposed) return;
      for (const job of this.jobs.values())
        if (now >= job.deadline)
          this.finish(job, this.failure(domainError("RECOVERY_EXPIRED", "unknown")));
      const runs = this.runtime.registry.list();
      for (const [id, entry] of this.schedule) {
        if (!this.runtime.registry.get(entry.run) && !this.jobs.has(id)) {
          entry.lease.release();
          this.schedule.delete(id);
        } else if (entry.freshUntil !== undefined && now >= entry.freshUntil)
          this.cache.stale(entry.run);
      }
      for (const status of runs) {
        const old = this.schedule.get(status.run.runId);
        if (old && sameRunRef(old.run, status.run)) continue;
        old?.lease.release();
        const lease = this.runtime.composition.bytes.reserve(1024);
        if (lease) this.schedule.set(status.run.runId, { run: status.run, due: now, lease });
      }
      const eligible = [...this.schedule.values()]
        .filter((entry) => entry.due <= now && !this.jobs.has(entry.run.runId))
        .sort((a, b) => a.run.runId.localeCompare(b.run.runId));
      if (now < this.nextTurn || !eligible.length) return;
      const next =
        eligible.find((entry) => entry.run.runId.localeCompare(this.lastRunId) > 0) ?? eligible[0]!;
      this.lastRunId = next.run.runId;
      this.nextTurn = now + this.policy.staggerMs;
      next.due = now + this.policy.cadenceMs;
      this.admit(next.run, now);
    } catch {
      this.dispose();
    } finally {
      this.ticking = false;
    }
  }
  snapshot() {
    return {
      active: this.jobs.size,
      waiters: [...this.jobs.values()].reduce((n, job) => n + job.waiters.size, 0),
      scheduled: this.schedule.size,
      transferIds: this.transferIds.size,
      disposed: this.disposed,
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listener.dispose();
    for (const job of this.jobs.values())
      this.finish(job, this.failure(domainError("WORKER_UNAVAILABLE")));
    for (const entry of this.schedule.values()) entry.lease.release();
    this.schedule.clear();
    for (const lease of this.transferIds.values()) lease.release();
    this.transferIds.clear();
    this.cache.dispose();
    if (!this.jobs.size) this.arena.release();
  }
}
