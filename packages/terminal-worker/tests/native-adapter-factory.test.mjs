import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createTerminalModel } from "@cove/terminal-engine";
import { M0_LIMITS } from "@cove/protocol/budgets";
import {
  composeSpawnPayload,
  encodePipeFrame,
  PipeErrorSchema,
  PipeResultSchema,
  validatePipeResultForCommand,
} from "@cove/protocol/pipe";
import { validateBaselineTransfer } from "@cove/protocol/terminal";
import { DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { createWorkerExecution } from "@cove/terminal-worker/execution";
import { expect, test, vi } from "vitest";

const nodePty = createRequire(import.meta.url)("node-pty");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadFactoryModule() {
  const publicEntry = import.meta.resolve("@cove/terminal-worker/native-adapter");
  return import(publicEntry + "?factory-test=" + crypto.randomUUID());
}

function limits(overrides = {}) {
  return {
    maxOwners: 1,
    aggregateInputBytes: 16,
    aggregateInputTasks: 2,
    perPtyInputBytes: 16,
    perPtyInputTasks: 2,
    earlyOutputBytes: 16,
    ...overrides,
  };
}

function spec(overrides = {}) {
  return {
    file: process.execPath,
    args: ["fixture"],
    cwd: process.cwd(),
    env: {},
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

function observer() {
  return { onData: vi.fn(), onExit: vi.fn(), onFault: vi.fn() };
}

function fakePty(options = {}) {
  const writer = deferred();
  let dataListener;
  let exitListener;
  const terminal = {
    pid: 41,
    onData(listener) {
      dataListener = listener;
      options.onInstallData?.(listener);
      return { dispose: vi.fn() };
    },
    onExit(listener) {
      exitListener = listener;
      options.onInstallExit?.(listener);
      return { dispose: vi.fn() };
    },
    writeBounded: options.writeBounded ?? (() => ({ accepted: false, reason: "closed" })),
    disposeBoundedWrite: vi.fn(() => true),
    boundedWriteCompletion: writer.promise,
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    signalOwned: vi.fn(() => ({ kind: "signaled" })),
  };
  return {
    terminal,
    writer,
    data: (bytes) => dataListener(bytes),
    exit: (value = { exitCode: 0, signal: 0 }) => exitListener(value),
  };
}

async function withPublicSeam(run) {
  const originalPreflight = nodePty.checkBoundedPtySupport;
  const originalSpawn = nodePty.spawn;
  try {
    await run({
      preflight(value) {
        nodePty.checkBoundedPtySupport = vi.fn(() => value);
      },
      spawn(implementation) {
        nodePty.spawn = vi.fn(implementation);
      },
    });
  } finally {
    nodePty.checkBoundedPtySupport = originalPreflight;
    nodePty.spawn = originalSpawn;
  }
}

function recordFactoryFixture(phase, value) {
  const dir = process.env.COVE_N2_FACTORY_QA_OUTPUT;
  if (!dir) return;
  appendFileSync(
    join(dir, "native-factory-receipts.jsonl"),
    JSON.stringify({ phase, ...value }, (_key, item) =>
      typeof item === "function" ? { kind: "actual-function" } : item,
    ) + "\n",
  );
}

function workerCommands(factory) {
  const worker = {
    serverId: "server",
    relayInstanceId: "relay",
    workerId: "worker",
    workerIncarnationId: "one",
  };
  const run = { serverId: "server", relayInstanceId: "relay", runId: "run" };
  const geometry = { cols: 12, rows: 4 };
  const holder = {
    connection: { connectionId: "connection", generation: 1 },
    viewId: "view",
    subscriptionId: "sub",
  };
  const deliveries = [];
  const delivery = {
    enqueue(event, payload, token) {
      const encoded = encodePipeFrame(3, new TextEncoder().encode(JSON.stringify(event)), payload);
      const entry = {
        event: structuredClone(event),
        payload: Uint8Array.from(payload),
        token,
        payloadHex: Buffer.from(payload).toString("hex"),
        payloadSHA256: createHash("sha256").update(payload).digest("hex"),
        encodedHex: encoded.ok ? Buffer.from(encoded.value).toString("hex") : undefined,
        encodedBytes: encoded.ok ? encoded.value.length : undefined,
      };
      recordFactoryFixture("actual-delivery-before-guard", entry);
      expect(encoded.ok).toBe(true);
      deliveries.push(entry);
      return encoded.value.length;
    },
    cancelUnsent(token) {
      recordFactoryFixture("actual-cancel-unsent", { token });
    },
  };
  const execution = createWorkerExecution({
    worker,
    effectiveBudgets: M0_LIMITS,
    factory,
    delivery,
  });
  const capture = (phase, value = {}) =>
    recordFactoryFixture(phase, {
      ...value,
      worker: execution.snapshot(),
      factory: factory.snapshot(),
      deliveries,
    });
  let ordinal = 0;
  const command = (type, fields = {}) => ({
    type,
    worker,
    run,
    requestId: `${type}-${++ordinal}`,
    ...fields,
  });
  const payload = composeSpawnPayload(
    { executable: process.execPath, argv: [], cwd: process.cwd() },
    (text) => new TextEncoder().encode(text),
  ).bytes;
  const spawn = command("spawn", {
    operationId: "spawn",
    geometry,
    profile: PROFILE,
    appearance: DEFAULT_APPEARANCE,
    effectiveBudgets: M0_LIMITS,
    spawnPayloadBytes: payload.length,
  });
  const assertResult = (request, result) => {
    expect(
      (result.type === "result" ? PipeResultSchema : PipeErrorSchema).safeParse(result).success,
    ).toBe(true);
    expect(validatePipeResultForCommand(request, result)).toBe(true);
  };
  const subscription = { run, ...holder };
  const completed = async (request) => {
    capture("installation-command-before", { request });
    const result = await execution.execute(request);
    capture("installation-result-before-assert", { request, result });
    assertResult(request, result);
    expect(result).toMatchObject({ type: "result", outcome: "accepted", atSeq: 0 });
    capture("installation-marker-before", { request, result });
    execution.markerEnqueued(request, result);
    capture("installation-response-settled-before", { requestId: request.requestId });
    execution.responseSettled(request.requestId);
    return result;
  };
  const install = async () => {
    const subscribe = command("subscribe", { subscription, atSeq: 0 });
    const marker = await completed(subscribe);
    expect(marker.recoveryMode).toBe("baseline");
    let parsedOrdinal = -1;
    let transfer;
    for (let turn = 0; turn < 64; turn++) {
      const own = deliveries.filter((item) => {
        const ref = item.event.subscription;
        return (
          ref?.run.serverId === run.serverId &&
          ref.run.relayInstanceId === run.relayInstanceId &&
          ref.run.runId === run.runId &&
          ref.connection.connectionId === holder.connection.connectionId &&
          ref.connection.generation === holder.connection.generation &&
          ref.viewId === holder.viewId &&
          ref.subscriptionId === holder.subscriptionId
        );
      });
      const start = own.find((item) => item.event.terminal.type === "baseline-start");
      const baselineId = start?.event.terminal.descriptor.baselineId;
      const chunks = own.filter(
        (item) =>
          item.event.terminal.type === "baseline-chunk" &&
          item.event.terminal.baselineId === baselineId,
      );
      for (const chunk of chunks) {
        if (chunk.event.terminal.ordinal <= parsedOrdinal) continue;
        await completed(
          command("baseline-progress", {
            subscription,
            baselineId,
            lastParsedOrdinal: chunk.event.terminal.ordinal,
          }),
        );
        parsedOrdinal = chunk.event.terminal.ordinal;
      }
      const end = own.find(
        (item) =>
          item.event.terminal.type === "baseline-end" &&
          item.event.terminal.baselineId === baselineId,
      );
      if (start && end) {
        transfer = { start, chunks, end };
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    capture("installation-complete-baseline-before-assert", { subscribe, marker, transfer });
    expect(transfer, "NOT_EXERCISED: actual current baseline complete transfer").toBeDefined();
    const { start, chunks, end } = transfer;
    expect(
      validateBaselineTransfer(
        start.event.terminal.descriptor,
        chunks.map((item) => ({ metadata: item.event.terminal, payload: item.payload })),
        end.event.terminal,
      ),
    ).toBe(true);
    await completed(command("applied-ack", { subscription, appliedSeq: marker.atSeq }));
    capture("installation-current-ack-before-assert", { subscription, marker });
    expect(execution.snapshot().runs[0]).toMatchObject({ receivedSeq: 0, parsedSeq: 0, geometry });
    return marker;
  };
  return {
    execution,
    command,
    spawn,
    payload,
    geometry,
    holder,
    run,
    assertResult,
    install,
    capture,
  };
}

function workerFactoryLimits() {
  return limits({
    aggregateInputBytes: 64 * 1024,
    aggregateInputTasks: 256,
    perPtyInputBytes: 64 * 1024,
    perPtyInputTasks: 256,
    earlyOutputBytes: 1024 * 1024,
  });
}

test("preflight and pure validation reject without consuming owner capacity", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: false, reason: "binding-mismatch" });
    seam.spawn(() => {
      throw new Error("spawn should not run");
    });
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(limits());
    expect(factory.spawn(spec({ file: "" }), observer())).toEqual({
      kind: "rejected",
      reason: "invalid-spec",
    });
    expect(factory.spawn(spec(), observer())).toEqual({
      kind: "rejected",
      reason: "binding-mismatch",
    });
    expect(nodePty.spawn).not.toHaveBeenCalled();
    expect(factory.snapshot()).toMatchObject({ owners: 0, peakOwners: 0 });
  });

  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: false, reason: "invented-reason" });
    seam.spawn(() => {
      throw new Error("spawn should not run");
    });
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(limits());
    expect(factory.spawn(spec(), observer())).toEqual({
      kind: "rejected",
      reason: "preflight-failed",
    });
    expect(factory.snapshot()).toMatchObject({ owners: 0, peakOwners: 0 });
  });
});

