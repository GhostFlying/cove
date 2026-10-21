import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { Store } from "../../dist/store/database.js";
import { prepareHome } from "../../dist/store/home.js";
import { loadOrCreateIdentity, recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import { EntryConfigService } from "../../dist/entry/entry-config.js";

// Entry configuration storage (m2 T3, migration 007): entry.set through the real store and
// receipts, the restart flag of entry.get, the SSH target the auth service reads, and the
// install-time port initialization that never replaces a configured port.

const encode = (text) => new TextEncoder().encode(text);
const directories = [];
const stores = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function openStore() {
  const path = await mkdtemp(join(tmpdir(), "cove-entry-test-"));
  directories.push(path);
  const layout = await prepareHome(join(path, "home"));
  const store = await Store.open({
    databasePath: layout.databasePath,
    backupDirectory: layout.backupDirectory,
  });
  stores.push(store);
  const identity = await loadOrCreateIdentity(store);
  return { store, identity };
}

async function service(store, identity, options = {}) {
  const instance = "instance-1";
  await recordInstanceStart(store, instance, 1);
  const composition = new RuntimeComposition(
    identity.serverId,
    instance,
    { ...M0_LIMITS },
    new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024),
  );
  const receipts = new OperationReceipts(
    composition,
    encode,
    new SqliteReceiptBackend(store, instance, () => 1),
  );
  return new EntryConfigService({
    store,
    receipts,
    serverId: identity.serverId,
    encodeUtf8: encode,
    initial: await store.call("entry.read", undefined),
    ...options,
  });
}

describe("entry configuration", () => {
  it("starts unconfigured and stores a change as an operation", async () => {
    const { store, identity } = await openStore();
    const entry = await service(store, identity);
    expect(await entry.record()).toEqual({
      revision: 0,
      settings: { businessPort: null, pairingPort: null, sshTarget: null, tsnetHostname: null },
      restartRequired: false,
    });
    expect(entry.sshTarget).toBeUndefined();

    const set = await entry.set(identity.principalId, {
      operationId: "op-1",
      patch: { businessPort: 23456, sshTarget: "me@devbox" },
    });
    expect(set.operation).toMatchObject({
      state: "succeeded",
      result: {
        resource: { kind: "config", id: "entry", revision: 1 },
        appliesAfterRestart: true,
      },
    });
    // The SSH target applies at once: the next invitation reads it.
    expect(entry.sshTarget).toBe("me@devbox");
    // A resend answers with the same record and changes nothing.
    const again = await entry.set(identity.principalId, {
      operationId: "op-1",
      patch: { businessPort: 23456, sshTarget: "me@devbox" },
    });
    expect(again.operation.operationId).toBe("op-1");
    expect((await entry.record()).revision).toBe(1);

    // An SSH target alone takes effect without a restart.
    const target = await entry.set(identity.principalId, {
      operationId: "op-2",
      expectedRevision: 1,
      patch: { sshTarget: "other@devbox" },
    });
    expect(target.operation.result).toEqual({
      resource: { kind: "config", id: "entry", revision: 2 },
    });
  });

  it("refuses a stale revision and one port for both listeners", async () => {
    const { store, identity } = await openStore();
    const entry = await service(store, identity);
    await entry.set(identity.principalId, { operationId: "a", patch: { pairingPort: 24000 } });
    expect(
      await entry.set(identity.principalId, {
        operationId: "b",
        expectedRevision: 0,
        patch: { businessPort: 24001 },
      }),
    ).toEqual({ error: expect.objectContaining({ kind: "REVISION_CONFLICT" }) });
    expect(
      await entry.set(identity.principalId, { operationId: "c", patch: { businessPort: 24000 } }),
    ).toEqual({ error: expect.objectContaining({ kind: "INVALID_ARGUMENT" }) });
    expect((await entry.record()).settings).toMatchObject({
      businessPort: null,
      pairingPort: 24000,
    });
  });

  it("reports a restart as required when a stored port differs from the bound one", async () => {
    const { store, identity } = await openStore();
    const entry = await service(store, identity);
    entry.bound({ businessPort: 40001, pairingPort: undefined, tsnetHostname: null });
    // Not configured: whatever the server bound is what was asked for.
    expect((await entry.record()).restartRequired).toBe(false);
    await entry.set(identity.principalId, { operationId: "a", patch: { businessPort: 40001 } });
    expect((await entry.record()).restartRequired).toBe(false);
    await entry.set(identity.principalId, { operationId: "b", patch: { pairingPort: 40002 } });
    expect((await entry.record()).restartRequired).toBe(true);
  });

  it("lets a startup flag override the stored SSH target", async () => {
    const { store, identity } = await openStore();
    const entry = await service(store, identity, { sshTargetOverride: "flag@host" });
    await entry.set(identity.principalId, { operationId: "a", patch: { sshTarget: "me@devbox" } });
    expect(entry.sshTarget).toBe("flag@host");
  });

  it("fixes only the ports that are not configured yet (cove server install)", async () => {
    const { store } = await openStore();
    expect(
      await store.call("entry.initializePorts", { businessPort: 25000, pairingPort: 25001, at: 1 }),
    ).toMatchObject({ revision: 1, businessPort: 25000, pairingPort: 25001 });
    // Configured ports are kept, and an unchanged configuration keeps its revision.
    expect(
      await store.call("entry.initializePorts", { businessPort: 26000, pairingPort: 26001, at: 2 }),
    ).toMatchObject({ revision: 1, businessPort: 25000, pairingPort: 25001 });
  });
});
