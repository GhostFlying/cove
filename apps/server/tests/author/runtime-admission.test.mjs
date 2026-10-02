import { describe, it, expect } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { encodePipeFrame } from "@cove/protocol/pipe";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { WorkerPipeSession } from "../../dist/terminal/worker-pipe-session.js";
import { WorkerPool } from "../../dist/terminal/worker-pool.js";
import { RunRegistry } from "../../dist/terminal/run-registry.js";
import { LocalRuntime } from "../../dist/terminal/local-runtime.js";

const codec = {
  encode: (text) => new TextEncoder().encode(text),
  decode: (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
};
const run = (id) => ({ serverId: "server", relayInstanceId: "instance", runId: id });
const worker = (id) => ({
  serverId: "server",
  relayInstanceId: "instance",
  workerId: id,
  workerIncarnationId: `${id}-birth`,
});
const status = (ref, state = "live") => ({
  run: ref,
  status: state,
  geometry: { cols: 80, rows: 24 },
  controlEpoch: 0,
  controlHolder: null,
  receivedSeq: 0,
  parsedSeq: 0,
  recovery: "ready",
  exitCode: null,
  signal: null,
});
const compositionFixture = (bytes, budgets = { ...M0_LIMITS }) =>
  new RuntimeComposition("server", "instance", budgets, bytes);
function sessionFixture(composition, ref) {
  const budgets = composition.budgets;
  const writes = [];
  const session = new WorkerPipeSession({
    worker: ref,
    composition,
    buildVersion: "author",
    codec,
    transport: {
      write: (bytes, done) => {
        writes.push(bytes);
        done();
        return true;
      },
    },
    now: () => 0,
    timeoutMs: 100,
    identityLimit: 16,
  });
  session.start();
  const ready = encodePipeFrame(
    2,
    codec.encode(
      JSON.stringify({
        type: "ready",
        worker: ref,
        pipeVersion: 2,
        buildVersion: "different-build",
        effectiveBudgets: budgets,
      }),
    ),
    new Uint8Array(),
  );
  session.receive(ready.value);
  return { session, writes };
}

function rejectReadyWorker(change, foreignBytes = null, foreignBudgets = { ...M0_LIMITS }) {
  const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
  const composition = compositionFixture(bytes);
  const account = foreignBytes ?? bytes;
  const ref = { ...worker("foreign"), ...change };
  const foreignComposition = new RuntimeComposition(
    ref.serverId,
    ref.relayInstanceId,
    foreignBudgets,
    account,
  );
  const foreign = sessionFixture(foreignComposition, ref).session;
  expect(foreign.ready).toBe(true);
  const pool = new WorkerPool(composition, 1, 1);
  const registry = new RunRegistry(composition);
  const runtime = new LocalRuntime(pool, registry, codec.encode);
  const before = bytes.snapshot();
  const foreignBefore = account.snapshot();
  let listeners = 0;
  const subscribe = foreign.onEvent.bind(foreign);
  foreign.onEvent = (...args) => {
    listeners++;
    return subscribe(...args);
  };
  expect(runtime.addWorker(foreign)).toBe(false);
  expect(pool.add(foreign)).toBe(false);
  expect(listeners).toBe(0);
  expect(pool.snapshot().workers).toBe(0);
  expect(bytes.snapshot()).toEqual(before);
  expect(account.snapshot()).toEqual(foreignBefore);
  const local = sessionFixture(composition, worker("local")).session;
  expect(runtime.addWorker(local)).toBe(true);
  expect(runtime.reserveRun(run("one"), { cols: 80, rows: 24 }).workerId).toBe("local");
  runtime.dispose();
  local.transportReleased();
  foreign.loseContact();
  foreign.transportReleased();
  return [bytes.snapshot().total, account.snapshot().total];
}

describe("runtime admission ownership", () => {
  it("rejects invalid budgets and authority without acquiring bytes", () => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    for (const budgets of [
      { ...M0_LIMITS, maxRuns: 0 },
      { ...M0_LIMITS, parseLowBytes: M0_LIMITS.parseHighBytes },
      { ...M0_LIMITS, runtimeBytes: M0_LIMITS.runtimeBytes - 1 },
    ]) {
      expect(() => compositionFixture(bytes, budgets)).toThrow("Invalid runtime composition");
    }
    expect(() => new RuntimeComposition("", "instance", { ...M0_LIMITS }, bytes)).toThrow(
      "Invalid runtime composition",
    );
    expect(bytes.snapshot().total).toBe(0);
  });

  it("freezes the validated effective budgets independently of caller mutations", () => {
    const budgets = { ...M0_LIMITS };
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const composition = compositionFixture(bytes, budgets);
    budgets.maxRuns = 1;
    budgets.runtimeBytes = 1;
    expect(composition.budgets.maxRuns).toBe(M0_LIMITS.maxRuns);
    expect(composition.budgets.runtimeBytes).toBe(M0_LIMITS.runtimeBytes);
    expect(Object.isFrozen(composition)).toBe(true);
    expect(Object.isFrozen(composition.budgets)).toBe(true);
  });

  it("rejects an equal-limit separate registry ledger at runtime construction", () => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const otherBytes = new RuntimeRetainedBytes(bytes.limit, bytes.controlReserve);
    const pool = new WorkerPool(compositionFixture(bytes), 1, 1);
    const registry = new RunRegistry(compositionFixture(otherBytes));
    expect(() => new LocalRuntime(pool, registry, codec.encode)).toThrow("Runtime budget mismatch");
    expect(pool.snapshot().workers).toBe(0);
    expect(bytes.snapshot().total).toBe(0);
    expect(otherBytes.snapshot().total).toBe(0);
    pool.dispose();
    registry.dispose();
  });

  it("rejects a separately validated registry budget even with the same ledger", () => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const pool = new WorkerPool(compositionFixture(bytes), 1, 1);
    const registry = new RunRegistry(
      compositionFixture(bytes, { ...M0_LIMITS, maxRuns: 1, listPage: 1 }),
    );
    expect(() => new LocalRuntime(pool, registry, codec.encode)).toThrow("Runtime budget mismatch");
    expect(bytes.snapshot().total).toBe(0);
    pool.dispose();
    registry.dispose();
  });

  it("rejects a ready session on an equal-limit distinct ledger before listeners or slots", () => {
    expect(
      rejectReadyWorker({}, new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024)),
    ).toEqual([0, 0]);
  });

  it("rejects a ready foreign-server session without consuming the sole local slot", () => {
    expect(rejectReadyWorker({ serverId: "foreign-server" })).toEqual([0, 0]);
  });

  it("rejects a ready foreign-relay session without consuming the sole local slot", () => {
    expect(rejectReadyWorker({ relayInstanceId: "foreign-instance" })).toEqual([0, 0]);
  });

  it("rejects a ready session with different validated budgets on the same ledger", () => {
    expect(rejectReadyWorker({}, null, { ...M0_LIMITS, maxRuns: 1, listPage: 1 })).toEqual([0, 0]);
  });

  it("rejects a foreign worker at session construction before arena or transport ownership", () => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const composition = compositionFixture(bytes);
    let writes = 0;
    expect(
      () =>
        new WorkerPipeSession({
          composition,
          worker: { ...worker("foreign"), relayInstanceId: "foreign-instance" },
          buildVersion: "author",
          codec,
          transport: {
            write: () => {
              writes++;
              return true;
            },
          },
          now: () => 0,
          timeoutMs: 100,
          identityLimit: 1,
        }),
    ).toThrow("Invalid session limits");
    expect(writes).toBe(0);
    expect(bytes.snapshot().total).toBe(0);
  });

  it("keeps control carve-out inside total at exact cap and refuses cap plus one", () => {
    const bytes = new RuntimeRetainedBytes(100, 20);
    const ordinary = bytes.reserve(80);
    expect(ordinary).not.toBeNull();
    expect(bytes.reserve(1)).toBeNull();
    const control = bytes.reserve(20, true);
    expect(control).not.toBeNull();
    expect(bytes.reserve(1, true)).toBeNull();
    ordinary.release();
    ordinary.release();
    control.release();
    expect(bytes.snapshot().total).toBe(0);
  });

  it("charges a shared full backing until its final subarray owner releases", () => {
    const bytes = new RuntimeRetainedBytes(356, 0);
    const storage = new Uint8Array(100);
    const a = bytes.retainBacking(storage.subarray(0, 1));
    const b = bytes.retainBacking(storage.subarray(99));
    expect(bytes.snapshot().total).toBe(356);
    a.release();
    a.release();
    expect(bytes.snapshot().total).toBe(356);
    b.release();
    expect(bytes.snapshot().total).toBe(0);
  });

  it("places on the least assigned ready worker without automatic replacement", () => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const composition = compositionFixture(bytes);
    const a = sessionFixture(composition, worker("a"));
    const b = sessionFixture(composition, worker("b"));
    const pool = new WorkerPool(composition, 2, 2);
    expect(pool.add(a.session)).toBe(true);
    expect(pool.add(b.session)).toBe(true);
    expect(pool.reserve(run("one")).worker.workerId).toBe("a");
    expect(pool.reserve(run("two")).worker.workerId).toBe("b");
    a.session.loseContact();
    b.session.loseContact();
    expect(pool.reserve(run("three"))).toBeNull();
    expect(pool.snapshot().workers).toBe(2);
    pool.dispose();
    expect(bytes.snapshot().total).toBe(0);
  });

  it("refuses run cap plus one with no new byte or placement ownership", () => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const budgets = { ...M0_LIMITS, maxRuns: 1, listPage: 1 };
    const composition = compositionFixture(bytes, budgets);
    const { session } = sessionFixture(composition, worker("a"));
    const pool = new WorkerPool(composition, 1, 1);
    const registry = new RunRegistry(composition, 1);
    const runtime = new LocalRuntime(pool, registry, codec.encode);
    runtime.addWorker(session);
    expect(runtime.reserveRun(run("one"), { cols: 80, rows: 24 })).not.toBeNull();
    const before = bytes.snapshot();
    expect(runtime.reserveRun(run("two"), { cols: 80, rows: 24 })).toBeNull();
    expect(bytes.snapshot()).toEqual(before);
    runtime.dispose();
    expect(bytes.snapshot().total).toBe(0);
  });

  it("keeps known exit evidence and downgrades live only to unverifiable on contact loss", () => {
    const bytes = new RuntimeRetainedBytes(100_000, 0);
    const registry = new RunRegistry(compositionFixture(bytes), 2);
    registry.reserve(run("live"), worker("a"), { cols: 80, rows: 24 });
    registry.reserve(run("done"), worker("a"), { cols: 80, rows: 24 });
    registry.observe(worker("a"), status(run("live")));
    registry.observe(worker("a"), status(run("done"), "exited"));
    registry.contactLost(worker("a"));
    expect(registry.get(run("live")).status.status).toBe("unverifiable");
    expect(registry.get(run("done")).status.status).toBe("exited");
    expect(registry.observe(worker("a"), status(run("done")))).toBe(false);
    registry.dispose();
  });

  it("rejects foreign incarnation observations and returns detached status snapshots", () => {
    const bytes = new RuntimeRetainedBytes(100_000, 0);
    const registry = new RunRegistry(compositionFixture(bytes), 1);
    registry.reserve(run("one"), worker("a"), { cols: 80, rows: 24 });
    expect(
      registry.observe({ ...worker("a"), workerIncarnationId: "foreign" }, status(run("one"))),
    ).toBe(false);
    registry.get(run("one")).status.geometry.cols = 2;
    expect(registry.get(run("one")).status.geometry.cols).toBe(80);
    registry.dispose();
  });

  it("retains run identity after explicit native-owner capacity release", () => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const composition = compositionFixture(bytes);
    const { session } = sessionFixture(composition, worker("a"));
    const pool = new WorkerPool(composition, 1, 1);
    const registry = new RunRegistry(composition, 2);
    const runtime = new LocalRuntime(pool, registry, codec.encode);
    runtime.addWorker(session);
    runtime.reserveRun(run("one"), { cols: 80, rows: 24 });
    const proof = {
      run: run("one"),
      worker: worker("a"),
      writerClosed: true,
      directlyOwnedLeaderExited: true,
    };
    expect(runtime.releaseOwnedCapacity(proof)).toBe(true);
    expect(runtime.releaseOwnedCapacity(proof)).toBe(false);
    expect(runtime.reserveRun(run("one"), { cols: 80, rows: 24 })).toBeNull();
    expect(runtime.reserveRun(run("two"), { cols: 80, rows: 24 })).not.toBeNull();
    runtime.dispose();
    expect(bytes.snapshot().total).toBe(0);
  });

  it("refuses session arena before any transport side effect when runtime bytes are insufficient", () => {
    const bytes = new RuntimeRetainedBytes(1, 0);
    let writes = 0;
    expect(
      () =>
        new WorkerPipeSession({
          worker: worker("a"),
          composition: compositionFixture(bytes),
          buildVersion: "author",
          codec,
          transport: {
            write: () => {
              writes++;
              return true;
            },
          },
          now: () => 0,
          timeoutMs: 100,
          identityLimit: 1,
        }),
    ).toThrow("Invalid session limits");
    expect(writes).toBe(0);
    expect(bytes.snapshot().total).toBe(0);
  });
});
