import { expect, test } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import {
  PIPE_VERSION,
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
  validatePipeResultForCommand,
} from "@cove/protocol/pipe";
import { runWorkerPipe } from "../dist/src/pipe-endpoint.js";

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
  subscriptionId: "subscription",
  viewId: "view",
};
const hello = {
  type: "hello",
  worker,
  pipeVersion: PIPE_VERSION,
  buildVersion: "parent",
  effectiveBudgets: M0_LIMITS,
};
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const status = {
  run,
  status: "live",
  geometry: { cols: 80, rows: 24 },
  controlEpoch: 0,
  controlHolder: null,
  receivedSeq: null,
  parsedSeq: null,
  recovery: "unavailable",
  exitCode: null,
  signal: null,
};

function encode(metadata, payload = new Uint8Array()) {
  const frame = encodePipeFrame(1, encoder.encode(JSON.stringify(metadata)), payload);
  if (!frame.ok) throw new Error(frame.error.code);
  return Buffer.from(frame.value);
}

function coalescedAtCap(cap) {
  const pieces = [];
  let remaining = cap;
  for (let index = 0; remaining > 0; index++) {
    const command = {
      type: "input",
      worker,
      run,
      subscription,
      requestId: `boundary-${index}`,
      epoch: 1,
      inputSeq: index + 1,
    };
    const base = encode(command).length;
    const max = base + 65_536;
    const length = remaining <= max ? remaining : Math.min(max, remaining - base - 1);
    if (length <= base) throw new Error("cannot construct exact boundary fixture");
    const piece = encode(command, Buffer.alloc(length - base, 0x61));
    pieces.push(piece);
    remaining -= piece.length;
  }
  return { bytes: Buffer.concat(pieces), count: pieces.length };
}

function createHarness(config = {}) {
  const input = new PassThrough();
  const chunks = [];
  const output = config.output ?? new PassThrough();
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const calls = [];
  const execution = {
    execute(command, payload) {
      calls.push({ command, payload });
      if (config.execute) return config.execute(command, payload);
      if (
        [
          "subscribe",
          "recover",
          "unsubscribe",
          "applied-ack",
          "baseline-progress",
          "preview-refresh",
        ].includes(command.type)
      )
        return Promise.resolve({
          type: "error",
          worker,
          run,
          requestId: command.requestId,
          commandType: command.type,
          error: domainError("CAPABILITY_UNAVAILABLE"),
        });
      return Promise.resolve({
        type: "result",
        worker,
        run,
        requestId: command.requestId,
        commandType: command.type,
        outcome: "accepted",
        ...(command.operationId && { operationId: command.operationId }),
      });
    },
    snapshot() {
      return {};
    },
    async shutdown(reason) {
      config.onShutdown?.(reason);
      return [];
    },
  };
  const pipe = runWorkerPipe(input, output, {
    buildVersion: "child",
    createExecution: () => execution,
  });
  const frames = () => {
    const bytes = Buffer.concat(chunks);
    const pipeDecoder = createPipeDecoder();
    const all = [];
    let offset = 0;
    while (offset < bytes.length) {
      const read = pipeDecoder.read(bytes.subarray(offset));
      all.push(...read.frames);
      offset += read.consumedBytes;
      if (read.consumedBytes === 0) throw new Error("test decoder stalled");
    }
    return all.map((frame) => {
      const metadata = JSON.parse(decoder.decode(frame.metadata));
      expect(validatePipeFrame(frame, metadata).ok).toBe(true);
      return metadata;
    });
  };
  return { input, output, pipe, calls, chunks, frames };
}

async function ready(harness, greeting = hello) {
  harness.input.write(encode(greeting));
  await tick();
  expect(harness.frames()[0]).toMatchObject({
    type: "ready",
    worker,
    pipeVersion: 2,
    buildVersion: "child",
  });
}

