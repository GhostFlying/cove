import { expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import {
  PIPE_VERSION,
  HEADER_BYTES,
  MAX_METADATA_BYTES,
  MAX_FRAME_BYTES,
  PIPE_ROUTE_CONTROL_COMMANDS,
  composeSpawnPayload,
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
  validatePipeResultForCommand,
} from "@cove/protocol/pipe";
import { DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { createWorkerExecution } from "@cove/terminal-worker/execution";
import { runWorkerPipe as runPublicWorkerPipe } from "@cove/terminal-worker/pipe";
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

function coalescedAtCap(cap, prefixFrameBytes) {
  const pieces = [];
  const frameLengths = [];
  const payloadLengths = [];
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
    const length =
      prefixFrameBytes && index < 4
        ? prefixFrameBytes
        : remaining <= max
          ? remaining
          : Math.min(max, remaining - base - 1);
    if (length <= base) throw new Error("cannot construct exact boundary fixture");
    const payloadLength = length - base;
    const piece = encode(command, Buffer.alloc(payloadLength, 0x61));
    pieces.push(piece);
    frameLengths.push(piece.length);
    payloadLengths.push(payloadLength);
    remaining -= piece.length;
  }
  return { bytes: Buffer.concat(pieces), count: pieces.length, frameLengths, payloadLengths };
}

function createHarness(config = {}) {
  const input = new PassThrough();
  const chunks = config.chunks ?? [];
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
  const pipe = (config.runPipe ?? runWorkerPipe)(input, output, {
    buildVersion: "child",
    createExecution: config.createExecution ?? (() => execution),
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

function createSeamNativeFactory() {
  const observed = { spawns: [], writes: [], resizes: [], stops: 0 };
  const cleanup = {
    scope: "initial-process-group",
    verified: false,
    graceful: { kind: "not-attempted", reason: "already-exited" },
    force: { kind: "not-attempted", reason: "already-exited" },
  };
  const factory = {
    retainedBytesAccounting: "participating",
    snapshot: () => ({ owners: observed.spawns.length - observed.stops }),
    spawn(spec, observer) {
      observed.spawns.push(spec);
      const pty = {
        pid: 100,
        writerCompletion: Promise.resolve({ kind: "closed" }),
        submit(bytes, onSettled) {
          const lease = spec.reserveRetainedBytes?.("native-input", bytes.length * 2 + 128);
          if (spec.reserveRetainedBytes && !lease)
            return { kind: "rejected", reason: "worker-byte-limit", writtenBytes: 0 };
          const copy = Buffer.from(bytes);
          observed.writes.push(copy);
          const ticket = observed.writes.length;
          try {
            onSettled({
              kind: "written",
              ticket,
              status: "written",
              originalBytes: copy.length,
              writtenBytes: copy.length,
              remainingBytes: 0,
            });
          } finally {
            lease?.release();
          }
          return { kind: "accepted", ticket, byteLength: copy.length };
        },
        automaticOutputSink() {},
        resize(cols, rows) {
          observed.resizes.push([cols, rows]);
        },
        pause() {},
        resume() {},
        retireInput() {},
        async stop() {
          observed.stops++;
          observer.onExit({ exitCode: 0 });
          return { kind: "exited", exit: { exitCode: 0 }, cleanup };
        },
        snapshot() {
          return {
            pid: 100,
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
      };
      return { kind: "created", pty };
    },
  };
  return { factory, observed };
}

function createRealExecutionHarness() {
  const native = createSeamNativeFactory();
  const harness = createHarness({
    runPipe: runPublicWorkerPipe,
    createExecution: (options) => createWorkerExecution({ ...options, factory: native.factory }),
  });
  return { ...harness, native: native.observed };
}

async function sendAndRead(harness, command, payload) {
  const before = harness.frames().length;
  harness.input.write(encode(command, payload));
  for (let attempt = 0; attempt < 20; attempt++) {
    const reply = harness
      .frames()
      .slice(before)
      .find((frame) => frame.requestId === command.requestId);
    if (reply) return reply;
    await tick();
  }
  throw new Error(`No correlated reply for ${command.requestId}`);
}

function seamSpawn(requestId = "seam-spawn") {
  const composed = composeSpawnPayload(
    { executable: "/bin/sh", argv: ["-c", "exit 0"], cwd: "/" },
    (value) => encoder.encode(value),
  );
  if (!composed) throw new Error("canonical spawn fixture failed");
  return {
    command: {
      type: "spawn",
      worker,
      run,
      requestId,
      operationId: "seam-spawn-op",
      geometry: { cols: 80, rows: 24 },
      profile: PROFILE,
      appearance: DEFAULT_APPEARANCE,
      effectiveBudgets: M0_LIMITS,
      spawnPayloadBytes: composed.bytes.length,
    },
    payload: composed.bytes,
  };
}

test("public pipe normalizes validated empty commands for real worker execution", async () => {
  const h = createRealExecutionHarness();
  const holder = {
    connection: subscription.connection,
    subscriptionId: subscription.subscriptionId,
    viewId: subscription.viewId,
  };
  try {
    await ready(h);
    const spawn = seamSpawn();
    expect(await sendAndRead(h, spawn.command, spawn.payload)).toMatchObject({
      type: "result",
      requestId: spawn.command.requestId,
      commandType: "spawn",
      outcome: "accepted",
    });
    expect(h.native.spawns).toHaveLength(1);
    expect(h.native.spawns[0]).toMatchObject({
      file: "/bin/sh",
      args: ["-c", "exit 0"],
      cwd: "/",
    });

    const subscribe = {
      type: "subscribe",
      worker,
      run,
      requestId: "seam-subscribe",
      subscription,
      atSeq: 0,
    };
    expect(await sendAndRead(h, subscribe)).toMatchObject({
      type: "result",
      recoveryMode: "baseline",
      atSeq: 0,
    });
    for (
      let turn = 0;
      turn < 20 && !h.frames().some((frame) => frame.terminal?.type === "baseline-end");
      turn++
    )
      await tick();
    const start = h.frames().find((frame) => frame.terminal?.type === "baseline-start");
    const chunks = h.frames().filter((frame) => frame.terminal?.type === "baseline-chunk");
    expect(start).toBeDefined();
    expect(h.frames().filter((frame) => frame.terminal?.type === "baseline-end")).toHaveLength(1);
    for (let index = 0; index < chunks.length; index++) {
      const progress = {
        type: "baseline-progress",
        worker,
        run,
        requestId: `seam-progress-${index}`,
        subscription,
        baselineId: start.terminal.descriptor.baselineId,
        lastParsedOrdinal: index,
      };
      expect((await sendAndRead(h, progress)).outcome).toBe("accepted");
    }
    const ack = {
      type: "applied-ack",
      worker,
      run,
      requestId: "seam-ack",
      subscription,
      appliedSeq: 0,
    };
    expect((await sendAndRead(h, ack)).outcome).toBe("accepted");

    const control = {
      type: "set-control",
      worker,
      run,
      requestId: "seam-control",
      expectedEpoch: 0,
      nextEpoch: 1,
      holder,
      geometry: { cols: 80, rows: 24 },
    };
    expect(await sendAndRead(h, control)).toMatchObject({
      type: "result",
      requestId: control.requestId,
      commandType: "set-control",
      outcome: "accepted",
    });
    const query = { type: "status", worker, run, requestId: "seam-status" };
    expect(await sendAndRead(h, query)).toMatchObject({
      type: "result",
      requestId: query.requestId,
      commandType: "status",
      outcome: "accepted",
      runStatus: { run, controlEpoch: 1, controlHolder: holder },
    });

    const bytes = Uint8Array.of(0x00, 0x80, 0xff, 0x41);
    const input = {
      type: "input",
      worker,
      run,
      requestId: "seam-input",
      subscription,
      epoch: 1,
      inputSeq: 1,
    };
    expect(await sendAndRead(h, input, bytes)).toMatchObject({
      type: "result",
      requestId: input.requestId,
      commandType: "input",
      outcome: "accepted",
      inputSeq: 1,
      writtenBytes: bytes.length,
    });
    expect(h.native.writes).toEqual([Buffer.from(bytes)]);

    const resize = {
      type: "resize",
      worker,
      run,
      requestId: "seam-resize",
      subscription,
      epoch: 1,
      geometry: { cols: 81, rows: 24 },
    };
    expect(await sendAndRead(h, resize)).toMatchObject({
      type: "result",
      commandType: "resize",
      outcome: "accepted",
    });
    expect(h.native.resizes).toContainEqual([81, 24]);
    const appearance = {
      type: "appearance",
      worker,
      run,
      requestId: "seam-appearance",
      subscription,
      epoch: 1,
      appearance: DEFAULT_APPEARANCE,
    };
    expect(await sendAndRead(h, appearance)).toMatchObject({
      type: "result",
      commandType: "appearance",
      outcome: "accepted",
    });

    const stop = { type: "stop", worker, run, requestId: "seam-stop", operationId: "stop-op" };
    expect(await sendAndRead(h, stop)).toMatchObject({
      type: "result",
      requestId: stop.requestId,
      commandType: "stop",
      outcome: "accepted",
    });
    expect(h.native.stops).toBe(1);
  } finally {
    await h.pipe.shutdown("test-complete");
  }
});

test.each([
  [
    "status with bytes",
    () => ({
      command: { type: "status", worker, run, requestId: "bad-status" },
      payload: Uint8Array.of(1),
    }),
  ],
  [
    "set-control with bytes",
    () => ({
      command: {
        type: "set-control",
        worker,
        run,
        requestId: "bad-control",
        expectedEpoch: 0,
        nextEpoch: 1,
        holder: null,
        geometry: { cols: 80, rows: 24 },
      },
      payload: Uint8Array.of(1),
    }),
  ],
  ["empty spawn", () => ({ command: seamSpawn().command, payload: new Uint8Array() })],
  [
    "short spawn",
    () => {
      const spawn = seamSpawn();
      return {
        command: spawn.command,
        payload: spawn.payload.subarray(0, spawn.payload.length - 1),
      };
    },
  ],
  [
    "empty input",
    () => ({
      command: {
        type: "input",
        worker,
        run,
        requestId: "bad-input",
        subscription,
        epoch: 1,
        inputSeq: 1,
      },
      payload: new Uint8Array(),
    }),
  ],
])("public pipe rejects %s before real execution", async (_name, fixture) => {
  const h = createRealExecutionHarness();
  try {
    await ready(h);
    const { command, payload } = fixture();
    h.input.write(encode(command, payload));
    expect((await h.pipe.closed).reason).toBe("invalid-frame-INVALID_METADATA");
    expect(h.native.spawns).toHaveLength(0);
    expect(h.frames()).toHaveLength(1);
  } finally {
    await h.pipe.shutdown("test-complete");
  }
});

test("real execution still rejects missing spawn and empty input directly", async () => {
  const native = createSeamNativeFactory();
  const execution = createWorkerExecution({
    worker,
    effectiveBudgets: M0_LIMITS,
    factory: native.factory,
  });
  try {
    const spawn = seamSpawn();
    expect(await execution.execute(spawn.command)).toMatchObject({
      type: "error",
      error: { kind: "INPUT_REJECTED" },
    });
    expect(
      await execution.execute(
        {
          type: "input",
          worker,
          run,
          requestId: "direct-empty-input",
          subscription,
          epoch: 1,
          inputSeq: 1,
        },
        new Uint8Array(),
      ),
    ).toMatchObject({
      type: "error",
      error: { kind: "INPUT_REJECTED" },
    });
    expect(native.observed.spawns).toHaveLength(0);
  } finally {
    await execution.shutdown("test-complete");
  }
});

async function ready(harness, greeting = hello) {
  harness.input.write(encode(greeting));
  await tick();
  expect(harness.pipe.snapshot()).toMatchObject({ parkedRequests: 0, outstandingRequests: 0 });
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

test("exact-cap ingress releases an unproduced header before every decoder yield", async () => {
  const cap = M0_LIMITS.pipeQueuedBytes;
  const fixture = coalescedAtCap(cap, 65_532);
  expect(fixture.bytes.length).toBe(cap);
  expect(fixture.frameLengths.slice(0, 4).reduce((sum, length) => sum + length, 0)).toBe(262_128);
  const responders = [];
  const h = createHarness({
    execute: (command) => new Promise((resolve) => responders.push({ command, resolve })),
  });
  await ready(h);
  h.input.write(fixture.bytes);
  const samples = [h.pipe.snapshot()];
  for (let attempt = 0; attempt < 100 && h.calls.length < fixture.count; attempt++) {
    await tick();
    samples.push(h.pipe.snapshot());
  }
  expect(samples[0].ingressBytes).toBe(cap);
  expect(samples.filter((sample) => sample.ingressBytes > 0).length).toBeGreaterThan(1);
  expect(samples.every((sample) => sample.ingressBytes <= cap)).toBe(true);
  expect(h.calls.map(({ command }) => command.requestId)).toEqual(
    fixture.payloadLengths.map((_, index) => `boundary-${index}`),
  );
  expect(h.calls.map(({ payload }) => payload.byteLength)).toEqual(fixture.payloadLengths);
  expect(h.pipe.snapshot().ingressBytes).toBe(0);
  for (const { command, resolve } of responders)
    resolve({
      type: "error",
      worker,
      run,
      requestId: command.requestId,
      commandType: command.type,
      error: domainError("CAPABILITY_UNAVAILABLE"),
    });
  await tick();
  expect(
    h
      .frames()
      .slice(1)
      .map((reply) => reply.requestId),
  ).toEqual(fixture.payloadLengths.map((_, index) => `boundary-${index}`));
  await h.pipe.shutdown("test-complete");
});

test("previous-chunk partial completes before a smaller-cap slice yield", async () => {
  const cap = 300_000;
  const fixture = coalescedAtCap(cap, 65_532);
  const h = createHarness({
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
  await ready(h, { ...hello, effectiveBudgets: { ...M0_LIMITS, pipeQueuedBytes: cap } });
  h.input.write(Buffer.from(fixture.bytes.subarray(0, 7)));
  expect(h.pipe.snapshot().ingressBytes).toBe(16);
  h.input.write(Buffer.from(fixture.bytes.subarray(7)));
  expect(h.pipe.snapshot().ingressBytes).toBeLessThanOrEqual(cap);
  for (let attempt = 0; attempt < 20 && h.calls.length < fixture.count; attempt++) await tick();
  expect(h.calls.map(({ command }) => command.requestId)).toEqual(
    fixture.payloadLengths.map((_, index) => `boundary-${index}`),
  );
  expect(h.frames()).toHaveLength(fixture.count + 1);
  expect(h.pipe.snapshot().state).toBe("ready");
  await h.pipe.shutdown("test-complete");
});

test("EOF with a decoder-owned partial remains truncated after yield repair", async () => {
  const h = createHarness();
  await ready(h);
  const command = encode({ type: "preview-refresh", worker, run, requestId: "partial-eof" });
  h.input.write(command.subarray(0, 16));
  expect(h.pipe.snapshot().ingressBytes).toBe(MAX_FRAME_BYTES);
  h.input.end();
  expect((await h.pipe.closed).reason).toBe("stdin-truncated-frame");
  expect(h.calls).toHaveLength(0);
});

test("readable close during a decoder yield freezes only admitted request IDs", async () => {
  const fixture = coalescedAtCap(M0_LIMITS.pipeQueuedBytes, 65_532);
  const h = createHarness({ execute: () => new Promise(() => {}) });
  await ready(h);
  h.input.write(fixture.bytes);
  const admittedIds = h.calls.map(({ command }) => command.requestId);
  expect(admittedIds).toHaveLength(4);
  h.input.destroy();
  const closed = await h.pipe.closed;
  expect(closed.reason).toBe("stdin-close");
  expect(closed.uncertainRequestIds).toEqual(admittedIds);
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
  expect(partial.pipe.snapshot().ingressBytes).toBe(16);
  partial.input.write(Buffer.alloc(budgets.pipeQueuedBytes - 6));
  expect((await partial.pipe.closed).reason).toBe("ingress-capacity-exceeded");
  expect(partial.calls).toHaveLength(0);

  const retainedBacking = createHarness();
  await ready(retainedBacking, { ...hello, effectiveBudgets: budgets });
  retainedBacking.input.write(Buffer.alloc(budgets.pipeQueuedBytes + 1).subarray(0, 7));
  expect((await retainedBacking.pipe.closed).reason).toBe("ingress-capacity-exceeded");
  expect(retainedBacking.pipe.snapshot().ingressBytes).toBe(0);
});

test("stub execution preserves correlated W2 unavailability through the pipe", async () => {
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
  const replies = [];
  for (const command of commands) replies.push(await sendAndRead(h, command));
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
  expect(h.pipe.snapshot()).toMatchObject({
    state: "ready",
    pendingCommands: 1,
    parkedRequests: 0,
  });
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

test("W2 O recover leaves X available and parks one next X until the prior write callback", async () => {
  const callbacks = [];
  const writes = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callbacks.push(callback);
    },
  });
  const h = createHarness({
    output,
    execute(command) {
      return Promise.resolve({
        type: "result",
        worker,
        run,
        requestId: command.requestId,
        commandType: command.type,
        outcome: "accepted",
        ...(command.type === "recover" ? { recoveryMode: "baseline", atSeq: 0 } : { atSeq: 0 }),
      });
    },
  });
  const budgets = { ...M0_LIMITS, pendingWorkerCommands: 1, reservedControlBytes: 4112 };
  h.input.write(encode({ ...hello, effectiveBudgets: budgets }));
  expect(callbacks).toHaveLength(1);
  callbacks.shift()();
  await tick();
  const recover = { type: "recover", worker, run, subscription, requestId: "recover-o" };
  const ack = { type: "applied-ack", worker, run, subscription, requestId: "ack-x", appliedSeq: 0 };
  const progress = {
    type: "baseline-progress",
    worker,
    run,
    subscription,
    requestId: "progress-x",
    baselineId: "b",
    lastParsedOrdinal: 0,
  };
  h.input.write(encode(recover));
  await tick();
  expect(h.calls.map(({ command }) => command.requestId)).toEqual(["recover-o"]);
  expect(h.pipe.snapshot()).toMatchObject({ outstandingRequests: 1, parkedRequests: 0 });
  h.input.write(encode(ack));
  await tick();
  expect(h.calls.map(({ command }) => command.requestId)).toEqual(["recover-o", "ack-x"]);
  expect(h.pipe.snapshot()).toMatchObject({ state: "ready", outstandingRequests: 2 });
  expect(writes).toHaveLength(2);
  callbacks.shift()();
  await tick();
  expect(writes).toHaveLength(3);
  h.input.write(encode(progress));
  await tick();
  expect(h.calls).toHaveLength(2);
  expect(h.pipe.snapshot()).toMatchObject({
    state: "ready",
    outstandingRequests: 2,
    parkedRequests: 1,
  });
  callbacks.shift()();
  await tick();
  expect(h.calls.map(({ command }) => command.requestId)).toEqual([
    "recover-o",
    "ack-x",
    "progress-x",
  ]);
  expect(writes).toHaveLength(4);
  callbacks.shift()();
  await tick();
  expect(h.pipe.snapshot()).toMatchObject({
    state: "ready",
    outstandingRequests: 0,
    parkedRequests: 0,
  });
  await h.pipe.shutdown("test-complete");
});

// A Writable that hands every write callback to the test, so a reply stays physically
// unsettled (and its request outstanding) until the test releases it.
function heldOutput() {
  const callbacks = [];
  const chunks = [];
  const output = new Writable({
    highWaterMark: 1024 * 1024,
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callbacks.push(callback);
    },
  });
  return { output, callbacks, chunks };
}

function routeControl(index) {
  const fields = [
    { type: "applied-ack", appliedSeq: index },
    { type: "baseline-progress", baselineId: "b", lastParsedOrdinal: index },
    { type: "unsubscribe" },
  ][index % 3];
  return { ...fields, worker, run, subscription, requestId: `route-${index}` };
}

async function routeHarness(execute, budgets = M0_LIMITS) {
  const held = heldOutput();
  const h = createHarness({ output: held.output, chunks: held.chunks, execute });
  h.input.write(encode({ ...hello, effectiveBudgets: budgets }));
  held.callbacks.shift()();
  await tick();
  return { h, held };
}

test("route control up to the shared window queues in arrival order behind one executing command", async () => {
  const { h, held } = await routeHarness();
  const commands = Array.from({ length: PIPE_ROUTE_CONTROL_COMMANDS }, (_, index) =>
    routeControl(index),
  );
  // The runtime may have this many outstanding at once; they can reach the worker in one read.
  h.input.write(Buffer.concat(commands.map((command) => encode(command))));
  await tick();
  expect(h.calls.map(({ command }) => command.requestId)).toEqual(["route-0"]);
  expect(h.pipe.snapshot()).toMatchObject({
    state: "ready",
    outstandingRequests: PIPE_ROUTE_CONTROL_COMMANDS,
    parkedRequests: PIPE_ROUTE_CONTROL_COMMANDS - 1,
  });
  // Each reply's write callback frees the slot for exactly the next parked command.
  for (let index = 1; index < PIPE_ROUTE_CONTROL_COMMANDS; index++) {
    held.callbacks.shift()();
    await tick();
    expect(h.calls.map(({ command }) => command.requestId)).toEqual(
      commands.slice(0, index + 1).map((command) => command.requestId),
    );
    expect(h.pipe.snapshot()).toMatchObject({
      state: "ready",
      parkedRequests: PIPE_ROUTE_CONTROL_COMMANDS - 1 - index,
    });
  }
  held.callbacks.shift()();
  await tick();
  expect(h.pipe.snapshot()).toMatchObject({
    state: "ready",
    outstandingRequests: 0,
    parkedRequests: 0,
  });
  expect(h.frames().map((frame) => frame.requestId)).toEqual([
    undefined,
    ...commands.map((command) => command.requestId),
  ]);
  await h.pipe.shutdown("test-complete");
});

test("the full route window waits behind an outstanding BUSY rejection", async () => {
  let settleOrdinary;
  // One ordinary slot, so a second preview earns a BUSY rejection. Until that reply's write
  // callback the rejection holds the slot route control shares, so every route command parks.
  const { h, held } = await routeHarness(
    (command) =>
      command.type === "preview-refresh"
        ? new Promise((resolve) => {
            settleOrdinary = resolve;
          })
        : Promise.resolve({
            type: "error",
            worker,
            run,
            requestId: command.requestId,
            commandType: command.type,
            error: domainError("CAPABILITY_UNAVAILABLE"),
          }),
    { ...M0_LIMITS, pendingWorkerCommands: 1 },
  );
  const preview = { type: "preview-refresh", worker, run, requestId: "preview" };
  h.input.write(Buffer.concat([encode(preview), encode({ ...preview, requestId: "busy" })]));
  await tick();
  expect(h.frames().at(-1)).toMatchObject({ requestId: "busy", error: { kind: "BUSY" } });
  const commands = Array.from({ length: PIPE_ROUTE_CONTROL_COMMANDS }, (_, index) =>
    routeControl(index),
  );
  h.input.write(Buffer.concat(commands.map((command) => encode(command))));
  await tick();
  expect(h.pipe.snapshot()).toMatchObject({
    state: "ready",
    parkedRequests: PIPE_ROUTE_CONTROL_COMMANDS,
  });
  // Settling the BUSY reply admits the oldest; the rest follow one callback at a time.
  for (let index = 0; index < PIPE_ROUTE_CONTROL_COMMANDS; index++) {
    held.callbacks.shift()();
    await tick();
    expect(h.calls.slice(1).map(({ command }) => command.requestId)).toEqual(
      commands.slice(0, index + 1).map((command) => command.requestId),
    );
  }
  expect(h.pipe.snapshot().state).toBe("ready");
  settleOrdinary({
    type: "error",
    worker,
    run,
    requestId: "preview",
    commandType: "preview-refresh",
    error: domainError("CAPABILITY_UNAVAILABLE"),
  });
  await h.pipe.shutdown("test-complete");
});

test("route control beyond the shared window is a protocol violation and fails closed", async () => {
  const { h } = await routeHarness();
  const commands = Array.from({ length: PIPE_ROUTE_CONTROL_COMMANDS + 1 }, (_, index) =>
    routeControl(index),
  );
  h.input.write(Buffer.concat(commands.map((command) => encode(command))));
  const closed = await h.pipe.closed;
  expect(closed.reason).toBe("route-control-ingress-capacity");
  expect(h.calls.map(({ command }) => command.requestId)).toEqual(["route-0"]);
  expect(closed.uncertainRequestIds).toEqual(
    commands.slice(0, PIPE_ROUTE_CONTROL_COMMANDS).map((command) => command.requestId),
  );
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

test("ordinary BUSY replies for reply bytes fit the ordinary window beside unsettled route control", async () => {
  const budgets = {
    ...M0_LIMITS,
    pipeQueuedBytes: 69_648,
    reservedControlBytes: 8_192,
    pendingWorkerCommands: 32,
  };
  const { h, held } = await routeHarness(
    (command) =>
      command.type === "preview-refresh"
        ? new Promise(() => {})
        : Promise.resolve({
            type: "error",
            worker,
            run,
            requestId: command.requestId,
            commandType: command.type,
            error: domainError("CAPABILITY_UNAVAILABLE"),
          }),
    budgets,
  );
  // The ack's reply stays unsettled, holding the slot a BUSY reply would otherwise take.
  h.input.write(encode(routeControl(0)));
  await tick();
  // 13 previews use up the ordinary reply bytes; the next three are refused for bytes alone.
  // All 17 commands are within the runtime's windows, so none of this is a violation.
  const previews = Array.from({ length: 16 }, (_, index) => ({
    type: "preview-refresh",
    worker,
    run,
    requestId: `preview-${index}`,
  }));
  h.input.write(Buffer.concat(previews.map((command) => encode(command))));
  await tick();
  // The ack's reply and the three BUSY replies are handed to the Writable, all unsettled.
  expect(h.pipe.snapshot()).toMatchObject({
    state: "ready",
    outstandingRequests: 17,
    responseItems: 4,
  });
  expect(h.calls.filter(({ command }) => command.type === "preview-refresh")).toHaveLength(13);
  // The rejections settle like any reply, and route control then runs again.
  for (let turn = 0; turn < 8 && held.callbacks.length; turn++) {
    while (held.callbacks.length) held.callbacks.shift()();
    await tick();
  }
  const busy = h
    .frames()
    .filter((frame) => frame.error?.kind === "BUSY")
    .map((frame) => frame.requestId);
  expect(busy).toEqual(["preview-13", "preview-14", "preview-15"]);
  h.input.write(encode(routeControl(1)));
  await tick();
  expect(h.calls.at(-1).command.requestId).toBe("route-1");
  expect(h.pipe.snapshot()).toMatchObject({ state: "ready", outstandingRequests: 14 });
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

test("write callback EPIPE keeps the later Writable error owned through close", async () => {
  const callbacks = [];
  const writes = [];
  const shutdowns = [];
  const events = [];
  const disposal = Promise.withResolvers();
  const output = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callbacks.push(callback);
    },
  });
  const emit = output.emit;
  output.emit = function (name, ...args) {
    if (name === "error" || name === "close") events.push(name);
    return emit.call(this, name, ...args);
  };
  const receipt = {
    stop: { kind: "observed", result: { kind: "exited" } },
    leader: { kind: "exit-observed" },
    writer: { kind: "closed" },
    ownershipEvidence: "closure-proven",
  };
  const h = createHarness({
    output,
    createExecution: () => ({
      execute: async (command) => ({
        type: "error",
        worker,
        run,
        requestId: command.requestId,
        commandType: command.type,
        error: domainError("CAPABILITY_UNAVAILABLE"),
      }),
      snapshot: () => ({}),
      shutdown: async (reason) => {
        shutdowns.push(reason);
        await disposal.promise;
        return [receipt];
      },
    }),
  });
  h.input.write(encode(hello));
  callbacks.shift()();
  await tick();
  const command = { type: "preview-refresh", worker, run, requestId: "epipe-reply" };
  h.input.write(encode(command));
  await tick();
  expect(writes).toHaveLength(2);
  events.push("write-callback");
  callbacks.shift()(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  await tick(); // Node emits error and close after the write callback.
  expect(events).toEqual(["write-callback", "error", "close"]);
  expect(output.closed).toBe(true);
  expect(h.pipe.snapshot().state).toBe("closing");
  expect(h.pipe.snapshot()).toMatchObject({
    responseItems: 0,
    transportBytes: 0,
    ordinaryAccountedBytes: 0,
    blocked: false,
  });
  expect(shutdowns).toEqual(["stdout-write-failed"]);
  expect(h.pipe.shutdown("late-close")).toBe(h.pipe.closed);
  disposal.resolve();
  const closed = await h.pipe.closed;
  expect(closed).toMatchObject({
    reason: "stdout-write-failed",
    uncertainRequestIds: ["epipe-reply"],
    disposalReceipts: [receipt],
    disposalUnverifiable: false,
  });
  expect(writes).toHaveLength(2);
  expect(output.listenerCount("error")).toBe(0);
  expect(h.pipe.snapshot()).toMatchObject({
    responseItems: 0,
    transportBytes: 0,
    ordinaryAccountedBytes: 0,
    queuedBytes: 0,
    outstandingRequests: 0,
    blocked: false,
  });
});

test("a late Writable error remains guarded after shutdown receipt until terminal close", async () => {
  let finish;
  const output = new Writable({
    autoDestroy: false,
    write(_chunk, _encoding, callback) {
      callback();
    },
    final(callback) {
      finish = callback;
    },
  });
  const shutdowns = [];
  const h = createHarness({ output, onShutdown: (reason) => shutdowns.push(reason) });
  h.input.write(encode(hello));
  await tick();
  expect(h.pipe.snapshot().state).toBe("ready");
  const closed = await h.pipe.shutdown("test-close");
  expect(closed.reason).toBe("test-close");
  expect(output.closed).toBe(false);
  output.emit("error", Object.assign(new Error("late EPIPE"), { code: "EPIPE" }));
  expect(shutdowns).toEqual(["test-close"]);
  finish();
  output.destroy();
  await tick();
  expect(output.closed).toBe(true);
  expect(output.listenerCount("error")).toBe(0);
});

test("logical shutdown retains handed-off bytes until physical Writable close", async () => {
  const callbacks = [];
  const writes = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callbacks.push(callback);
    },
  });
  const h = createHarness({ output });
  h.input.write(encode(hello));
  callbacks.shift()();
  await tick();
  h.input.write(encode({ type: "preview-refresh", worker, run, requestId: "held" }));
  await tick();
  const before = h.pipe.snapshot();
  expect(before).toMatchObject({ responseItems: 1, blocked: true });
  expect(before.transportBytes).toBeGreaterThan(0);
  expect(before.ordinaryAccountedBytes).toBeGreaterThan(0);
  const closed = await h.pipe.shutdown("test-close");
  expect(closed).toMatchObject({ reason: "test-close", uncertainRequestIds: ["held"] });
  expect(h.pipe.snapshot()).toMatchObject({
    state: "closed",
    responseItems: 1,
    transportBytes: before.transportBytes,
    ordinaryAccountedBytes: before.ordinaryAccountedBytes,
    blocked: true,
  });
  output.destroy();
  await tick();
  expect(output.closed).toBe(true);
  expect(h.pipe.snapshot()).toMatchObject({
    responseItems: 0,
    transportBytes: 0,
    ordinaryAccountedBytes: 0,
    queuedBytes: 0,
    outstandingRequests: 0,
    blocked: false,
    peakAccountedBytes: before.peakAccountedBytes,
  });
  expect(await h.pipe.shutdown("later-close")).toBe(closed);
  expect(writes).toHaveLength(2);
});

test("late success and error callbacks after terminal retirement do not restore debt", async () => {
  for (const error of [false, true]) {
    let heldCallback;
    let writes = 0;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        writes++;
        if (writes === 1) callback();
        else heldCallback = callback;
      },
    });
    const h = createHarness({ output });
    h.input.write(encode(hello));
    await tick();
    h.input.write(encode({ type: "preview-refresh", worker, run, requestId: "late" }));
    await tick();
    expect(h.pipe.snapshot().responseItems).toBe(1);
    output.emit("close");
    const closed = await h.pipe.closed;
    expect(closed).toMatchObject({ reason: "stdout-close", uncertainRequestIds: ["late"] });
    expect(h.pipe.snapshot()).toMatchObject({ responseItems: 0, transportBytes: 0 });
    heldCallback(error ? Object.assign(new Error("late EPIPE"), { code: "EPIPE" }) : undefined);
    await tick();
    output.destroy();
    await tick();
    expect(h.pipe.snapshot()).toMatchObject({
      responseItems: 0,
      transportBytes: 0,
      ordinaryAccountedBytes: 0,
      queuedBytes: 0,
      outstandingRequests: 0,
      blocked: false,
    });
    expect(await h.pipe.shutdown("repeated-close")).toBe(closed);
    expect(writes).toBe(2);
  }
});

test("terminal close retires a handed-off duplicate response token once", async () => {
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
  const original = { type: "stop", worker, run, requestId: "duplicate", operationId: "first" };
  h.input.write(encode(original));
  await tick();
  h.input.write(encode({ ...original, operationId: "second" }));
  await tick();
  expect(h.pipe.snapshot()).toMatchObject({ responseItems: 2, outstandingRequests: 1 });
  output.emit("close");
  const closed = await h.pipe.closed;
  expect(closed).toMatchObject({ reason: "stdout-close", uncertainRequestIds: ["duplicate"] });
  expect(h.pipe.snapshot()).toMatchObject({
    responseItems: 0,
    transportBytes: 0,
    ordinaryAccountedBytes: 0,
    outstandingRequests: 0,
  });
  callbacks.shift()();
  output.destroy();
  await tick();
  expect(h.pipe.snapshot().responseItems).toBe(0);
  expect(await h.pipe.shutdown("again")).toBe(closed);
});

test("synchronous close during write(false) cannot restore blocked transport", async () => {
  let writes = 0;
  const output = new Writable({
    highWaterMark: 1,
    write() {
      writes++;
      this.emit("close");
    },
  });
  const h = createHarness({ output });
  h.input.write(encode(hello));
  const closed = await h.pipe.closed;
  expect(closed.reason).toBe("stdout-close");
  expect(h.pipe.snapshot()).toMatchObject({
    responseItems: 0,
    transportBytes: 0,
    ordinaryAccountedBytes: 0,
    blocked: false,
  });
  output.destroy();
  await tick();
  expect(h.pipe.snapshot()).toMatchObject({ transportBytes: 0, blocked: false });
  expect(writes).toBe(1);
});

test("parked route request ID rejects an ordinary collision and preserves its first response", async () => {
  const callbacks = [];
  const writes = [];
  const writeReturns = [];
  const calls = [];
  const realResults = [];
  const trace = [];
  const blockerGate = Promise.withResolvers();
  const duplicateGate = Promise.withResolvers();
  const probeGate = Promise.withResolvers();
  const native = createSeamNativeFactory();
  let holdCallbacks = false;
  let execution;
  let h;
  const record = (label) => {
    if (!h) return;
    trace.push({
      label,
      snapshot: h.pipe.snapshot(),
      execution: execution.snapshot(),
      calls: structuredClone(calls),
      realResults: structuredClone(realResults),
      replies: decodeWrites(),
      writes: writes.map((bytes) => [...bytes]),
      writeReturns: [...writeReturns],
      heldCallbacks: callbacks.length,
    });
  };
  const output = new Writable({
    highWaterMark: 1024 * 1024,
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      if (holdCallbacks) callbacks.push(callback);
      else callback();
    },
  });
  const originalWrite = output.write;
  output.write = function (...args) {
    const accepted = originalWrite.apply(this, args);
    writeReturns.push(accepted);
    record("actual-write-return");
    return accepted;
  };
  h = createHarness({
    runPipe: runPublicWorkerPipe,
    output,
    createExecution(options) {
      execution = createWorkerExecution({ ...options, factory: native.factory });
      return {
        ...execution,
        async execute(command, payload) {
          calls.push({ command: structuredClone(command), payload: payload && [...payload] });
          record("actual-execute-entry");
          const result = await execution.execute(command, payload);
          realResults.push({ command: structuredClone(command), result: structuredClone(result) });
          record("actual-business-result-before-return-gate");
          if (command.requestId === "held-route") await blockerGate.promise;
          if (command.requestId === "parked-id" && command.type === "preview-refresh")
            await duplicateGate.promise;
          if (command.requestId.startsWith("debt-probe-")) await probeGate.promise;
          return result;
        },
      };
    },
  });
  function decodeWrites() {
    const wire = createPipeDecoder();
    return writes.flatMap((bytes) =>
      wire.read(bytes).frames.map((frame) => ({
        kind: frame.kind,
        metadata: JSON.parse(decoder.decode(frame.metadata)),
        payload: [...frame.payload],
      })),
    );
  }
  const drain = async () => {
    for (let turn = 0; turn < 30; turn++) {
      callbacks.shift()?.();
      await tick();
    }
  };
  const send = async (command, payload) => {
    h.input.write(encode(command, payload));
    for (let turn = 0; turn < 30; turn++) {
      const reply = decodeWrites().find(({ metadata }) => metadata.requestId === command.requestId);
      if (reply) return reply.metadata;
      await tick();
    }
    throw new Error(`No actual setup reply for ${command.requestId}`);
  };
  const blocker = {
    type: "applied-ack",
    worker,
    run,
    subscription,
    requestId: "held-route",
    appliedSeq: 0,
  };
  const parked = { type: "unsubscribe", worker, run, subscription, requestId: "parked-id" };
  const duplicate = {
    type: "preview-refresh",
    worker,
    run,
    requestId: "parked-id",
    knownVersion: 0,
  };
  const probes = [
    { ...duplicate, requestId: "debt-probe-preview-1" },
    { ...duplicate, requestId: "debt-probe-preview-2" },
    { type: "status", worker, run, requestId: "debt-probe-status" },
  ];
  trace.push({
    label: "fixed-stimuli",
    commands: [blocker, parked, duplicate, ...probes],
    ingress: [blocker, parked, duplicate, ...probes].map((command) => [...encode(command)]),
  });
  try {
    h.input.write(encode(hello));
    await tick();
    const spawn = seamSpawn("parked-control-spawn");
    expect(await send(spawn.command, spawn.payload)).toMatchObject({
      type: "result",
      outcome: "accepted",
    });
    expect(
      await send({
        type: "subscribe",
        worker,
        run,
        subscription,
        requestId: "parked-control-subscribe",
        atSeq: 0,
      }),
    ).toMatchObject({ type: "result", recoveryMode: "baseline", atSeq: 0 });
    for (
      let turn = 0;
      turn < 30 &&
      !decodeWrites().some(({ metadata }) => metadata.terminal?.type === "baseline-end");
      turn++
    )
      await tick();
    const start = decodeWrites().find(
      ({ metadata }) => metadata.terminal?.type === "baseline-start",
    );
    const chunks = decodeWrites().filter(
      ({ metadata }) => metadata.terminal?.type === "baseline-chunk",
    );
    expect(start).toBeDefined();
    expect(
      decodeWrites().filter(({ metadata }) => metadata.terminal?.type === "baseline-end"),
    ).toHaveLength(1);
    for (let index = 0; index < chunks.length; index++)
      expect(
        await send({
          type: "baseline-progress",
          worker,
          run,
          subscription,
          requestId: `parked-control-progress-${index}`,
          baselineId: start.metadata.terminal.descriptor.baselineId,
          lastParsedOrdinal: index,
        }),
      ).toMatchObject({ type: "result", outcome: "accepted" });
    expect(await send({ ...blocker, requestId: "parked-control-installed-ack" })).toMatchObject({
      type: "result",
      outcome: "accepted",
    });
    await tick();
    record("real-route-installed-and-physical-setup-settled");
    holdCallbacks = true;
    h.input.write(encode(blocker));
    await tick();
    record("real-route-result-held-before-endpoint-completion");
    expect(
      realResults.find(({ command }) => command.requestId === blocker.requestId)?.result,
    ).toMatchObject({ type: "result", outcome: "accepted" });
    expect(h.pipe.snapshot()).toMatchObject({
      state: "ready",
      pendingCommands: 1,
      outstandingRequests: 1,
      parkedRequests: 0,
      blocked: false,
    });
    h.input.write(encode(parked));
    await tick();
    record("first-id-parked-with-flowing-ingress");
    expect(
      calls.some(
        ({ command }) => command.type === parked.type && command.requestId === parked.requestId,
      ),
    ).toBe(false);
    expect(h.pipe.snapshot().ingressBytes).toBeGreaterThan(0);
    h.input.write(encode(duplicate));
    await tick();
    record("ordinary-same-id-actually-processed-before-route-release");
    blockerGate.resolve();
    await tick();
    record("blocker-response-held-by-real-writable-callback");
    await drain();
    record("parked-admission-and-physical-original-response-settled");
    duplicateGate.resolve();
    await tick();
    await drain();
    record("actual-late-duplicate-result-returned-after-parked-admission");
    for (const command of probes) h.input.write(encode(command));
    await tick();
    record("distinct-real-return-gates-reply-debt-conservation");
    probeGate.resolve();
    await tick();
    await drain();
    record("all-response-callbacks-settled");
    const replies = decodeWrites().map(({ metadata }) => metadata);
    expect(
      calls
        .filter(({ command }) => command.requestId === parked.requestId)
        .map(({ command }) => command.type),
    ).toEqual([parked.type]);
    expect(
      trace.find(({ label }) => label === "first-id-parked-with-flowing-ingress").snapshot,
    ).toMatchObject({
      state: "ready",
      outstandingRequests: 2,
      parkedRequests: 1,
      pendingCommands: 1,
      blocked: false,
    });
    expect(
      trace.find(
        ({ label }) => label === "ordinary-same-id-actually-processed-before-route-release",
      ).snapshot,
    ).toMatchObject({
      state: "ready",
      outstandingRequests: 2,
      parkedRequests: 1,
      pendingCommands: 1,
      blocked: false,
    });
    for (const label of [
      "first-id-parked-with-flowing-ingress",
      "ordinary-same-id-actually-processed-before-route-release",
    ]) {
      const snapshot = trace.find((row) => row.label === label).snapshot;
      expect(snapshot.outstandingRequests - snapshot.parkedRequests).toBe(1);
    }
    expect(
      trace.find(({ label }) => label === "blocker-response-held-by-real-writable-callback")
        .snapshot,
    ).toMatchObject({
      parkedRequests: 1,
      outstandingRequests: 2,
      responseItems: 2,
      transportBytes: 713,
    });
    expect(
      trace.find(({ label }) => label === "parked-admission-and-physical-original-response-settled")
        .snapshot,
    ).toMatchObject({
      parkedRequests: 0,
      outstandingRequests: 0,
      responseItems: 0,
      transportBytes: 0,
    });
    expect(replies.filter((reply) => reply.requestId === parked.requestId)).toEqual([
      {
        type: "error",
        worker,
        run,
        requestId: duplicate.requestId,
        commandType: duplicate.type,
        error: domainError("OPERATION_ID_CONFLICT"),
      },
      {
        type: "result",
        worker,
        run,
        requestId: parked.requestId,
        commandType: parked.type,
        outcome: "accepted",
      },
    ]);
    expect(writeReturns.every(Boolean)).toBe(true);
    const legalPeak = Math.max(
      ...trace
        .filter(({ snapshot }) => snapshot)
        .map(
          ({ snapshot }) =>
            snapshot.pendingCommands * (HEADER_BYTES + MAX_METADATA_BYTES) +
            snapshot.queuedBytes +
            snapshot.transportBytes,
        ),
    );
    expect(h.pipe.snapshot().peakAccountedBytes).toBeLessThanOrEqual(legalPeak);
    expect(h.pipe.snapshot().peakAccountedBytes).toBe(12_336);
    expect(h.pipe.snapshot()).toMatchObject({
      state: "ready",
      outstandingRequests: 0,
      parkedRequests: 0,
      pendingCommands: 0,
      responseItems: 0,
      queuedBytes: 0,
      transportBytes: 0,
      ordinaryAccountedBytes: 0,
      ingressBytes: 0,
      blocked: false,
    });
  } finally {
    blockerGate.resolve();
    duplicateGate.resolve();
    probeGate.resolve();
    const closed = await h.pipe.shutdown("parked-id-author-cleanup");
    trace.push({ label: "real-shutdown-receipt", closed });
    output.destroy();
    h.input.destroy();
    await drain();
    record("physical-close-finally-cleanup");
    const dir = new URL("../../../.cache/author-parked-request-id-r2/", import.meta.url);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL("receipts.json", dir), JSON.stringify(trace, null, 2) + "\n");
  }
  expect(h.pipe.snapshot()).toMatchObject({
    state: "closed",
    outstandingRequests: 0,
    parkedRequests: 0,
    responseItems: 0,
    queuedBytes: 0,
    transportBytes: 0,
    ordinaryAccountedBytes: 0,
    ingressBytes: 0,
    blocked: false,
  });
});
