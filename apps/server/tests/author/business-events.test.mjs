import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUSINESS_LIMITS, businessRunId } from "@cove/protocol/business-events";
import { M0_CAPABILITIES } from "@cove/protocol/bootstrap";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { PROFILE, BASELINE_ENCODING } from "@cove/protocol/profile";
import { BusinessEventStream } from "../../dist/business/event-stream.js";
import { BusinessSnapshots } from "../../dist/business/snapshot.js";
import { BusinessWebSocket } from "../../dist/transport/business-websocket.js";
import { LocalAdmission } from "../../dist/transport/local-admission.js";
import { DeviceConnections } from "../../dist/auth/connections.js";
import { Store } from "../../dist/store/database.js";
import { prepareHome } from "../../dist/store/home.js";
import { loadOrCreateIdentity, recordInstanceStart } from "../../dist/store/identity.js";
import { RunLog } from "../../dist/store/runs.js";
import { RecordingRunRegistry } from "../../dist/entry/recording-run-registry.js";
import { LocalRuntime } from "../../dist/terminal/local-runtime.js";
import { WorkerPool } from "../../dist/terminal/worker-pool.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";

const identity = { serverId: "server", relayInstanceId: "instance" };
const encoder = (text) => new TextEncoder().encode(text);
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const repo = (name = "one") => ({
  kind: "repo",
  id: "repo",
  record: {
    repoId: "repo",
    revision: 0,
    displayName: name,
    path: "/fixture/repo",
    mainBranch: null,
    registeredAtMs: 1,
  },
});
const upsert = (value) => ({ type: "upsert", value });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cove-business-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const layout = await prepareHome(join(root, "home"));
  const store = await Store.open({
    databasePath: layout.databasePath,
    backupDirectory: layout.backupDirectory,
    operationModules: [new URL("./store-test-operations.mjs", import.meta.url).href],
  });
  cleanup.push(() => store.close().catch(() => undefined));
  const persistent = await loadOrCreateIdentity(store);
  await recordInstanceStart(store, "instance", 1);
  const composition = new RuntimeComposition(
    persistent.serverId,
    "instance",
    { ...M0_LIMITS },
    new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024),
  );
  const runs = new RunLog(store, () => 2);
  const registry = new RecordingRunRegistry(composition, runs);
  const runtime = new LocalRuntime(
    new WorkerPool(composition, 1, M0_LIMITS.maxRuns),
    registry,
    encoder,
  );
  cleanup.push(() => runtime.dispose());
  const snapshots = new BusinessSnapshots(store, runtime, join(layout.home, "workspace"), ids());
  cleanup.push(() => snapshots.close());
  const sql = (sql, params = []) => store.call("test.run", { sql, params });
  const insertRepo = () =>
    sql("INSERT INTO repos VALUES('repo',0,'before','/fixture/repo','/fixture/repo/.git',NULL,1)");
  return { root, layout, store, composition, runtime, registry, runs, snapshots, sql, insertRepo };
}