test("split hello and coalesced commands preserve correlated revision-2 frames", async () => {
  const h = createHarness();
  const bytes = encode(hello);
  h.input.write(bytes.subarray(0, 7));
  expect(h.frames()).toEqual([]);
  h.input.write(bytes.subarray(7));
  await tick();
  const one = { type: "preview-refresh", worker, run, requestId: "q1" };
  const two = { type: "preview-refresh", worker, run, requestId: "q2" };
  h.input.write(Buffer.concat([encode(one), encode(two)]));
  await tick();
  expect(h.calls.map(({ command }) => command.requestId)).toEqual(["q1", "q2"]);
  const replies = h.frames().slice(1);
  expect(replies).toHaveLength(2);
  expect(validatePipeResultForCommand(one, replies[0])).toBe(true);
  expect(validatePipeResultForCommand(two, replies[1])).toBe(true);
  h.input.end();
  expect((await h.pipe.closed).reason).toBe("stdin-eof");
});

test("command before ready and duplicate hello terminate the pipe", async () => {
  const command = { type: "stop", worker, run, requestId: "q1", operationId: "op1" };
  const before = createHarness();
  before.input.write(encode(command));
  expect((await before.pipe.closed).reason).toBe("command-before-hello");
  expect(before.calls).toEqual([]);

  const coalesced = createHarness();
  coalesced.input.write(Buffer.concat([encode(hello), encode(command)]));
  expect((await coalesced.pipe.closed).reason).toBe("unexpected-frame");
  expect(coalesced.calls).toEqual([]);

  const duplicate = createHarness();
  await ready(duplicate);
  duplicate.input.write(encode(hello));
  expect((await duplicate.pipe.closed).reason).toBe("unexpected-frame");
});

test("invalid format, UTF-8, metadata and foreign worker fail closed", async () => {
  const old = createHarness();
  const oldFrame = encode(hello);
  oldFrame[3] = 1;
  old.input.write(oldFrame);
  expect((await old.pipe.closed).reason).toBe("decode-UNSUPPORTED_FORMAT");

  const utf8 = createHarness();
  const invalid = encode(hello);
  invalid[16] = 0xff;
  utf8.input.write(invalid);
  expect((await utf8.pipe.closed).reason).toBe("invalid-metadata-json");

  const payload = createHarness();
  await ready(payload);
  payload.input.write(
    encode({ type: "stop", worker, run, requestId: "q", operationId: "o" }, Uint8Array.of(1)),
  );
  expect((await payload.pipe.closed).reason).toBe("invalid-frame-INVALID_METADATA");

  const foreign = createHarness();
  await ready(foreign);
  foreign.input.write(
    encode({
      type: "stop",
      worker: { ...worker, workerIncarnationId: "other" },
      run,
      requestId: "q",
      operationId: "o",
    }),
  );
  expect((await foreign.pipe.closed).reason).toBe("foreign-worker");
});

test("coalesced input beyond one decoder slice reaches every command within the pipe budget", async () => {
  const h = createHarness();
  await ready(h);
  const commands = Array.from({ length: 48 }, (_, index) => ({
    type: "preview-refresh",
    worker,
    run,
    requestId: `request-${index}`,
  }));
  h.input.write(Buffer.concat(commands.map((command) => encode(command))));
  for (let attempt = 0; attempt < 10 && h.calls.length < commands.length; attempt++) await tick();
  expect(h.calls).toHaveLength(commands.length);
  expect(h.frames()).toHaveLength(commands.length + 1);
  expect(h.pipe.snapshot().peakAccountedBytes).toBeLessThanOrEqual(M0_LIMITS.pipeQueuedBytes);
  await h.pipe.shutdown("test-complete");
});