test("marker two is refused before reservation and a missing post-entry signal method tombstones", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 2 });
    seam.spawn(() => {
      throw new Error("native spawn must not run");
    });
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(limits());
    expect(factory.spawn(spec(), observer())).toEqual({
      kind: "rejected",
      reason: "binding-mismatch",
    });
    expect(nodePty.spawn).not.toHaveBeenCalled();
    expect(factory.snapshot()).toMatchObject({ owners: 0, peakOwners: 0 });
  });
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const first = fakePty();
    delete first.terminal.signalOwned;
    seam.spawn(() => first.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(limits());
    expect(factory.spawn(spec(), observer()).kind).toBe("unclassified-failure");
    expect(first.terminal.disposeBoundedWrite).toHaveBeenCalledOnce();
    expect(factory.snapshot()).toMatchObject({ owners: 1, tombstones: 1 });
  });
});

test("spawn snapshots caller-owned spec and observer before native entry", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const first = fakePty({
      onInstallData(listener) {
        listener(Buffer.from("A"));
      },
    });
    const mutableSpec = spec({ args: ["original"], env: { MODE: "original" } });
    const originalData = vi.fn();
    const changedData = vi.fn();
    const mutableObserver = { onData: originalData, onExit: vi.fn(), onFault: vi.fn() };
    seam.spawn((_file, args, options) => {
      mutableSpec.args[0] = "changed";
      mutableSpec.env.MODE = "changed";
      mutableObserver.onData = changedData;
      expect(args).toEqual(["original"]);
      expect(options.env).toEqual({ MODE: "original" });
      return first.terminal;
    });
    const { createNativePtyFactory } = await loadFactoryModule();
    const result = createNativePtyFactory(limits()).spawn(mutableSpec, mutableObserver);
    expect(result.kind).toBe("created");
    expect(originalData).toHaveBeenCalledWith(Buffer.from("A"));
    expect(changedData).not.toHaveBeenCalled();
  });
});