describe("bounded publication window", () => {
  it("captures immutable records and replays exact contiguous global ranges through kind filters", () => {
    const stream = new BusinessEventStream(identity, ids());
    const original = repo();
    const all = stream.capture([original], [], {});
    const captured = stream.capture([original], [], { kinds: ["task"] });
    original.record.displayName = "mutated";
    expect(all.records[0].record.displayName).toBe("one");
    stream.publish([upsert(repo("later"))]);
    const received = [];
    const subscription = stream.subscribe({ kinds: ["task"] }, captured.cursor, (frame) =>
      received.push(frame),
    );
    expect(typeof subscription).toBe("object");
    expect(received).toMatchObject([
      { type: "changes", after: { sequence: 0 }, cursor: { sequence: 1 }, changes: [] },
    ]);
    expect(captured.records).toEqual([]);
    subscription.dispose();
  });
  it("rejects foreign identities, altered filters and old publication generations explicitly", () => {
    const stream = new BusinessEventStream(identity, ids());
    const cursor = stream.cursor({});
    expect(stream.subscribe({}, { ...cursor, relayInstanceId: "old" }, () => {})).toBe("identity");
    expect(stream.subscribe({ kinds: ["task"] }, cursor, () => {})).toBe("filter");
    stream.invalidate("publication-uncertain");
    expect(stream.subscribe({}, cursor, () => {})).toBe("generation");
  });
  it("evicts a bounded window and reports gaps without silently resuming now", () => {
    const stream = new BusinessEventStream(identity, ids(), {
      bytes: 4096,
      items: 1,
      subscriptions: 1,
    });
    const old = stream.cursor({});
    stream.publish([upsert(repo())]);
    stream.publish([upsert(repo("two"))]);
    expect(stream.retained.items).toBe(1);
    expect(stream.subscribe({}, old, () => {})).toBe("gap");
    expect(stream.subscribe({}, { ...stream.cursor({}), sequence: 99 }, () => {})).toBe("gap");
  });
  it("invalidates subscribers on an oversized committed publication and enforces subscriber count", () => {
    const stream = new BusinessEventStream(identity, ids(), {
      bytes: 200,
      items: 10,
      subscriptions: 1,
    });
    const received = [];
    const old = stream.cursor({});
    stream.subscribe({}, old, (frame) => received.push(frame));
    expect(stream.subscribe({}, old, () => {})).toBe("busy");
    stream.publish([upsert(repo("a".repeat(128)))]);
    expect(received.at(-1)).toEqual({ type: "reset", reason: "overflow" });
    expect(stream.retained).toEqual({ bytes: 0, items: 0, subscriptions: 0 });
  });
});

describe("compiled worker transaction and runtime barrier", () => {
  it("captures one immutable DB view and replays a later commit even before its caller resumes", async () => {
    const f = await fixture();
    await f.insertRepo();
    const initial = await f.snapshots.capture({});
    expect(initial.records.find((value) => value.kind === "repo").record.displayName).toBe(
      "before",
    );
    initial.release();
    const reading = f.snapshots.capture({});
    const writing = f.sql(
      "UPDATE repos SET display_name='after',revision=revision+1 WHERE repo_id='repo'",
    );
    const captured = await reading;
    await writing;
    expect(captured.records.find((value) => value.kind === "repo").record.displayName).toBe(
      "before",
    );
    const events = [];
    const sub = f.snapshots.stream.subscribe({}, captured.cursor, (event) => events.push(event));
    expect(
      events.flatMap((event) => event.changes ?? []).find((change) => change.value?.kind === "repo")
        .value.record.displayName,
    ).toBe("after");
    captured.release();
    sub.dispose();
  });
  it("rolls journal changes back with the business transaction", async () => {
    const f = await fixture();
    await f.insertRepo();
    const before = f.snapshots.stream.cursor({});
    await expect(
      f.store.call("test.failAfterWrite", { sql: "UPDATE repos SET display_name='lost'" }),
    ).rejects.toThrow("injected failure");
    expect(f.snapshots.stream.cursor({})).toEqual(before);
    const captured = await f.snapshots.capture({});
    expect(captured.records.find((value) => value.kind === "repo").record.displayName).toBe(
      "before",
    );
    captured.release();
  });
  it("invalidates rather than hiding a commit whose result cannot be cloned", async () => {
    const f = await fixture();
    await f.insertRepo();
    const frames = [];
    const before = f.snapshots.stream.cursor({});
    f.snapshots.stream.subscribe({}, before, (frame) => frames.push(frame));
    await f.store.call("test.armAfterCommit", { operation: "test.run", mode: "unanswerable" });
    await expect(f.sql("UPDATE repos SET display_name='committed'")).rejects.toMatchObject({
      outcome: "unknown",
    });
    expect(frames.at(-1)).toEqual({ type: "reset", reason: "publication-uncertain" });
    expect(f.snapshots.stream.cursor({}).streamId).not.toBe(before.streamId);
    await expect(f.snapshots.capture({})).rejects.toThrow("The Cove store is not available");
  });
  it("orders confirmed exit before its delayed durable row without resurrection, and preserves contact loss as unknown", async () => {
    const f = await fixture();
    const run = { serverId: f.composition.serverId, relayInstanceId: "instance", runId: "run" };
    const worker = {
      serverId: f.composition.serverId,
      relayInstanceId: "instance",
      workerId: "worker",
      workerIncarnationId: "incarnation",
    };
    await f.runs.started(run, "/fixture", null);
    expect(f.registry.reserve(run, worker, { cols: 80, rows: 24 })).toBe(true);
    f.registry.contactLost(worker);
    expect(f.snapshots.fact(run).record.status).toBe("unverifiable");
    const reading = f.snapshots.capture({});
    f.registry.observeExit(worker, run, { exitCode: 0, signal: null });
    const captured = await reading;
    expect(captured.records.find((value) => value.kind === "runtime").record.status).toBe("exited");
    await f.store.call("config.read", undefined); // FIFO barrier after RecordingRunRegistry's queued exit.
    expect(f.snapshots.fact(run).record.status).toBe("exited");
    expect(businessRunId(run)).toBe(captured.records.find((value) => value.kind === "runtime").id);
    captured.release();
  });
  it("caps retained immutable snapshots until their delivery lease is released", async () => {
    const f = await fixture();
    const retained = [];
    for (let i = 0; i < BUSINESS_LIMITS.concurrentSnapshots; i++)
      retained.push(await f.snapshots.capture({}));
    expect(await f.snapshots.capture({})).toEqual({ error: "busy" });
    retained[0].release();
    const next = await f.snapshots.capture({});
    expect(next.records).toBeDefined();
    next.release();
    for (const snapshot of retained) snapshot.release();
  });
});

