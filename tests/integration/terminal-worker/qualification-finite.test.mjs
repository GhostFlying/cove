import { expect, test, afterAll } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { domainError } from "../../../packages/protocol/dist/errors.js";
import { encode, hello, installedBin, until } from "./pipe-harness.mjs";

const delivery = installedBin();
const publicFile = join(delivery.consumerRoot, "qualification-finite-public.mjs");
writeFileSync(
  publicFile,
  'export { createRunSession } from "@cove/terminal-worker/execution";\nexport { runWorkerPipe } from "@cove/terminal-worker/pipe";\n',
);
const { createRunSession, runWorkerPipe } = await import(pathToFileURL(publicFile).href);
afterAll(() => delivery.cleanup());
const preserveFinite = (name, value) => {
  const dir = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  if (dir) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
};

const tick = () => new Promise((resolve) => setImmediate(resolve));
const receipt = {
  stop: { kind: "observed", result: { kind: "exited" } },
  leader: { kind: "exit-observed" },
  writer: { kind: "closed" },
  ownershipEvidence: "closure-proven",
};

function fakeRun(onFact = () => {}, hooks = {}) {
  const state = { pauses: [], resumes: [], faults: [], emitted: 0, observer: null, native: null };
  let session;
  const pty = {
    pid: 71,
    writerCompletion: Promise.resolve({ kind: "closed" }),
    pause() {
      state.pauses.push(session?.snapshot() ?? null);
      hooks.onPause?.(state, session);
    },
    resume() {
      state.resumes.push(session?.snapshot() ?? null);
    },
    submit() {
      throw Error("unexpected native input");
    },
    automaticOutputSink() {},
    resize() {},
    retireInput() {},
    stop() {
      state.observer.onExit({ exitCode: 0 });
      return Promise.resolve({ kind: "exited", exit: { exitCode: 0 }, cleanup: {} });
    },
    snapshot() {
      return { pid: 71, exited: false, writer: "closed", input: { allocatedBytes: 0 } };
    },
  };
  state.native = pty;
  const created = createRunSession({
    run: { serverId: "finite", relayInstanceId: "local", runId: "item-pressure" },
    geometry: { cols: 80, rows: 24 },
    spawn: { file: "unused", args: [], cwd: "/", env: {} },
    factory: {
      spawn(_spec, observer) {
        state.observer = observer;
        hooks.onSpawn?.(observer);
        return { kind: "created", pty };
      },
    },
    onFact: (fact) => {
      onFact(fact);
      if (fact.event.type === "output") state.emitted += fact.bytes.length;
    },
    onFault: (fault) => state.faults.push(fault),
  });
  expect(created.kind).toBe("created");
  session = created.session;
  return { state, session };
}

test("compiled public session pauses before 256 one-KiB items and resumes only after drain", async () => {
  const owned = fakeRun();
  const { state, session } = owned;
  let offered = 0;
  try {
    for (; offered < 768 && state.pauses.length === 0; offered++)
      state.observer.onData(Buffer.alloc(1024, 0x42));
    expect(offered).toBeGreaterThanOrEqual(192);
    expect(offered).toBeLessThan(256);
    expect(state.pauses[0].queuedItems).toBeGreaterThanOrEqual(192);
    expect(state.pauses[0].queuedBytes).toBeLessThan(524_288);
    while (offered < 768) {
      await until(() => state.resumes.length > state.pauses.length - 1, 8000, "item low resume");
      const count = state.pauses.length;
      for (; offered < 768 && state.pauses.length === count; offered++)
        state.observer.onData(Buffer.alloc(1024, 0x42));
    }
    expect((await session.barrier()).ok).toBe(true);
    expect(state.emitted).toBe(768 * 1024);
    expect(state.pauses.length).toBeGreaterThan(0);
    expect(state.resumes.length).toBeGreaterThan(0);
    expect(state.resumes.every((s) => s.queuedItems <= 64 && s.queuedBytes <= 131_072)).toBe(true);
    expect(state.faults).toEqual([]);
  } finally {
    preserveFinite("fake-item-pressure", {
      offered,
      emitted: state.emitted,
      pauses: state.pauses,
      resumes: state.resumes,
      faults: state.faults,
      final: session.snapshot(),
    });
    await session.dispose();
  }
});