test("typed cleanup pending holds one owner and confirmed clean releases it once", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const cleanup = deferred();
    const cause = new Error("synthetic spawn failure");
    seam.spawn(() => {
      throw new nodePty.BoundedPtySpawnError(cause, cleanup.promise);
    });
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(limits());
    const failure = factory.spawn(spec(), observer());
    expect(failure).toMatchObject({ kind: "failed", cause });
    expect(failure.cleanup).toBe(cleanup.promise);
    expect(factory.snapshot()).toMatchObject({ owners: 1, rollbackPendingOwners: 1 });
    expect(factory.spawn(spec(), observer())).toEqual({ kind: "rejected", reason: "owner-limit" });
    cleanup.resolve({ kind: "confirmed-clean" });
    await cleanup.promise;
    await Promise.resolve();
    expect(factory.snapshot()).toMatchObject({ owners: 0, rollbackPendingOwners: 0 });

    const next = fakePty();
    seam.spawn(() => next.terminal);
    expect(factory.spawn(spec(), observer()).kind).toBe("created");
    cleanup.resolve({ kind: "cleanup-uncertain", reason: "timeout" });
    await Promise.resolve();
    expect(factory.snapshot()).toMatchObject({ owners: 1, activeOwners: 1, tombstones: 0 });
  });
});

test("uncertain, invalid, rejecting, and unclassified failed spawns retain bounded tombstones", async () => {
  for (const variant of ["uncertain", "invalid", "reject", "unclassified"]) {
    await withPublicSeam(async (seam) => {
      seam.preflight({ supported: true, contractVersion: 3 });
      let cleanup;
      if (variant === "unclassified")
        seam.spawn(() => {
          throw new Error("plain");
        });
      else {
        cleanup = deferred();
        seam.spawn(() => {
          throw new nodePty.BoundedPtySpawnError(new Error(variant), cleanup.promise);
        });
      }
      const { createNativePtyFactory } = await loadFactoryModule();
      const factory = createNativePtyFactory(limits());
      const result = factory.spawn(spec(), observer());
      expect(["failed", "unclassified-failure"]).toContain(result.kind);
      if (variant === "uncertain") {
        cleanup.resolve({ kind: "cleanup-uncertain", reason: "timeout" });
      } else if (variant === "invalid") {
        cleanup.resolve(
          Object.defineProperty({}, "kind", {
            get() {
              throw new Error("getter");
            },
          }),
        );
      } else if (variant === "reject") cleanup.reject(new Error("contract violation"));
      await Promise.resolve();
      await Promise.resolve();
      expect(factory.snapshot()).toMatchObject({ owners: 1, tombstones: 1 });
      expect(factory.spawn(spec(), observer())).toEqual({
        kind: "rejected",
        reason: "owner-limit",
      });
    });
  }
});

test("successful owner releases only after writer close and child exit in either order", async () => {
  for (const order of ["writer-first", "exit-first"]) {
    await withPublicSeam(async (seam) => {
      seam.preflight({ supported: true, contractVersion: 3 });
      const first = fakePty();
      const second = fakePty();
      let calls = 0;
      seam.spawn(() => (calls++ === 0 ? first.terminal : second.terminal));
      const { createNativePtyFactory } = await loadFactoryModule();
      const factory = createNativePtyFactory(limits());
      expect(factory.spawn(spec(), observer()).kind).toBe("created");
      if (order === "writer-first") first.writer.resolve({ kind: "closed" });
      else first.exit();
      await Promise.resolve();
      expect(factory.snapshot()).toMatchObject({ owners: 1, activeOwners: 1 });
      expect(factory.spawn(spec(), observer())).toEqual({
        kind: "rejected",
        reason: "owner-limit",
      });
      if (order === "writer-first") first.exit();
      else first.writer.resolve({ kind: "closed" });
      await vi.waitFor(
        () => expect(factory.snapshot()).toMatchObject({ owners: 0, activeOwners: 0 }),
        { timeout: 300 },
      );
      expect(factory.spawn(spec(), observer()).kind).toBe("created");
    });
  }
});

