import { describe, it, expect } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { encodePipeFrame } from "@cove/protocol/pipe";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import { WorkerPipeSession } from "../../dist/terminal/worker-pipe-session.js";
import { WorkerPool } from "../../dist/terminal/worker-pool.js";
import { RunRegistry } from "../../dist/terminal/run-registry.js";
import { LocalRuntime } from "../../dist/terminal/local-runtime.js";

const codec = { encode: (text) => new TextEncoder().encode(text),
  decode: (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
const run = (id) => ({ serverId: "server", relayInstanceId: "instance", runId: id });
const worker = (id) => ({ serverId: "server", relayInstanceId: "instance", workerId: id,
  workerIncarnationId: `${id}-birth` });
const status = (ref, state = "live") => ({ run: ref, status: state, geometry: { cols: 80, rows: 24 },
  controlEpoch: 0, controlHolder: null, receivedSeq: 0, parsedSeq: 0,
  recovery: "ready", exitCode: null, signal: null });
function sessionFixture(account, ref, budgets = { ...M0_LIMITS }) {
  const writes = [];
  const session = new WorkerPipeSession({ worker: ref, budgets, buildVersion: "author",
    bytes: account, codec, transport: { write: (bytes, done) => { writes.push(bytes); done(); return true; } },
    now: () => 0, timeoutMs: 100, identityLimit: 16 });
  session.start();
  const ready = encodePipeFrame(2, codec.encode(JSON.stringify({ type: "ready", worker: ref,
    pipeVersion: 2, buildVersion: "different-build", effectiveBudgets: budgets })), new Uint8Array());
  session.receive(ready.value);
  return { session, writes };
}

describe("runtime admission ownership", () => {
  it("keeps control carve-out inside total at exact cap and refuses cap plus one", () => {
    const bytes = new RuntimeRetainedBytes(100, 20);
    const ordinary = bytes.reserve(80);
    expect(ordinary).not.toBeNull();
    expect(bytes.reserve(1)).toBeNull();
    const control = bytes.reserve(20, true);
    expect(control).not.toBeNull();
    expect(bytes.reserve(1, true)).toBeNull();
    ordinary.release(); ordinary.release(); control.release();
    expect(bytes.snapshot().total).toBe(0);
  });

  it("charges a shared full backing until its final subarray owner releases", () => {
    const bytes = new RuntimeRetainedBytes(356, 0);
    const storage = new Uint8Array(100);
    const a = bytes.retainBacking(storage.subarray(0, 1));
    const b = bytes.retainBacking(storage.subarray(99));
    expect(bytes.snapshot().total).toBe(356);
    a.release(); a.release();
    expect(bytes.snapshot().total).toBe(356);
    b.release();
    expect(bytes.snapshot().total).toBe(0);
  });

  it("places on the least assigned ready worker without automatic replacement", () => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const a = sessionFixture(bytes, worker("a"));
    const b = sessionFixture(bytes, worker("b"));
    const pool = new WorkerPool({ ...M0_LIMITS }, bytes, 2, 2);
    expect(pool.add(a.session)).toBe(true); expect(pool.add(b.session)).toBe(true);
    expect(pool.reserve(run("one")).worker.workerId).toBe("a");
    expect(pool.reserve(run("two")).worker.workerId).toBe("b");
    a.session.loseContact(); b.session.loseContact();
    expect(pool.reserve(run("three"))).toBeNull();
    expect(pool.snapshot().workers).toBe(2);
    pool.dispose();
    expect(bytes.snapshot().total).toBe(0);
  });

  it("refuses run cap plus one with no new byte or placement ownership", () => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const budgets = { ...M0_LIMITS, maxRuns: 1, listPage: 1 };
    const { session } = sessionFixture(bytes, worker("a"), budgets);
    const pool = new WorkerPool(budgets, bytes, 1, 1);
    const registry = new RunRegistry("server", "instance", 1, bytes);
    const runtime = new LocalRuntime(pool, registry, bytes, codec.encode);
    runtime.addWorker(session);
    expect(runtime.reserveRun(run("one"), { cols: 80, rows: 24 })).not.toBeNull();
    const before = bytes.snapshot();
    expect(runtime.reserveRun(run("two"), { cols: 80, rows: 24 })).toBeNull();
    expect(bytes.snapshot()).toEqual(before);
    runtime.dispose(); expect(bytes.snapshot().total).toBe(0);
  });

  it("keeps known exit evidence and downgrades live only to unverifiable on contact loss", () => {
    const bytes = new RuntimeRetainedBytes(100_000, 0);
    const registry = new RunRegistry("server", "instance", 2, bytes);
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
    const registry = new RunRegistry("server", "instance", 1, bytes);
    registry.reserve(run("one"), worker("a"), { cols: 80, rows: 24 });
    expect(registry.observe({ ...worker("a"), workerIncarnationId: "foreign" }, status(run("one")))).toBe(false);
    registry.get(run("one")).status.geometry.cols = 2;
    expect(registry.get(run("one")).status.geometry.cols).toBe(80);
    registry.dispose();
  });

  it("retains run identity after explicit native-owner capacity release", () => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const { session } = sessionFixture(bytes, worker("a"));
    const pool = new WorkerPool({ ...M0_LIMITS }, bytes, 1, 1);
    const registry = new RunRegistry("server", "instance", 2, bytes);
    const runtime = new LocalRuntime(pool, registry, bytes, codec.encode);
    runtime.addWorker(session);
    runtime.reserveRun(run("one"), { cols: 80, rows: 24 });
    const proof = { run: run("one"), worker: worker("a"), writerClosed: true, directlyOwnedLeaderExited: true };
    expect(runtime.releaseOwnedCapacity(proof)).toBe(true);
    expect(runtime.releaseOwnedCapacity(proof)).toBe(false);
    expect(runtime.reserveRun(run("one"), { cols: 80, rows: 24 })).toBeNull();
    expect(runtime.reserveRun(run("two"), { cols: 80, rows: 24 })).not.toBeNull();
    runtime.dispose(); expect(bytes.snapshot().total).toBe(0);
  });

  it("refuses session arena before any transport side effect when runtime bytes are insufficient", () => {
    const bytes = new RuntimeRetainedBytes(1, 0);
    let writes = 0;
    expect(() => new WorkerPipeSession({ worker: worker("a"), budgets: { ...M0_LIMITS },
      bytes, buildVersion: "author", codec, transport: { write: () => { writes++; return true; } },
      now: () => 0, timeoutMs: 100, identityLimit: 1 })).toThrow();
    expect(writes).toBe(0); expect(bytes.snapshot().total).toBe(0);
  });
});
