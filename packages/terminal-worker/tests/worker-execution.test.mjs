import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { composeSpawnPayload } from "@cove/protocol/pipe";
import { PROFILE, DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { createRunSession, createWorkerExecution } from "@cove/terminal-worker/execution";

const worker = {
  serverId: "server",
  relayInstanceId: "relay",
  workerId: "worker",
  workerIncarnationId: "one",
};
const geometry = { cols: 12, rows: 4 };
const encode = (value) => new TextEncoder().encode(value);
let requestOrdinal = 0;
const run = (runId = "run") => ({ serverId: "server", relayInstanceId: "relay", runId });
const holder = (id = "sub") => ({
  connection: { connectionId: "connection", generation: 1 },
  viewId: "view",
  subscriptionId: id,
});
const subscription = (id = "sub", target = run()) => ({ run: target, ...holder(id) });
const command = (type, fields = {}, target = run()) => ({
  type,
  worker,
  run: target,
  requestId: `${type}-${++requestOrdinal}`,
  ...fields,
});
const spawnCommand = (target = run(), budgets = M0_LIMITS) => {
  const composed = composeSpawnPayload(
    { executable: "/bin/sh", argv: ["-c", "exit 0"], cwd: "/" },
    encode,
  );
  return {
    command: command(
      "spawn",
      {
        operationId: `op-${target.runId}`,
        geometry,
        profile: PROFILE,
        appearance: DEFAULT_APPEARANCE,
        effectiveBudgets: budgets,
        spawnPayloadBytes: composed.bytes.length,
      },
      target,
    ),
    payload: composed.bytes,
  };
};
const cleanup = {
  scope: "initial-process-group",
  verified: false,
  graceful: { kind: "not-attempted", reason: "already-exited" },
  force: { kind: "not-attempted", reason: "already-exited" },
};

function fakeFactory(config = {}) {
  const owned = new Map();
  let tickets = 0;
  return {
    owned,
    snapshot() {
      return { owners: owned.size };
    },
    spawn(spec, observer) {
      if (config.rejectSpawn) return { kind: "rejected", reason: "preflight-failed" };
      const item = { spec, observer, writes: [], replies: [], resizes: [], stops: 0, retired: 0 };
      const pty = {
        pid: owned.size + 100,
        writerCompletion: Promise.resolve({ kind: "closed" }),
        submit(bytes, onSettled) {
          item.writes.push(Buffer.from(bytes));
          if (config.submit) return config.submit(item, bytes, onSettled, ++tickets);
          const ticket = ++tickets;
          onSettled({
            kind: "written",
            ticket,
            status: "written",
            originalBytes: bytes.length,
            writtenBytes: bytes.length,
            remainingBytes: 0,
          });
          return { kind: "accepted", ticket, byteLength: bytes.length };
        },
        automaticOutputSink(output) {
          item.replies.push(output);
        },
        resize(cols, rows) {
          item.resizes.push([cols, rows]);
          config.resize?.(item, cols, rows);
        },
        pause() {},
        resume() {},
        retireInput() {
          item.retired++;
        },
        async stop() {
          item.stops++;
          if (config.stop) return config.stop(item);
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
      owned.set(spec.file + owned.size, item);
      return { kind: "created", pty };
    },
  };
}

async function start(config = {}, budgets = M0_LIMITS, onFact) {
  const factory = fakeFactory(config);
  const execution = createWorkerExecution({
    worker,
    effectiveBudgets: budgets,
    factory,
    ...(onFact && { onFact }),
  });
  const spawn = spawnCommand(run(), budgets);
  expect(await execution.execute(spawn.command, spawn.payload)).toMatchObject({
    type: "result",
    commandType: "spawn",
    outcome: "accepted",
    atSeq: 0,
  });
  return { execution, factory, item: [...factory.owned.values()][0] };
}

test("registered execution entry preserves the first-slice facade and rejects W2 commands", async () => {
  expect(typeof createRunSession).toBe("function");
  const direct = createRunSession({
    run: run("direct"),
    geometry,
    spawn: { file: "/bin/sh", args: [], cwd: "/", env: {} },
    factory: fakeFactory(),
  });
  expect(direct.kind).toBe("created");
  expect(Object.keys(direct)).toEqual(["kind", "session"]);
  expect(Object.keys(direct.session)).toEqual(["barrier", "snapshot", "dispose"]);
  await direct.session.dispose();
  const { execution } = await start();
  try {
    expect(
      await execution.execute(command("subscribe", { subscription: subscription(), atSeq: 0 })),
    ).toMatchObject({ type: "error", error: { kind: "CAPABILITY_UNAVAILABLE" } });
    expect(
      await execution.execute(command("recover", { subscription: subscription() })),
    ).toMatchObject({ type: "error", error: { kind: "CAPABILITY_UNAVAILABLE" } });
    expect(
      await execution.execute(command("unsubscribe", { subscription: subscription() })),
    ).toMatchObject({ type: "error", error: { kind: "CAPABILITY_UNAVAILABLE" } });
    expect(
      await execution.execute(
        command("applied-ack", {
          subscription: subscription(),
          appliedSeq: 0,
        }),
      ),
    ).toMatchObject({ type: "error", error: { kind: "CAPABILITY_UNAVAILABLE" } });
    expect(
      await execution.execute(
        command("baseline-progress", {
          subscription: subscription(),
          baselineId: "baseline",
          lastParsedOrdinal: 0,
        }),
      ),
    ).toMatchObject({ type: "error", error: { kind: "CAPABILITY_UNAVAILABLE" } });
    expect(await execution.execute(command("preview-refresh"))).toMatchObject({
      type: "error",
      error: { kind: "CAPABILITY_UNAVAILABLE" },
    });
  } finally {
    await execution.shutdown("test");
  }
});

test("queued control holds later callback bytes unsequenced through synchronous native resize", async () => {
  const facts = [];
  const { execution, item } = await start(
    {
      resize(current) {
        current.observer.onData(Buffer.from("R"));
      },
    },
    M0_LIMITS,
    (fact) => facts.push(fact),
  );
  try {
    const retainedBytes = execution.snapshot().accountedBytes;
    item.observer.onData(Buffer.from("A"));
    const control = execution.execute(
      command("set-control", {
        expectedEpoch: 0,
        nextEpoch: 1,
        holder: holder(),
        geometry: { cols: 14, rows: 4 },
        appearance: { ...DEFAULT_APPEARANCE, foreground: "eeee/eeee/eeee" },
      }),
    );
    item.observer.onData(Buffer.from("B"));
    expect(await control).toMatchObject({ type: "result", atSeq: 4 });
    item.observer.onExit({ exitCode: 23 });
    const status = await execution.execute(command("status"));
    expect(status.runStatus).toMatchObject({
      geometry: { cols: 14, rows: 4 },
      controlEpoch: 1,
      status: "exited",
      receivedSeq: 7,
      parsedSeq: 7,
      exitCode: 23,
    });
    expect(facts.map((fact) => [fact.event.type, fact.event.seq])).toEqual([
      ["output", 1],
      ["resize", 2],
      ["appearance", 3],
      ["control", 4],
      ["output", 5],
      ["output", 6],
      ["exit", 7],
    ]);
    expect(execution.snapshot().accountedBytes).toBe(retainedBytes);
  } finally {
    await execution.shutdown("test");
  }
});

test("same-size resize consumes no sequence and stale epoch cannot grant control", async () => {
  const { execution, item } = await start();
  try {
    const grant = await execution.execute(
      command("set-control", {
        expectedEpoch: 0,
        nextEpoch: 1,
        holder: holder(),
        geometry,
      }),
    );
    expect(grant).toMatchObject({ type: "result", atSeq: 1 });
    expect(
      await execution.execute(
        command("resize", {
          subscription: subscription(),
          epoch: 1,
          geometry,
        }),
      ),
    ).toMatchObject({ type: "result", atSeq: 1 });
    expect(item.resizes).toEqual([]);
    expect(
      await execution.execute(
        command("set-control", {
          expectedEpoch: 0,
          nextEpoch: 1,
          holder: holder("other"),
          geometry,
        }),
      ),
    ).toMatchObject({ type: "error", error: { kind: "STALE_CONTROL" } });
    expect((await execution.execute(command("status"))).runStatus.receivedSeq).toBe(1);
  } finally {
    await execution.shutdown("test");
  }
});

test("queued takeover fences the old input identity before a native write", async () => {
  const { execution, item } = await start();
  try {
    await execution.execute(
      command("set-control", { expectedEpoch: 0, nextEpoch: 1, holder: holder("a"), geometry }),
    );
    const takeover = execution.execute(
      command("set-control", { expectedEpoch: 1, nextEpoch: 2, holder: holder("b"), geometry }),
    );
    const stale = execution.execute(
      command("input", { subscription: subscription("a"), epoch: 1, inputSeq: 1 }),
      encode("do-not-write"),
    );
    expect(await takeover).toMatchObject({ type: "result" });
    expect(await stale).toMatchObject({ type: "error", error: { kind: "STALE_CONTROL" } });
    expect(item.writes).toEqual([]);
  } finally {
    await execution.shutdown("test");
  }
});

test("input sequence gaps write once and duplicate/lower identities never replay", async () => {
  const { execution, item } = await start();
  try {
    await execution.execute(
      command("set-control", { expectedEpoch: 0, nextEpoch: 1, holder: holder(), geometry }),
    );
    const first = await execution.execute(
      command("input", { subscription: subscription(), epoch: 1, inputSeq: 3 }),
      encode("alpha"),
    );
    expect(first).toMatchObject({ type: "result", writtenBytes: 5, inputSeq: 3 });
    expect(
      await execution.execute(
        command("input", { subscription: subscription(), epoch: 1, inputSeq: 3 }),
        encode("again"),
      ),
    ).toMatchObject({ type: "error", error: { kind: "INPUT_REJECTED" } });
    expect(
      await execution.execute(
        command("input", { subscription: subscription(), epoch: 1, inputSeq: 2 }),
        encode("lower"),
      ),
    ).toMatchObject({ type: "error", error: { kind: "INPUT_REJECTED" } });
    expect(item.writes.map((bytes) => bytes.toString())).toEqual(["alpha"]);
  } finally {
    await execution.shutdown("test");
  }
});

test("partial native settlement is unknown and fences subsequent input without retry", async () => {
  const { execution, item } = await start({
    submit(_item, bytes, onSettled, ticket) {
      onSettled({
        kind: "unknown",
        ticket,
        status: "error",
        originalBytes: bytes.length,
        writtenBytes: 2,
        remainingBytes: bytes.length - 2,
      });
      return { kind: "accepted", ticket, byteLength: bytes.length };
    },
  });
  try {
    await execution.execute(
      command("set-control", { expectedEpoch: 0, nextEpoch: 1, holder: holder(), geometry }),
    );
    expect(
      await execution.execute(
        command("input", { subscription: subscription(), epoch: 1, inputSeq: 1 }),
        encode("hello"),
      ),
    ).toMatchObject({
      type: "error",
      error: {
        kind: "RESULT_UNKNOWN",
        acceptance: "unknown",
        nextAction: "inspect-run",
        subject: "input",
      },
    });
    expect(
      await execution.execute(
        command("input", { subscription: subscription(), epoch: 1, inputSeq: 2 }),
        encode("world"),
      ),
    ).toMatchObject({ type: "error", error: { kind: "WORKER_UNAVAILABLE" } });
    expect(item.writes.map((bytes) => bytes.toString())).toEqual(["hello"]);
  } finally {
    await execution.shutdown("test");
  }
});

test("zero-prefix settlement is unknown and does not claim written bytes", async () => {
  const { execution, item } = await start({
    submit(_item, bytes, onSettled, ticket) {
      onSettled({
        kind: "unknown",
        ticket,
        status: "closed",
        originalBytes: bytes.length,
        writtenBytes: 0,
        remainingBytes: bytes.length,
      });
      return { kind: "accepted", ticket, byteLength: bytes.length };
    },
  });
  try {
    await execution.execute(
      command("set-control", { expectedEpoch: 0, nextEpoch: 1, holder: holder(), geometry }),
    );
    const outcome = await execution.execute(
      command("input", { subscription: subscription(), epoch: 1, inputSeq: 1 }),
      encode("x"),
    );
    expect(outcome).toMatchObject({
      type: "error",
      error: { kind: "RESULT_UNKNOWN", nextAction: "inspect-run" },
    });
    expect("writtenBytes" in outcome).toBe(false);
    expect(item.writes).toHaveLength(1);
  } finally {
    await execution.shutdown("test");
  }
});

test("same subscription keeps attempted sequence across control loss and regrant", async () => {
  const { execution, item } = await start();
  try {
    await execution.execute(
      command("set-control", { expectedEpoch: 0, nextEpoch: 1, holder: holder(), geometry }),
    );
    await execution.execute(
      command("input", { subscription: subscription(), epoch: 1, inputSeq: 7 }),
      encode("first"),
    );
    await execution.execute(
      command("set-control", { expectedEpoch: 1, nextEpoch: 1, holder: null, geometry }),
    );
    await execution.execute(
      command("set-control", { expectedEpoch: 1, nextEpoch: 2, holder: holder(), geometry }),
    );
    expect(
      await execution.execute(
        command("input", { subscription: subscription(), epoch: 2, inputSeq: 7 }),
        encode("replay"),
      ),
    ).toMatchObject({ type: "error", error: { kind: "INPUT_REJECTED" } });
    expect(
      await execution.execute(
        command("input", { subscription: subscription(), epoch: 2, inputSeq: 9 }),
        encode("later"),
      ),
    ).toMatchObject({ type: "result", writtenBytes: 5 });
    expect(item.writes.map((bytes) => bytes.toString())).toEqual(["first", "later"]);
  } finally {
    await execution.shutdown("test");
  }
});

test("native resize failure does not publish a grant and preserves live status", async () => {
  const { execution, item } = await start({
    resize() {
      throw new Error("test resize fault");
    },
  });
  try {
    expect(
      await execution.execute(
        command("set-control", {
          expectedEpoch: 0,
          nextEpoch: 1,
          holder: holder(),
          geometry: { cols: 14, rows: 4 },
        }),
      ),
    ).toMatchObject({ type: "error", error: { kind: "RESULT_UNKNOWN" } });
    expect((await execution.execute(command("status"))).runStatus).toMatchObject({
      status: "live",
      controlEpoch: 0,
      controlHolder: null,
      geometry,
      receivedSeq: 0,
      parsedSeq: 0,
    });
    expect(
      await execution.execute(
        command("set-control", { expectedEpoch: 0, nextEpoch: 1, holder: holder(), geometry }),
      ),
    ).toMatchObject({ type: "error", error: { kind: "WORKER_UNAVAILABLE" } });
    expect(item.resizes).toEqual([[14, 4]]);
  } finally {
    await execution.shutdown("test");
  }
});

test("synchronous resize output overflow fences the transaction before a grant", async () => {
  const budgets = { ...M0_LIMITS, parseLowBytes: 1, parseHighBytes: 2, parseHardBytes: 3 };
  const { execution } = await start(
    {
      resize(item) {
        item.observer.onData(Buffer.from("overflow"));
      },
    },
    budgets,
  );
  try {
    expect(
      await execution.execute(
        command("set-control", {
          expectedEpoch: 0,
          nextEpoch: 1,
          holder: holder(),
          geometry: { cols: 14, rows: 4 },
        }),
      ),
    ).toMatchObject({ type: "error", error: { kind: "RESULT_UNKNOWN" } });
    expect((await execution.execute(command("status"))).runStatus).toMatchObject({
      controlEpoch: 0,
      controlHolder: null,
    });
  } finally {
    await execution.shutdown("test");
  }
});

test("pending command cap includes a write awaiting actual settlement", async () => {
  let settle;
  const budgets = { ...M0_LIMITS, pendingWorkerCommands: 1 };
  const { execution } = await start(
    {
      submit(_item, bytes, onSettled, ticket) {
        settle = () =>
          onSettled({
            kind: "written",
            ticket,
            status: "written",
            originalBytes: bytes.length,
            writtenBytes: bytes.length,
            remainingBytes: 0,
          });
        return { kind: "accepted", ticket, byteLength: bytes.length };
      },
    },
    budgets,
  );
  try {
    await execution.execute(
      command("set-control", { expectedEpoch: 0, nextEpoch: 1, holder: holder(), geometry }),
    );
    const pending = execution.execute(
      command("input", { subscription: subscription(), epoch: 1, inputSeq: 1 }),
      encode("pending"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(typeof settle).toBe("function");
    expect(await execution.execute(command("status"))).toMatchObject({
      type: "error",
      error: { kind: "BUSY" },
    });
    settle();
    expect(await pending).toMatchObject({ type: "result", writtenBytes: 7 });
  } finally {
    await execution.shutdown("test");
  }
});

test("retained input identity count rejects a second full subscription", async () => {
  const budgets = { ...M0_LIMITS, pendingWorkerCommands: 1 };
  const { execution, item } = await start({}, budgets);
  try {
    await execution.execute(
      command("set-control", { expectedEpoch: 0, nextEpoch: 1, holder: holder("a"), geometry }),
    );
    await execution.execute(
      command("input", { subscription: subscription("a"), epoch: 1, inputSeq: 1 }),
      encode("first"),
    );
    await execution.execute(
      command("set-control", { expectedEpoch: 1, nextEpoch: 2, holder: holder("b"), geometry }),
    );
    expect(
      await execution.execute(
        command("input", { subscription: subscription("b"), epoch: 2, inputSeq: 1 }),
        encode("second"),
      ),
    ).toMatchObject({ type: "error", error: { kind: "BUSY" } });
    expect(item.writes.map((bytes) => bytes.toString())).toEqual(["first"]);
    expect(execution.snapshot().inputIdentities).toBe(1);
  } finally {
    await execution.shutdown("test");
  }
});

test("worker byte cap retains identity and rejects the next run without eviction", async () => {
  let byteCap = 4_000;
  for (let index = 0; index < 8; index++) {
    const budgets = { ...M0_LIMITS, workerBytes: byteCap };
    const spawn = spawnCommand(run(), budgets);
    byteCap =
      128 +
      Buffer.byteLength(JSON.stringify(spawn.command)) +
      spawn.payload.length +
      256 +
      Buffer.byteLength("serverrelayrun") +
      1;
  }
  const budgets = { ...M0_LIMITS, workerBytes: byteCap };
  const { execution } = await start({}, budgets);
  try {
    const firstBytes = execution.snapshot().accountedBytes;
    const second = spawnCommand(run("next"), budgets);
    expect(await execution.execute(second.command, second.payload)).toMatchObject({
      type: "error",
      error: { kind: "BUSY" },
    });
    expect(execution.snapshot()).toMatchObject({ runIds: 1, accountedBytes: firstBytes });
  } finally {
    await execution.shutdown("test");
  }
});

test("retained run identity blocks reuse after stop and maxRuns counts retained IDs", async () => {
  const budgets = { ...M0_LIMITS, maxRuns: 1, listPage: 1 };
  const { execution } = await start({}, budgets);
  try {
    expect(await execution.execute(command("stop", { operationId: "stop-op" }))).toMatchObject({
      type: "result",
      outcome: "accepted",
    });
    const duplicate = spawnCommand(run(), budgets);
    expect(await execution.execute(duplicate.command, duplicate.payload)).toMatchObject({
      type: "error",
      error: { kind: "OPERATION_ID_CONFLICT" },
    });
    const second = spawnCommand(run("second"), budgets);
    expect(await execution.execute(second.command, second.payload)).toMatchObject({
      type: "error",
      error: { kind: "BUSY" },
    });
    expect(execution.snapshot().runIds).toBe(1);
  } finally {
    await execution.shutdown("test");
  }
});

test("stop follows earlier output in the pump and returns the cached receipt", async () => {
  const facts = [];
  const { execution, item } = await start({}, M0_LIMITS, (fact) => facts.push(fact));
  item.observer.onData(Buffer.from("A"));
  const first = execution.execute(command("stop", { operationId: "stop-first" }));
  item.observer.onData(Buffer.from("B"));
  expect(await first).toMatchObject({ type: "result", outcome: "accepted" });
  expect(facts.map(({ event }) => [event.type, event.seq])).toEqual([["output", 1]]);
  const second = await execution.execute(command("stop", { operationId: "stop-second" }));
  expect(second).toMatchObject({ type: "result", outcome: "accepted" });
  expect(item.stops).toBe(1);
  expect((await execution.execute(command("status"))).runStatus).toMatchObject({
    status: "exited",
    receivedSeq: 1,
    parsedSeq: 1,
  });
});

test("failed spawn retains its run identity", async () => {
  const factory = fakeFactory({ rejectSpawn: true });
  const execution = createWorkerExecution({ worker, effectiveBudgets: M0_LIMITS, factory });
  const spawn = spawnCommand();
  expect(await execution.execute(spawn.command, spawn.payload)).toMatchObject({
    type: "error",
    error: { kind: "WORKER_UNAVAILABLE" },
  });
  expect(
    await execution.execute({ ...spawn.command, requestId: "retry" }, spawn.payload),
  ).toMatchObject({ type: "error", error: { kind: "OPERATION_ID_CONFLICT" } });
  expect(execution.snapshot().runIds).toBe(1);
});

test("model query reply uses the writer even with no fact observer", async () => {
  const { execution, item } = await start();
  try {
    item.observer.onData(Buffer.from("\u001b[5n"));
    await execution.execute(command("status"));
    expect(item.replies.map((reply) => Buffer.from(reply.bytes).toString())).toEqual(["\u001b[0n"]);
  } finally {
    await execution.shutdown("test");
  }
});

test("1004 focus replies occur only on null-to-holder transitions", async () => {
  const { execution, item } = await start();
  try {
    item.observer.onData(Buffer.from("\u001b[?1004h"));
    await execution.execute(command("status"));
    await execution.execute(
      command("set-control", { expectedEpoch: 0, nextEpoch: 1, holder: holder("a"), geometry }),
    );
    await execution.execute(
      command("set-control", { expectedEpoch: 1, nextEpoch: 2, holder: holder("b"), geometry }),
    );
    await execution.execute(
      command("set-control", { expectedEpoch: 2, nextEpoch: 2, holder: null, geometry }),
    );
    expect(
      item.replies
        .filter((reply) => reply.kind === "focus")
        .map((reply) => Buffer.from(reply.bytes).toString()),
    ).toEqual(["\u001b[I", "\u001b[O"]);
  } finally {
    await execution.shutdown("test");
  }
});

test("foreign and malformed commands fail before W2 capability fallback", async () => {
  const { execution } = await start();
  try {
    const foreign = command("subscribe", { subscription: subscription(), atSeq: 0 });
    expect(
      await execution.execute({ ...foreign, worker: { ...worker, workerIncarnationId: "other" } }),
    ).toMatchObject({ type: "error", error: { kind: "INSTANCE_MISMATCH" } });
    await expect(execution.execute({ ...foreign, requestId: "bad space" })).rejects.toThrow(
      "Invalid pipe command",
    );
    expect(
      await execution.execute(
        command("subscribe", {
          subscription: subscription("sub", run("foreign")),
          atSeq: 0,
        }),
      ),
    ).toMatchObject({ type: "error", error: { kind: "INSTANCE_MISMATCH" } });
  } finally {
    await execution.shutdown("test");
  }
});

test("negotiated geometry rejects before native resize or sequence allocation", async () => {
  const budgets = { ...M0_LIMITS, maxCols: 12 };
  const { execution, item } = await start({}, budgets);
  try {
    await execution.execute(
      command("set-control", { expectedEpoch: 0, nextEpoch: 1, holder: holder(), geometry }),
    );
    const before = (await execution.execute(command("status"))).runStatus.receivedSeq;
    expect(
      await execution.execute(
        command("resize", {
          subscription: subscription(),
          epoch: 1,
          geometry: { cols: 13, rows: 4 },
        }),
      ),
    ).toMatchObject({ type: "error", error: { kind: "INVALID_SIZE" } });
    expect(item.resizes).toEqual([]);
    expect((await execution.execute(command("status"))).runStatus.receivedSeq).toBe(before);
  } finally {
    await execution.shutdown("test");
  }
});

test("worker shutdown starts all bounded stops before waiting for either receipt", async () => {
  const resolvers = [];
  const factory = fakeFactory({
    stop(item) {
      return new Promise((resolve) =>
        resolvers.push(() => {
          item.observer.onExit({ exitCode: 0 });
          resolve({ kind: "exited", exit: { exitCode: 0 }, cleanup });
        }),
      );
    },
  });
  const execution = createWorkerExecution({ worker, effectiveBudgets: M0_LIMITS, factory });
  const first = spawnCommand(run("one"));
  const second = spawnCommand(run("two"));
  await execution.execute(first.command, first.payload);
  await execution.execute(second.command, second.payload);
  const shutdown = execution.shutdown("test");
  expect(resolvers).toHaveLength(2);
  resolvers.forEach((resolve) => resolve());
  expect(await shutdown).toHaveLength(2);
  expect(execution.snapshot().shuttingDown).toBe(true);
});