test("close uncertainty stays charged after child exit and invalid public shape is tombstoned", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const first = fakePty();
    seam.spawn(() => first.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(limits());
    expect(factory.spawn(spec(), observer()).kind).toBe("created");
    first.writer.resolve({ kind: "close-uncertain", error: "EINTR" });
    first.exit();
    await vi.waitFor(
      () => expect(factory.snapshot()).toMatchObject({ owners: 1, tombstones: 1, activeOwners: 0 }),
      { timeout: 300 },
    );
  });

  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const invalid = fakePty();
    delete invalid.terminal.writeBounded;
    seam.spawn(() => invalid.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(limits());
    expect(factory.spawn(spec(), observer()).kind).toBe("unclassified-failure");
    expect(invalid.terminal.disposeBoundedWrite).toHaveBeenCalledOnce();
    expect(invalid.terminal.signalOwned).toHaveBeenCalledWith("SIGHUP", "leader");
    expect(factory.snapshot()).toMatchObject({ owners: 1, tombstones: 1 });
  });
});

test("early raw data is delivered before exit and bounded overflow faults without dropping old bytes", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const events = [];
    const first = fakePty({
      onInstallData(listener) {
        listener(Buffer.from([0x00, 0x80, 0xff]));
      },
      onInstallExit(listener) {
        listener({ exitCode: 23, signal: 0 });
      },
    });
    seam.spawn(() => first.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(limits({ earlyOutputBytes: 3 }));
    const result = factory.spawn(spec(), {
      onData(bytes) {
        events.push(["data", bytes.toString("hex")]);
      },
      onExit(exit) {
        events.push(["exit", exit.exitCode]);
      },
      onFault(fault) {
        events.push(["fault", fault.reason]);
      },
    });
    expect(result.kind).toBe("created");
    expect(events).toEqual([
      ["data", "0080ff"],
      ["exit", 23],
    ]);
  });

  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const first = fakePty({
      onInstallData(listener) {
        listener(Buffer.from("12"));
        listener(Buffer.from("34"));
      },
    });
    seam.spawn(() => first.terminal);
    const faults = [];
    const { createNativePtyFactory } = await loadFactoryModule();
    const result = createNativePtyFactory(limits({ earlyOutputBytes: 3 })).spawn(spec(), {
      onData(bytes) {
        faults.push({ kind: "delivered", bytes: bytes.toString() });
      },
      onExit() {},
      onFault(fault) {
        faults.push(fault);
      },
    });
    expect(result.kind).toBe("created");
    expect(faults).toMatchObject([
      { kind: "output", reason: "early-output-limit" },
      { kind: "delivered", bytes: "12" },
    ]);
    expect(first.terminal.pause).toHaveBeenCalledOnce();
    expect(first.terminal.disposeBoundedWrite).toHaveBeenCalledOnce();
  });
});

test("stop uses owned group and leader signals and settles only from observed exit", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const first = fakePty();
    seam.spawn(() => first.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const result = createNativePtyFactory(limits()).spawn(spec(), observer());
    expect(result.kind).toBe("created");
    const stop = result.pty.stop();
    expect(result.pty.stop()).toBe(stop);
    expect(first.terminal.signalOwned).toHaveBeenCalledTimes(2);
    expect(first.terminal.signalOwned).toHaveBeenNthCalledWith(
      1,
      "SIGHUP",
      "initial-process-group",
    );
    expect(first.terminal.signalOwned).toHaveBeenNthCalledWith(2, "SIGHUP", "leader");
    let settled = false;
    stop.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    first.exit({ exitCode: 0, signal: 1 });
    await expect(stop).resolves.toMatchObject({
      kind: "exited",
      exit: { exitCode: 0, signal: 1 },
      cleanup: { scope: "initial-process-group", verified: false, graceful: { kind: "signaled" } },
    });
  });
});

test("compiled N2 caches only bounded signal failure fields from a hostile public result", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const native = fakePty();
    const retainedGraph = {
      payload: Buffer.alloc(200_000),
      nested: { payload: Buffer.alloc(200_000) },
    };
    native.terminal.signalOwned = vi.fn(() => ({
      kind: "unverifiable",
      reason: "signal-failed",
      errorCode: "E".repeat(200_000),
      retainedGraph,
    }));
    seam.spawn(() => native.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(limits());
    const created = factory.spawn(spec(), observer());
    expect(created.kind).toBe("created");
    const stop = created.pty.stop();
    expect(factory.snapshot().owners).toBe(1);
    native.exit({ exitCode: 0 });
    const receipt = await stop;
    expect(receipt).toMatchObject({
      kind: "exited",
      cleanup: {
        graceful: { kind: "unverifiable", errorCode: "E".repeat(32) },
      },
      signalFailure: { phase: "graceful", cause: { category: "native-failure" } },
    });
    expect(JSON.stringify(receipt)).not.toContain("retainedGraph");
    expect(JSON.stringify(receipt).length).toBeLessThan(1024);
    expect(receipt.signalFailure.cause).not.toBe(retainedGraph);
    expect(factory.snapshot().owners).toBe(1);
    native.writer.resolve({ kind: "closed" });
    await vi.waitFor(() => expect(factory.snapshot().owners).toBe(0), { timeout: 300 });
  });
});