class Socket extends EventEmitter {
  frames = [];
  closed = false;
  hold = false;
  hook;
  send(text, callback) {
    const frame = JSON.parse(text);
    this.frames.push(frame);
    if (this.hold) return;
    void Promise.resolve(this.hook?.(frame)).then(() => callback(), callback);
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.emit("close");
    }
  }
  message(value) {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }
}
async function socketFixture(f, auth) {
  const secret = "s".repeat(43);
  const admission = new LocalAdmission(
    { host: "127.0.0.1", port: 32123, allowedOrigins: [] },
    secret,
    f.composition,
    M0_LIMITS,
    f.composition.bytes,
    auth,
  );
  const transport = new BusinessWebSocket(
    admission,
    { runtime: f.runtime, buildVersion: "fixture", ...(auth ? { auth } : {}) },
    f.snapshots,
    () => 1,
  );
  cleanup.push(() => transport.close());
  const socket = new Socket();
  transport.accept(socket, admission.claim("unauthenticated"), "loopback");
  socket.message({
    type: "cove-bootstrap",
    bootstrapVersion: 1,
    protocolVersion: 2,
    buildVersion: "client",
    expectedServerId: f.composition.serverId,
    expectedRelayInstanceId: "instance",
    capabilities: [...M0_CAPABILITIES],
    profiles: [PROFILE],
    encodings: [BASELINE_ENCODING],
    secret,
  });
  await waitFor(() => socket.frames.some((frame) => frame.type === "cove-bootstrap-result"));
  return { socket, admission, transport };
}
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("Expected business stream transition did not arrive");
}
it("serves snapshot/end/replay/ready on an authenticated separate compiled business socket", async () => {
  const f = await fixture();
  await f.insertRepo();
  const secret = "s".repeat(43);
  const admission = new LocalAdmission(
    { host: "127.0.0.1", port: 32123, allowedOrigins: [] },
    secret,
    f.composition,
    M0_LIMITS,
    f.composition.bytes,
  );
  const transport = new BusinessWebSocket(
    admission,
    { runtime: f.runtime, buildVersion: "fixture" },
    f.snapshots,
    () => 1,
  );
  cleanup.push(() => transport.close());
  const socket = new Socket();
  transport.accept(socket, admission.claim("unauthenticated"), "loopback");
  socket.message({
    type: "cove-bootstrap",
    bootstrapVersion: 1,
    protocolVersion: 2,
    buildVersion: "client",
    expectedServerId: f.composition.serverId,
    expectedRelayInstanceId: "instance",
    capabilities: [...M0_CAPABILITIES],
    profiles: [PROFILE],
    encodings: [BASELINE_ENCODING],
    secret,
  });
  await waitFor(() => socket.frames.some((frame) => frame.type === "cove-bootstrap-result"));
  socket.message({ type: "subscribe", filter: {} });
  await waitFor(() => socket.frames.some((frame) => frame.type === "ready"));
  expect(socket.frames.map((frame) => frame.type)).toEqual([
    "cove-bootstrap-result",
    "snapshot-begin",
    "snapshot-page",
    "snapshot-end",
    "ready",
  ]);
  await f.sql("DELETE FROM repos WHERE repo_id='repo'");
  await waitFor(() => socket.frames.some((frame) => frame.type === "changes"));
  expect(socket.frames.at(-1).changes).toContainEqual({ type: "delete", kind: "repo", id: "repo" });
  socket.close();
  expect(admission.snapshot().authenticated).toBe(0);
});

