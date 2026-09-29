import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { BASELINE_ENCODING, DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
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
const tick = () => new Promise((resolve) => setImmediate(resolve));
let requestOrdinal = 0;
const command = (type, fields = {}) => ({
  type,
  worker,
  run,
  requestId: `flow-${++requestOrdinal}`,
  ...fields,
});

test("W2 replay evicts whole facts, keeps a selected copy charged, and never alters caller bytes", () => {
  const account = new WorkerRetainedBytes(16_384, 4112);
  const replay = new ReplayWindow(1024, 2, (bytes) => account.reserve("worker", bytes));
  const first = Uint8Array.from([65]);
  const append = (seq, bytes) => replay.append({ event: { type: "output", run, seq }, bytes });
  append(1, first);
  first[0] = 88;
  append(2, Uint8Array.from([66]));
  const pinned = replay.select(0, 2);
  expect(pinned.facts.map((fact) => fact.bytes[0])).toEqual([65, 66]);
  const withTwo = account.snapshot().workerBytes;
  append(3, Uint8Array.from([67]));
  expect(replay.select(0, 3)).toBeUndefined();
  const later = replay.select(1, 3);
  expect(later?.facts.map((fact) => fact.event.seq)).toEqual([2, 3]);
  expect(account.snapshot().workerBytes).toBeGreaterThan(withTwo);
  later.release();
  replay.clear();
  expect(account.snapshot().workerBytes).toBe(withTwo);
  pinned.release();
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 large baseline advances beyond 256 KiB credit only after exact parsed progress", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const emitted = [];
  const recovery = new RecoverySubscriptions(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event, payload) {
        const charge =
          16 + new TextEncoder().encode(JSON.stringify(event)).byteLength + payload.byteLength;
        emitted.push({ event, payload: Uint8Array.from(payload), charge });
        return charge;
      },
      cancelUnsent() {},
    },
  );
  const vt = Uint8Array.from({ length: 400_000 }, (_, index) => index % 251);
  const baseline = {
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    checkpointSeq: 0,
    atSeq: 0,
    captureGeometry: { cols: 12, rows: 4 },
    currentGeometry: { cols: 12, rows: 4 },
    coverage: {
      normal: {
        historyLines: 0,
        includedHistoryLines: 0,
        trimmedBefore: false,
        resizeContext: "complete",
      },
      alternate: { included: true, resizeContext: "complete" },
    },
    vt,
    tail: new Uint8Array(),
    appearance: DEFAULT_APPEARANCE,
  };
  try {
    const subscribe = command("subscribe", { subscription: ref, atSeq: 0 });
    const opened = await recovery.open(subscribe, {
      run,
      replay: new ReplayWindow(1024, 2, (bytes) => account.reserve("worker", bytes)),
      captureBaseline: async (reserveDetached) =>
        reserveDetached(vt.length + 4096)
          ? { status: "ready", baseline }
          : { status: "unavailable", reason: "denied" },
    });
    expect(opened.result).toMatchObject({ recoveryMode: "baseline", atSeq: 0 });
    expect(account.snapshot().workerBytes).toBeGreaterThan(400_000);
    expect(emitted).toEqual([]);
    recovery.markerEnqueued(subscribe, opened.result);
    for (let index = 0; index < 4; index++) await tick();
    const initial = emitted.filter((item) => item.event.terminal.type === "baseline-chunk");
    expect(initial.length).toBeGreaterThan(0);
    expect(initial.length).toBeLessThan(7);
    expect(emitted.some((item) => item.event.terminal.type === "baseline-end")).toBe(false);
    const baselineId = emitted[0].event.terminal.descriptor.baselineId;
    const badProgress = command("baseline-progress", {
      subscription: ref,
      baselineId,
      lastParsedOrdinal: 7,
    });
    expect(recovery.command(badProgress).failure).toBe("RESYNC_REQUIRED");
    for (let ordinal = 0; ordinal < 7; ordinal++) {
      const progress = command("baseline-progress", {
        subscription: ref,
        baselineId,
        lastParsedOrdinal: ordinal,
      });
      expect(recovery.command(progress).result.outcome).toBe("accepted");
      for (let turn = 0; turn < 4; turn++) await tick();
    }
    expect(emitted.filter((item) => item.event.terminal.type === "baseline-chunk")).toHaveLength(7);
    expect(emitted.at(-1).event.terminal.type).toBe("baseline-end");
    expect(
      emitted
        .filter((item) => item.event.terminal.type === "baseline-chunk")
        .reduce((sum, item) => sum + item.payload.byteLength, 0),
    ).toBe(400_000);
    const ack = command("applied-ack", { subscription: ref, appliedSeq: 0 });
    expect(recovery.command(ack).result.outcome).toBe("accepted");
    expect(recovery.installed(ref)).toBe(true);
    expect(account.snapshot().workerBytes).toBe(2 * 8320);
  } finally {
    recovery.shutdown();
  }
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 capture scheduler admits two generations and yields the third without extra ownership", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const recovery = new RecoverySubscriptions(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    { enqueue: () => false, cancelUnsent() {} },
  );
  const started = [];
  const release = [];
  const capture = (id) =>
    recovery.capture(
      id,
      () =>
        new Promise((resolve) => {
          started.push(id);
          release.push(() => resolve(id));
        }),
    );
  try {
    const a = capture("a");
    const b = capture("b");
    const c = capture("c");
    await tick();
    expect(started).toEqual(["a", "b"]);
    release.shift()();
    expect(await a).toBe("a");
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
    release.shift()();
    release.shift()();
    expect(await Promise.all([b, c])).toEqual(["b", "c"]);
  } finally {
    recovery.shutdown();
  }
});

