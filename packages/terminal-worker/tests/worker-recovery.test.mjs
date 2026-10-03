import { expect, test } from "vitest";
import { createTerminalModel } from "@cove/terminal-engine";
import { RecoverySubscriptions } from "../dist/src/recovery-subscription.js";
import { ReplayWindow } from "../dist/src/replay-window.js";
import { WorkerRetainedBytes } from "../dist/src/worker-retained-bytes.js";
import { PassThrough, Writable } from "node:stream";
import { M0_LIMITS } from "@cove/protocol/budgets";
import {
  PIPE_VERSION,
  composeSpawnPayload,
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
} from "@cove/protocol/pipe";
import { DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { createWorkerExecution } from "@cove/terminal-worker/execution";
import { runWorkerPipe } from "@cove/terminal-worker/pipe";

const worker = {
  serverId: "server",
  relayInstanceId: "relay",
  workerId: "worker",
  workerIncarnationId: "incarnation",
};
const run = { serverId: "server", relayInstanceId: "relay", runId: "run" };
const subscription = {
  run,
  connection: { connectionId: "connection", generation: 1 },
  viewId: "view",
  subscriptionId: "subscription",
};
const utf8 = (value) => new TextEncoder().encode(value);
let ordinal = 0;
const command = (type, fields = {}) => ({
  type,
  worker,
  run,
  requestId: `r${++ordinal}`,
  ...fields,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

function factory() {
  let observer;
  let ticket = 0;
  const writes = [];
  return {
    retainedBytesAccounting: "participating",
    writes,
    get observer() {
      return observer;
    },
    spawn(_spec, value) {
      observer = value;
      return {
        kind: "created",
        pty: {
          pid: 1,
          writerCompletion: Promise.resolve({ kind: "closed" }),
          submit(bytes, onSettled) {
            const current = ++ticket;
            writes.push(Buffer.from(bytes));
            queueMicrotask(() =>
              onSettled({
                kind: "written",
                ticket: current,
                status: "written",
                originalBytes: bytes.length,
                writtenBytes: bytes.length,
                remainingBytes: 0,
              }),
            );
            return { kind: "accepted", ticket: current, byteLength: bytes.length };
          },
          automaticOutputSink() {},
          pause() {},
          resume() {},
          resize() {},
          retireInput() {},
          async stop() {
            observer.onExit({ exitCode: 0 });
            return {
              kind: "exited",
              exit: { exitCode: 0 },
              cleanup: {
                scope: "initial-process-group",
                verified: false,
                graceful: { kind: "not-attempted", reason: "already-exited" },
                force: { kind: "not-attempted", reason: "already-exited" },
              },
            };
          },
          snapshot() {
            return {
              pid: 1,
              exited: false,
              writer: "closed",
              input: {
                allocatedBytes: 0,
                tasks: 0,
                peakAllocatedBytes: 0,
                peakTasks: 0,
                maxBytes: 65_536,
                maxTasks: 256,
              },
              earlyOutputBytes: 0,
              paused: false,
            };
          },
        },
      };
    },
  };
}

test("W2 producer baseline marker, progress, final ACK and live fact use actual engine", async () => {
  const native = factory();
  const emitted = [];
  const delivery = {
    enqueue(event, payload, token) {
      emitted.push({ event, payload: Uint8Array.from(payload), token });
      return 16 + utf8(JSON.stringify(event)).byteLength + payload.byteLength;
    },
    cancelUnsent() {},
  };
  const execution = createWorkerExecution({
    worker,
    effectiveBudgets: M0_LIMITS,
    factory: native,
    delivery,
  });
  try {
    const composed = composeSpawnPayload(
      { executable: "/bin/sh", argv: ["-c", "exit 0"], cwd: "/" },
      utf8,
    );
    const spawn = command("spawn", {
      operationId: "spawn",
      geometry: { cols: 12, rows: 4 },
      profile: PROFILE,
      appearance: DEFAULT_APPEARANCE,
      effectiveBudgets: M0_LIMITS,
      spawnPayloadBytes: composed.bytes.length,
    });
    expect((await execution.execute(spawn, composed.bytes)).outcome).toBe("accepted");
    native.observer.onData(Buffer.from("HELLO"));
    expect((await execution.execute(command("status"))).runStatus.parsedSeq).toBe(1);
    const subscribe = command("subscribe", { subscription, atSeq: 0 });
    const marker = await execution.execute(subscribe);
    expect(marker).toMatchObject({ type: "result", recoveryMode: "baseline", atSeq: 1 });
    expect(emitted).toEqual([]);
    execution.markerEnqueued(subscribe, marker);
    for (let index = 0; index < 4; index++) await tick();
    const kinds = emitted.map((entry) => entry.event.terminal.type);
    expect(kinds[0]).toBe("baseline-start");
    expect(kinds.at(-1)).toBe("baseline-end");
    const chunks = emitted.filter((entry) => entry.event.terminal.type === "baseline-chunk");
    expect(chunks.length).toBeGreaterThan(0);
    const baselineId = emitted[0].event.terminal.descriptor.baselineId;
    for (let index = 0; index < chunks.length; index++) {
      const progress = command("baseline-progress", {
        subscription,
        baselineId,
        lastParsedOrdinal: index,
      });
      expect((await execution.execute(progress)).outcome).toBe("accepted");
      execution.responseSettled(progress.requestId);
    }
    const ack = command("applied-ack", { subscription, appliedSeq: 1 });
    expect((await execution.execute(ack)).outcome).toBe("accepted");
    execution.responseSettled(ack.requestId);
    native.observer.onData(Buffer.from("NEXT"));
    expect((await execution.execute(command("status"))).runStatus.parsedSeq).toBe(2);
    for (let index = 0; index < 3; index++) await tick();
    expect(emitted.at(-1).event.terminal).toMatchObject({ type: "output", seq: 2 });
    expect(new TextDecoder().decode(emitted.at(-1).payload)).toBe("NEXT");
  } finally {
    await execution.shutdown("finite-test");
  }
});

test("W2 compiled endpoint queues baseline marker first and preview result after transfer", async () => {
  const native = factory();
  const input = new PassThrough();
  const output = new PassThrough();
  const bytes = [];
  output.on("data", (chunk) => bytes.push(Buffer.from(chunk)));
  const pipe = runWorkerPipe(input, output, {
    buildVersion: "finite",
    createExecution: (options) => createWorkerExecution({ ...options, factory: native }),
  });
  const send = (metadata, payload = new Uint8Array()) => {
    const frame = encodePipeFrame(1, utf8(JSON.stringify(metadata)), payload);
    if (!frame.ok) throw new Error(frame.error.code);
    input.write(Buffer.from(frame.value));
  };
  const received = () => {
    const decoder = createPipeDecoder();
    const collected = [];
    const all = Buffer.concat(bytes);
    let offset = 0;
    while (offset < all.byteLength) {
      const read = decoder.read(all.subarray(offset));
      offset += read.consumedBytes;
      for (const frame of read.frames) {
        const metadata = JSON.parse(new TextDecoder().decode(frame.metadata));
        expect(validatePipeFrame(frame, metadata).ok).toBe(true);
        collected.push(metadata);
      }
      if (read.consumedBytes === 0) break;
    }
    return collected;
  };
  const until = async (predicate) => {
    for (let index = 0; index < 20; index++) {
      const frames = received();
      if (predicate(frames)) return frames;
      await tick();
    }
    throw new Error("Finite endpoint did not reach the required frame boundary");
  };
  try {
    send({
      type: "hello",
      worker,
      pipeVersion: PIPE_VERSION,
      buildVersion: "finite",
      effectiveBudgets: M0_LIMITS,
    });
    await until((frames) => frames.some((frame) => frame.type === "ready"));
    const composed = composeSpawnPayload(
      { executable: "/bin/sh", argv: ["-c", "exit 0"], cwd: "/" },
      utf8,
    );
    const spawn = command("spawn", {
      operationId: "endpoint-spawn",
      geometry: { cols: 12, rows: 4 },
      profile: PROFILE,
      appearance: DEFAULT_APPEARANCE,
      effectiveBudgets: M0_LIMITS,
      spawnPayloadBytes: composed.bytes.length,
    });
    send(spawn, composed.bytes);
    await until((frames) => frames.some((frame) => frame.requestId === spawn.requestId));
    native.observer.onData(Buffer.from("BASE"));
    const status = command("status");
    send(status);
    await until((frames) => frames.some((frame) => frame.requestId === status.requestId));
    const subscribe = command("subscribe", { subscription, atSeq: 0 });
    send(subscribe);
    const frames = await until((items) =>
      items.some((item) => item.terminal?.type === "baseline-end"),
    );
    const markerIndex = frames.findIndex((frame) => frame.requestId === subscribe.requestId);
    const firstEvent = frames.findIndex((frame) => frame.terminal?.type === "baseline-start");
    expect(frames[markerIndex]).toMatchObject({ outcome: "accepted", recoveryMode: "baseline" });
    expect(firstEvent).toBeGreaterThan(markerIndex);
    expect(frames.filter((frame) => frame.terminal?.type === "baseline-end")).toHaveLength(1);
    const preview = command("preview-refresh");
    send(preview);
    const withPreview = await until((items) =>
      items.some((item) => item.requestId === preview.requestId),
    );
    const previewKinds = withPreview.flatMap((item) =>
      item.terminal?.type?.startsWith("preview-") ? [item.terminal.type] : [],
    );
    expect(previewKinds).toEqual(["preview-start", "preview-chunk", "preview-end"]);
    expect(withPreview.findIndex((item) => item.terminal?.type === "preview-end")).toBeLessThan(
      withPreview.findIndex((item) => item.requestId === preview.requestId),
    );
    const baselineId = frames[firstEvent].terminal.descriptor.baselineId;
    const chunks = frames.filter((frame) => frame.terminal?.type === "baseline-chunk");
    for (let index = 0; index < chunks.length; index++) {
      const progress = command("baseline-progress", {
        subscription,
        baselineId,
        lastParsedOrdinal: index,
      });
      send(progress);
      await until((items) => items.some((item) => item.requestId === progress.requestId));
    }
    const ack = command("applied-ack", { subscription, appliedSeq: 1 });
    send(ack);
    await until((items) => items.some((item) => item.requestId === ack.requestId));
    native.observer.onData(Buffer.from("LATER"));
    const laterStatus = command("status");
    send(laterStatus);
    await until((items) =>
      items.some((item) => item.terminal?.type === "output" && item.terminal.seq === 2),
    );
    const recover = command("recover", { subscription, appliedSeq: 1 });
    send(recover);
    const recovered = await until(
      (items) =>
        items.filter((item) => item.terminal?.type === "output" && item.terminal.seq === 2)
          .length === 2,
    );
    const oldAndNew = recovered.flatMap((item, index) =>
      item.terminal?.type === "output" && item.terminal.seq === 2 ? [index] : [],
    );
    const recoveryMarker = recovered.findIndex((item) => item.requestId === recover.requestId);
    expect(recovered[recoveryMarker]).toMatchObject({
      outcome: "accepted",
      recoveryMode: "replay",
    });
    expect(oldAndNew[0]).toBeLessThan(recoveryMarker);
    expect(oldAndNew[1]).toBeGreaterThan(recoveryMarker);
  } finally {
    input.end();
    await pipe.shutdown("finite-test");
    output.destroy();
  }
});

test("W2 preview without subscription emits complete transfer then unchanged version", async () => {
  const native = factory();
  const emitted = [];
  const execution = createWorkerExecution({
    worker,
    effectiveBudgets: M0_LIMITS,
    factory: native,
    delivery: {
      enqueue(event, payload) {
        emitted.push({ event, payload: Uint8Array.from(payload) });
        return 16 + utf8(JSON.stringify(event)).byteLength + payload.byteLength;
      },
      cancelUnsent() {},
    },
  });
  try {
    const composed = composeSpawnPayload(
      { executable: "/bin/sh", argv: ["-c", "exit 0"], cwd: "/" },
      utf8,
    );
    expect(
      (
        await execution.execute(
          command("spawn", {
            operationId: "preview-spawn",
            geometry: { cols: 12, rows: 4 },
            profile: PROFILE,
            appearance: DEFAULT_APPEARANCE,
            effectiveBudgets: M0_LIMITS,
            spawnPayloadBytes: composed.bytes.length,
          }),
          composed.bytes,
        )
      ).outcome,
    ).toBe("accepted");
    native.observer.onData(Buffer.from("PREVIEW"));
    expect((await execution.execute(command("status"))).runStatus.parsedSeq).toBe(1);
    const changed = await execution.execute(command("preview-refresh"));
    expect(changed).toMatchObject({ outcome: "accepted", previewVersion: 1 });
    expect(emitted.map((item) => item.event.terminal.type)).toEqual([
      "preview-start",
      "preview-chunk",
      "preview-end",
    ]);
    expect(emitted.every((item) => item.event.subscription === undefined)).toBe(true);
    expect(new TextDecoder().decode(emitted[1].payload)).toContain("PREVIEW");
    expect(
      (await execution.execute(command("preview-refresh", { knownVersion: 1 }))).previewVersion,
    ).toBe(1);
    expect(emitted).toHaveLength(3);
    expect(
      (await execution.execute(command("preview-refresh", { knownVersion: 2 }))).error.kind,
    ).toBe("RESYNC_REQUIRED");
    expect(emitted).toHaveLength(3);
  } finally {
    await execution.shutdown("finite-test");
  }
});

function directHarness(budgets = M0_LIMITS) {
  const native = factory();
  const emitted = [];
  const execution = createWorkerExecution({
    worker,
    effectiveBudgets: budgets,
    factory: native,
    delivery: {
      enqueue(event, payload, token) {
        emitted.push({ event, payload: Uint8Array.from(payload), token });
        return 16 + utf8(JSON.stringify(event)).byteLength + payload.byteLength;
      },
      cancelUnsent() {},
    },
  });
  return { native, emitted, execution };
}

async function spawnDirect(execution, budgets = M0_LIMITS) {
  const composed = composeSpawnPayload(
    { executable: "/bin/sh", argv: ["-c", "exit 0"], cwd: "/" },
    utf8,
  );
  const spawn = command("spawn", {
    operationId: `spawn-${ordinal}`,
    geometry: { cols: 12, rows: 4 },
    profile: PROFILE,
    appearance: DEFAULT_APPEARANCE,
    effectiveBudgets: budgets,
    spawnPayloadBytes: composed.bytes.length,
  });
  expect((await execution.execute(spawn, composed.bytes)).outcome).toBe("accepted");
}

async function subscribeAndApply(execution, emitted, ref) {
  const subscribe = command("subscribe", { subscription: ref, atSeq: 0 });
  const marker = await execution.execute(subscribe);
  expect(marker).toMatchObject({ outcome: "accepted", recoveryMode: "baseline" });
  execution.markerEnqueued(subscribe, marker);
  for (let turn = 0; turn < 12; turn++) {
    if (
      emitted.some(
        (item) =>
          item.event.subscription?.subscriptionId === ref.subscriptionId &&
          item.event.terminal.type === "baseline-end",
      )
    )
      break;
    await tick();
  }
  const own = emitted.filter(
    (item) => item.event.subscription?.subscriptionId === ref.subscriptionId,
  );
  const start = own.find((item) => item.event.terminal.type === "baseline-start");
  const chunks = own.filter((item) => item.event.terminal.type === "baseline-chunk");
  expect(own.at(-1)?.event.terminal.type).toBe("baseline-end");
  for (let index = 0; index < chunks.length; index++) {
    const progress = command("baseline-progress", {
      subscription: ref,
      baselineId: start.event.terminal.descriptor.baselineId,
      lastParsedOrdinal: index,
    });
    expect((await execution.execute(progress)).outcome).toBe("accepted");
    execution.responseSettled(progress.requestId);
  }
  const ack = command("applied-ack", { subscription: ref, appliedSeq: marker.atSeq });
  expect((await execution.execute(ack)).outcome).toBe("accepted");
  execution.responseSettled(ack.requestId);
  return { marker, start, chunks };
}

test("W2 two refs keep independent credit and same-ref recover fences old attempt", async () => {
  const { native, emitted, execution } = directHarness();
  const peer = { ...subscription, subscriptionId: "peer" };
  try {
    await spawnDirect(execution);
    native.observer.onData(Buffer.from("A"));
    expect((await execution.execute(command("status"))).runStatus.parsedSeq).toBe(1);
    const first = await subscribeAndApply(execution, emitted, subscription);
    const second = await subscribeAndApply(execution, emitted, peer);
    expect(first.marker.atSeq).toBe(1);
    expect(second.marker.atSeq).toBe(1);
    native.observer.onData(Buffer.from("B"));
    expect((await execution.execute(command("status"))).runStatus.parsedSeq).toBe(2);
    for (let turn = 0; turn < 4; turn++) await tick();
    const seq2 = emitted.filter(
      (item) => item.event.terminal.type === "output" && item.event.terminal.seq === 2,
    );
    expect(seq2.map((item) => item.event.subscription.subscriptionId).sort()).toEqual([
      "peer",
      "subscription",
    ]);
    const ack = command("applied-ack", { subscription, appliedSeq: 2 });
    expect((await execution.execute(ack)).outcome).toBe("accepted");
    execution.responseSettled(ack.requestId);
    native.observer.onData(Buffer.from("C"));
    expect((await execution.execute(command("status"))).runStatus.parsedSeq).toBe(3);
    for (let turn = 0; turn < 4; turn++) await tick();
    const oldToken = emitted.find(
      (item) =>
        item.event.subscription?.subscriptionId === "subscription" && item.event.terminal.seq === 3,
    ).token;
    const recover = command("recover", { subscription, appliedSeq: 2 });
    const marker = await execution.execute(recover);
    expect(marker).toMatchObject({ outcome: "accepted", recoveryMode: "replay", atSeq: 3 });
    execution.markerEnqueued(recover, marker);
    execution.responseSettled(recover.requestId);
    for (let turn = 0; turn < 4; turn++) await tick();
    const replay = emitted.filter(
      (item) =>
        item.event.subscription?.subscriptionId === "subscription" && item.event.terminal.seq === 3,
    );
    expect(replay).toHaveLength(2);
    expect(replay[1].token).not.toBe(oldToken);
    expect(new TextDecoder().decode(replay[1].payload)).toBe("C");
    const stale = command("baseline-progress", {
      subscription,
      baselineId: first.start.event.terminal.descriptor.baselineId,
      lastParsedOrdinal: 0,
    });
    expect((await execution.execute(stale)).error.kind).toBe("RESYNC_REQUIRED");
    execution.responseSettled(stale.requestId);
    const future = command("applied-ack", { subscription, appliedSeq: 4 });
    expect((await execution.execute(future)).error.kind).toBe("RESYNC_REQUIRED");
    execution.responseSettled(future.requestId);
    const current = command("applied-ack", { subscription, appliedSeq: 3 });
    expect((await execution.execute(current)).outcome).toBe("accepted");
    execution.responseSettled(current.requestId);
    const duplicate = command("applied-ack", { subscription, appliedSeq: 3 });
    expect((await execution.execute(duplicate)).outcome).toBe("accepted");
    execution.responseSettled(duplicate.requestId);
    const peerAck = command("applied-ack", { subscription: peer, appliedSeq: 3 });
    expect((await execution.execute(peerAck)).outcome).toBe("accepted");
    execution.responseSettled(peerAck.requestId);
  } finally {
    await execution.shutdown("finite-test");
  }
});

test("W2 input is fenced before final baseline ACK and available after installation", async () => {
  const { native, emitted, execution } = directHarness();
  try {
    await spawnDirect(execution);
    const control = command("set-control", {
      expectedEpoch: 0,
      nextEpoch: 1,
      holder: {
        connection: subscription.connection,
        viewId: subscription.viewId,
        subscriptionId: subscription.subscriptionId,
      },
      geometry: { cols: 12, rows: 4 },
    });
    expect((await execution.execute(control)).error.kind).toBe("RESYNC_REQUIRED");
    const input = command("input", { subscription, epoch: 1, inputSeq: 1 });
    expect((await execution.execute(input, utf8("X"))).error.kind).toBe("RESYNC_REQUIRED");
    expect(native.observer).toBeDefined();
    await subscribeAndApply(execution, emitted, subscription);
    expect((await execution.execute(control)).outcome).toBe("accepted");
    const written = await execution.execute(input, utf8("X"));
    expect(written).toMatchObject({ type: "result", writtenBytes: 1 });
    expect(native.writes.map((bytes) => bytes.toString())).toEqual(["X"]);
  } finally {
    await execution.shutdown("finite-test");
  }
});

test("W2 old transport-owned bytes precede same-ref recovery marker and new producer", async () => {
  const native = factory();
  const input = new PassThrough();
  const writes = [];
  let releaseHeld;
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      const decoder = createPipeDecoder();
      const read = decoder.read(chunk);
      const frame = read.frames[0];
      const metadata = JSON.parse(new TextDecoder().decode(frame.metadata));
      writes.push({ metadata, payload: Buffer.from(frame.payload) });
      if (metadata.terminal?.type === "output" && metadata.terminal.seq === 2)
        releaseHeld = callback;
      else queueMicrotask(callback);
    },
  });
  const pipe = runWorkerPipe(input, output, {
    buildVersion: "finite",
    createExecution: (options) => createWorkerExecution({ ...options, factory: native }),
  });
  const send = (metadata, payload = new Uint8Array()) => {
    const frame = encodePipeFrame(1, utf8(JSON.stringify(metadata)), payload);
    if (!frame.ok) throw new Error(frame.error.code);
    input.write(Buffer.from(frame.value));
  };
  const until = async (predicate) => {
    for (let turn = 0; turn < 40; turn++) {
      if (predicate(writes)) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(
      `Finite transport did not reach its bounded frame boundary: ${JSON.stringify({
        frames: writes.map(
          (item) => item.metadata.terminal?.type ?? item.metadata.requestId ?? item.metadata.type,
        ),
        snapshot: pipe.snapshot(),
      })}`,
    );
  };
  try {
    send({
      type: "hello",
      worker,
      pipeVersion: PIPE_VERSION,
      buildVersion: "finite",
      effectiveBudgets: M0_LIMITS,
    });
    await until((items) => items.some((item) => item.metadata.type === "ready"));
    const composed = composeSpawnPayload(
      { executable: "/bin/sh", argv: ["-c", "exit 0"], cwd: "/" },
      utf8,
    );
    const spawn = command("spawn", {
      operationId: "transport-spawn",
      geometry: { cols: 12, rows: 4 },
      profile: PROFILE,
      appearance: DEFAULT_APPEARANCE,
      effectiveBudgets: M0_LIMITS,
      spawnPayloadBytes: composed.bytes.length,
    });
    send(spawn, composed.bytes);
    await until((items) => items.some((item) => item.metadata.requestId === spawn.requestId));
    native.observer.onData(Buffer.from("SEED"));
    const status = command("status");
    send(status);
    await until((items) => items.some((item) => item.metadata.requestId === status.requestId));
    const subscribe = command("subscribe", { subscription, atSeq: 0 });
    send(subscribe);
    await until((items) => items.some((item) => item.metadata.terminal?.type === "baseline-end"));
    const baselineId = writes.find((item) => item.metadata.terminal?.type === "baseline-start")
      .metadata.terminal.descriptor.baselineId;
    const chunks = writes.filter((item) => item.metadata.terminal?.type === "baseline-chunk");
    for (let index = 0; index < chunks.length; index++) {
      const progress = command("baseline-progress", {
        subscription,
        baselineId,
        lastParsedOrdinal: index,
      });
      send(progress);
      await until((items) => items.some((item) => item.metadata.requestId === progress.requestId));
    }
    const ack = command("applied-ack", { subscription, appliedSeq: 1 });
    send(ack);
    await until((items) => items.some((item) => item.metadata.requestId === ack.requestId));
    native.observer.onData(Buffer.from("HELD"));
    const later = command("status");
    send(later);
    await until(() => !!releaseHeld);
    expect(pipe.snapshot()).toMatchObject({ blocked: true });
    expect(pipe.snapshot().transportBytes).toBeGreaterThan(0);
    const recover = command("recover", { subscription, appliedSeq: 1 });
    send(recover);
    for (let turn = 0; turn < 3; turn++) await tick();
    expect(writes.some((item) => item.metadata.requestId === recover.requestId)).toBe(false);
    const release = releaseHeld;
    releaseHeld = undefined;
    release();
    await until(
      (items) =>
        items.filter(
          (item) => item.metadata.terminal?.type === "output" && item.metadata.terminal.seq === 2,
        ).length === 2,
    );
    const oldAndNew = writes.flatMap((item, index) =>
      item.metadata.terminal?.type === "output" && item.metadata.terminal.seq === 2 ? [index] : [],
    );
    const markerIndex = writes.findIndex((item) => item.metadata.requestId === recover.requestId);
    expect(writes[markerIndex].metadata).toMatchObject({
      recoveryMode: "replay",
      outcome: "accepted",
    });
    expect(oldAndNew[0]).toBeLessThan(markerIndex);
    expect(oldAndNew[1]).toBeGreaterThan(markerIndex);
    expect(writes[oldAndNew[0]].payload.toString()).toBe("HELD");
    expect(writes[oldAndNew[1]].payload.toString()).toBe("HELD");
  } finally {
    releaseHeld?.();
    input.end();
    await pipe.shutdown("finite-test");
    output.destroy();
  }
});

test("W2 uncancelled capture and installed recover preserve validation, tokens and retiring refusal", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const reserve = (bytes) => account.reserve("worker", bytes);
  const engine = createTerminalModel({
    run,
    geometry: { cols: 12, rows: 4 },
    onAutomaticOutput() {},
  });
  const replay = new ReplayWindow(4096, 4, reserve);
  const emitted = [];
  const recovery = new RecoverySubscriptions(worker, M0_LIMITS, reserve, {
    enqueue(event, payload, token) {
      emitted.push({ event, token });
      return 16 + utf8(JSON.stringify(event)).byteLength + payload.length;
    },
    cancelUnsent() {},
  });
  const source = {
    run,
    replay,
    captureBaseline: (reserveDetached) => engine.captureBaseline(reserveDetached),
  };
  const routeCommand = (type, fields = {}) => command(type, { subscription, ...fields });
  async function install(openCommand, opened) {
    expect(opened.result.recoveryMode).toBe("baseline");
    const first = emitted.length;
    recovery.markerEnqueued(openCommand, opened.result);
    await tick();
    expect(emitted.slice(first).map(({ event }) => event.terminal.type)).toEqual([
      "baseline-start",
      "baseline-chunk",
      "baseline-end",
    ]);
    const baselineId = emitted[first].event.terminal.descriptor.baselineId;
    expect(
      recovery.command(routeCommand("baseline-progress", { baselineId, lastParsedOrdinal: 0 }))
        .result.outcome,
    ).toBe("accepted");
    expect(recovery.command(routeCommand("applied-ack", { appliedSeq: 0 })).result.outcome).toBe(
      "accepted",
    );
    expect(recovery.installed(subscription)).toBe(true);
  }
  try {
    const subscribe = routeCommand("subscribe", { atSeq: 0 });
    await install(subscribe, await recovery.open(subscribe, source));
    expect((await recovery.open(routeCommand("subscribe", { atSeq: 0 }), source)).failure).toBe(
      "OPERATION_ID_CONFLICT",
    );
    expect((await recovery.open(routeCommand("recover", { appliedSeq: 1 }), source)).failure).toBe(
      "RESYNC_REQUIRED",
    );
    expect(recovery.installed(subscription)).toBe(true);
    const recover = routeCommand("recover", { appliedSeq: 0 });
    await install(recover, await recovery.open(recover, source));
    expect(emitted[0].token).not.toBe(emitted[3].token);
    const unsubscribe = routeCommand("unsubscribe");
    expect(recovery.command(unsubscribe).result.outcome).toBe("accepted");
    expect((await recovery.open(routeCommand("recover", { appliedSeq: 0 }), source)).failure).toBe(
      "BUSY",
    );
    expect((await recovery.open(routeCommand("subscribe", { atSeq: 0 }), source)).failure).toBe(
      "OPERATION_ID_CONFLICT",
    );
    recovery.responseSettled(unsubscribe.requestId);
    expect(recovery.routeCount).toBe(0);
    expect(account.snapshot().workerBytes).toBe(0);
  } finally {
    recovery.shutdown();
    replay.clear();
    engine.dispose();
  }
});