test("compiled N2 resize onFault fences W1 transaction without signaling a live leader", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const native = fakePty();
    const originalWriteBounded = native.terminal.writeBounded;
    native.terminal.writeBounded = vi.fn(function (...args) {
      return Reflect.apply(originalWriteBounded, this, args);
    });
    native.terminal.resize = vi.fn(() => {
      throw new Error("resize failed");
    });
    seam.spawn(() => native.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(workerFactoryLimits());
    const harness = workerCommands(factory);
    const { execution, command, assertResult, geometry, holder } = harness;
    try {
      const spawned = await execution.execute(harness.spawn, harness.payload);
      harness.capture("spawn-result-before-assert", { request: harness.spawn, result: spawned });
      assertResult(harness.spawn, spawned);
      expect(spawned.type).toBe("result");
      await harness.install();
      const resize = command("set-control", {
        expectedEpoch: 0,
        nextEpoch: 1,
        holder,
        geometry: { cols: 14, rows: 4 },
      });
      harness.capture("resize-before", { request: resize });
      const failed = await execution.execute(resize);
      harness.capture("resize-result-before-assert", {
        request: resize,
        result: failed,
        nativeResizeCalls: native.terminal.resize.mock.calls,
        nativeSignals: native.terminal.signalOwned.mock.calls,
      });
      assertResult(resize, failed);
      expect(failed).toMatchObject({ type: "error", error: { kind: "RESULT_UNKNOWN" } });
      expect(native.terminal.resize).toHaveBeenCalledOnce();
      expect(native.terminal.signalOwned).not.toHaveBeenCalled();
      native.data(Buffer.from("A"));
      const status = command("status");
      const observed = await execution.execute(status);
      harness.capture("status-result-before-assert", { request: status, result: observed });
      assertResult(status, observed);
      expect(observed.runStatus).toMatchObject({
        status: "live",
        controlEpoch: 0,
        controlHolder: null,
        geometry,
        receivedSeq: 1,
        parsedSeq: 1,
      });
      const stop = command("stop", { operationId: "stop" });
      const pendingStop = execution.execute(stop);
      native.exit({ exitCode: 0 });
      native.writer.resolve({ kind: "closed" });
      const stopped = await pendingStop;
      harness.capture("stop-result-before-assert", { request: stop, result: stopped });
      assertResult(stop, stopped);
      expect(stopped.type).toBe("result");
      expect(factory.snapshot().owners).toBe(0);
    } catch (error) {
      harness.capture("first-body-failure", {
        error: { name: error.name, message: error.message, stack: error.stack },
      });
      throw error;
    } finally {
      try {
        harness.capture("finally-before", {
          nativeWriteCalls: native.terminal.writeBounded.mock.calls,
          nativeResizeCalls: native.terminal.resize.mock.calls,
          nativeSignals: native.terminal.signalOwned.mock.calls,
        });
      } finally {
        native.writer.resolve({ kind: "closed" });
        native.exit({ exitCode: 0 });
        const shutdown = await execution.shutdown("test");
        harness.capture("finally-after", {
          shutdown,
          nativeWriteCalls: native.terminal.writeBounded.mock.calls,
          nativeResizeCalls: native.terminal.resize.mock.calls,
          nativeSignals: native.terminal.signalOwned.mock.calls,
        });
      }
    }
  });
});