test("exact pipe ingress cap crosses decoder slices while cap plus one is rejected before retention", async () => {
  const fixture = coalescedAtCap(M0_LIMITS.pipeQueuedBytes);
  expect(fixture.bytes.length).toBe(M0_LIMITS.pipeQueuedBytes);
  expect(fixture.count).toBeGreaterThan(32);
  const valid = createHarness({
    execute: (command) =>
      Promise.resolve({
        type: "error",
        worker,
        run,
        requestId: command.requestId,
        commandType: command.type,
        error: domainError("CAPABILITY_UNAVAILABLE"),
      }),
  });
  await ready(valid);
  valid.input.write(fixture.bytes);
  for (let attempt = 0; attempt < 100 && valid.calls.length < fixture.count; attempt++)
    await tick();
  expect(valid.calls).toHaveLength(fixture.count);
  expect(valid.pipe.snapshot().state).toBe("ready");
  expect(valid.pipe.snapshot().peakDecodeSliceBytes).toBeLessThanOrEqual(256 * 1024);
  expect(valid.frames()).toHaveLength(fixture.count + 1);
  await valid.pipe.shutdown("test-complete");

  const invalid = createHarness();
  await ready(invalid);
  invalid.input.write(Buffer.concat([fixture.bytes, Buffer.of(0)]));
  expect((await invalid.pipe.closed).reason).toBe("ingress-capacity-exceeded");
  expect(invalid.pipe.snapshot().ingressBytes).toBe(0);
  expect(invalid.calls).toHaveLength(0);
});

test("pre-hello default and decoder partial count toward the ingress cap", async () => {
  const before = createHarness();
  before.input.write(Buffer.alloc(M0_LIMITS.pipeQueuedBytes + 1));
  expect((await before.pipe.closed).reason).toBe("ingress-capacity-exceeded");
  expect(before.pipe.snapshot().ingressBytes).toBe(0);

  const budgets = { ...M0_LIMITS, pipeQueuedBytes: 69_648 };
  const partial = createHarness();
  await ready(partial, { ...hello, effectiveBudgets: budgets });
  const command = encode({ type: "preview-refresh", worker, run, requestId: "partial" });
  partial.input.write(command.subarray(0, 7));
  await tick();
  expect(partial.pipe.snapshot().ingressBytes).toBe(7);
  partial.input.write(Buffer.alloc(budgets.pipeQueuedBytes - 6));
  expect((await partial.pipe.closed).reason).toBe("ingress-capacity-exceeded");
  expect(partial.calls).toHaveLength(0);

  const retainedBacking = createHarness();
  await ready(retainedBacking, { ...hello, effectiveBudgets: budgets });
  retainedBacking.input.write(Buffer.alloc(budgets.pipeQueuedBytes + 1).subarray(0, 7));
  expect((await retainedBacking.pipe.closed).reason).toBe("ingress-capacity-exceeded");
  expect(retainedBacking.pipe.snapshot().ingressBytes).toBe(0);
});

test("all W2-only commands are explicitly unavailable through the pipe", async () => {
  const h = createHarness();
  await ready(h);
  const commands = [
    { type: "subscribe", subscription, atSeq: 0 },
    { type: "recover", subscription },
    { type: "unsubscribe", subscription },
    { type: "applied-ack", subscription, appliedSeq: 0 },
    { type: "baseline-progress", subscription, baselineId: "b", lastParsedOrdinal: 0 },
    { type: "preview-refresh" },
  ].map((fields, index) => ({ ...fields, worker, run, requestId: `q${index}` }));
  h.input.write(Buffer.concat(commands.map((command) => encode(command))));
  await tick();
  const replies = h.frames().slice(1);
  expect(replies).toHaveLength(commands.length);
  replies.forEach((reply, index) => {
    expect(reply.error.kind).toBe("CAPABILITY_UNAVAILABLE");
    expect(validatePipeResultForCommand(commands[index], reply)).toBe(true);
  });
  await h.pipe.shutdown("test-complete");
});

