import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DesktopStorage } from "../dist/types/node/main/storage.js";
import { DesktopHost } from "../dist/types/node/main/host.js";
import { createM1Fixture } from "../../cli/tests/m1/fixtures.mjs";
import { waitFor } from "../../cli/tests/recording-view.mjs";

let fixture;
const hosts = [];
beforeEach(async () => {
  fixture = await createM1Fixture();
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.dispose());
  await fixture?.cleanup();
  fixture = undefined;
});
// This injected test cipher isolates actual host/domain behavior; it is not Keychain evidence.
const testCipher = {
  available: async () => true,
  encrypt: async (value) => Buffer.from(value).map((byte) => byte ^ 0xa5),
  decrypt: async (value) =>
    Buffer.from(value)
      .map((byte) => byte ^ 0xa5)
      .toString("utf8"),
};
async function makeHost(name) {
  const storage = new DesktopStorage(join(fixture.root, name), testCipher);
  const host = new DesktopHost(
    storage,
    fixture.home("network-home"),
    "0.0.0+desktoptest",
    () => {},
  );
  hosts.push(host);
  await host.initialize();
  expect(host.snapshot().ready).toBe(true);
  return { host, storage };
}
function value(reply) {
  expect(reply).toHaveProperty("ok", true);
  return reply.value;
}
async function rpc(host, serverId, method, params) {
  const outcome = value(await host.call(serverId, method, params));
  expect(outcome).toHaveProperty("ok", true);
  return outcome.value;
}
async function mirrored(host, serverId, predicate) {
  let found;
  await waitFor(
    "Desktop business mirror",
    () => {
      found = host.snapshot().sessions[serverId]?.mirror.records.find(predicate);
      return !!found;
    },
    10_000,
  );
  return found.record;
}

test("compiled Desktop host pairs independent devices and mirrors two real servers without moving navigation", async () => {
  const a = await fixture.startServer(fixture.home("server-a"));
  const b = await fixture.startServer(fixture.home("server-b"));
  const { host } = await makeHost("desktop");
  value(await host.pairLocal({ alias: "alpha", home: a.home, name: "Desktop" }));
  value(await host.pairLocal({ alias: "beta", home: b.home, name: "Desktop" }));
  const ids = host.snapshot().servers.map((server) => server.serverId);
  expect(new Set(ids).size).toBe(2);
  expect(JSON.stringify(host.snapshot())).not.toContain("device-token");
  for (const server of host.snapshot().servers) {
    value(await host.connect(server.serverId, "loopback"));
    const clone = await fixture.gitRepo(`clone-${server.alias}`);
    const registered = await rpc(host, server.serverId, "repo.register", { path: clone.path });
    const repoId = registered.operation.result.resource.id;
    await rpc(host, server.serverId, "task.create", {
      title: `${server.alias} task`,
      mounts: [{ source: "checkout", repoId }],
    });
    const task = await mirrored(
      host,
      server.serverId,
      (row) => row.kind === "task" && row.record.title === `${server.alias} task`,
    );
    expect(task.workspace.mounts[0].path).toBe(clone.path);
    const observed = await rpc(host, server.serverId, "task.get", { taskId: task.taskId });
    expect(observed.task.workspace.entryState).toBe("ready");
  }
  expect(host.snapshot().sessions[ids[0]].status).toBe("current");
  expect(host.snapshot().sessions[ids[1]].status).toBe("current");
  expect(host.snapshot()).not.toHaveProperty("selectedTask");
  const original = host.snapshot().servers[0];
  value(await host.disconnect(original.serverId));
  expect(host.snapshot().sessions[ids[1]].status).toBe("current");
  const devices = await fixture.coveJson(["auth", "device", "list"], { home: a.home });
  expect(devices.devices.map((device) => device.name)).toEqual(["Desktop"]);
});