test("compiled N2 partial write faults before settlement but leaves output and explicit stop available", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const native = fakePty();
    let settle;
    native.terminal.writeBounded = vi.fn((bytes, callback) => {
      settle = callback;
      return { accepted: true, ticket: 7, byteLength: bytes.length };
    });
    seam.spawn(() => native.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(workerFactoryLimits());
    const harness = workerCommands(factory);
    const { execution, command, assertResult, geometry, holder, run } = harness;
    try {
      const spawned = await execution.execute(harness.spawn, harness.payload);
      harness.capture("spawn-result-before-assert", { request: harness.spawn, result: spawned });
      assertResult(harness.spawn, spawned);
      expect(spawned.type).toBe("result");
      await harness.install();
      const control = command("set-control", { expectedEpoch: 0, nextEpoch: 1, holder, geometry });
      const controlResult = await execution.execute(control);
      harness.capture("control-result-before-assert", {
        request: control,
        result: controlResult,
        nativeResizeCalls: native.terminal.resize.mock.calls,
      });
      assertResult(control, controlResult);
      expect(controlResult).toMatchObject({ type: "result", outcome: "accepted", atSeq: 1 });
      expect(execution.snapshot().runs[0]).toMatchObject({
        controlEpoch: 1,
        controlHolder: holder,
        geometry,
      });
      expect(native.terminal.resize).not.toHaveBeenCalled();
      const input = command("input", { subscription: { run, ...holder }, epoch: 1, inputSeq: 1 });
      harness.capture("input-before", {
        request: input,
        payloadHex: "4142",
        payloadSHA256: createHash("sha256").update("AB").digest("hex"),
      });
      const pending = execution.execute(input, Buffer.from("AB"));
      pending.then(
        (result) => harness.capture("input-real-result", { request: input, result }),
        (error) =>
          harness.capture("input-real-throw", {
            request: input,
            error: { name: error.name, message: error.message, stack: error.stack },
          }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      harness.capture("input-callback-before-assert", {
        request: input,
        callbackPresent: typeof settle,
        nativeWriteCalls: native.terminal.writeBounded.mock.calls,
        nativeSignals: native.terminal.signalOwned.mock.calls,
      });
      expect(typeof settle).toBe("function");
      harness.capture("partial-settlement-before", {
        ticket: 7,
        status: "error",
        originalBytes: 2,
        writtenBytes: 1,
        remainingBytes: 1,
        errorCode: "EIO",
      });
      settle({
        ticket: 7,
        status: "error",
        originalBytes: 2,
        writtenBytes: 1,
        remainingBytes: 1,
        errorCode: "EIO",
      });
      const failed = await pending;
      harness.capture("input-result-before-assert", { request: input, result: failed });
      assertResult(input, failed);
      expect(failed).toMatchObject({ type: "error", error: { kind: "RESULT_UNKNOWN" } });
      expect(native.terminal.writeBounded).toHaveBeenCalledOnce();
      expect(native.terminal.signalOwned).not.toHaveBeenCalled();
      native.data(Buffer.from("B"));
      const status = command("status");
      const observed = await execution.execute(status);
      harness.capture("status-result-before-assert", { request: status, result: observed });
      assertResult(status, observed);
      expect(observed.runStatus).toMatchObject({
        status: "live",
        receivedSeq: 2,
        parsedSeq: 2,
        controlEpoch: 1,
      });
      const stop = command("stop", { operationId: "stop" });
      const pendingStop = execution.execute(stop);
      native.exit({ exitCode: 0 });
      native.writer.resolve({ kind: "closed" });
      const stopped = await pendingStop;
      harness.capture("stop-result-before-assert", { request: stop, result: stopped });
      assertResult(stop, stopped);
      expect(stopped.type).toBe("result");
      expect(factory.snapshot().owners).toBe(0);
    } catch (error) {
      harness.capture("first-body-failure", {
        error: { name: error.name, message: error.message, stack: error.stack },
      });
      throw error;
    } finally {
      try {
        harness.capture("finally-before", {
          nativeWriteCalls: native.terminal.writeBounded.mock.calls,
          nativeResizeCalls: native.terminal.resize.mock.calls,
          nativeSignals: native.terminal.signalOwned.mock.calls,
        });
      } finally {
        native.writer.resolve({ kind: "closed" });
        native.exit({ exitCode: 0 });
        const shutdown = await execution.shutdown("test");
        harness.capture("finally-after", {
          shutdown,
          nativeWriteCalls: native.terminal.writeBounded.mock.calls,
          nativeResizeCalls: native.terminal.resize.mock.calls,
          nativeSignals: native.terminal.signalOwned.mock.calls,
        });
      }
    }
  });
});

test("compiled adapter forwards bounded synchronous native settlement diagnostics", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const source = {
      ticket: 81,
      status: "error",
      originalBytes: 2,
      writtenBytes: 1,
      remainingBytes: 1,
      errorCode: "E".repeat(200_000),
      errorMessage: "😀".repeat(100_000),
      retainedGraph: { bytes: Buffer.alloc(200_000) },
    };
    const native = fakePty({
      writeBounded: vi.fn((bytes, callback) => {
        callback(source);
        source.errorCode = "CHANGED";
        source.errorMessage = "CHANGED";
        return { accepted: true, ticket: 81, byteLength: bytes.length };
      }),
    });
    seam.spawn(() => native.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(limits());
    const created = factory.spawn(spec(), observer());
    expect(created.kind).toBe("created");
    try {
      const settlements = [];
      expect(created.pty.submit(Buffer.from("AB"), (value) => settlements.push(value)).kind).toBe(
        "accepted",
      );
      expect(settlements).toEqual([
        {
          kind: "unknown",
          ticket: 81,
          status: "error",
          originalBytes: 2,
          writtenBytes: 1,
          remainingBytes: 1,
          errorCode: "E".repeat(32),
          errorMessage: "😀".repeat(32),
        },
      ]);
      expect(JSON.stringify(settlements)).not.toContain("retainedGraph");
      expect(native.terminal.writeBounded).toHaveBeenCalledOnce();
      expect(nodePty.spawn).toHaveBeenCalledOnce();
      expect(native.terminal.signalOwned).not.toHaveBeenCalled();
    } finally {
      const stopped = created.pty.stop();
      native.exit({ exitCode: 0 });
      native.writer.resolve({ kind: "closed" });
      await stopped;
      await new Promise((resolve) => setImmediate(resolve));
      expect(factory.snapshot().owners).toBe(0);
    }
  });
});

