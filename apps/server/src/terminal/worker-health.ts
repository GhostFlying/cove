import type { WorkerLoad } from "@cove/protocol/pipe";
import type { WorkerStatus } from "@cove/protocol/rpc";
import { WORKER_HEALTH_REASONS, type WorkerHealth } from "@cove/protocol/terminal";

type Reason = (typeof WORKER_HEALTH_REASONS)[number];

// A worker's informational health (issue #103; docs/terminal-architecture.md 3.3, "worker 过载
// 状态"). It only reports: nothing here retires a subscription, refuses a command or declares a
// worker lost. A worker is "overloaded" once any condition below has held continuously for
// OVERLOAD_ENTER_MS, and "normal" again only after every condition has stayed clear for
// OVERLOAD_LEAVE_MS (hysteresis, so a worker hovering at a threshold does not flap).
//
// - event-loop-delay: the p99 event-loop delay the worker measured over its latest heartbeat
//   window. On a saturated worker every reply and output event queues behind parsing.
// - heartbeat-gap: runtime-observed time since the latest heartbeat, accrued per tick and capped
//   like liveness silence, so a stall of the runtime's own loop is not charged to the worker.
// - command-age: the age of the oldest command sent to the worker and not yet answered, stop
//   excepted (a stop waits for its process group to exit, which says nothing about load).
//
// CPU share and parse backlog are reported with the health but never trigger it: a worker can
// use a whole core and still answer promptly, and a backlog drains in bursts.
// The thresholds and their calibration are in the design document named above.
export const OVERLOAD_THRESHOLDS = Object.freeze({
  eventLoopDelayP99Ms: 200,
  heartbeatGapMs: 3_000,
  commandAgeMs: 5_000,
});
export const OVERLOAD_ENTER_MS = 5_000;
export const OVERLOAD_LEAVE_MS = 10_000;

export interface HealthSignals {
  readonly heartbeatGapMs: number;
  readonly oldestCommandAgeMs: number | undefined;
}

export class WorkerHealthMonitor {
  private state: WorkerHealth["state"] = "normal";
  private reasons: Reason[] = [];
  private stateSince: number;
  // When each currently holding condition began to hold, and the first evaluation since which
  // no condition has held (undefined while one holds).
  private readonly heldSince = new Map<Reason, number>();
  private clearSince: number | undefined;
  private load: WorkerLoad | undefined;
  private signals: HealthSignals = { heartbeatGapMs: 0, oldestCommandAgeMs: undefined };

  constructor(now: number) {
    this.stateSince = now;
    this.clearSince = now;
  }

  heartbeat(load: WorkerLoad): void {
    this.load = { ...load };
  }

  get health(): WorkerHealth {
    return { state: this.state, reasons: [...this.reasons] };
  }

  // Returns the new health when it changed (state or reasons), for logging and publication.
  evaluate(now: number, signals: HealthSignals): WorkerHealth | undefined {
    this.signals = { ...signals };
    const holding = new Set<Reason>();
    if ((this.load?.eventLoopDelayP99Ms ?? 0) > OVERLOAD_THRESHOLDS.eventLoopDelayP99Ms)
      holding.add("event-loop-delay");
    if (signals.heartbeatGapMs > OVERLOAD_THRESHOLDS.heartbeatGapMs) holding.add("heartbeat-gap");
    if ((signals.oldestCommandAgeMs ?? 0) > OVERLOAD_THRESHOLDS.commandAgeMs)
      holding.add("command-age");
    for (const reason of WORKER_HEALTH_REASONS)
      if (!holding.has(reason)) this.heldSince.delete(reason);
      else if (!this.heldSince.has(reason)) this.heldSince.set(reason, now);
    if (holding.size) this.clearSince = undefined;
    else this.clearSince ??= now;
    const sustained = WORKER_HEALTH_REASONS.filter(
      (reason) => now - (this.heldSince.get(reason) ?? now + 1) >= OVERLOAD_ENTER_MS,
    );
    if (this.state === "normal") {
      if (!sustained.length) return undefined;
      this.state = "overloaded";
      this.stateSince = now;
      this.reasons = sustained;
      return this.health;
    }
    if (this.clearSince !== undefined && now - this.clearSince >= OVERLOAD_LEAVE_MS) {
      this.state = "normal";
      this.stateSince = now;
      this.reasons = [];
      return this.health;
    }
    // While overloaded, the reasons accumulate every condition that became sustained, so the
    // report names everything that contributed until the worker is normal again.
    const added = sustained.filter((reason) => !this.reasons.includes(reason));
    if (!added.length) return undefined;
    this.reasons = WORKER_HEALTH_REASONS.filter(
      (reason) => this.reasons.includes(reason) || added.includes(reason),
    );
    return this.health;
  }

  status(now: number, workerId: string): WorkerStatus {
    const load = this.load;
    return {
      workerId,
      health: this.health,
      stateAgeMs: Math.max(0, now - this.stateSince),
      signals: {
        eventLoopDelayP99Ms: load?.eventLoopDelayP99Ms ?? null,
        eventLoopDelayMaxMs: load?.eventLoopDelayMaxMs ?? null,
        cpuPercent: load?.cpuPercent ?? null,
        parseBacklogBytes: load?.parseBacklogBytes ?? null,
        executingCommands: load?.executingCommands ?? null,
        heartbeatGapMs: Math.max(0, Math.round(this.signals.heartbeatGapMs)),
        oldestCommandAgeMs:
          this.signals.oldestCommandAgeMs === undefined
            ? null
            : Math.max(0, Math.round(this.signals.oldestCommandAgeMs)),
      },
    };
  }
}
