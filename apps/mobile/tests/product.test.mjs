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