test("owned stop forces once at the grace boundary and reports unknown at the final deadline", async () => {
  vi.useFakeTimers();
  try {
    await withPublicSeam(async (seam) => {
      seam.preflight({ supported: true, contractVersion: 3 });
      const first = fakePty();
      seam.spawn(() => first.terminal);
      const { createNativePtyFactory } = await loadFactoryModule();
      const result = createNativePtyFactory(limits()).spawn(spec(), observer());
      expect(result.kind).toBe("created");
      const stop = result.pty.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(first.terminal.signalOwned).toHaveBeenCalledTimes(4);
      expect(first.terminal.signalOwned).toHaveBeenNthCalledWith(
        3,
        "SIGKILL",
        "initial-process-group",
      );
      expect(first.terminal.signalOwned).toHaveBeenNthCalledWith(4, "SIGKILL", "leader");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(stop).resolves.toMatchObject({
        kind: "unverifiable",
        cleanup: { verified: false, force: { kind: "signaled" } },
      });
      expect(result.pty.stop()).toBe(stop);
      expect(first.terminal.signalOwned).toHaveBeenCalledTimes(4);
      expect(result.pty.snapshot().exited).toBe(false);
      expect(result.pty.pid).toBe(41);
    });
  } finally {
    vi.useRealTimers();
  }
});

test("group failure does not suppress leader stop and exit preserves first failure", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const first = fakePty();
    first.terminal.signalOwned = vi.fn((signal, scope) =>
      scope === "initial-process-group"
        ? { kind: "unverifiable", reason: "scope-unavailable" }
        : { kind: "signaled" },
    );
    seam.spawn(() => first.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const faults = [];
    const result = createNativePtyFactory(limits()).spawn(spec(), {
      onData() {},
      onExit() {},
      onFault(fault) {
        faults.push(fault);
      },
    });
    expect(result.kind).toBe("created");
    const stop = result.pty.stop();
    expect(first.terminal.signalOwned).toHaveBeenCalledWith("SIGHUP", "leader");
    first.exit({ exitCode: 0, signal: 1 });
    await expect(stop).resolves.toMatchObject({
      kind: "exited",
      cleanup: { graceful: { kind: "unverifiable", reason: "scope-unavailable" }, verified: false },
      signalFailure: { phase: "graceful" },
    });
    expect(faults).toMatchObject([{ kind: "io", reason: "owned-stop-failed" }]);
  });
});

test("already exited and late exit never trigger another owned signal", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const first = fakePty();
    seam.spawn(() => first.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const factory = createNativePtyFactory(limits());
    const result = factory.spawn(spec(), observer());
    expect(result.kind).toBe("created");
    first.exit();
    const stop = result.pty.stop();
    expect(result.pty.stop()).toBe(stop);
    await expect(stop).resolves.toMatchObject({
      kind: "exited",
      cleanup: { graceful: { kind: "not-attempted", reason: "already-exited" } },
    });
    expect(first.terminal.signalOwned).not.toHaveBeenCalled();
    first.writer.resolve({ kind: "closed" });
    await vi.waitFor(() => expect(factory.snapshot().owners).toBe(0), { timeout: 300 });
  });
});

test("late actual exit releases the original owner without rewriting a timed-out stop", async () => {
  vi.useFakeTimers();
  try {
    await withPublicSeam(async (seam) => {
      seam.preflight({ supported: true, contractVersion: 3 });
      const first = fakePty();
      seam.spawn(() => first.terminal);
      const { createNativePtyFactory } = await loadFactoryModule();
      const factory = createNativePtyFactory(limits());
      const result = factory.spawn(spec(), observer());
      expect(result.kind).toBe("created");
      const stop = result.pty.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      const settled = await stop;
      expect(settled.kind).toBe("unverifiable");
      first.writer.resolve({ kind: "closed" });
      await Promise.resolve();
      expect(factory.snapshot().owners).toBe(1);
      first.exit({ exitCode: 0, signal: 9 });
      await Promise.resolve();
      expect(factory.snapshot().owners).toBe(0);
      expect(await result.pty.stop()).toBe(settled);
      expect(first.terminal.signalOwned).toHaveBeenCalledTimes(4);
    });
  } finally {
    vi.useRealTimers();
  }
});

test("public signal reentry observes the already published stop promise", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const first = fakePty();
    let adapter;
    let reentered;
    first.terminal.signalOwned = vi.fn(() => {
      reentered = adapter.stop();
      return { kind: "signaled" };
    });
    seam.spawn(() => first.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const result = createNativePtyFactory(limits()).spawn(spec(), observer());
    expect(result.kind).toBe("created");
    adapter = result.pty;
    const stop = adapter.stop();
    expect(reentered).toBe(stop);
    expect(first.terminal.signalOwned).toHaveBeenCalledTimes(2);
    first.exit();
    await expect(stop).resolves.toMatchObject({ kind: "exited" });
  });
});

test("recorded native reap skips force while delayed JS exit remains unresolved", async () => {
  vi.useFakeTimers();
  try {
    await withPublicSeam(async (seam) => {
      seam.preflight({ supported: true, contractVersion: 3 });
      const first = fakePty();
      first.terminal.signalOwned = vi.fn(() => ({ kind: "already-reaped" }));
      seam.spawn(() => first.terminal);
      const { createNativePtyFactory } = await loadFactoryModule();
      const result = createNativePtyFactory(limits()).spawn(spec(), observer());
      expect(result.kind).toBe("created");
      const stop = result.pty.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(stop).resolves.toMatchObject({
        kind: "unverifiable",
        cleanup: { force: { kind: "not-attempted", reason: "already-reaped" } },
      });
      expect(first.terminal.signalOwned).toHaveBeenCalledTimes(2);
      first.exit();
      expect(result.pty.snapshot().exited).toBe(true);
    });
  } finally {
    vi.useRealTimers();
  }
});