test("an admitted write reference survives cold app restart and queries its original server operation", async () => {
  const server = await fixture.startServer(fixture.home("server"));
  const first = await makeHost("desktop");
  value(await first.host.pairLocal({ alias: "box", home: server.home, name: "Desktop" }));
  const id = server.record.serverId;
  value(await first.host.connect(id, "loopback"));
  const result = await rpc(first.host, id, "task.create", { title: "once-only", mounts: [] });
  const operationId = result.operation.operationId;
  first.host.dispose();
  const second = await makeHost("desktop");
  expect(
    second.storage.pendingOperations().find((row) => row.operationId === operationId),
  ).toMatchObject({ serverId: id, relayInstanceId: server.record.relayInstanceId });
  value(await second.host.connect(id, "loopback"));
  const queried = value(await second.host.queryOperation(id, operationId));
  expect(queried.ok).toBe(true);
  expect(queried.value.operation.operationId).toBe(operationId);
  const tasks = await fixture.coveJson(["task", "list"], { home: server.home });
  expect(tasks.tasks.filter((task) => task.title === "once-only")).toHaveLength(1);
  const missing = {
    serverId: id,
    relayInstanceId: server.record.relayInstanceId,
    operationId: "unverifiable-original",
    method: "task.create",
    createdAtMs: 1,
    status: "unknown",
  };
  await second.storage.recordOperation(missing);
  const notFound = value(await second.host.queryOperation(id, missing.operationId));
  expect(notFound.ok).toBe(false);
  expect(
    second.storage.pendingOperations().find((row) => row.operationId === missing.operationId),
  ).toEqual(missing);
  await fixture.stopServer(server);
  // Installed servers use stable configured ports. Keep this fixture's explicit entry stable
  // too; a random new port is a different entry, not an instance-recovery condition.
  const restarted = await fixture.startServer(server.home, [
    "--port",
    new URL(server.record.endpoint).port,
  ]);
  expect(restarted.record.relayInstanceId).not.toBe(server.record.relayInstanceId);
  value(await second.host.connect(id, "loopback"));
  expect(value(await second.host.queryOperation(id, operationId)).ok).toBe(true);
  expect(
    second.storage.pendingOperations().find((row) => row.operationId === operationId)
      .relayInstanceId,
  ).toBe(server.record.relayInstanceId);
});

test("failed durable write admission sends no domain write to the actual server", async () => {
  const server = await fixture.startServer(fixture.home("server"));
  const { host } = await makeHost("desktop");
  value(await host.pairLocal({ alias: "box", home: server.home, name: "Desktop" }));
  value(await host.connect(server.record.serverId, "loopback"));
  const path = join(fixture.root, "desktop", "operations.json");
  await rm(path);
  await mkdir(path);
  const outcome = await host.call(server.record.serverId, "task.create", {
    title: "must-not-dispatch",
    mounts: [],
  });
  expect(outcome.ok).toBe(false);
  expect((await fixture.coveJson(["task", "list"], { home: server.home })).tasks).toEqual([]);
  expect(
    (await readFile(join(fixture.root, "desktop", "credentials.sealed"))).byteLength,
  ).toBeGreaterThan(0);
});

test("acknowledging completed writes frees both durable and session capacity beyond 256 operations", async () => {
  const server = await fixture.startServer(fixture.home("server"));
  const { host, storage } = await makeHost("desktop");
  const id = server.record.serverId;
  value(await host.pairLocal({ alias: "box", home: server.home, name: "Desktop" }));
  value(await host.connect(id, "loopback"));
  for (const reference of storage.pendingOperations())
    value(await host.acknowledgeOperation(id, reference.operationId));
  const created = await rpc(host, id, "task.create", { title: "capacity", mounts: [] });
  const taskId = created.operation.result.resource.id;
  value(await host.acknowledgeOperation(id, created.operation.operationId));
  for (let index = 0; index < 257; index++) {
    const updated = await rpc(host, id, "task.update", { taskId, title: `update-${index}` });
    value(await host.acknowledgeOperation(id, updated.operation.operationId));
    expect(storage.pendingOperations()).toHaveLength(0);
    expect(host.snapshot().sessions[id].operations).toHaveLength(0);
  }
  expect((await rpc(host, id, "task.get", { taskId })).task.title).toBe("update-256");
}, 90_000);

test("retirement during durable admission records a proven pre-dispatch failure as not sent", async () => {
  const server = await fixture.startServer(fixture.home("server"));
  const { host, storage } = await makeHost("desktop");
  const id = server.record.serverId;
  value(await host.pairLocal({ alias: "box", home: server.home, name: "Desktop" }));
  value(await host.connect(id, "loopback"));
  const save = storage.recordOperation.bind(storage);
  storage.recordOperation = async (operation) => {
    await save(operation);
    if (operation.status === "pending") value(await host.disconnect(id));
  };
  const outcome = value(
    await host.call(id, "task.create", {
      title: "must-not-dispatch",
      mounts: [],
    }),
  );
  expect(outcome).toMatchObject({ ok: false, kind: "local-error" });
  const reference = storage.pendingOperations().find((row) => row.method === "task.create");
  expect(reference.status).toBe("not-sent");
  expect((await fixture.coveJson(["task", "list"], { home: server.home })).tasks).toEqual([]);
  value(await host.acknowledgeOperation(id, reference.operationId));
  expect(storage.pendingOperations().some((row) => row.operationId === reference.operationId)).toBe(
    false,
  );
});
