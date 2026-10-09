import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { M0_LIMITS } from "@cove/protocol/budgets";
import {
  composeSpawnPayload,
  PipeErrorSchema,
  PipeResultSchema,
  validatePipeResultForCommand,
} from "@cove/protocol/pipe";
import { PROFILE, DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { createRunSession, createWorkerExecution } from "@cove/terminal-worker/execution";
import { retainedFactCharge } from "../dist/src/replay-window.js";

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
    retainedBytesAccounting: "participating",
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
          const lease = spec.reserveRetainedBytes?.("native-input", bytes.length * 2 + 128);
          if (spec.reserveRetainedBytes && !lease)
            return { kind: "rejected", reason: "worker-byte-limit", writtenBytes: 0 };
          item.writes.push(Buffer.from(bytes));
          let handled = false;
          const settle = (result) => {
            if (handled) return onSettled(result);
            handled = true;
            try {
              onSettled(result);
            } finally {
              lease?.release();
            }
          };
          if (config.submit) {
            const admission = config.submit(item, bytes, settle, ++tickets);
            if (admission.kind === "rejected" && !handled) lease?.release();
            return admission;
          }
          const ticket = ++tickets;
          settle({
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

function deliverySink(deliveries) {
  return {
    enqueue(event, payload) {
      deliveries.push({ event, payload: Buffer.from(payload) });
      return 16 + encode(JSON.stringify(event)).byteLength + payload.byteLength;
    },
    cancelUnsent() {},
  };
}

async function install(execution, deliveries, ref, workerRef = worker) {
  const subscribe = command(
    "subscribe",
    { worker: workerRef, subscription: ref, atSeq: 0 },
    ref.run,
  );
  const marker = await execution.execute(subscribe);
  expect(marker).toMatchObject({ type: "result", outcome: "accepted", recoveryMode: "baseline" });
  execution.markerEnqueued(subscribe, marker);
  for (let turn = 0; turn < 10; turn++) {
    if (
      deliveries.some(
        (item) =>
          item.event.terminal.type === "baseline-end" &&
          item.event.subscription.subscriptionId === ref.subscriptionId &&
          item.event.run.runId === ref.run.runId,
      )
    )
      break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const own = deliveries.filter(
    (item) =>
      item.event.subscription?.subscriptionId === ref.subscriptionId &&
      item.event.run.runId === ref.run.runId,
  );
  const chunks = own.filter((item) => item.event.terminal.type === "baseline-chunk");
  const baselineId = own.find((item) => item.event.terminal.type === "baseline-start")?.event
    .terminal.descriptor.baselineId;
  expect(own.at(-1)?.event.terminal.type).toBe("baseline-end");
  for (let index = 0; index < chunks.length; index++) {
    const progress = command(
      "baseline-progress",
      {
        worker: workerRef,
        subscription: ref,
        baselineId,
        lastParsedOrdinal: index,
      },
      ref.run,
    );
    expect((await execution.execute(progress)).outcome).toBe("accepted");
    execution.responseSettled(progress.requestId);
  }
  const ack = command(
    "applied-ack",
    { worker: workerRef, subscription: ref, appliedSeq: marker.atSeq },
    ref.run,
  );
  expect((await execution.execute(ack)).outcome).toBe("accepted");
  execution.responseSettled(ack.requestId);
}

async function start(config = {}, budgets = M0_LIMITS, onFact, installDefault = true) {
  const factory = fakeFactory(config);
  const deliveries = [];
  const execution = createWorkerExecution({
    worker,
    effectiveBudgets: budgets,
    factory,
    delivery: deliverySink(deliveries),
    ...(onFact && { onFact }),
  });
  const spawn = spawnCommand(run(), budgets);
  expect(await execution.execute(spawn.command, spawn.payload)).toMatchObject({
    type: "result",
    commandType: "spawn",
    outcome: "accepted",
    atSeq: 0,
  });
  if (installDefault)
    for (const id of budgets.workerBytes >= 9 * 1024 * 1024 ? ["sub", "a", "b", "other"] : ["sub"])
      await install(execution, deliveries, subscription(id));
  return {
    execution,
    factory,
    item: [...factory.owned.values()][0],
    install: (ref) => install(execution, deliveries, ref),
    deliveries,
  };
}

async function startF5Pressure(
  budgets = { ...M0_LIMITS, workerBytes: 256 * 1024, reservedControlBytes: 4112 },
  extraSubscription = false,
) {
  const facts = [];
  let factObserver;
  const setup = await start({}, budgets, (fact) => {
    facts.push(fact);
    factObserver?.(fact);
  });
  const secondRun = run("second");
  const secondSpawn = spawnCommand(secondRun, budgets);
  expect(await setup.execution.execute(secondSpawn.command, secondSpawn.payload)).toMatchObject({
    type: "result",
    outcome: "accepted",
  });
  await setup.install(subscription("sub", secondRun));
  if (extraSubscription) await setup.install(subscription("other"));
  const items = [...setup.factory.owned.values()];
  for (const target of [run(), secondRun])
    expect(
      await setup.execution.execute(
        command(
          "set-control",
          { expectedEpoch: 0, nextEpoch: 1, holder: holder(), geometry },
          target,
        ),
      ),
    ).toMatchObject({ type: "result", outcome: "accepted" });
  items[0].observer.onData(Buffer.alloc(5_000, 0x41));
  items[1].observer.onData(Buffer.alloc(5_000, 0x42));
  await setup.execution.execute(command("status"));
  await setup.execution.execute(command("status", {}, secondRun));
  for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setImmediate(resolve));
  for (const target of [run(), secondRun]) {
    const ack = command(
      "applied-ack",
      { subscription: subscription("sub", target), appliedSeq: 1 },
      target,
    );
    expect(await setup.execution.execute(ack)).toMatchObject({
      type: "result",
      outcome: "accepted",
    });
    setup.execution.responseSettled(ack.requestId);
  }
  return {
    ...setup,
    items,
    secondRun,
    budgets,
    facts,
    observeFact: (observer) => (factObserver = observer),
  };
}

test.each([
  ["one chunk", [65_536], 1],
  ["separate callbacks", [65_536, 1], 2],
  ["one split callback", [65_537], 2],
])("worker ingress returns to its baseline after %s", async (_name, lengths, expectedFacts) => {
  const facts = [];
  const { execution, item } = await start({}, M0_LIMITS, (fact) => facts.push(fact));
  try {
    const baseline = execution.snapshot().retainedBreakdown.workerBytes;
    for (const length of lengths) item.observer.onData(Buffer.alloc(length, 0x41));
    expect(execution.snapshot().retainedBreakdown.workerBytes).toBeGreaterThan(baseline);
    const status = await execution.execute(command("status"));
    expect(status.runStatus).toMatchObject({ parsedSeq: expectedFacts });
    expect(facts).toHaveLength(expectedFacts);
    expect(facts.reduce((sum, fact) => sum + fact.bytes.length, 0)).toBe(
      lengths.reduce((sum, length) => sum + length, 0),
    );
    for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setImmediate(resolve));
    for (const id of ["sub", "a", "b", "other"]) {
      const ack = command("applied-ack", {
        subscription: subscription(id),
        appliedSeq: expectedFacts,
      });
      expect(await execution.execute(ack)).toMatchObject({ type: "result", outcome: "accepted" });
      execution.responseSettled(ack.requestId);
    }
    const retained = execution.snapshot();
    expect(retained.retainedBreakdown.workerBytes - retained.replay[0].bytes).toBe(baseline);
  } finally {
    await execution.shutdown("test");
  }
});

test("W2 direct O recover in progress does not consume the X ACK slot", async () => {
  const budgets = { ...M0_LIMITS, pendingWorkerCommands: 1 };
  const { execution, install: installRun } = await start({}, budgets, undefined, false);
  try {
    await installRun(subscription("recover"));
    await installRun(subscription("ack"));
    const recover = command("recover", { subscription: subscription("recover") });
    const pending = execution.execute(recover);
    expect(execution.snapshot().ordinaryPendingCommands).toBe(1);
    const ack = command("applied-ack", {
      subscription: subscription("ack"),
      appliedSeq: 0,
    });
    expect(await execution.execute(ack)).toMatchObject({ type: "result", outcome: "accepted" });
    execution.responseSettled(ack.requestId);
    expect(await pending).toMatchObject({ type: "result", outcome: "accepted" });
    expect(execution.snapshot().ordinaryPendingCommands).toBe(0);
  } finally {
    await execution.shutdown("test");
  }
});

test("W2 rejected unknown-subscription input retains replay cache and releases admission bytes", async () => {
  const { execution, item } = await start();
  try {
    item.observer.onData(Buffer.from("cached"));
    await execution.execute(command("status"));
    await new Promise((resolve) => setImmediate(resolve));
    const before = execution.snapshot();
    expect(before.replay[0].events).toBeGreaterThan(0);
    const result = await execution.execute(
      command("input", { subscription: subscription("unknown"), epoch: 1, inputSeq: 1 }),
      Buffer.alloc(20_000),
    );
    expect(result).toMatchObject({ type: "error", error: { kind: "RESYNC_REQUIRED" } });
    expect(execution.snapshot().replay[0].events).toBe(before.replay[0].events);
    expect(execution.snapshot().accountedBytes).toBe(before.accountedBytes);
  } finally {
    await execution.shutdown("test");
  }
});

test.each([
  {
    name: "stale epoch",
    expected: "STALE_CONTROL",
    input: () => ({ subscription: subscription(), epoch: 2, inputSeq: 1 }),
  },
  {
    name: "wrong installed holder",
    expected: "STALE_CONTROL",
    extraSubscription: true,
    input: () => ({ subscription: subscription("other"), epoch: 1, inputSeq: 1 }),
  },
  {
    name: "duplicate sequence",
    expected: "INPUT_REJECTED",
    async prepare({ execution }) {
      expect(
        await execution.execute(
          command("input", { subscription: subscription(), epoch: 1, inputSeq: 3 }),
          Buffer.from([65]),
        ),
      ).toMatchObject({ type: "result", writtenBytes: 1 });
    },
    input: () => ({ subscription: subscription(), epoch: 1, inputSeq: 3 }),
  },
  {
    name: "lower sequence",
    expected: "INPUT_REJECTED",
    async prepare({ execution }) {
      expect(
        await execution.execute(
          command("input", { subscription: subscription(), epoch: 1, inputSeq: 3 }),
          Buffer.from([65]),
        ),
      ).toMatchObject({ type: "result", writtenBytes: 1 });
    },
    input: () => ({ subscription: subscription(), epoch: 1, inputSeq: 2 }),
  },
  {
    name: "exhausted sequence",
    expected: "COUNTER_EXHAUSTED",
    async prepare({ execution }) {
      expect(
        await execution.execute(
          command("input", {
            subscription: subscription(),
            epoch: 1,
            inputSeq: Number.MAX_SAFE_INTEGER,
          }),
          Buffer.from([65]),
        ),
      ).toMatchObject({ type: "result", writtenBytes: 1 });
    },
    input: () => ({ subscription: subscription(), epoch: 1, inputSeq: Number.MAX_SAFE_INTEGER }),
  },
  {
    name: "identity cap",
    expected: "BUSY",
    budgets: {
      ...M0_LIMITS,
      workerBytes: 256 * 1024,
      reservedControlBytes: 4112,
      pendingWorkerCommands: 1,
    },
    async prepare({ execution }) {
      expect(
        await execution.execute(
          command("input", { subscription: subscription(), epoch: 1, inputSeq: 1 }),
          Buffer.from([65]),
        ),
      ).toMatchObject({ type: "result", writtenBytes: 1 });
    },
    input: ({ secondRun }) => ({
      subscription: subscription("sub", secondRun),
      epoch: 1,
      inputSeq: 1,
    }),
    target: ({ secondRun }) => secondRun,
  },
])(
  "W2 pressure rejects $name without evicting either run or changing replay mode",
  async (caseInfo) => {
    const setup = await startF5Pressure(caseInfo.budgets, caseInfo.extraSubscription);
    const { execution, items } = setup;
    try {
      await caseInfo.prepare?.(setup);
      const target = caseInfo.target?.(setup) ?? run();
      const fields = caseInfo.input(setup);
      const input = command("input", fields, target);
      const before = execution.snapshot();
      const beforeWrites = items.map((item) => item.writes.length);
      expect(before.replay.map(({ events }) => events)).toEqual([2, 2]);
      const fullCharge = 128 + Buffer.byteLength(JSON.stringify(input)) + 20_000 + 40_768;
      expect((caseInfo.budgets?.workerBytes ?? 256 * 1024) - before.accountedBytes).toBeLessThan(
        fullCharge,
      );
      const rejected = await execution.execute(input, Buffer.alloc(20_000));
      expect(rejected).toMatchObject({ type: "error", error: { kind: caseInfo.expected } });
      const after = execution.snapshot();
      expect(after.replay).toEqual(before.replay);
      expect(after.accountedBytes).toBe(before.accountedBytes);
      expect(items.map((item) => item.writes.length)).toEqual(beforeWrites);
      const recover = command(
        "recover",
        { subscription: subscription("sub", target), appliedSeq: 1 },
        target,
      );
      expect(await execution.execute(recover)).toMatchObject({
        type: "result",
        recoveryMode: "replay",
      });
    } finally {
      await execution.shutdown("test");
    }
  },
);

test("W2 valid ordered input reclaims only the required unpinned whole facts and writes once", async () => {
  const { execution, items, facts, budgets } = await startF5Pressure();
  try {
    const input = command("input", { subscription: subscription(), epoch: 1, inputSeq: 1 });
    const before = execution.snapshot();
    const byRun = [run(), run("second")].map((target) =>
      facts.filter((fact) => fact.event.run.runId === target.runId),
    );
    expect(byRun.map((entries) => entries.map((fact) => fact.event.seq))).toEqual([
      [1, 2],
      [1, 2],
    ]);
    const identityCharge =
      192 + Buffer.byteLength("connection") + Buffer.byteLength("view") + Buffer.byteLength("sub");
    const commandCharge = 128 + Buffer.byteLength(JSON.stringify(input)) + 20_000;
    let shortfall =
      commandCharge +
      identityCharge +
      2 * 20_000 +
      768 -
      (budgets.workerBytes - before.accountedBytes);
    expect(shortfall).toBeGreaterThan(0);
    const expected = before.replay.map((state) => ({ ...state }));
    let cursor = 0;
    while (shortfall > 0) {
      const fact = byRun[cursor].shift();
      expect(fact).toBeDefined();
      const charge = retainedFactCharge(fact);
      expected[cursor].events--;
      expected[cursor].bytes -= charge;
      shortfall -= charge;
      cursor = (cursor + 1) % byRun.length;
    }
    expect(await execution.execute(input, Buffer.alloc(20_000))).toMatchObject({
      type: "result",
      writtenBytes: 20_000,
    });
    expect(execution.snapshot().replay).toEqual(expected);
    expect(items.map((item) => item.writes.length)).toEqual([1, 0]);
    expect(items[0].writes[0]).toEqual(Buffer.alloc(20_000));
    expect(execution.snapshot().peakAccountedBytes).toBeLessThanOrEqual(budgets.workerBytes);
    const evictedOutput = expected.findIndex((state) => state.events === 0);
    expect(evictedOutput).toBeGreaterThanOrEqual(0);
    const target = evictedOutput === 0 ? run() : run("second");
    const recover = command(
      "recover",
      { subscription: subscription("sub", target), appliedSeq: 1 },
      target,
    );
    expect(await execution.execute(recover)).toMatchObject({
      type: "result",
      recoveryMode: "baseline",
    });
  } finally {
    await execution.shutdown("test");
  }
});

test("W2 queued control loss decides input at pump order without replay reclamation", async () => {
  const { execution, items, observeFact, budgets } = await startF5Pressure();
  try {
    let afterControl;
    observeFact((fact) => {
      if (fact.event.run.runId === "run" && fact.event.type === "control" && fact.event.seq === 3)
        afterControl = execution.snapshot().replay;
    });
    const release = execution.execute(
      command("set-control", { expectedEpoch: 1, nextEpoch: 1, holder: null, geometry }),
    );
    const input = command("input", { subscription: subscription(), epoch: 1, inputSeq: 1 });
    const before = execution.snapshot();
    expect(budgets.workerBytes - before.accountedBytes).toBeLessThan(
      128 + Buffer.byteLength(JSON.stringify(input)) + 20_000 + 40_768,
    );
    const rejected = execution.execute(input, Buffer.alloc(20_000));
    expect(await release).toMatchObject({ type: "result", outcome: "accepted" });
    expect(await rejected).toMatchObject({ type: "error", error: { kind: "STALE_CONTROL" } });
    expect(afterControl).toBeDefined();
    expect(execution.snapshot().replay).toEqual(afterControl);
    expect(items.map((item) => item.writes.length)).toEqual([0, 0]);
  } finally {
    await execution.shutdown("test");
  }
});

async function withInstrumentedCounters(fields, runCase) {
  const suffix = randomUUID();
  const source = new URL("../dist/src/", import.meta.url);
  const sessionFile = new URL(`run-session-counter-${suffix}.js`, source);
  const workerFile = new URL(`worker-execution-counter-${suffix}.js`, source);
  const originalSession = await readFile(new URL("run-session.js", source), "utf8");
  const originalWorker = await readFile(new URL("worker-execution.js", source), "utf8");
  let instrumentedSession = originalSession;
  for (const [field, value] of Object.entries(fields)) {
    const initializer = `#${field} = 0;`;
    expect(instrumentedSession.split(initializer)).toHaveLength(2);
    instrumentedSession = instrumentedSession.replace(initializer, `#${field} = ${value};`);
  }
  const instrumentedWorker = originalWorker.replaceAll(
    '"./run-session.js"',
    `"./run-session-counter-${suffix}.js"`,
  );
  expect(instrumentedWorker).not.toBe(originalWorker);
  try {
    await writeFile(sessionFile, instrumentedSession);
    await writeFile(workerFile, instrumentedWorker);
    const { createWorkerExecution: createNearLimitWorker } = await import(workerFile.href);
    await runCase(createNearLimitWorker);
  } finally {
    await Promise.allSettled([unlink(sessionFile), unlink(workerFile)]);
  }
}

function expectCorrelated(commandValue, response, type) {
  expect(response.type).toBe(type);
  expect((type === "result" ? PipeResultSchema : PipeErrorSchema).safeParse(response).success).toBe(
    true,
  );
  expect(validatePipeResultForCommand(commandValue, response)).toBe(true);
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
  const execution = createWorkerExecution({
    worker,
    effectiveBudgets: M0_LIMITS,
    factory: fakeFactory(),
  });
  const spawn = spawnCommand();
  expect((await execution.execute(spawn.command, spawn.payload)).outcome).toBe("accepted");
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

test("a signaled leader reports the signal name and no exit code in its exit fact and status", async () => {
  const facts = [];
  const { execution, item } = await start({}, M0_LIMITS, (fact) => facts.push(fact));
  try {
    // node-pty reports a SIGHUP-killed leader as exit code 0 with signal number 1.
    item.observer.onExit({ exitCode: 0, signal: 1 });
    const status = await execution.execute(command("status"));
    expect(status.runStatus).toMatchObject({ status: "exited", exitCode: null, signal: "SIGHUP" });
    expect(facts.at(-1).event).toMatchObject({ type: "exit", exitCode: null, signal: "SIGHUP" });
  } finally {
    await execution.shutdown("test");
  }
});

test("an ordinary leader exit with a zero signal reports its exit code and no signal", async () => {
  const facts = [];
  const { execution, item } = await start({}, M0_LIMITS, (fact) => facts.push(fact));
  try {
    item.observer.onExit({ exitCode: 7, signal: 0 });
    const status = await execution.execute(command("status"));
    expect(status.runStatus).toMatchObject({ status: "exited", exitCode: 7, signal: null });
    expect(facts.at(-1).event).toMatchObject({ type: "exit", exitCode: 7, signal: null });
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
    const retained = execution.snapshot();
    expect(retained.accountedBytes).toBeGreaterThan(retainedBytes);
    expect(retained.retainedBreakdown.engineBytes).toBeGreaterThanOrEqual(65_536);
    expect(retained.accountedBytes).toBeLessThanOrEqual(M0_LIMITS.workerBytes);
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

test("input MAX exhausts only its full identity after one legal gap", async () => {
  const { execution, item } = await start();
  try {
    await execution.execute(
      command("set-control", {
        expectedEpoch: 0,
        nextEpoch: 1,
        holder: holder(),
        geometry,
      }),
    );
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(
      await execution.execute(
        command("input", { subscription: subscription(), epoch: 1, inputSeq: maximum }),
        encode("max"),
      ),
    ).toMatchObject({ type: "result", writtenBytes: 3 });
    expect(
      await execution.execute(
        command("input", { subscription: subscription(), epoch: 1, inputSeq: maximum }),
        encode("repeat"),
      ),
    ).toMatchObject({ type: "error", error: { kind: "COUNTER_EXHAUSTED" } });
    expect((await execution.execute(command("status"))).runStatus.reason).toBe(
      "Current input sequence exhausted",
    );
    await execution.execute(
      command("set-control", {
        expectedEpoch: 1,
        nextEpoch: 1,
        holder: null,
        geometry,
      }),
    );
    await execution.execute(
      command("set-control", {
        expectedEpoch: 1,
        nextEpoch: 2,
        holder: holder(),
        geometry,
      }),
    );
    expect(
      await execution.execute(
        command("input", { subscription: subscription(), epoch: 2, inputSeq: maximum }),
        encode("regrant"),
      ),
    ).toMatchObject({ type: "error", error: { kind: "COUNTER_EXHAUSTED" } });
    await execution.execute(
      command("set-control", {
        expectedEpoch: 2,
        nextEpoch: 3,
        holder: holder("other"),
        geometry,
      }),
    );
    expect(
      await execution.execute(
        command("input", { subscription: subscription("other"), epoch: 3, inputSeq: 1 }),
        encode("other"),
      ),
    ).toMatchObject({ type: "result", writtenBytes: 5 });
    expect(item.writes.map((value) => value.toString())).toEqual(["max", "other"]);
  } finally {
    await execution.shutdown("test");
  }
});

test("compiled near-MAX epoch rejects new grants but accepts same-epoch release", async () => {
  await withInstrumentedCounters(
    { controlEpoch: Number.MAX_SAFE_INTEGER },
    async (createNearLimitWorker) => {
      const factory = fakeFactory();
      const deliveries = [];
      const execution = createNearLimitWorker({
        worker,
        effectiveBudgets: M0_LIMITS,
        factory,
        delivery: deliverySink(deliveries),
      });
      try {
        const spawn = spawnCommand();
        const spawned = await execution.execute(spawn.command, spawn.payload);
        expectCorrelated(spawn.command, spawned, "result");
        await install(execution, deliveries, subscription());
        const grant = command("set-control", {
          expectedEpoch: Number.MAX_SAFE_INTEGER,
          nextEpoch: Number.MAX_SAFE_INTEGER,
          holder: holder(),
          geometry,
        });
        const rejected = await execution.execute(grant);
        expectCorrelated(grant, rejected, "error");
        expect(rejected.error.kind).toBe("COUNTER_EXHAUSTED");
        const release = command("set-control", {
          expectedEpoch: Number.MAX_SAFE_INTEGER,
          nextEpoch: Number.MAX_SAFE_INTEGER,
          holder: null,
          geometry,
        });
        const released = await execution.execute(release);
        expectCorrelated(release, released, "result");
        const statusCommand = command("status");
        const status = await execution.execute(statusCommand);
        expectCorrelated(statusCommand, status, "result");
        expect(status.runStatus).toMatchObject({
          controlEpoch: Number.MAX_SAFE_INTEGER,
          controlHolder: null,
          reason: "Control epoch exhausted",
        });
        const stopCommand = command("stop", { operationId: "near-max-epoch-stop" });
        expectCorrelated(stopCommand, await execution.execute(stopCommand), "result");
      } finally {
        await execution.shutdown("test");
      }
    },
  );
});

test("compiled near-MAX output rejects multi-fact grant before native resize", async () => {
  await withInstrumentedCounters(
    { receivedSeq: Number.MAX_SAFE_INTEGER - 1 },
    async (createNearLimitWorker) => {
      const factory = fakeFactory();
      const deliveries = [];
      const execution = createNearLimitWorker({
        worker,
        effectiveBudgets: M0_LIMITS,
        factory,
        delivery: deliverySink(deliveries),
      });
      try {
        const spawn = spawnCommand();
        expectCorrelated(
          spawn.command,
          await execution.execute(spawn.command, spawn.payload),
          "result",
        );
        await install(execution, deliveries, subscription());
        const item = [...factory.owned.values()][0];
        const grant = command("set-control", {
          expectedEpoch: 0,
          nextEpoch: 1,
          holder: holder(),
          geometry: { cols: geometry.cols + 1, rows: geometry.rows },
        });
        const rejected = await execution.execute(grant);
        expectCorrelated(grant, rejected, "error");
        expect(rejected.error.kind).toBe("COUNTER_EXHAUSTED");
        expect(item.resizes).toEqual([]);
        const statusCommand = command("status");
        const status = await execution.execute(statusCommand);
        expectCorrelated(statusCommand, status, "result");
        expect(status.runStatus).toMatchObject({
          controlEpoch: 0,
          controlHolder: null,
          receivedSeq: Number.MAX_SAFE_INTEGER - 1,
          reason: "Run fact sequence exhausted",
        });
        expect(execution.snapshot().sessions[0].snapshot.counterExhausted).toBe(true);
        const stopCommand = command("stop", { operationId: "near-max-output-stop" });
        expectCorrelated(stopCommand, await execution.execute(stopCommand), "result");
      } finally {
        await execution.shutdown("test");
      }
    },
  );
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

test("pending command cap retains a write while reserved status remains available", async () => {
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
      type: "result",
      commandType: "status",
    });
    settle();
    expect(await pending).toMatchObject({ type: "result", writtenBytes: 7 });
  } finally {
    await execution.shutdown("test");
  }
});

test("status and first stop use independent reserved slots under ordinary saturation", async () => {
  let settle;
  const budgets = { ...M0_LIMITS, pendingWorkerCommands: 1, reservedControlBytes: 4112 };
  const { execution, item } = await start(
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
      command("set-control", {
        expectedEpoch: 0,
        nextEpoch: 1,
        holder: holder(),
        geometry,
      }),
    );
    const input = execution.execute(
      command("input", { subscription: subscription(), epoch: 1, inputSeq: 1 }),
      encode("held"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const status = await execution.execute(command("status"));
    expect(status).toMatchObject({
      type: "result",
      runStatus: {
        controlEpoch: 1,
        parsedSeq: 1,
        receivedSeq: 1,
      },
    });
    const stop = execution.execute(command("stop", { operationId: "first-stop" }));
    expect(execution.snapshot()).toMatchObject({
      ordinaryPendingCommands: 1,
      reservedStatusPending: false,
      reservedStopPending: true,
      retainedBreakdown: { reservedControlBytes: 4112 },
    });
    expect(await execution.execute(command("stop", { operationId: "second-stop" }))).toMatchObject({
      type: "error",
      error: { kind: "BUSY" },
    });
    settle();
    expect(await input).toMatchObject({ type: "result", writtenBytes: 4 });
    expect(await stop).toMatchObject({ type: "result", outcome: "accepted" });
    expect(item.stops).toBe(1);
    expect(await execution.execute(command("stop", { operationId: "later-stop" }))).toMatchObject({
      type: "result",
      outcome: "accepted",
    });
    expect(item.stops).toBe(1);
  } finally {
    await execution.shutdown("test");
  }
});

test("cached status reports only settled geometry while a mutation waits on input", async () => {
  let settle;
  const { execution } = await start({
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
  });
  try {
    await execution.execute(
      command("set-control", {
        expectedEpoch: 0,
        nextEpoch: 1,
        holder: holder(),
        geometry,
      }),
    );
    const pendingInput = execution.execute(
      command("input", {
        subscription: subscription(),
        epoch: 1,
        inputSeq: 1,
      }),
      encode("held"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const nextGeometry = { cols: geometry.cols + 1, rows: geometry.rows };
    const mutation = execution.execute(
      command("set-control", {
        expectedEpoch: 1,
        nextEpoch: 2,
        holder: holder(),
        geometry: nextGeometry,
      }),
    );
    const status = await execution.execute(command("status"));
    expect(status.runStatus).toMatchObject({
      geometry,
      controlEpoch: 1,
      receivedSeq: 1,
      parsedSeq: 1,
    });
    settle();
    expect(await pendingInput).toMatchObject({ type: "result", writtenBytes: 4 });
    expect(await mutation).toMatchObject({ type: "result" });
    expect((await execution.execute(command("status"))).runStatus).toMatchObject({
      geometry: nextGeometry,
      controlEpoch: 2,
    });
  } finally {
    settle?.();
    await execution.shutdown("test");
  }
});

test("minimum control carve-out covers max IDs and concurrent status/stop overlap", async () => {
  const id = "x".repeat(128);
  const longWorker = { serverId: id, relayInstanceId: id, workerId: id, workerIncarnationId: id };
  const longRun = { serverId: id, relayInstanceId: id, runId: id };
  const budgets = { ...M0_LIMITS, pendingWorkerCommands: 1, reservedControlBytes: 4112 };
  const deliveries = [];
  let settle;
  const factory = fakeFactory({
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
    stop(item) {
      item.observer.onExit({ exitCode: 0 });
      return {
        kind: "unverifiable",
        cause: "c".repeat(128),
        cleanup: {
          ...cleanup,
          graceful: { kind: "unverifiable", reason: "signal-failed", errorCode: "E".repeat(32) },
          force: { kind: "unverifiable", reason: "signal-failed", errorCode: "F".repeat(32) },
        },
        signalFailure: { phase: "force", cause: "s".repeat(128) },
      };
    },
  });
  const execution = createWorkerExecution({
    worker: longWorker,
    effectiveBudgets: budgets,
    factory,
    delivery: deliverySink(deliveries),
  });
  const makeCommand = (type, fields, requestId) => ({
    ...command(type, fields, longRun),
    worker: longWorker,
    requestId,
  });
  try {
    const spawn = spawnCommand(longRun, budgets);
    const spawnRequest = { ...spawn.command, worker: longWorker, operationId: id };
    expectCorrelated(spawnRequest, await execution.execute(spawnRequest, spawn.payload), "result");
    await install(execution, deliveries, subscription("sub", longRun), longWorker);
    const grant = makeCommand(
      "set-control",
      {
        expectedEpoch: 0,
        nextEpoch: 1,
        holder: holder(),
        geometry,
      },
      "grant",
    );
    expectCorrelated(grant, await execution.execute(grant), "result");
    const input = makeCommand(
      "input",
      { subscription: subscription("sub", longRun), epoch: 1, inputSeq: 1 },
      "input",
    );
    const pendingInput = execution.execute(input, encode("held"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(typeof settle).toBe("function");
    const statusRequest = makeCommand("status", {}, id);
    const stopRequest = makeCommand("stop", { operationId: id }, "r".repeat(128));
    const statusPromise = execution.execute(statusRequest);
    const stopPromise = execution.execute(stopRequest);
    expect(execution.snapshot()).toMatchObject({
      ordinaryPendingCommands: 1,
      reservedStatusPending: true,
      reservedStopPending: true,
      retainedBreakdown: { reservedControlBytes: 4112 },
    });
    const status = await statusPromise;
    expectCorrelated(statusRequest, status, "result");
    expect(status.runStatus.controlEpoch).toBe(1);
    expect(execution.snapshot().accountedBytes).toBeLessThanOrEqual(budgets.workerBytes);
    settle();
    expectCorrelated(input, await pendingInput, "result");
    const stopped = await stopPromise;
    expectCorrelated(stopRequest, stopped, "result");
    expect(Buffer.byteLength(statusRequest.requestId)).toBe(128);
    expect(Buffer.byteLength(stopRequest.requestId)).toBe(128);
    expect(Buffer.byteLength(stopRequest.operationId)).toBe(128);
    expect(execution.snapshot().peakAccountedBytes).toBeLessThanOrEqual(budgets.workerBytes);
    expect(factory.owned.size).toBe(1);
  } finally {
    settle?.();
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

test("worker byte cap rejects model allocation before native spawn and retains run identity", async () => {
  const budgets = { ...M0_LIMITS, workerBytes: 92 * 1024 };
  const { execution, factory } = await start({}, budgets, undefined, false);
  try {
    const firstBytes = execution.snapshot().accountedBytes;
    const second = spawnCommand(run("next"), budgets);
    expect(await execution.execute(second.command, second.payload)).toMatchObject({
      type: "error",
      error: { kind: "BUSY" },
    });
    expect(execution.snapshot().runIds).toBe(2);
    expect(execution.snapshot().accountedBytes).toBeGreaterThan(firstBytes);
    expect(execution.snapshot().accountedBytes).toBeLessThanOrEqual(budgets.workerBytes);
    expect(factory.owned.size).toBe(1);
  } finally {
    await execution.shutdown("test");
  }
});

test("two T2 tails and held N2 input share one worker pre-admission cap", async () => {
  let releaseFirst;
  const budgets = { ...M0_LIMITS, workerBytes: 256 * 1024, reservedControlBytes: 4112 };
  const {
    execution,
    factory,
    item: first,
    install: installRun,
  } = await start(
    {
      submit(item, bytes, onSettled, ticket) {
        if (item === first) {
          releaseFirst = () =>
            onSettled({
              kind: "written",
              ticket,
              status: "written",
              originalBytes: bytes.length,
              writtenBytes: bytes.length,
              remainingBytes: 0,
            });
          return { kind: "accepted", ticket, byteLength: bytes.length };
        }
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
  const secondRun = run("second");
  try {
    const secondSpawn = spawnCommand(secondRun, budgets);
    expect(await execution.execute(secondSpawn.command, secondSpawn.payload)).toMatchObject({
      type: "result",
      outcome: "accepted",
    });
    const second = [...factory.owned.values()][1];
    first.observer.onData(Buffer.alloc(5_000, 0x41));
    second.observer.onData(Buffer.alloc(5_000, 0x42));
    await execution.execute(command("status"));
    await execution.execute(command("status", {}, secondRun));
    await installRun(subscription("sub", secondRun));
    const snapshots = execution.snapshot().sessions.map(({ snapshot }) => snapshot);
    expect(snapshots.map((snapshot) => snapshot.settledState.resources.tailAllocatedBytes)).toEqual(
      [65_536, 65_536],
    );
    for (const target of [run(), secondRun])
      await execution.execute(
        command(
          "set-control",
          {
            expectedEpoch: 0,
            nextEpoch: 1,
            holder: holder(),
            geometry,
          },
          target,
        ),
      );
    const replayBeforeInput = execution
      .snapshot()
      .replay.reduce((sum, item) => sum + item.events, 0);
    const held = execution.execute(
      command("input", {
        subscription: subscription("sub", run()),
        epoch: 1,
        inputSeq: 1,
      }),
      Buffer.alloc(20_000),
    );
    for (let turn = 0; turn < 32 && !releaseFirst; turn++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(typeof releaseFirst).toBe("function");
    expect(execution.snapshot().replay.reduce((sum, item) => sum + item.events, 0)).toBeLessThan(
      replayBeforeInput,
    );
    expect(budgets.workerBytes - execution.snapshot().accountedBytes).toBeLessThan(20_000);
    const secondResult = await execution.execute(
      command(
        "input",
        {
          subscription: subscription("sub", secondRun),
          epoch: 1,
          inputSeq: 1,
        },
        secondRun,
      ),
      Buffer.alloc(20_000),
    );
    expect(secondResult).toMatchObject({ type: "error", error: { kind: "BUSY" } });
    expect(second.writes).toHaveLength(0);
    expect(execution.snapshot().accountedBytes).toBeLessThanOrEqual(budgets.workerBytes);
    releaseFirst();
    expect(await held).toMatchObject({ type: "result", writtenBytes: 20_000 });
    expect(
      await execution.execute(
        command(
          "input",
          {
            subscription: subscription("sub", secondRun),
            epoch: 1,
            inputSeq: 2,
          },
          secondRun,
        ),
        Buffer.alloc(20_000),
      ),
    ).toMatchObject({ type: "result", writtenBytes: 20_000 });
    expect(second.writes).toHaveLength(1);
    expect(execution.snapshot().peakAccountedBytes).toBeLessThanOrEqual(budgets.workerBytes);
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

test("hostile injected stop causes are normalized before cached status and receipt", async () => {
  const cause = { oversized: Buffer.alloc(200_000) };
  Object.defineProperty(cause, "message", {
    get() {
      throw new Error("accessor evaluated");
    },
  });
  const budgets = { ...M0_LIMITS, workerBytes: 96 * 1024, reservedControlBytes: 4112 };
  const { execution, item } = await start(
    {
      stop() {
        return { kind: "unverifiable", cause, cleanup, signalFailure: { phase: "force", cause } };
      },
    },
    budgets,
  );
  const stopped = await execution.execute(command("stop", { operationId: "hostile-stop" }));
  expect(stopped).toMatchObject({ type: "result", outcome: "accepted" });
  const snapshot = execution.snapshot();
  const receipt = snapshot.sessions[0].snapshot.stop.result;
  expect(receipt).toMatchObject({
    kind: "unverifiable",
    cause: { category: "native-failure" },
    signalFailure: { phase: "force", cause: { category: "native-failure" } },
  });
  expect(receipt.cause).not.toBe(cause);
  expect(receipt.signalFailure.cause).not.toBe(cause);
  expect(JSON.stringify(receipt).length).toBeLessThan(1024);
  expect(snapshot.accountedBytes).toBeLessThanOrEqual(budgets.workerBytes);
  expect(snapshot.sessions[0].snapshot.ownershipEvidence).toBe("unresolved");
  item.observer.onExit({ exitCode: 0 });
  expect(execution.snapshot().sessions[0].snapshot.ownershipEvidence).toBe("closure-proven");
  expect(item.stops).toBe(1);
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