it("keeps all snapshot pages on one view while a committed mutation waits behind the snapshot", async () => {
  const f = await fixture();
  await f.sql(`WITH RECURSIVE ids(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM ids WHERE x<400)
    INSERT INTO repos SELECT printf('repo%04d',x),0,'before','/fixture/'||hex(zeroblob(512))||x,'/git/'||x,NULL,1 FROM ids`);
  const { socket } = await socketFixture(f);
  let injected = false;
  socket.hook = async (frame) => {
    if (frame.type === "snapshot-page" && !injected) {
      injected = true;
      await f.sql("UPDATE repos SET display_name='after',revision=1 WHERE repo_id='repo0001'");
    }
  };
  socket.message({ type: "subscribe", filter: {} });
  await waitFor(() => socket.frames.some((frame) => frame.type === "changes"));
  const pages = socket.frames.filter((frame) => frame.type === "snapshot-page");
  expect(pages.length).toBeGreaterThan(1);
  expect(
    pages.flatMap((page) => page.records).find((value) => value.id === "repo0001").record
      .displayName,
  ).toBe("before");
  const end = socket.frames.findIndex((frame) => frame.type === "snapshot-end");
  const change = socket.frames.findIndex((frame) => frame.type === "changes");
  expect(change).toBeGreaterThan(end);
  expect(
    socket.frames[change].changes.find((value) => value.value?.id === "repo0001").value.record
      .displayName,
  ).toBe("after");
  socket.close();
});

it("closes an overflowing slow snapshot consumer and returns its subscription, admission and snapshot lease", async () => {
  const f = await fixture();
  await f.insertRepo();
  const { socket, admission } = await socketFixture(f);
  socket.hold = true;
  socket.message({ type: "subscribe", filter: {} });
  await waitFor(() => socket.frames.some((frame) => frame.type === "snapshot-begin"));
  for (let i = 0; i <= BUSINESS_LIMITS.queueItems; i++)
    f.snapshots.stream.publish([upsert(repo(String(i)))]);
  await waitFor(() => socket.closed);
  expect(f.snapshots.stream.retained.subscriptions).toBe(0);
  expect(admission.snapshot().authenticated).toBe(0);
  const retained = [];
  for (let i = 0; i < BUSINESS_LIMITS.concurrentSnapshots; i++)
    retained.push(await f.snapshots.capture({}));
  expect(retained.every((value) => "release" in value)).toBe(true);
  for (const value of retained) value.release();
});

it("registers admitted device event sockets for synchronous revocation and tears down their stream", async () => {
  const f = await fixture();
  const connections = new DeviceConnections();
  const verdict = { kind: "device", deviceId: "device", principalId: "owner", confirm: false };
  const auth = { authenticate: () => verdict, admitted: () => {}, connections };
  const { socket, admission } = await socketFixture(f, auth);
  socket.message({ type: "subscribe", filter: {} });
  await waitFor(() => socket.frames.some((frame) => frame.type === "ready"));
  expect(connections.count("device")).toBe(1);
  expect(await connections.closeDevice("device", 100)).toBe(0);
  expect(socket.closed).toBe(true);
  expect(f.snapshots.stream.retained.subscriptions).toBe(0);
  expect(admission.snapshot().authenticated).toBe(0);
});