test("reserved status and stop execute while the one ordinary slot is held", async () => {
  let settleOrdinary;
  const pending = new Promise((resolve) => {
    settleOrdinary = resolve;
  });
  const h = createHarness({
    execute: (command) =>
      command.type === "preview-refresh"
        ? pending
        : Promise.resolve({
            type: "result",
            worker,
            run,
            requestId: command.requestId,
            commandType: command.type,
            outcome: "accepted",
            ...(command.type === "status"
              ? { runStatus: status }
              : { operationId: command.operationId }),
          }),
  });
  await ready(h, { ...hello, effectiveBudgets: { ...M0_LIMITS, pendingWorkerCommands: 1 } });
  const ordinary = { type: "preview-refresh", worker, run, requestId: "ordinary" };
  const controlStatus = { type: "status", worker, run, requestId: "status" };
  const controlStop = { type: "stop", worker, run, requestId: "stop", operationId: "op" };
  const overflow = { ...ordinary, requestId: "overflow" };
  h.input.write(
    Buffer.concat(
      [ordinary, controlStatus, controlStop, overflow].map((command) => encode(command)),
    ),
  );
  await tick();
  expect(h.calls.map(({ command }) => command.requestId)).toEqual(["ordinary", "status", "stop"]);
  const replies = h.frames().slice(1);
  expect(replies).toHaveLength(3);
  expect(replies.find((reply) => reply.requestId === "overflow")?.error.kind).toBe("BUSY");
  expect(replies.find((reply) => reply.requestId === "status")?.runStatus).toEqual(status);
  expect(replies.find((reply) => reply.requestId === "stop")?.outcome).toBe("accepted");
  expect(h.pipe.snapshot()).toMatchObject({ state: "ready", pendingCommands: 1 });
  settleOrdinary({
    type: "error",
    worker,
    run,
    requestId: "ordinary",
    commandType: "preview-refresh",
    error: domainError("CAPABILITY_UNAVAILABLE"),
  });
  await tick();
  expect(h.frames()).toHaveLength(5);
  await h.pipe.shutdown("test-complete");
});

test("ordinary response reservations stop before spending the control reserve", async () => {
  const budgets = {
    ...M0_LIMITS,
    pipeQueuedBytes: 69_648,
    reservedControlBytes: 8_192,
    pendingWorkerCommands: 32,
  };
  const h = createHarness({
    execute: (command) =>
      command.type === "preview-refresh"
        ? new Promise(() => {})
        : Promise.resolve({
            type: "result",
            worker,
            run,
            requestId: command.requestId,
            commandType: command.type,
            outcome: "accepted",
            ...(command.type === "status"
              ? { runStatus: status }
              : { operationId: command.operationId }),
          }),
  });
  await ready(h, { ...hello, effectiveBudgets: budgets });
  const ordinary = Array.from({ length: 14 }, (_, index) => ({
    type: "preview-refresh",
    worker,
    run,
    requestId: `ordinary-${index}`,
  }));
  const controlStatus = { type: "status", worker, run, requestId: "status" };
  const controlStop = { type: "stop", worker, run, requestId: "stop", operationId: "op" };
  h.input.write(
    Buffer.concat([...ordinary, controlStatus, controlStop].map((command) => encode(command))),
  );
  await tick();
  expect(h.calls.filter(({ command }) => command.type === "preview-refresh")).toHaveLength(13);
  expect(h.calls.map(({ command }) => command.type).slice(-2)).toEqual(["status", "stop"]);
  expect(h.frames().find((reply) => reply.requestId === "ordinary-13")?.error.kind).toBe("BUSY");
  expect(h.pipe.snapshot().ordinaryAccountedBytes).toBeLessThanOrEqual(
    budgets.pipeQueuedBytes - budgets.reservedControlBytes,
  );
  expect(h.pipe.snapshot().peakAccountedBytes).toBeLessThanOrEqual(budgets.pipeQueuedBytes);
  expect(h.pipe.snapshot().state).toBe("ready");
  await h.pipe.shutdown("test-complete");
});

