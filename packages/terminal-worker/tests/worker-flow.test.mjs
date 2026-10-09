import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { BASELINE_ENCODING, DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { RecoverySubscriptions } from "../dist/src/recovery-subscription.js";
import { ReplayWindow, retainedFactCharge } from "../dist/src/replay-window.js";
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

test("W2 replay falls back across requiresBaseline but accepts after-floor and ordinary intervals", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const replay = new ReplayWindow(16_384, 8, (bytes) => account.reserve("worker", bytes));
  replay.append({ event: { type: "output", run, seq: 1 }, bytes: Uint8Array.from([65]) });
  replay.append({
    event: { type: "resize", run, seq: 2, geometry: { cols: 12, rows: 4 }, requiresBaseline: true },
  });
  replay.append({ event: { type: "output", run, seq: 3 }, bytes: Uint8Array.from([66]) });
  expect(replay.select(1, 3)).toBeUndefined();
  const afterFloor = replay.select(2, 3);
  expect(afterFloor?.facts.map((fact) => fact.event.seq)).toEqual([3]);
  afterFloor.release();
  replay.append({ event: { type: "output", run, seq: 4 }, bytes: Uint8Array.from([67]) });
  const ordinary = replay.select(3, 4);
  expect(ordinary?.facts.map((fact) => fact.event.seq)).toEqual([4]);
  ordinary.release();
  let captures = 0;
  const recovery = new RecoverySubscriptions(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    { enqueue: () => false, cancelUnsent() {} },
  );
  try {
    const opened = await recovery.open(command("subscribe", { subscription: ref, atSeq: 1 }), {
      run,
      replay,
      captureBaseline: async (reserveDetached) => {
        captures++;
        expect(reserveDetached(4097)).toBe(true);
        return {
          status: "ready",
          baseline: {
            profile: PROFILE,
            encoding: BASELINE_ENCODING,
            checkpointSeq: 4,
            atSeq: 4,
            captureGeometry: { cols: 12, rows: 4 },
            currentGeometry: { cols: 12, rows: 4 },
            control: { epoch: 0, holder: null },
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
    expect(opened.result.recoveryMode).toBe("baseline");
    expect(captures).toBe(1);
  } finally {
    recovery.shutdown();
    replay.clear();
  }
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 maximum palette metadata and selected references refuse before retention, then release", () => {
  const appearance = {
    palette: Array.from({ length: 256 }, (_, index) => ({ index, rgb: "ffff/ffff/ffff" })),
  };
  const fact = { event: { type: "appearance", run, seq: 1, appearance } };
  const charge = retainedFactCharge(fact);
  expect(charge).toBeGreaterThan(4096);
  const tooSmall = new WorkerRetainedBytes(charge + 4112, 4112);
  const refused = new ReplayWindow(charge - 1, 1, (bytes) => tooSmall.reserve("worker", bytes));
  refused.append(fact);
  expect(refused.retainedEvents).toBe(0);
  expect(tooSmall.snapshot().workerBytes).toBe(0);

  const account = new WorkerRetainedBytes(charge + 4112, 4112);
  const replay = new ReplayWindow(charge, 1, (bytes) => account.reserve("worker", bytes));
  replay.append(fact);
  expect(replay.retainedBytes).toBe(charge);
  expect(replay.select(0, 1)).toBeUndefined();
  replay.clear();
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 4096 selected replay references own their table bytes through ring eviction", () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const replay = new ReplayWindow(4 * 1024 * 1024, 4096, (bytes) =>
    account.reserve("worker", bytes),
  );
  for (let seq = 1; seq <= 4096; seq++)
    replay.append({ event: { type: "output", run, seq }, bytes: Uint8Array.from([seq & 255]) });
  expect(replay.retainedEvents).toBe(4096);
  const ringBytes = account.snapshot().workerBytes;
  const selected = replay.select(0, 4096);
  expect(selected?.facts).toHaveLength(4096);
  expect(account.snapshot().workerBytes - ringBytes).toBeGreaterThanOrEqual(4096 * 64);
  replay.clear();
  expect(account.snapshot().workerBytes).toBeGreaterThan(0);
  selected.release();
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 memory-pressure eviction preserves pinned ownership and makes a gap require baseline", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const replay = new ReplayWindow(16_384, 4, (bytes) => account.reserve("worker", bytes));
  for (let seq = 1; seq <= 3; seq++)
    replay.append({ event: { type: "output", run, seq }, bytes: Uint8Array.from([seq]) });
  const pinned = replay.pin(2);
  expect(pinned?.fact.bytes?.[0]).toBe(2);
  const before = account.snapshot().workerBytes;
  expect(replay.evictOldest()).toBe(true);
  expect(replay.evictOldest()).toBe(true);
  expect(account.snapshot().workerBytes).toBeLessThan(before);
  expect(replay.select(1, 3)).toBeUndefined();
  const afterFloor = replay.select(2, 3);
  expect(afterFloor?.facts.map((fact) => fact.event.seq)).toEqual([3]);
  afterFloor.release();
  let captured = 0;
  const recovery = new RecoverySubscriptions(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    { enqueue: () => false, cancelUnsent() {} },
  );
  try {
    const opened = await recovery.open(command("subscribe", { subscription: ref, atSeq: 1 }), {
      run,
      replay,
      captureBaseline: async (reserveDetached) => {
        captured++;
        expect(reserveDetached(4097)).toBe(true);
        return {
          status: "ready",
          baseline: {
            profile: PROFILE,
            encoding: BASELINE_ENCODING,
            checkpointSeq: 3,
            atSeq: 3,
            captureGeometry: { cols: 12, rows: 4 },
            currentGeometry: { cols: 12, rows: 4 },
            control: { epoch: 0, holder: null },
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
    expect(opened.result.recoveryMode).toBe("baseline");
    expect(captured).toBe(1);
  } finally {
    recovery.shutdown();
    replay.clear();
  }
  expect(account.snapshot().workerBytes).toBeGreaterThan(0);
  pinned.release();
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 input-priority reclaim skips a pinned oldest fact and releases only an unpinned whole fact", () => {
  const account = new WorkerRetainedBytes(16_384, 4112);
  const replay = new ReplayWindow(4096, 4, (bytes) => account.reserve("worker", bytes));
  replay.append({ event: { type: "output", run, seq: 1 }, bytes: Uint8Array.from([65]) });
  replay.append({ event: { type: "output", run, seq: 2 }, bytes: Uint8Array.from([66]) });
  const pin = replay.pin(1);
  const before = account.snapshot().workerBytes;
  expect(replay.evictOldestUnpinned()).toBe(true);
  expect(replay.retainedEvents).toBe(1);
  expect(replay.retainedBytes).toBe(retainedFactCharge(pin.fact));
  expect(account.snapshot().workerBytes).toBe(
    before -
      retainedFactCharge({
        event: { type: "output", run, seq: 2 },
        bytes: Uint8Array.from([66]),
      }),
  );
  expect(replay.evictOldestUnpinned()).toBe(false);
  expect(replay.select(1, 2)).toBeUndefined();
  replay.clear();
  expect(account.snapshot().workerBytes).toBeGreaterThan(0);
  pin.release();
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 replay eviction cannot retire an installed route's unacknowledged delivery", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const replay = new ReplayWindow(16_384, 4, (bytes) => account.reserve("worker", bytes));
  const emitted = [];
  const recovery = new RecoverySubscriptions(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event, payload) {
        emitted.push(event);
        return 16 + new TextEncoder().encode(JSON.stringify(event)).byteLength + payload.length;
      },
      cancelUnsent() {},
    },
  );
  try {
    const subscribe = command("subscribe", { subscription: ref, atSeq: 0 });
    const opened = await recovery.open(subscribe, {
      run,
      replay,
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
            control: { epoch: 0, holder: null },
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
    const baselineId = emitted[0].terminal.descriptor.baselineId;
    expect(
      recovery.command(
        command("baseline-progress", { subscription: ref, baselineId, lastParsedOrdinal: 0 }),
      ).result.outcome,
    ).toBe("accepted");
    expect(
      recovery.command(command("applied-ack", { subscription: ref, appliedSeq: 0 })).result.outcome,
    ).toBe("accepted");
    expect(recovery.installed(ref)).toBe(true);
    emitted.length = 0;
    const fact = { event: { type: "output", run, seq: 1 }, bytes: Uint8Array.from([66]) };
    replay.append(fact);
    recovery.onFact(run, fact, replay);
    expect(replay.evictOldest()).toBe(true);
    const unacknowledgedBytes = account.snapshot().workerBytes;
    await tick();
    expect(emitted.map((event) => event.terminal.seq)).toEqual([1]);
    expect(account.snapshot().workerBytes).toBeLessThan(unacknowledgedBytes);
    expect(account.snapshot().workerBytes).toBeGreaterThan(2 * 8320);
    expect(
      recovery.command(command("applied-ack", { subscription: ref, appliedSeq: 1 })).result.outcome,
    ).toBe("accepted");
    expect(account.snapshot().workerBytes).toBe(2 * 8320);
  } finally {
    recovery.shutdown();
    replay.clear();
  }
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 baseline frame table refuses tiny worker headroom before retaining frame views", async () => {
  const limit = 22_000;
  const account = new WorkerRetainedBytes(limit, 4112);
  const replay = new ReplayWindow(1024, 2, (bytes) => account.reserve("worker", bytes));
  const recovery = new RecoverySubscriptions(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue: () => {
        throw new Error("frame must not be emitted");
      },
      cancelUnsent() {},
    },
  );
  try {
    const result = await recovery.open(command("subscribe", { subscription: ref, atSeq: 0 }), {
      run,
      replay,
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
            control: { epoch: 0, holder: null },
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
    expect(result.failure).toBe("RECOVERY_UNAVAILABLE");
    expect(account.snapshot().peakAccountedBytes).toBeLessThanOrEqual(limit);
    expect(recovery.installed(ref)).toBe(false);
  } finally {
    recovery.shutdown();
  }
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 maximum 129-chunk baseline retains its table lease until route shutdown", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const vt = new Uint8Array(M0_LIMITS.baselineVtBytes);
  const tail = new Uint8Array(M0_LIMITS.baselineTailBytes);
  const recovery = new RecoverySubscriptions(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    { enqueue: () => false, cancelUnsent() {} },
  );
  try {
    const result = await recovery.open(command("subscribe", { subscription: ref, atSeq: 0 }), {
      run,
      replay: new ReplayWindow(1024, 2, (bytes) => account.reserve("worker", bytes)),
      captureBaseline: async (reserveDetached) => {
        expect(reserveDetached(vt.length + tail.length + 4096)).toBe(true);
        return {
          status: "ready",
          baseline: {
            profile: PROFILE,
            encoding: BASELINE_ENCODING,
            checkpointSeq: 0,
            atSeq: 0,
            captureGeometry: { cols: 12, rows: 4 },
            currentGeometry: { cols: 12, rows: 4 },
            control: { epoch: 0, holder: null },
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
            tail,
            appearance: DEFAULT_APPEARANCE,
          },
        };
      },
    });
    expect(result.result.recoveryMode).toBe("baseline");
    expect(account.snapshot().workerBytes).toBeGreaterThan(
      vt.length + tail.length + 129 * 512 + 2 * 8320,
    );
    expect(account.snapshot().peakAccountedBytes).toBeLessThanOrEqual(M0_LIMITS.workerBytes);
  } finally {
    recovery.shutdown();
  }
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 sent-ledger denial fences before enqueue and releases post-N ownership", async () => {
  const account = new WorkerRetainedBytes(50_000, 4112);
  const events = [];
  const recovery = new RecoverySubscriptions(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event, payload) {
        events.push(event);
        return 16 + new TextEncoder().encode(JSON.stringify(event)).byteLength + payload.length;
      },
      cancelUnsent() {},
    },
  );
  let blocker;
  try {
    const subscribe = command("subscribe", { subscription: ref, atSeq: 0 });
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
            control: { epoch: 0, holder: null },
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
    expect(opened.result.outcome).toBe("accepted");
    recovery.markerEnqueued(subscribe, opened.result);
    await tick();
    const baselineId = events[0].terminal.descriptor.baselineId;
    expect(
      recovery.command(
        command("baseline-progress", { subscription: ref, baselineId, lastParsedOrdinal: 0 }),
      ).result.outcome,
    ).toBe("accepted");
    expect(
      recovery.command(command("applied-ack", { subscription: ref, appliedSeq: 0 })).result.outcome,
    ).toBe("accepted");
    events.length = 0;
    recovery.onFact(run, { event: { type: "output", run, seq: 1 }, bytes: Uint8Array.from([66]) });
    blocker = account.reserve("worker", account.availableOrdinaryBytes() - 64);
    expect(blocker).toBeDefined();
    await tick();
    expect(events).toEqual([]);
    expect(
      recovery.command(command("applied-ack", { subscription: ref, appliedSeq: 0 })).failure,
    ).toBe("RESYNC_REQUIRED");
    expect(account.snapshot().peakAccountedBytes).toBeLessThanOrEqual(50_000);
  } finally {
    recovery.shutdown();
    blocker?.release();
  }
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
    control: { epoch: 0, holder: null },
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
            control: { epoch: 0, holder: null },
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
          control: { epoch: 0, holder: null },
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

test("W2 scheduler defers a fourth legal frame before the 256 KiB turn boundary", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const observed = [];
  let turn = 0;
  const recovery = new RecoverySubscriptions(
    worker,
    M0_LIMITS,
    (bytes) => account.reserve("worker", bytes),
    {
      enqueue(event, payload) {
        const charge =
          16 + new TextEncoder().encode(JSON.stringify(event)).byteLength + payload.length;
        observed.push({ event, charge, turn });
        return charge;
      },
      cancelUnsent() {},
    },
  );
  const subscriptions = ["one", "two", "three", "four"].map((subscriptionId) => ({
    ...ref,
    subscriptionId,
  }));
  try {
    for (const subscription of subscriptions) {
      const subscribe = command("subscribe", { subscription, atSeq: 0 });
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
              control: { epoch: 0, holder: null },
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
      expect(opened.result.recoveryMode).toBe("baseline");
      recovery.markerEnqueued(subscribe, opened.result);
      await tick();
      const start = observed.find(
        (item) =>
          item.event.subscription.subscriptionId === subscription.subscriptionId &&
          item.event.terminal.type === "baseline-start",
      );
      expect(
        recovery.command(
          command("baseline-progress", {
            subscription,
            baselineId: start.event.terminal.descriptor.baselineId,
            lastParsedOrdinal: 0,
          }),
        ).result.outcome,
      ).toBe("accepted");
      expect(
        recovery.command(command("applied-ack", { subscription, appliedSeq: 0 })).result.outcome,
      ).toBe("accepted");
    }
    observed.length = 0;
    turn = 1;
    recovery.onFact(run, {
      event: { type: "output", run, seq: 1 },
      bytes: Uint8Array.from({ length: 65_536 }, () => 65),
    });
    await tick();
    const first = observed.filter(
      (item) => item.turn === 1 && item.event.terminal.type === "output",
    );
    expect(first).toHaveLength(3);
    expect(first.reduce((sum, item) => sum + item.charge, 0)).toBeLessThanOrEqual(256 * 1024);
    expect(first.reduce((sum, item) => sum + item.charge, 0) + first[0].charge).toBeGreaterThan(
      256 * 1024,
    );
    turn = 2;
    await tick();
    const second = observed.filter(
      (item) => item.turn === 2 && item.event.terminal.type === "output",
    );
    expect(second).toHaveLength(1);
    expect(
      new Set([...first, ...second].map((item) => item.event.subscription.subscriptionId)).size,
    ).toBe(4);
    const beforeAck = account.snapshot().workerBytes;
    for (const subscription of subscriptions)
      expect(
        recovery.command(command("applied-ack", { subscription, appliedSeq: 1 })).result.outcome,
      ).toBe("accepted");
    expect(account.snapshot().workerBytes).toBeLessThan(beforeAck);
  } finally {
    recovery.shutdown();
  }
  expect(account.snapshot().workerBytes).toBe(0);
});
