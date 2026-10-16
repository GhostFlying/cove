import { describe, expect, it } from "vitest";
import {
  OVERLOAD_ENTER_MS,
  OVERLOAD_LEAVE_MS,
  OVERLOAD_THRESHOLDS,
  WorkerHealthMonitor,
} from "../../dist/terminal/worker-health.js";

// Issue #103: a worker's informational overload state. Enters after any condition holds for
// OVERLOAD_ENTER_MS, leaves after every condition stays clear for OVERLOAD_LEAVE_MS.
const quiet = { heartbeatGapMs: 0, oldestCommandAgeMs: undefined };
const load = (changes = {}) => ({
  windowMs: 1000,
  eventLoopDelayP99Ms: 11,
  eventLoopDelayMaxMs: 15,
  cpuPercent: 30,
  parseBacklogBytes: 0,
  executingCommands: 0,
  ...changes,
});

// Evaluates once per second from `from` to `to` (inclusive), returning every change.
function run(monitor, from, to, signals = () => quiet) {
  const changes = [];
  for (let now = from; now <= to; now += 1000) {
    const changed = monitor.evaluate(now, signals(now));
    if (changed) changes.push({ now, ...changed });
  }
  return changes;
}

describe("worker health", () => {
  it("enters overloaded only after a condition holds for the whole entry period", () => {
    const monitor = new WorkerHealthMonitor(0);
    monitor.heartbeat(load({ eventLoopDelayP99Ms: OVERLOAD_THRESHOLDS.eventLoopDelayP99Ms + 1 }));
    expect(run(monitor, 0, OVERLOAD_ENTER_MS - 1000)).toEqual([]);
    expect(monitor.health).toEqual({ state: "normal", reasons: [] });
    expect(run(monitor, OVERLOAD_ENTER_MS, OVERLOAD_ENTER_MS)).toEqual([
      { now: OVERLOAD_ENTER_MS, state: "overloaded", reasons: ["event-loop-delay"] },
    ]);
  });

  it("restarts the entry period when a condition clears, and never triggers on CPU alone", () => {
    const monitor = new WorkerHealthMonitor(0);
    // A whole core of CPU with a prompt event loop is not overload.
    monitor.heartbeat(load({ cpuPercent: 100, parseBacklogBytes: 1 << 20 }));
    expect(run(monitor, 0, 60_000)).toEqual([]);
    // A gap that clears one second short of the entry period starts over.
    const gap = (now) => ({
      heartbeatGapMs: now >= 70_000 && now !== 74_000 ? OVERLOAD_THRESHOLDS.heartbeatGapMs + 1 : 0,
      oldestCommandAgeMs: undefined,
    });
    // It holds from 70 s, clears at 74 s and holds again from 75 s, so it is sustained at 80 s.
    expect(run(monitor, 61_000, 79_000, gap)).toEqual([]);
    expect(run(monitor, 80_000, 80_000, gap)).toEqual([
      { now: 80_000, state: "overloaded", reasons: ["heartbeat-gap"] },
    ]);
  });

  it("leaves overloaded only after every condition stays clear for the hold period", () => {
    const monitor = new WorkerHealthMonitor(0);
    const age = (busyUntil) => (now) => ({
      heartbeatGapMs: 0,
      oldestCommandAgeMs: now <= busyUntil ? OVERLOAD_THRESHOLDS.commandAgeMs + 1 : 10,
    });
    expect(run(monitor, 0, 10_000, age(10_000)).map((change) => change.state)).toEqual([
      "overloaded",
    ]);
    // Clear for less than the hold period, then holding again: still overloaded.
    expect(run(monitor, 11_000, 11_000 + OVERLOAD_LEAVE_MS - 2000, age(10_000))).toEqual([]);
    expect(run(monitor, 20_000, 21_000, age(21_000))).toEqual([]);
    expect(monitor.health.state).toBe("overloaded");
    // Clear from 22 s for the whole hold period: normal.
    const changes = run(monitor, 22_000, 22_000 + OVERLOAD_LEAVE_MS, age(21_000));
    expect(changes).toEqual([{ now: 22_000 + OVERLOAD_LEAVE_MS, state: "normal", reasons: [] }]);
  });

  it("names every condition that became sustained while overloaded, in a fixed order", () => {
    const monitor = new WorkerHealthMonitor(0);
    const signals = (now) => ({
      heartbeatGapMs: 0,
      oldestCommandAgeMs: now >= 3000 ? OVERLOAD_THRESHOLDS.commandAgeMs + 1 : 0,
    });
    monitor.heartbeat(load({ eventLoopDelayP99Ms: 500 }));
    const changes = run(monitor, 0, 10_000, signals);
    expect(changes).toEqual([
      { now: 5000, state: "overloaded", reasons: ["event-loop-delay"] },
      { now: 8000, state: "overloaded", reasons: ["event-loop-delay", "command-age"] },
    ]);
  });

  it("reports the signals it judged and how long the state has lasted", () => {
    const monitor = new WorkerHealthMonitor(0);
    expect(monitor.status(500, "w1")).toEqual({
      workerId: "w1",
      health: { state: "normal", reasons: [] },
      stateAgeMs: 500,
      signals: {
        eventLoopDelayP99Ms: null,
        eventLoopDelayMaxMs: null,
        cpuPercent: null,
        parseBacklogBytes: null,
        executingCommands: null,
        heartbeatGapMs: 0,
        oldestCommandAgeMs: null,
      },
    });
    monitor.heartbeat(load({ eventLoopDelayP99Ms: 250, executingCommands: 3 }));
    run(monitor, 1000, 6000, () => ({ heartbeatGapMs: 400, oldestCommandAgeMs: 1200 }));
    expect(monitor.status(7000, "w1")).toEqual({
      workerId: "w1",
      health: { state: "overloaded", reasons: ["event-loop-delay"] },
      stateAgeMs: 1000,
      signals: {
        eventLoopDelayP99Ms: 250,
        eventLoopDelayMaxMs: 15,
        cpuPercent: 30,
        parseBacklogBytes: 0,
        executingCommands: 3,
        heartbeatGapMs: 400,
        oldestCommandAgeMs: 1200,
      },
    });
  });
});