test("duplicate outstanding ID rejects second command without releasing first", async () => {
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  const h = createHarness({ execute: () => pending });
  await ready(h);
  const one = { type: "stop", worker, run, requestId: "q", operationId: "one" };
  const two = { ...one, operationId: "two" };
  h.input.write(Buffer.concat([encode(one), encode(two)]));
  await tick();
  expect(h.calls).toHaveLength(1);
  expect(h.frames()[1].error.kind).toBe("OPERATION_ID_CONFLICT");
  expect(h.pipe.snapshot().pendingCommands).toBe(1);
  settle({
    type: "result",
    worker,
    run,
    requestId: "q",
    commandType: "stop",
    outcome: "accepted",
    operationId: "one",
  });
  await tick();
  expect(h.frames()).toHaveLength(3);
  await h.pipe.shutdown("test-complete");
});

test("request ID stays outstanding until its response write callback settles", async () => {
  const callbacks = [];
  const writes = [];
  const output = new Writable({
    highWaterMark: 1024 * 1024,
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callbacks.push(callback);
    },
  });
  const h = createHarness({ output });
  h.input.write(encode(hello));
  callbacks.shift()();
  await tick();
  const first = { type: "stop", worker, run, requestId: "q", operationId: "first" };
  const duplicate = { ...first, operationId: "second" };
  h.input.write(encode(first));
  await tick();
  expect(writes).toHaveLength(2);
  expect(h.pipe.snapshot()).toMatchObject({ pendingCommands: 0, outstandingRequests: 1 });
  h.input.write(encode(duplicate));
  await tick();
  expect(h.calls).toHaveLength(1);
  expect(h.pipe.snapshot().responseItems).toBe(2);
  callbacks.shift()();
  await tick();
  expect(writes).toHaveLength(3);
  expect(h.pipe.snapshot().outstandingRequests).toBe(1);
  callbacks.shift()();
  await tick();
  expect(h.pipe.snapshot().outstandingRequests).toBe(0);
  await h.pipe.shutdown("test-complete");
});

test("queued original and duplicate tokens preserve one uncertain ID on close", async () => {
  const callbacks = [];
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  const h = createHarness({ output });
  h.input.write(encode(hello));
  callbacks.shift()();
  await tick();
  const blocker = { type: "preview-refresh", worker, run, requestId: "blocker" };
  const original = { ...blocker, requestId: "q", knownVersion: 1 };
  h.input.write(Buffer.concat([encode(blocker), encode(original)]));
  await tick();
  h.input.write(encode({ ...original, knownVersion: 2 }));
  await tick();
  expect(h.calls).toHaveLength(2);
  expect(h.pipe.snapshot().outstandingRequests).toBe(2);
  const closed = await h.pipe.shutdown("test-close");
  expect(closed.uncertainRequestIds).toEqual(["blocker", "q"]);
  callbacks.splice(0).forEach((callback) => callback());
  await tick();
  expect(closed.uncertainRequestIds).toEqual(["blocker", "q"]);
});

test("an invalid execution result fences delivery and retains request uncertainty", async () => {
  const h = createHarness({
    execute: (command) =>
      Promise.resolve({
        type: "result",
        worker,
        run,
        requestId: command.requestId,
        commandType: "status",
        outcome: "accepted",
      }),
  });
  await ready(h);
  h.input.write(encode({ type: "stop", worker, run, requestId: "q", operationId: "o" }));
  const closed = await h.pipe.closed;
  expect(closed.reason).toBe("invalid-execution-correlation");
  expect(closed.uncertainRequestIds).toEqual(["q"]);
});

