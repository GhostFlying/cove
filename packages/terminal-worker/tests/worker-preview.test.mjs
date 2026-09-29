import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { PreviewService } from "../dist/src/preview-service.js";
import { WorkerRetainedBytes } from "../dist/src/worker-retained-bytes.js";

const worker = {
  serverId: "server",
  relayInstanceId: "relay",
  workerId: "worker",
  workerIncarnationId: "incarnation",
};
const run = { serverId: "server", relayInstanceId: "relay", runId: "run" };
let ordinal = 0;
const command = () => ({
  type: "preview-refresh",
  worker,
  run,
  requestId: `preview-${++ordinal}`,
});
const ready = {
  status: "ready",
  preview: { atSeq: 1, geometry: { cols: 12, rows: 4 }, vt: Uint8Array.from([65, 66]) },
};

test("W2 preview holds one run slot through capture and fences late completion after shutdown", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const events = [];
  const service = new PreviewService(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event) {
        events.push(event);
        return 128;
      },
      cancelUnsent() {},
    },
    (_runId, operation) => operation(),
  );
  let resolveCapture;
  const capture = () =>
    new Promise((resolve) => {
      resolveCapture = resolve;
    });
  const first = service.refresh(command(), run, capture);
  expect(account.snapshot().workerBytes).toBeGreaterThan(0);
  expect((await service.refresh(command(), run, async () => ready)).failure).toBe("BUSY");
  expect(events).toEqual([]);
  service.shutdown();
  resolveCapture(ready);
  expect((await first).failure).toBe("RESULT_UNKNOWN");
  expect(events).toEqual([]);
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 preview partial admission expires once, cancels unsent bytes and never sends after error", async () => {
  const budgets = { ...M0_LIMITS, recoveryDeadlineMs: 10 };
  const account = new WorkerRetainedBytes(budgets.workerBytes, budgets.reservedControlBytes);
  const events = [];
  const canceled = [];
  const service = new PreviewService(
    worker,
    budgets,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event, _payload, token) {
        if (events.length === 1) return false;
        events.push({ event, token });
        return 128;
      },
      cancelUnsent(token) {
        canceled.push(token);
      },
    },
    (_runId, operation) => operation(),
  );
  try {
    const result = await service.refresh(command(), run, async () => ready);
    expect(result.failure).toBe("RECOVERY_EXPIRED");
    expect(events.map((item) => item.event.terminal.type)).toEqual(["preview-start"]);
    expect(canceled).toEqual([events[0].token]);
    service.capacity();
    expect(events).toHaveLength(1);
    expect(account.snapshot().workerBytes).toBe(0);
  } finally {
    service.shutdown();
  }
});

test("W2 reentrant delivery-capacity callback cannot duplicate a preview frame", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const events = [];
  let service;
  service = new PreviewService(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event) {
        events.push(event.terminal.type);
        if (events.length === 1) service.capacity();
        return 128;
      },
      cancelUnsent() {},
    },
    (_runId, operation) => operation(),
  );
  try {
    expect((await service.refresh(command(), run, async () => ready)).result.outcome).toBe(
      "accepted",
    );
    expect(events).toEqual(["preview-start", "preview-chunk", "preview-end"]);
    expect(account.snapshot().workerBytes).toBe(0);
  } finally {
    service.shutdown();
  }
});

test("W2 preview capture expiry keeps its lease until a late model result settles", async () => {
  const budgets = { ...M0_LIMITS, recoveryDeadlineMs: 10 };
  const account = new WorkerRetainedBytes(budgets.workerBytes, budgets.reservedControlBytes);
  const events = [];
  const service = new PreviewService(
    worker,
    budgets,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event) {
        events.push(event);
        return 128;
      },
      cancelUnsent() {},
    },
    (_runId, operation) => operation(),
  );
  let resolveCapture;
  try {
    const pending = service.refresh(
      command(),
      run,
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
    expect((await pending).failure).toBe("RECOVERY_EXPIRED");
    expect(account.snapshot().workerBytes).toBeGreaterThan(0);
    expect((await service.refresh(command(), run, async () => ready)).failure).toBe("BUSY");
    resolveCapture(ready);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([]);
    expect(account.snapshot().workerBytes).toBe(0);
  } finally {
    service.shutdown();
  }
});

test("W2 preview capture rejection is correlated and releases its reserved slot", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const events = [];
  const service = new PreviewService(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event) {
        events.push(event);
        return 128;
      },
      cancelUnsent() {},
    },
    (_runId, operation) => operation(),
  );
  try {
    const failed = await service.refresh(command(), run, () => {
      throw new Error("capture failed");
    });
    expect(failed.failure).toBe("RECOVERY_UNAVAILABLE");
    expect(events).toEqual([]);
    expect(account.snapshot().workerBytes).toBe(0);
    expect((await service.refresh(command(), run, async () => ready)).result.outcome).toBe(
      "accepted",
    );
  } finally {
    service.shutdown();
  }
  expect(account.snapshot().workerBytes).toBe(0);
});