test("resize, pause, and resume use only the owned public PTY handle", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const first = fakePty();
    seam.spawn(() => first.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const result = createNativePtyFactory(limits()).spawn(spec(), observer());
    expect(result.kind).toBe("created");
    result.pty.resize(120, 40);
    result.pty.pause();
    result.pty.pause();
    result.pty.resume();
    result.pty.resume();
    expect(first.terminal.resize).toHaveBeenCalledWith(120, 40);
    expect(first.terminal.pause).toHaveBeenCalledTimes(1);
    expect(first.terminal.resume).toHaveBeenCalledTimes(1);
    expect(() => result.pty.resize(121, 40)).toThrow(RangeError);
  });
});

test("user and automatic output share one writer FIFO and automatic rejection fences input", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const callbacks = [];
    const calls = [];
    let ticket = 1;
    const first = fakePty({
      writeBounded(bytes, callback) {
        calls.push(Buffer.from(bytes).toString("hex"));
        callbacks.push(callback);
        return { accepted: true, ticket: ticket++, byteLength: bytes.byteLength };
      },
    });
    seam.spawn(() => first.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const result = createNativePtyFactory(
      limits({ aggregateInputTasks: 3, perPtyInputTasks: 3 }),
    ).spawn(spec(), observer());
    expect(result.kind).toBe("created");
    expect(result.pty.submit(Buffer.from("A"), vi.fn()).kind).toBe("accepted");
    result.pty.automaticOutputSink({ atSeq: 1, kind: "query", bytes: Buffer.from("Q") });
    expect(result.pty.submit(Buffer.from("A"), vi.fn()).kind).toBe("accepted");
    expect(calls).toEqual(["41", "51", "41"]);
    callbacks[0]({
      ticket: 1,
      status: "written",
      originalBytes: 1,
      writtenBytes: 1,
      remainingBytes: 0,
    });
    callbacks[1]({
      ticket: 2,
      status: "written",
      originalBytes: 1,
      writtenBytes: 1,
      remainingBytes: 0,
    });
    callbacks[2]({
      ticket: 3,
      status: "written",
      originalBytes: 1,
      writtenBytes: 1,
      remainingBytes: 0,
    });
  });

  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const first = fakePty({
      writeBounded: vi.fn(() => ({ accepted: false, reason: "task-limit" })),
    });
    seam.spawn(() => first.terminal);
    const faults = [];
    const { createNativePtyFactory } = await loadFactoryModule();
    const result = createNativePtyFactory(limits()).spawn(spec(), {
      onData() {},
      onExit() {},
      onFault(fault) {
        faults.push(fault);
      },
    });
    expect(result.kind).toBe("created");
    result.pty.automaticOutputSink({ atSeq: 2, kind: "focus", bytes: Buffer.from("F") });
    expect(faults).toMatchObject([
      {
        kind: "automatic-output",
        reason: "rejected",
        admission: { kind: "rejected", reason: "native-task-limit" },
      },
    ]);
    expect(first.terminal.disposeBoundedWrite).toHaveBeenCalledOnce();
    expect(result.pty.submit(Buffer.from("B"), vi.fn())).toEqual({
      kind: "rejected",
      reason: "fenced",
      writtenBytes: 0,
    });
  });
});

test("compiled terminal model sends query and focus replies through the adapter sink", async () => {
  await withPublicSeam(async (seam) => {
    seam.preflight({ supported: true, contractVersion: 3 });
    const writes = [];
    let ticket = 1;
    const first = fakePty({
      writeBounded(bytes, callback) {
        const copy = Buffer.from(bytes);
        writes.push(copy);
        const currentTicket = ticket++;
        callback({
          ticket: currentTicket,
          status: "written",
          originalBytes: copy.byteLength,
          writtenBytes: copy.byteLength,
          remainingBytes: 0,
        });
        return { accepted: true, ticket: currentTicket, byteLength: copy.byteLength };
      },
    });
    seam.spawn(() => first.terminal);
    const { createNativePtyFactory } = await loadFactoryModule();
    const result = createNativePtyFactory(limits()).spawn(spec(), observer());
    expect(result.kind).toBe("created");
    const run = { serverId: "server", relayInstanceId: "relay", runId: "run" };
    const model = createTerminalModel({
      run,
      geometry: { cols: 12, rows: 4 },
      onAutomaticOutput: result.pty.automaticOutputSink.bind(result.pty),
    });
    try {
      const encoder = new TextEncoder();
      const query = model.apply({ type: "output", run, seq: 1 }, encoder.encode("\u001b[5n"));
      expect(await query).toMatchObject({ ok: true });
      expect(writes.map((bytes) => bytes.toString())).toEqual(["\u001b[0n"]);
      expect(
        await model.apply({ type: "output", run, seq: 2 }, encoder.encode("\u001b[?1004h")),
      ).toMatchObject({
        ok: true,
      });
      expect(
        await model.apply({
          type: "control",
          run,
          seq: 3,
          epoch: 3,
          holder: {
            connection: { connectionId: "connection", generation: 1 },
            viewId: "view",
            subscriptionId: "subscription",
          },
          geometry: { cols: 12, rows: 4 },
        }),
      ).toMatchObject({ ok: true });
      expect(writes.map((bytes) => bytes.toString())).toEqual(["\u001b[0n", "\u001b[I"]);
    } finally {
      model.dispose();
    }
  });
});