test("W2 reentrant unsubscribe fences producer before an enqueued frame can commit successors", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const emitted = [];
  const canceled = [];
  const unsubscribe = command("unsubscribe", { subscription: ref });
  let recovery;
  recovery = new RecoverySubscriptions(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event, payload, _token) {
        emitted.push(event.terminal.type);
        if (emitted.length === 1)
          expect(recovery.command(unsubscribe).result.outcome).toBe("accepted");
        return 16 + new TextEncoder().encode(JSON.stringify(event)).byteLength + payload.length;
      },
      cancelUnsent(token) {
        canceled.push(token);
      },
    },
  );
  const subscribe = command("subscribe", { subscription: ref, atSeq: 0 });
  try {
    const opened = await recovery.open(subscribe, {
      run,
      replay: new ReplayWindow(1024, 2, (bytes) => account.reserve("worker", bytes)),
      captureBaseline: async (reserveDetached) => {
        expect(reserveDetached(4097)).toBe(true);
        return {
          status: "ready",
          baseline: {
            profile: PROFILE,
            encoding: BASELINE_ENCODING,
            checkpointSeq: 0,
            atSeq: 0,
            captureGeometry: { cols: 12, rows: 4 },
            currentGeometry: { cols: 12, rows: 4 },
            coverage: {
              normal: {
                historyLines: 0,
                includedHistoryLines: 0,
                trimmedBefore: false,
                resizeContext: "complete",
              },
              alternate: { included: true, resizeContext: "complete" },
            },
            vt: Uint8Array.from([65]),
            tail: new Uint8Array(),
            appearance: DEFAULT_APPEARANCE,
          },
        };
      },
    });
    recovery.markerEnqueued(subscribe, opened.result);
    await tick();
    expect(emitted).toEqual(["baseline-start"]);
    expect(canceled).toHaveLength(1);
    recovery.responseSettled(unsubscribe.requestId);
    expect(recovery.routeCount).toBe(0);
  } finally {
    recovery.shutdown();
  }
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 pending capture expires with a correlated result and no late producer", async () => {
  const budgets = { ...M0_LIMITS, recoveryDeadlineMs: 10 };
  const account = new WorkerRetainedBytes(budgets.workerBytes, budgets.reservedControlBytes);
  const emitted = [];
  const recovery = new RecoverySubscriptions(
    worker,
    budgets,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event) {
        emitted.push(event);
        return 128;
      },
      cancelUnsent() {},
    },
  );
  let finishCapture;
  const subscribe = command("subscribe", { subscription: ref, atSeq: 0 });
  try {
    const result = await recovery.open(subscribe, {
      run,
      replay: new ReplayWindow(1024, 2, (bytes) => account.reserve("worker", bytes)),
      captureBaseline: () =>
        new Promise((resolve) => {
          finishCapture = resolve;
        }),
    });
    expect(result.failure).toBe("RECOVERY_EXPIRED");
    expect(emitted).toEqual([]);
    finishCapture({ status: "unavailable", reason: "late" });
    await tick();
    expect(emitted).toEqual([]);
    expect(recovery.installed(ref)).toBe(false);
  } finally {
    recovery.shutdown();
  }
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 one slow route overflows without hiding a healthy peer's exact live facts", async () => {
  const budgets = { ...M0_LIMITS, postNEvents: 1 };
  const account = new WorkerRetainedBytes(budgets.workerBytes, budgets.reservedControlBytes);
  const slow = { ...ref, subscriptionId: "slow" };
  const healthy = { ...ref, subscriptionId: "healthy" };
  const delivered = [];
  let blockSlow = false;
  const recovery = new RecoverySubscriptions(
    worker,
    budgets,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event, payload) {
        if (blockSlow && event.subscription.subscriptionId === "slow") return false;
        delivered.push({ event, payload: Uint8Array.from(payload) });
        return 16 + new TextEncoder().encode(JSON.stringify(event)).byteLength + payload.length;
      },
      cancelUnsent() {},
    },
  );
  const source = {
    run,
    replay: new ReplayWindow(1024, 2, (bytes) => account.reserve("worker", bytes)),
    captureBaseline: async (reserveDetached) => {
      expect(reserveDetached(4097)).toBe(true);
      return {
        status: "ready",
        baseline: {
          profile: PROFILE,
          encoding: BASELINE_ENCODING,
          checkpointSeq: 0,
          atSeq: 0,
          captureGeometry: { cols: 12, rows: 4 },
          currentGeometry: { cols: 12, rows: 4 },
          coverage: {
            normal: {
              historyLines: 0,
              includedHistoryLines: 0,
              trimmedBefore: false,
              resizeContext: "complete",
            },
            alternate: { included: true, resizeContext: "complete" },
          },
          vt: Uint8Array.from([65]),
          tail: new Uint8Array(),
          appearance: DEFAULT_APPEARANCE,
        },
      };
    },
  };
  try {
    for (const subscription of [slow, healthy]) {
      const subscribe = command("subscribe", { subscription, atSeq: 0 });
      const opened = await recovery.open(subscribe, source);
      expect(opened.result.outcome).toBe("accepted");
      recovery.markerEnqueued(subscribe, opened.result);
      await tick();
      const start = delivered.find(
        (item) =>
          item.event.subscription.subscriptionId === subscription.subscriptionId &&
          item.event.terminal.type === "baseline-start",
      );
      const progress = command("baseline-progress", {
        subscription,
        baselineId: start.event.terminal.descriptor.baselineId,
        lastParsedOrdinal: 0,
      });
      expect(recovery.command(progress).result.outcome).toBe("accepted");
      expect(
        recovery.command(command("applied-ack", { subscription, appliedSeq: 0 })).result.outcome,
      ).toBe("accepted");
    }
    blockSlow = true;
    recovery.onFact(run, { event: { type: "output", run, seq: 1 }, bytes: Uint8Array.from([66]) });
    await tick();
    recovery.onFact(run, { event: { type: "output", run, seq: 2 }, bytes: Uint8Array.from([67]) });
    await tick();
    expect(
      recovery.command(command("applied-ack", { subscription: slow, appliedSeq: 0 })).failure,
    ).toBe("RESYNC_REQUIRED");
    expect(
      delivered
        .filter(
          (item) =>
            item.event.subscription.subscriptionId === "healthy" &&
            item.event.terminal.type === "output",
        )
        .map((item) => [item.event.terminal.seq, item.payload[0]]),
    ).toEqual([
      [1, 66],
      [2, 67],
    ]);
    expect(
      recovery.command(command("applied-ack", { subscription: healthy, appliedSeq: 2 })).result
        .outcome,
    ).toBe("accepted");
  } finally {
    recovery.shutdown();
  }
  expect(account.snapshot().workerBytes).toBe(0);
});