test("write(false) never retransmits ready and drain releases the single ordered queue", async () => {
  const writes = [];
  const callbacks = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callbacks.push(callback);
    },
  });
  const h = createHarness({ output });
  h.input.write(encode(hello));
  await tick();
  expect(writes).toHaveLength(1);
  expect(h.pipe.snapshot().blocked).toBe(true);
  callbacks.shift()();
  await tick();
  expect(writes).toHaveLength(1);
  expect(h.pipe.snapshot().blocked).toBe(false);
  await h.pipe.shutdown("test-complete");
});

test("EOF classifies pending work as uncertain and shuts down once", async () => {
  const shutdowns = [];
  const h = createHarness({
    execute: () => new Promise(() => {}),
    onShutdown: (reason) => shutdowns.push(reason),
  });
  await ready(h);
  h.input.write(encode({ type: "stop", worker, run, requestId: "pending", operationId: "op" }));
  await tick();
  h.input.end();
  const closed = await h.pipe.closed;
  expect(closed.reason).toBe("stdin-eof");
  expect(closed.uncertainRequestIds).toEqual(["pending"]);
  expect(shutdowns).toEqual(["stdin-eof"]);
});

test("readable close without EOF settles once and preserves held request uncertainty", async () => {
  const shutdowns = [];
  let reentrant;
  const h = createHarness({
    execute: () => new Promise(() => {}),
    onShutdown: (reason) => {
      shutdowns.push(reason);
      reentrant = h.pipe.shutdown("reentrant-close");
    },
  });
  await ready(h);
  h.input.write(encode({ type: "stop", worker, run, requestId: "held", operationId: "op" }));
  await tick();
  h.input.destroy();
  const closed = await h.pipe.closed;
  expect(closed.reason).toBe("stdin-close");
  expect(closed.uncertainRequestIds).toEqual(["held"]);
  expect(shutdowns).toEqual(["stdin-close"]);
  expect(reentrant).toBe(h.pipe.closed);
  expect(await h.pipe.shutdown("later-close")).toBe(closed);
});

test("readable close keeps a physical reply token uncertain after execution completes", async () => {
  const callbacks = [];
  const output = new Writable({
    highWaterMark: 1024 * 1024,
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  const h = createHarness({ output });
  h.input.write(encode(hello));
  callbacks.shift()();
  await tick();
  h.input.write(encode({ type: "stop", worker, run, requestId: "reply", operationId: "op" }));
  await tick();
  expect(h.pipe.snapshot()).toMatchObject({ pendingCommands: 0, responseItems: 1 });
  h.input.destroy();
  const closed = await h.pipe.closed;
  expect(closed).toMatchObject({ reason: "stdin-close", uncertainRequestIds: ["reply"] });
  callbacks.shift()();
  await tick();
  expect(await h.pipe.closed).toBe(closed);
});

test("readable error then close and EOF then close keep their first shutdown cause", async () => {
  const failureReasons = [];
  const failure = createHarness({ onShutdown: (reason) => failureReasons.push(reason) });
  await ready(failure);
  failure.input.destroy(new Error("read failure"));
  expect((await failure.pipe.closed).reason).toBe("stdin-error");
  await tick();
  expect(failureReasons).toEqual(["stdin-error"]);

  const eofReasons = [];
  const eof = createHarness({ onShutdown: (reason) => eofReasons.push(reason) });
  await ready(eof);
  eof.input.end();
  expect((await eof.pipe.closed).reason).toBe("stdin-eof");
  await tick();
  expect(eofReasons).toEqual(["stdin-eof"]);
});

test("EPIPE retains uncertainty for a response still buffered by stdout", async () => {
  const callbacks = [];
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  const h = createHarness({ output });
  h.input.write(encode(hello));
  await tick();
  callbacks.shift()();
  await tick();
  h.input.write(encode({ type: "stop", worker, run, requestId: "q", operationId: "o" }));
  await tick();
  expect(callbacks).toHaveLength(1);
  output.destroy(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  const closed = await h.pipe.closed;
  expect(closed.reason).toBe("stdout-error");
  expect(closed.uncertainRequestIds).toContain("q");
});