test.each(["unsubscribe", "recover"])(
  "W2 actual engine detached callback %s refuses old allocation and preserves legal fresh admission",
  async (action) => {
    const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
    const engine = createTerminalModel({
      run,
      geometry: { cols: 12, rows: 4 },
      onAutomaticOutput() {},
    });
    const emitted = [];
    const admissions = [];
    const leases = [];
    const interrupt = command(action, {
      subscription,
      ...(action === "recover" && { appliedSeq: 0 }),
    });
    let recovery;
    let replacement;
    let interruptionOutcome;
    let fired = false;
    const reserve = (bytes, owner) => {
      const lease = account.reserve("worker", bytes);
      if (!lease) return undefined;
      const record = { owner, held: bytes, releases: 0 };
      leases.push(record);
      const owned = {
        release() {
          expect(++record.releases).toBe(1);
          record.held = 0;
          lease.release();
        },
        shrinkTo(next) {
          record.held = next;
          lease.shrinkTo(next);
        },
      };
      if (owner === "recovery-baseline" && !fired) {
        fired = true;
        if (action === "recover") replacement = recovery.open(interrupt, source);
        else interruptionOutcome = recovery.command(interrupt);
      }
      return owned;
    };
    const replay = new ReplayWindow(4096, 4, reserve);
    recovery = new RecoverySubscriptions(worker, M0_LIMITS, reserve, {
      enqueue(event, payload) {
        emitted.push(event);
        return 16 + utf8(JSON.stringify(event)).byteLength + payload.length;
      },
      cancelUnsent() {},
    });
    const source = {
      run,
      replay,
      captureBaseline: (reserveDetached) =>
        engine.captureBaseline((bytes) => {
          const accepted = reserveDetached(bytes);
          admissions.push(accepted);
          return accepted;
        }),
    };
    try {
      const subscribe = command("subscribe", { subscription, atSeq: 0 });
      expect((await recovery.open(subscribe, source)).failure).toBe("RESYNC_REQUIRED");
      expect(admissions[0]).toBe(false);
      expect(interruptionOutcome?.result.outcome).toBe(
        action === "unsubscribe" ? "accepted" : undefined,
      );
      expect(emitted).toEqual([]);
      expect(leases.find((lease) => lease.owner === "recovery-baseline")).toMatchObject({
        held: 0,
        releases: 1,
      });
      recovery.markerEnqueued(subscribe, { outcome: "accepted" });
      await tick();
      expect(emitted).toEqual([]);
      let fresh;
      let opened;
      let retiringFailure;
      let retiredBytes;
      if (action === "unsubscribe") {
        retiringFailure = (
          await recovery.open(command("recover", { subscription, appliedSeq: 0 }), source)
        ).failure;
        recovery.responseSettled(interrupt.requestId);
        retiredBytes = account.snapshot().workerBytes;
        fresh = command("subscribe", { subscription, atSeq: 0 });
        opened = await recovery.open(fresh, source);
      } else {
        fresh = interrupt;
        opened = await replacement;
      }
      expect([retiringFailure, retiredBytes]).toEqual(
        action === "unsubscribe" ? ["BUSY", 0] : [undefined, undefined],
      );
      expect(opened.result.recoveryMode).toBe("baseline");
      expect(admissions).toEqual([false, true]);
      recovery.markerEnqueued(fresh, opened.result);
      await tick();
      expect(emitted.map((event) => event.terminal.type)).toEqual([
        "baseline-start",
        "baseline-chunk",
        "baseline-end",
      ]);
    } finally {
      recovery.shutdown();
      replay.clear();
      engine.dispose();
    }
    expect(account.snapshot().workerBytes).toBe(0);
    expect(leases.every((lease) => lease.releases === 1)).toBe(true);
  },
);