test("compiled public session retains the hard cap when a producer ignores pause", async () => {
  const { state, session } = fakeRun();
  try {
    for (let index = 0; index < 257; index++) state.observer.onData(Buffer.alloc(1024, 0x42));
    expect(state.pauses.length).toBeGreaterThan(0);
    expect(state.faults.length).toBeGreaterThan(0);
    expect(session.snapshot().faulted).toBe(true);
    expect(session.snapshot().queuedItems).toBeLessThanOrEqual(256);
  } finally {
    await session.dispose();
  }
});

test("early ingress pauses on attachment", async () => {
  const early = fakeRun(undefined, {
    onSpawn(observer) {
      for (let index = 0; index < 192; index++) observer.onData(Buffer.alloc(1024, 0x42));
    },
  });
  try {
    expect(early.state.pauses.length).toBeGreaterThan(0);
    expect(early.state.faults).toEqual([]);
    expect(early.session.snapshot().paused).toBe(true);
  } finally {
    await early.session.dispose();
  }
});

test("reentrant pause callback disposal cannot resume a retired owner", async () => {
  const owned = fakeRun(undefined, {
    onPause(state, session) {
      state.observer.onData(Buffer.alloc(1024, 0x42));
      void session.dispose();
    },
  });
  for (let index = 0; index < 192; index++) owned.state.observer.onData(Buffer.alloc(1024, 0x42));
  await owned.session.dispose();
  expect(owned.state.pauses).toHaveLength(1);
  expect(owned.state.resumes).toHaveLength(0);
  expect(owned.state.faults).toEqual([]);
});

