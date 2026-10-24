import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { DesktopStorage } from "../dist/types/node/main/storage.js";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "cove-desktop-store-"));
  directories.push(path);
  return path;
}
// The injected cipher tests persistence/error boundaries. Actual Keychain protection is a
// separate Electron/macOS acceptance; this test does not pretend AES injection proves it.
function cipher() {
  const key = randomBytes(32);
  return {
    available: async () => true,
    encrypt: async (text) => {
      const nonce = randomBytes(12);
      const encryptor = createCipheriv("aes-256-gcm", key, nonce);
      const data = Buffer.concat([encryptor.update(text, "utf8"), encryptor.final()]);
      return Buffer.concat([nonce, encryptor.getAuthTag(), data]);
    },
    decrypt: async (bytes) => {
      const data = Buffer.from(bytes);
      const decryptor = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decryptor.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decryptor.update(data.subarray(28)), decryptor.final()]).toString(
        "utf8",
      );
    },
  };
}
const server = {
  alias: "test",
  serverId: "server1",
  deviceId: "device1",
  token: "a-private-device-token",
  defaultEntry: "loopback",
  entries: { loopback: { port: 23456 } },
};
const operation = {
  serverId: "server1",
  relayInstanceId: "original-instance",
  operationId: "write1",
  method: "task.create",
  createdAtMs: 1,
  status: "unknown",
};

test("credentials cold-load from sealed bytes and never appear in the operation ledger", async () => {
  const path = await directory();
  const protection = cipher();
  const first = new DesktopStorage(path, protection);
  await first.load();
  await first.saveServer(server);
  await first.recordOperation(operation);
  expect(
    (await readFile(join(path, "credentials.sealed"))).includes(Buffer.from(server.token)),
  ).toBe(false);
  expect(await readFile(join(path, "operations.json"), "utf8")).not.toContain(server.token);
  const restored = new DesktopStorage(path, protection);
  await restored.load();
  expect(restored.serverRecords()).toEqual([server]);
  expect(restored.pendingOperations()).toEqual([operation]);
});
test("a failed secure save does not publish paired state or overwrite prior credentials", async () => {
  const path = await directory();
  const protection = cipher();
  const store = new DesktopStorage(path, protection);
  await store.load();
  await store.saveServer(server);
  const before = await readFile(join(path, "credentials.sealed"));
  protection.encrypt = async () => {
    throw new Error("user denied Keychain");
  };
  await expect(
    store.saveServer({ ...server, alias: "second", serverId: "server2" }),
  ).rejects.toThrow("user denied");
  expect(store.serverRecords()).toEqual([server]);
  expect(await readFile(join(path, "credentials.sealed"))).toEqual(before);
});
test("Keychain unavailability never triggers a plaintext fallback", async () => {
  const path = await directory();
  const protection = cipher();
  const store = new DesktopStorage(path, protection);
  await store.load();
  await store.saveServer(server);
  protection.available = async () => false;
  const restored = new DesktopStorage(path, protection);
  await expect(restored.load()).rejects.toThrow("Keychain is unavailable");
  expect(restored.serverRecords()).toEqual([]);
  await expect(store.forgetServer(server.serverId)).rejects.toThrow("Keychain is unavailable");
  expect(store.serverRecords()).toEqual([server]);
});
test("failed operation persistence cannot publish a recovery reference", async () => {
  const path = await directory();
  await writeFile(join(path, "not-a-directory"), "preserve");
  const store = new DesktopStorage(join(path, "not-a-directory"), cipher());
  await expect(store.recordOperation(operation)).rejects.toThrow(/EEXIST|ENOTDIR/);
  expect(store.pendingOperations()).toEqual([]);
  expect(await readFile(join(path, "not-a-directory"), "utf8")).toBe("preserve");
});
test("forgetting a device does not erase unresolved effects or claim they were undone", async () => {
  const path = await directory();
  const store = new DesktopStorage(path, cipher());
  await store.load();
  await store.saveServer(server);
  await store.recordOperation(operation);
  await store.forgetServer(server.serverId);
  expect(store.serverRecords()).toEqual([]);
  expect(store.pendingOperations()).toEqual([operation]);
  await expect(store.acknowledgeOperation(server.serverId, operation.operationId)).rejects.toThrow(
    "unresolved",
  );
});
test("observed in-progress receipts remain tracked until their final record is acknowledged", async () => {
  const path = await directory();
  const store = new DesktopStorage(path, cipher());
  await store.load();
  await store.recordOperation({ ...operation, status: "observed", result: { state: "running" } });
  await expect(store.acknowledgeOperation(server.serverId, operation.operationId)).rejects.toThrow(
    "in progress",
  );
  await store.recordOperation({ ...operation, status: "observed", result: { state: "succeeded" } });
  await store.acknowledgeOperation(server.serverId, operation.operationId);
  expect(store.pendingOperations()).toEqual([]);
});
test("corrupt or oversized state is preserved and refused rather than replaced", async () => {
  const path = await directory();
  await writeFile(join(path, "operations.json"), "{broken");
  await expect(new DesktopStorage(path, cipher()).load()).rejects.toThrow(/JSON|position|property/);
  expect(await readFile(join(path, "operations.json"), "utf8")).toBe("{broken");
  await writeFile(join(path, "operations.json"), "x".repeat(1024 * 1024 + 1));
  await expect(new DesktopStorage(path, cipher()).load()).rejects.toThrow("size limit");
});
