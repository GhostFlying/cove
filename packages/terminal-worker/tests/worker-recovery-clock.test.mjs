import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { PreviewService } from "../dist/src/preview-service.js";
import { RecoverySubscriptions } from "../dist/src/recovery-subscription.js";
import { ReplayWindow } from "../dist/src/replay-window.js";
import { WorkerRetainedBytes } from "../dist/src/worker-retained-bytes.js";

const worker = {
  serverId: "server",
  relayInstanceId: "relay",
  workerId: "worker",
  workerIncarnationId: "incarnation",
};
const run = { serverId: "server", relayInstanceId: "relay", runId: "run" };
const ref = {
  run,
  connection: { connectionId: "connection", generation: 1 },
  viewId: "view",
  subscriptionId: "subscription",
};

function manualClock() {
  let time = 0;
  let ordinal = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, delayMs) {
      const handle = { id: ++ordinal };
      timers.set(handle, { at: time + delayMs, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    advance(deltaMs) {
      time += deltaMs;
      while (true) {
        const due = [...timers].find(([, timer]) => timer.at <= time);
        if (!due) break;
        timers.delete(due[0]);
        due[1].callback();
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("W2 recovery uses one instance clock for capture race and route expiry", async () => {
  const clock = manualClock();
  const budgets = { ...M0_LIMITS, recoveryDeadlineMs: 20 };
  const account = new WorkerRetainedBytes(budgets.workerBytes, budgets.reservedControlBytes);
  const replay = new ReplayWindow(1024, 2, (bytes) => account.reserve("worker", bytes));
  const emitted = [];
  const recovery = new RecoverySubscriptions(
    worker,
    budgets,
    (bytes) => account.reserve("worker", bytes),
    { enqueue: (event) => emitted.push(event), cancelUnsent() {} },
    clock,
  );
  let settled = false;
  try {
    const pending = recovery
      .open(
        {
          type: "subscribe",
          worker,
          run,
          requestId: "clock-recovery",
          subscription: ref,
          atSeq: 0,
        },
        { run, replay, captureBaseline: () => new Promise(() => {}) },
      )
      .then((outcome) => {
        settled = true;
        return outcome;
      });
    expect(clock.pending).toBeGreaterThan(0);
    clock.advance(19);
    await tick();
    expect(settled).toBe(false);
    clock.advance(1);
    expect((await pending).failure).toBe("RECOVERY_EXPIRED");
    expect(emitted).toEqual([]);
  } finally {
    recovery.shutdown();
    replay.clear();
  }
  expect(clock.pending).toBe(0);
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 preview uses the injected clock for capture and partial-delivery expiry", async () => {
  const clock = manualClock();
  const budgets = { ...M0_LIMITS, recoveryDeadlineMs: 20 };
  const account = new WorkerRetainedBytes(budgets.workerBytes, budgets.reservedControlBytes);
  const emitted = [];
  const canceled = [];
  const preview = new PreviewService(
    worker,
    budgets,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event) {
        if (emitted.length) return false;
        emitted.push(event);
        return 128;
      },
      cancelUnsent: (token) => canceled.push(token),
    },
    (_runId, operation) => operation(),
    clock,
  );
  const command = { type: "preview-refresh", worker, run, requestId: "clock-preview" };
  const ready = {
    status: "ready",
    preview: { atSeq: 1, geometry: { cols: 12, rows: 4 }, vt: Uint8Array.from([65]) },
  };
  let settled = false;
  try {
    const pending = preview
      .refresh(command, run, async () => ready)
      .then((outcome) => {
        settled = true;
        return outcome;
      });
    await tick();
    expect(emitted.map((event) => event.terminal.type)).toEqual(["preview-start"]);
    expect(emitted[0].terminal.generatedAtMs).toBeGreaterThan(1_000_000_000_000);
    clock.advance(19);
    await tick();
    expect(settled).toBe(false);
    clock.advance(1);
    expect((await pending).failure).toBe("RECOVERY_EXPIRED");
    expect(canceled).toHaveLength(1);
  } finally {
    preview.shutdown();
  }
  expect(clock.pending).toBe(0);
  expect(account.snapshot().workerBytes).toBe(0);
});
