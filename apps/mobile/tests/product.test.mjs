import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { LocalStore } from "../dist/local-store.js";
import { Operations } from "../dist/operation-store.js";
import { MobileHost } from "../dist/mobile-host.js";
const owned = [];
afterEach(async () => {
  for (const cleanup of owned.splice(0).reverse()) await cleanup();
});
const profile = () => ({
  id: randomUUID(),
  serverId: "server-test",
  peerID: "n123",
  port: 9550,
  label: "Fixture",
  state: "ready",
});
const digest = async (value) => createHash("sha256").update(value).digest("hex");
async function storage(path = ":memory:") {
  const db = new DatabaseSync(path);
  owned.push(() => db.close());
  const sql = {
    execAsync: async (text) => {
      db.exec(text);
    },
    runAsync: async (text, ...values) => db.prepare(text).run(...values),
    getAllAsync: async (text, ...values) => db.prepare(text).all(...values),
  };
  const store = new LocalStore({
    read: sql,
    transaction: async (body) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = await body(sql);
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  });
  await store.initialize();
  return { store, db };
}
function session(handler) {
  return {
    generation: 1,
    calls: [],
    snapshot() {
      return {
        status: "current",
        generation: this.generation,
        identity: { serverId: "server-test", relayInstanceId: "instance-test" },
        operations: [],
      };
    },
    async call(method, params) {
      this.calls.push({ method, params });
      return handler(method, params);
    },
  };
}
const unknown = { ok: false, kind: "operation-unknown", operation: {} };
const missing = { ok: false, kind: "rpc-error", error: { kind: "OPERATION_NOT_FOUND" } };
it("compiled journal survives reopen with original credential slot and immutable digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cove-mobile-product-"));
  owned.push(() => rm(dir, { recursive: true, force: true }));
  const first = await storage(join(dir, "app.db"));
  const p = profile();
  await first.store.putProfile(p);
  const operations = new Operations(first.store, randomUUID, digest);
  const client = session(() => unknown);
  await operations.write(
    p,
    client,
    "task.create",
    { title: "Fixture task", mounts: [] },
    "Create task",
  );
  const before = (await first.store.operations())[0];
  const second = await storage(join(dir, "app.db"));
  expect(await second.store.profiles()).toEqual([p]);
  expect((await second.store.operations())[0]).toEqual(before);
  expect(before.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(before)).not.toContain("Fixture task"); // only digest, not replayable arguments
});
it("durable admission failure prevents the transport call", async () => {
  const { store } = await storage();
  const p = profile();
  await store.putProfile(p);
  const original = store.putOperation.bind(store);
  store.putOperation = async (_row, admission) => {
    if (admission) throw new Error("disk full");
    return original(_row);
  };
  const client = session(() => unknown);
  const operations = new Operations(store, randomUUID, digest);
  await expect(
    operations.write(p, client, "task.create", { title: "Fixture", mounts: [] }, "Create task"),
  ).rejects.toThrow("disk full");
  expect(client.calls).toHaveLength(0);
});
it("cold reconciliation only reads original ID and not-found stays unknown", async () => {
  const { store } = await storage();
  const p = profile();
  await store.putProfile(p);
  const initial = session(() => unknown);
  await new Operations(store, randomUUID, digest).write(
    p,
    initial,
    "task.create",
    { title: "Fixture", mounts: [] },
    "Create task",
  );
  const row = (await store.operations())[0];
  const cold = new Operations(store, randomUUID, digest);
  const client = session(() => missing);
  await cold.reconcile(p, client, row.operationId);
  await cold.reconcile(p, client, row.operationId);
  expect(client.calls).toEqual([
    { method: "operation.get", params: { operationId: row.operationId } },
    { method: "operation.get", params: { operationId: row.operationId } },
  ]);
  expect((await store.operations())[0]).toMatchObject({
    state: "unknown",
    observation: "not-found",
    digest: row.digest,
  });
  await expect(store.acknowledge(row.operationId)).rejects.toThrow("Unresolved");
});
it("new credential slot cannot query an old principal's operation even on same server", async () => {
  const { store } = await storage();
  const p = profile();
  await store.putProfile(p);
  const operations = new Operations(store, randomUUID, digest);
  await operations.write(
    p,
    session(() => unknown),
    "task.create",
    { title: "Fixture", mounts: [] },
    "Create task",
  );
  const client = session(() => missing);
  await expect(
    operations.reconcile(profile(), client, (await store.operations())[0].operationId),
  ).rejects.toThrow("credential slot");
  expect(client.calls).toHaveLength(0);
});
it("lost outcome persistence leaves original ID available for read-only recovery", async () => {
  const { store } = await storage();
  const p = profile();
  await store.putProfile(p);
  const put = store.putOperation.bind(store);
  let fail = true;
  store.putOperation = async (row, admission) => {
    if (!admission && fail) throw new Error("storage result lost");
    return put(row, admission);
  };
  const operations = new Operations(store, randomUUID, digest);
  const client = session(() => unknown);
  await expect(
    operations.write(p, client, "task.create", { title: "Fixture", mounts: [] }, "Create task"),
  ).rejects.toThrow("storage result lost");
  expect(client.calls).toHaveLength(1);
  const row = (await store.operations())[0];
  expect(row.state).toBe("pending");
  fail = false;
  await operations.reconcile(
    p,
    session(() => missing),
    row.operationId,
  );
  expect((await store.operations())[0].state).toBe("unknown");
});
it("background during durable admission fences the write before dispatch", async () => {
  const { store } = await storage();
  const p = profile();
  await store.putProfile(p);
  const client = session(() => unknown);
  const put = store.putOperation.bind(store);
  store.putOperation = async (row, admission) => {
    await put(row, admission);
    if (admission) client.generation++;
  };
  await expect(
    new Operations(store, randomUUID, digest).write(
      p,
      client,
      "task.create",
      { title: "Fixture", mounts: [] },
      "Create task",
    ),
  ).rejects.toThrow("Connection changed");
  expect(client.calls).toHaveLength(0);
  expect((await store.operations())[0].state).toBe("not-sent");
});
it("journal enforces row bound without evicting unresolved records", async () => {
  const { store } = await storage();
  const p = profile();
  const row = {
    profileId: p.id,
    serverId: p.serverId,
    relayInstanceId: "instance-test",
    method: "task.create",
    digest: "a".repeat(64),
    summary: "Create task",
    state: "unknown",
    observation: "unqueried",
    createdAt: 1,
  };
  for (let i = 0; i < 256; i++) await store.putOperation({ ...row, operationId: `op-${i}` }, true);
  await expect(store.putOperation({ ...row, operationId: "op-overflow" }, true)).rejects.toThrow(
    "capacity",
  );
  expect(await store.operations()).toHaveLength(256);
});
it("operation identity is immutable across outcome updates", async () => {
  const { store } = await storage();
  const p = profile();
  await store.putProfile(p);
  await new Operations(store, randomUUID, digest).write(
    p,
    session(() => unknown),
    "task.create",
    { title: "Fixture", mounts: [] },
    "Create task",
  );
  const row = (await store.operations())[0];
  await expect(store.putOperation({ ...row, digest: "b".repeat(64) })).rejects.toThrow(
    "identity mismatch",
  );
  expect((await store.operations())[0].digest).toBe(row.digest);
});
it("late native node open after background is closed without creating entries", async () => {
  const { store } = await storage();
  let release;
  let closes = 0;
  let entries = 0;
  const host = new MobileHost({
    store,
    uuid: randomUUID,
    digest,
    secure: () => ({ read: async () => null, write: async () => {}, remove: async () => {} }),
    openNode: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await host.initialize();
  const opening = host.foreground();
  await new Promise((r) => setTimeout(r, 0));
  host.background();
  release({
    status: '{"state":"Running"}',
    driver: {
      openEntry: () => {
        entries++;
      },
    },
    close: async () => {
      closes++;
    },
  });
  await opening;
  expect(closes).toBe(1);
  expect(entries).toBe(0);
  expect(host.snapshot().foreground).toBe(false);
});
it("read provenance rejects replacement sessions with coincidentally equal counters", async () => {
  const { stampRead, readIsCurrent } = await import("../dist/read-observation.js");
  const first = session(() => missing);
  const second = session(() => missing);
  first.snapshot = () => ({
    status: "current",
    identity: { serverId: "server-test", relayInstanceId: "instance-test" },
    generation: 1,
    mirror: { version: 3 },
  });
  second.snapshot = first.snapshot;
  const stamp = stampRead(first);
  expect(readIsCurrent(stamp, first)).toBe(true);
  expect(readIsCurrent(stamp, second)).toBe(false);
  expect(readIsCurrent(stamp, undefined)).toBe(false);
  first.snapshot = () => ({ status: "stale" });
  expect(readIsCurrent(stamp, first)).toBe(false);
});
it("exact run facts expose runtime controller and qualify stale catalog", async () => {
  const { runFacts } = await import("../dist/read-observation.js");
  const run = { serverId: "server-test", relayInstanceId: "instance-test", runId: "run-test" };
  const state = {
    status: "current",
    identity: { serverId: run.serverId, relayInstanceId: run.relayInstanceId },
    mirror: {
      status: "current",
      records: [
        { kind: "run", record: { run, lifecycle: "running", verification: "live" } },
        {
          kind: "runtime",
          record: {
            run,
            status: "exited",
            controlEpoch: 7,
            controlHolder: { connection: { connectionId: "phone-other" } },
          },
        },
      ],
    },
  };
  expect(runFacts(state, run)).toContain("runtime exited");
  expect(runFacts(state, run)).not.toContain("running / live");
  expect(runFacts(state, run)).toContain("phone-other · epoch 7");
  expect(runFacts({ ...state, status: "stale" }, run)).toContain("unverified");
  expect(runFacts(state, { ...run, relayInstanceId: "old-instance" })).toContain("unverified");
});
it("explicit stop preserves native shutdown rejection and never retries logout", async () => {
  const { store } = await storage();
  let stops = 0;
  let closes = 0;
  let logouts = 0;
  const host = new MobileHost({
    store,
    uuid: randomUUID,
    digest,
    secure: () => ({ read: async () => null }),
    openNode: async () => ({
      status: '{"state":"Running"}',
      driver: {
        nextEvent: () => new Promise(() => {}),
        stop: () => {
          stops++;
          throw new Error("native private failure");
        },
      },
      close: async () => {
        closes++;
        throw new Error("close private detail");
      },
      logout: async () => {
        logouts++;
      },
    }),
  });
  await host.initialize();
  await host.foreground();
  await expect(host.stop()).rejects.toThrow("shutdown-unverified");
  expect(host.snapshot()).toMatchObject({ foreground: false, nodeState: "shutdown-unverified" });
  await expect(host.stop()).rejects.toThrow("shutdown-unverified");
  expect({ stops, closes, logouts }).toEqual({ stops: 1, closes: 1, logouts: 0 });
});
it("explicit stop waits for an in-flight native open to close", async () => {
  const { store } = await storage();
  let release;
  let closeRelease;
  let closes = 0;
  const host = new MobileHost({
    store,
    uuid: randomUUID,
    digest,
    secure: () => ({ read: async () => null }),
    openNode: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await host.initialize();
  const opening = host.foreground();
  await new Promise((r) => setTimeout(r, 0));
  const stopped = host.stop();
  expect(host.snapshot().nodeState).toBe("stopping");
  release({
    status: '{"state":"Running"}',
    close: () => {
      closes++;
      return new Promise((resolve) => {
        closeRelease = resolve;
      });
    },
  });
  await opening;
  await new Promise((r) => setTimeout(r, 0));
  expect(host.snapshot().nodeState).toBe("stopping");
  closeRelease();
  await stopped;
  expect(closes).toBe(1);
  expect(host.snapshot().nodeState).toBe("stopped");
});
it("bootstrap verification retains safe protocol/identity categories without raw response", async () => {
  const { verifyServer } = await import("../dist/entry.js");
  const { PROTOCOL_VERSION, BOOTSTRAP_VERSION } = await import("@cove/protocol/bootstrap");
  const http = (status, value) => ({
    post: (_request, callbacks) => {
      queueMicrotask(() =>
        callbacks.onResponse({ status, headers: {}, body: Buffer.from(JSON.stringify(value)) }),
      );
      return { cancel: () => "handed-off" };
    },
  });
  await expect(
    verifyServer(
      http(200, {
        type: "cove-bootstrap-identity",
        bootstrapVersion: BOOTSTRAP_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        buildVersion: "fixture",
        serverId: "wrong-server",
        relayInstanceId: "instance-test",
      }),
      "server-test",
    ),
  ).rejects.toMatchObject({ failure: { stage: "identity", category: "server-mismatch" } });
  await expect(
    verifyServer(
      http(409, {
        type: "cove-bootstrap-error",
        kind: "PROTOCOL_MISMATCH",
        message: "PROTOCOL MISMATCH",
        supportedVersions: { bootstrap: [BOOTSTRAP_VERSION], protocol: [99] },
      }),
      "server-test",
    ),
  ).rejects.toMatchObject({ failure: { stage: "protocol", category: "protocol-mismatch" } });
});
it("credential store failures remain distinguishable from entry and auth failures", async () => {
  const { connectionReason } = await import("../dist/action-error.js");
  const { store } = await storage();
  const p = profile();
  await store.putProfile(p);
  const host = new MobileHost({
    store,
    uuid: randomUUID,
    digest,
    secure: () => ({
      read: async () => {
        throw new Error("private credential body");
      },
    }),
    openNode: async () => ({
      status: '{"state":"Running"}',
      driver: { nextEvent: () => new Promise(() => {}), stop: () => {} },
      close: async () => {},
    }),
  });
  await host.initialize();
  await host.foreground();
  await expect(host.connect(p.id)).rejects.toMatchObject({
    failure: { stage: "credentials", category: "store-unavailable" },
  });
  expect(JSON.stringify(host.snapshot())).not.toContain("private credential body");
  expect(connectionReason("DEVICE_REVOKED")).toEqual({
    stage: "authentication",
    category: "revoked",
  });
  await host.stop();
});
it("safe connection classification retains pairing identity request delivery", async () => {
  const { pairServer } = await import("../dist/pairing.js");
  const { encodeInvitation } = await import("@cove/protocol/auth");
  const invitation = encodeInvitation({
    version: 1,
    serverId: "server-test",
    inviteId: "invite-test",
    secret: "a".repeat(43),
    expiresAtMs: Date.now() + 60000,
    pairingPort: 9550,
    entries: { tsnet: { nodeId: "serverNode", name: "server.test" } },
  });
  const ports = {
    entry: () => ({
      http: {
        post: (_request, callbacks) => {
          queueMicrotask(() =>
            callbacks.onFailure({ disposition: "not-sent", reason: "transport" }),
          );
          return { cancel: () => "not-sent" };
        },
      },
      close: () => {},
    }),
  };
  await expect(
    pairServer(ports, invitation, "Fixture", {
      write: async () => {
        throw new Error("must not persist");
      },
    }),
  ).rejects.toMatchObject({
    stage: "identity",
    disposition: "not-sent",
    redemptionDisposition: "not-sent",
  });
});
it("a rejected native open settles ownership and allows a later explicit local start", async () => {
  const { store } = await storage();
  let opens = 0;
  const node = {
    status: '{"state":"Running"}',
    driver: { nextEvent: () => new Promise(() => {}), stop: () => {} },
    close: async () => {},
  };
  const host = new MobileHost({
    store,
    uuid: randomUUID,
    digest,
    secure: () => ({ read: async () => null }),
    openNode: async () => {
      opens++;
      if (opens === 1) throw new Error("native open failed");
      return node;
    },
  });
  await host.initialize();
  await expect(host.foreground()).rejects.toThrow("connection");
  expect(host.snapshot().nodeState).toBe("open-unverified");
  await host.foreground();
  expect(opens).toBe(2);
  expect(host.snapshot().nodeState).toBe("Running");
  await host.stop();
});
it("background-cancelled native open does not poison a future explicit start", async () => {
  const { store } = await storage();
  let rejectOpen;
  let opens = 0;
  const host = new MobileHost({
    store,
    uuid: randomUUID,
    digest,
    secure: () => ({ read: async () => null }),
    openNode: () => {
      opens++;
      return opens === 1
        ? new Promise((_resolve, reject) => {
            rejectOpen = reject;
          })
        : Promise.resolve({
            status: '{"state":"Running"}',
            driver: { nextEvent: () => new Promise(() => {}), stop: () => {} },
            close: async () => {},
          });
    },
  });
  await host.initialize();
  const opening = host.foreground();
  await new Promise((r) => setTimeout(r, 0));
  host.background();
  rejectOpen(new Error("native epoch cancelled"));
  await expect(opening).rejects.toThrow("connection");
  await new Promise((r) => setTimeout(r, 0));
  expect(host.snapshot().nodeState).toBe("shutdown-unverified");
  await host.foreground();
  expect(opens).toBe(2);
  expect(host.snapshot().nodeState).toBe("Running");
  await host.stop();
});