test("compiled public pipe owns callback EPIPE and subsequent asynchronous error through one close", async () => {
  const callbacks = [];
  const events = [];
  const shutdowns = [];
  const disposal = Promise.withResolvers();
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  const emit = output.emit;
  output.emit = function (name, ...args) {
    if (name === "error" || name === "close") events.push(name);
    return emit.call(this, name, ...args);
  };
  const input = new PassThrough();
  const pipe = runWorkerPipe(input, output, {
    buildVersion: "independent-finite",
    createExecution: () => ({
      execute: async (command) => ({
        type: "error",
        worker: command.worker,
        run: command.run,
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
  input.write(encode(hello));
  expect(callbacks).toHaveLength(1);
  callbacks.shift()();
  await tick();
  input.write(
    encode({
      type: "preview-refresh",
      worker: hello.worker,
      run: {
        serverId: hello.worker.serverId,
        relayInstanceId: hello.worker.relayInstanceId,
        runId: "r",
      },
      requestId: "uncertain-reply",
    }),
  );
  await until(() => callbacks.length === 1, 8000, "reply write callback");
  callbacks.shift()(Object.assign(Error("broken pipe"), { code: "EPIPE" }));
  await tick();
  expect(events).toEqual(["error", "close"]);
  expect(output.closed).toBe(true);
  expect(shutdowns).toEqual(["stdout-write-failed"]);
  expect(pipe.shutdown("late-close")).toBe(pipe.closed);
  disposal.resolve();
  expect(await pipe.closed).toMatchObject({
    reason: "stdout-write-failed",
    uncertainRequestIds: ["uncertain-reply"],
    disposalReceipts: [receipt],
    disposalUnverifiable: false,
  });
  const afterClose = pipe.snapshot();
  preserveFinite("fake-callback-epipe", {
    events,
    shutdowns,
    closed: await pipe.closed,
    afterClose,
  });
  expect(afterClose).toMatchObject({
    state: "closed",
    responseItems: 0,
    transportBytes: 0,
    ordinaryAccountedBytes: 0,
    blocked: false,
  });
});

test("logical shutdown retains handed-off bytes until the Writable physically closes", async () => {
  const callbacks = [];
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  const input = new PassThrough();
  const pipe = runWorkerPipe(input, output, {
    buildVersion: "independent-held-open",
    createExecution: () => ({
      execute: async (request) => ({
        type: "error",
        worker: request.worker,
        run: request.run,
        requestId: request.requestId,
        commandType: request.type,
        error: domainError("CAPABILITY_UNAVAILABLE"),
      }),
      snapshot: () => ({}),
      shutdown: async () => [receipt],
    }),
  });
  try {
    input.write(encode(hello));
    expect(callbacks).toHaveLength(1);
    callbacks.shift()();
    await tick();
    input.write(
      encode({
        type: "preview-refresh",
        worker: hello.worker,
        run: {
          serverId: hello.worker.serverId,
          relayInstanceId: hello.worker.relayInstanceId,
          runId: "r",
        },
        requestId: "held-open-reply",
      }),
    );
    await until(() => callbacks.length === 1, 8000, "held transport callback");
    const handedOff = pipe.snapshot();
    expect(handedOff.responseItems).toBe(1);
    expect(handedOff.transportBytes).toBeGreaterThan(0);
    const closed = await pipe.shutdown("finite-held-open");
    const beforePhysicalClose = pipe.snapshot();
    preserveFinite("fake-held-open-before-close", { handedOff, beforePhysicalClose, closed });
    expect(output.closed).toBe(false);
    expect(closed.uncertainRequestIds).toEqual(["held-open-reply"]);
    expect(beforePhysicalClose.responseItems).toBe(1);
    expect(beforePhysicalClose.transportBytes).toBeGreaterThan(0);
    const terminalClose = new Promise((resolve) => output.once("close", resolve));
    output.destroy();
    await terminalClose;
    await tick();
    expect(output.closed).toBe(true);
    const afterPhysicalClose = pipe.snapshot();
    preserveFinite("fake-held-open-after-close", {
      beforePhysicalClose,
      afterPhysicalClose,
      closed,
    });
    expect(afterPhysicalClose).toMatchObject({
      state: "closed",
      responseItems: 0,
      transportBytes: 0,
      ordinaryAccountedBytes: 0,
      queuedBytes: 0,
      outstandingRequests: 0,
      blocked: false,
    });
    expect(await pipe.shutdown("later-close")).toBe(closed);
  } finally {
    output.destroy();
    input.destroy();
  }
});

test("late callback after terminal close cannot revive response debt or alter first cause", async () => {
  const callbacks = [];
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  const input = new PassThrough();
  const pipe = runWorkerPipe(input, output, {
    buildVersion: "independent-late-callback",
    createExecution: () => ({
      execute: async (request) => ({
        type: "error",
        worker: request.worker,
        run: request.run,
        requestId: request.requestId,
        commandType: request.type,
        error: domainError("CAPABILITY_UNAVAILABLE"),
      }),
      snapshot: () => ({}),
      shutdown: async () => [receipt],
    }),
  });
  try {
    input.write(encode(hello));
    callbacks.shift()();
    await tick();
    input.write(
      encode({
        type: "preview-refresh",
        worker: hello.worker,
        run: {
          serverId: hello.worker.serverId,
          relayInstanceId: hello.worker.relayInstanceId,
          runId: "r",
        },
        requestId: "late-callback-reply",
      }),
    );
    await until(() => callbacks.length === 1, 8000, "late callback retained");
    const before = pipe.snapshot();
    expect(before.responseItems).toBe(1);
    output.emit("close");
    const closed = await pipe.closed;
    const afterClose = pipe.snapshot();
    callbacks.shift()();
    await tick();
    const afterCallback = pipe.snapshot();
    preserveFinite("fake-late-callback", { before, afterClose, afterCallback, closed });
    expect(closed).toMatchObject({
      reason: "stdout-close",
      uncertainRequestIds: ["late-callback-reply"],
      disposalReceipts: [receipt],
    });
    for (const state of [afterClose, afterCallback])
      expect(state).toMatchObject({
        responseItems: 0,
        transportBytes: 0,
        ordinaryAccountedBytes: 0,
        blocked: false,
      });
    expect(await pipe.shutdown("repeat")).toBe(closed);
  } finally {
    output.destroy();
    input.destroy();
  }
});
