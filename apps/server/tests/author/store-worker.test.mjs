import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { Store, StoreError } from "../../dist/store/database.js";
import {
  StoreOperationError,
  StoreUnavailableError,
  uncertainStoreOutcome,
} from "../../dist/store/store-errors.js";
import { prepareHome } from "../../dist/store/home.js";
import { loadOrCreateIdentity, recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { ConfigService, sqliteConfigState } from "../../dist/store/config.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";

// The store runs in a dedicated worker thread (D6 B, store/database.ts). These tests drive the
// real compiled store and worker: the bounded queue, error kinds across the thread boundary, fail
// closed on a worker crash with uncertain results, and the shutdown order that releases the
// instance lock only after the database closed.

const testOperations = new URL("./store-test-operations.mjs", import.meta.url).href;
const encode = (text) => new TextEncoder().encode(text);
const directories = [];
const stores = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function home() {
  const path = await mkdtemp(join(tmpdir(), "cove-store-worker-"));
  directories.push(path);
  return prepareHome(join(path, "home"));
}

async function open(layout, limits) {
  const store = await Store.open({
    databasePath: layout.databasePath,
    backupDirectory: layout.backupDirectory,
    operationModules: [testOperations],
    ...(limits ? { limits } : {}),
  });
  stores.push(store);
  return store;
}

// A flag the test.block operation waits on inside its transaction.
function gate() {
  const flag = new SharedArrayBuffer(4);
  return {
    flag,
    release: () => {
      Atomics.store(new Int32Array(flag), 0, 1);
      Atomics.notify(new Int32Array(flag), 0);
    },
  };
}

// Opens the data directory from another process: SQLite locks belong to processes.
function openElsewhere(layout) {
  const script = `
    const { Store } = await import(${JSON.stringify(new URL("../../dist/store/database.js", import.meta.url).href)});
    try {
      const store = await Store.open(${JSON.stringify({ databasePath: layout.databasePath, backupDirectory: layout.backupDirectory })});
      await store.close();
      console.log("opened");
    } catch (error) {
      console.log(error.category ?? "other");
    }
  `;
  return new Promise((done, fail) =>
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 20_000 },
      (error, stdout) => (error ? fail(error) : done(stdout.trim())),
    ),
  );
}

const settle = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

describe("store worker calls", () => {
  it("bounds in-flight and queued calls, refuses the overflow unsent and keeps call order", async () => {
    const layout = await home();
    const store = await open(layout, { inFlight: 1, queued: 2 });
    await loadOrCreateIdentity(store);
    const { flag, release } = gate();
    const order = [];
    const blocked = store.call("test.block", { flag }).then((value) => order.push(value));
    const queued = [1, 2].map((n) =>
      store
        .call("test.run", { sql: "UPDATE config SET revision = ?", params: [n] })
        .then(() => order.push(n)),
    );
    const overflow = await settle(store.call("test.get", { sql: "SELECT 1 AS one" }));
    expect(overflow.error).toBeInstanceOf(StoreUnavailableError);
    expect(overflow.error).toMatchObject({ reason: "busy", outcome: "not-sent" });
    expect(uncertainStoreOutcome(overflow.error)).toBe(false);
    release();
    await Promise.all([blocked, ...queued]);
    expect(order).toEqual(["released", 1, 2]);
    expect(await store.call("test.get", { sql: "SELECT revision FROM config" })).toEqual({
      revision: 2,
    });
  });

  it("preserves error kinds across the thread boundary", async () => {
    const layout = await home();
    const store = await open(layout);
    await loadOrCreateIdentity(store);
    const sqlite = await settle(store.call("test.run", { sql: "INSERT INTO missing VALUES (1)" }));
    expect(sqlite.error).toBeInstanceOf(StoreOperationError);
    expect(sqlite.error).toMatchObject({ name: "StoreOperationError", code: "SQLITE_ERROR" });
    const constraint = await settle(
      store.call("test.run", {
        sql: "INSERT INTO server_identity (id, server_id, local_principal_id, created_at_ms) VALUES (1, 'a', 'b', 1)",
      }),
    );
    expect(constraint.error.code).toMatch(/^SQLITE_CONSTRAINT/);
    const plain = await settle(store.call("test.failPlain", {}));
    expect(plain.error).toBeInstanceOf(StoreOperationError);
    expect(plain.error).toMatchObject({ code: null, message: "plain failure" });
    // A second opener in this process fails at the instance lock with its category.
    const second = await settle(
      Store.open({ databasePath: layout.databasePath, backupDirectory: layout.backupDirectory }),
    );
    expect(second.error).toBeInstanceOf(StoreError);
    expect(second.error.category).toBe("in-use");
    // The failed calls rolled back and the store still works.
    expect(store.isOpen).toBe(true);
    expect(
      await store.call("test.get", { sql: "SELECT count(*) AS n FROM server_identity" }),
    ).toEqual({ n: 1 });
  });

  it("refuses arguments that cannot be cloned as not sent, without failing the store", async () => {
    const layout = await home();
    const store = await open(layout);
    await loadOrCreateIdentity(store);
    const unsendable = await settle(
      store.call("test.run", { sql: "UPDATE config SET revision = 3", params: [() => 1] }),
    );
    // postMessage throws before anything reaches the worker: not "ran and rolled back".
    expect(unsendable.error).toBeInstanceOf(StoreUnavailableError);
    expect(unsendable.error).toMatchObject({ reason: "unsendable", outcome: "not-sent" });
    expect(unsendable.error).not.toBeInstanceOf(StoreOperationError);
    expect(uncertainStoreOutcome(unsendable.error)).toBe(false);
    expect(store.isOpen).toBe(true);
    expect(await store.call("test.get", { sql: "SELECT revision FROM config" })).toEqual({
      revision: 0,
    });
  });
});

describe("store worker failure", () => {
  it("fails closed on a crash during a write: in flight is unknown, queued and later calls are unsent", async () => {
    const layout = await home();
    const store = await open(layout, { inFlight: 2, queued: 4 });
    await loadOrCreateIdentity(store);
    const failures = [];
    store.onFailure(() => failures.push("failed"));
    const { flag, release } = gate();
    // In flight: a write that crashes the worker inside its transaction, and a call behind it.
    const crashing = settle(
      store.call("test.block", { flag, sql: "UPDATE config SET revision = 41", crash: true }),
    );
    const behind = settle(store.call("test.run", { sql: "UPDATE config SET revision = 42" }));
    // Queued on the main thread: never handed to the worker.
    const queued = settle(store.call("test.run", { sql: "UPDATE config SET revision = 43" }));
    release();
    for (const result of [await crashing, await behind]) {
      expect(result.error).toBeInstanceOf(StoreUnavailableError);
      expect(result.error).toMatchObject({ reason: "failed", outcome: "unknown" });
      expect(uncertainStoreOutcome(result.error)).toBe(true);
    }
    expect((await queued).error).toMatchObject({ reason: "failed", outcome: "not-sent" });
    expect(failures).toEqual(["failed"]);
    expect(store.isOpen).toBe(false);
    const later = await settle(store.call("test.get", { sql: "SELECT 1" }));
    expect(later.error).toMatchObject({ reason: "failed", outcome: "not-sent" });
    // Nothing restarted the worker, and the instance lock is still held: no other server can
    // start beside this process while it shuts down.
    expect(await openElsewhere(layout)).toBe("in-use");
    // close() reports the unclean end and releases the lock.
    await expect(store.close()).rejects.toBeInstanceOf(StoreUnavailableError);
    stores.splice(stores.indexOf(store), 1);
    expect(await openElsewhere(layout)).toBe("opened");
    // The crashed transaction rolled back; the in-flight call behind it never ran.
    const reopened = await open(layout);
    expect(await reopened.call("test.get", { sql: "SELECT revision FROM config" })).toEqual({
      revision: 0,
    });
  });

  it("surfaces a receipt-checked write lost in a crash as RESULT_UNKNOWN and never replays it", async () => {
    const layout = await home();
    const store = await open(layout);
    await loadOrCreateIdentity(store);
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const composition = new RuntimeComposition("server", "instance", { ...M0_LIMITS }, bytes);
    await recordInstanceStart(store, "instance", 1);
    const { flag, release } = gate();
    let crashing;
    // Starts the crashing call just before receipts.write is handed to the store, so the write is
    // in flight behind it when the worker dies (the receipt lookups before it have completed).
    class CrashBeforeWrite extends SqliteReceiptBackend {
      write(request, limits) {
        crashing = settle(store.call("test.block", { flag, crash: true }));
        return super.write(request, limits);
      }
    }
    const receipts = new OperationReceipts(
      composition,
      encode,
      new CrashBeforeWrite(store, "instance", () => 1),
    );
    const config = new ConfigService({
      home: "/home/owner/.cove",
      serverId: "server",
      receipts,
      state: sqliteConfigState(store),
      encodeUtf8: encode,
    });
    const params = { operationId: "lost", patch: { workspaceRoot: "/srv/lost" } };
    const pending = config.set("principal", params);
    while (!crashing) await new Promise((done) => setTimeout(done, 5));
    release();
    await crashing;
    expect(await pending).toEqual({
      error: expect.objectContaining({
        kind: "RESULT_UNKNOWN",
        acceptance: "unknown",
        nextAction: "query-operation",
      }),
    });
    // Later requests are refused, not executed.
    expect(await config.set("principal", { ...params, operationId: "after" })).toMatchObject({
      error: { kind: "BUSY", acceptance: "not-accepted" },
    });
    receipts.dispose();
    await store.close().catch(() => undefined);
    stores.splice(stores.indexOf(store), 1);
    // Restart: nothing was applied and nothing is replayed on its own; the same request is only
    // executed when the client sends it again.
    const reopened = await open(layout);
    expect(await reopened.call("test.get", { sql: "SELECT revision FROM config" })).toEqual({
      revision: 0,
    });
    expect(
      await reopened.call("test.get", { sql: "SELECT count(*) AS n FROM operations" }),
    ).toEqual({ n: 0 });
  });

  // The barrier sits after receipts.write committed (business change and receipt together)
  // and before its result is posted: "crash" exits the worker, "unanswerable" makes the result
  // uncloneable. Separate tests (not a loop) so test discovery lists each case.
  async function lostReplyThenResend(mode) {
    const layout = await home();
    const configService = (store) => {
      const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
      const composition = new RuntimeComposition("server", "instance", { ...M0_LIMITS }, bytes);
      const receipts = new OperationReceipts(
        composition,
        encode,
        new SqliteReceiptBackend(store, "instance", () => 1),
      );
      const config = new ConfigService({
        home: "/home/owner/.cove",
        serverId: "server",
        receipts,
        state: sqliteConfigState(store),
        encodeUtf8: encode,
      });
      return { receipts, config };
    };
    const store = await open(layout);
    await loadOrCreateIdentity(store);
    await recordInstanceStart(store, "instance", 1);
    const first = configService(store);
    await store.call("test.armAfterCommit", { operation: "receipts.write", mode });
    const params = { operationId: "committed", patch: { workspaceRoot: "/srv/committed" } };
    expect(await first.config.set("principal", params)).toEqual({
      error: expect.objectContaining({
        kind: "RESULT_UNKNOWN",
        acceptance: "unknown",
        nextAction: "query-operation",
      }),
    });
    expect(store.isOpen).toBe(false);
    first.receipts.dispose();
    await expect(store.close()).rejects.toBeInstanceOf(StoreUnavailableError);
    stores.splice(stores.indexOf(store), 1);
    // After a restart the write is there exactly once: one business revision, one receipt.
    const reopened = await open(layout);
    const count = async () => ({
      config: await reopened.call("test.get", {
        sql: "SELECT revision, workspace_root AS root FROM config",
      }),
      receipts: await reopened.call("test.all", {
        sql: "SELECT operation_id AS id, state FROM operations",
      }),
    });
    const committed = {
      config: { revision: 1, root: "/srv/committed" },
      receipts: [{ id: "committed", state: "succeeded" }],
    };
    expect(await count()).toEqual(committed);
    // A same-ID resend returns the original result and changes nothing.
    const second = configService(reopened);
    const resent = await second.config.set("principal", params);
    expect(resent).toEqual({
      operation: expect.objectContaining({ operationId: "committed", state: "succeeded" }),
    });
    expect(resent.operation.result).toEqual({
      resource: { kind: "config", id: "server", revision: 1 },
    });
    expect(await count()).toEqual(committed);
    second.receipts.dispose();
  }

  it("surfaces a committed receipt-checked write whose reply is lost in a crash as RESULT_UNKNOWN; a resend returns it", async () => {
    await expect(lostReplyThenResend("crash")).resolves.toBeUndefined();
  });

  it("surfaces a committed receipt-checked write whose reply cannot be sent as RESULT_UNKNOWN; a resend returns it", async () => {
    await expect(lostReplyThenResend("unanswerable")).resolves.toBeUndefined();
  });

  it("fails closed when the worker exits while idle or cannot send a result", async () => {
    for (const operation of ["test.exitSoon", "test.unanswerable"]) {
      const layout = await home();
      const store = await open(layout);
      const failed = new Promise((done) => store.onFailure(done));
      await settle(store.call(operation, {}));
      await failed;
      expect(store.isOpen).toBe(false);
      expect((await settle(store.call("test.get", { sql: "SELECT 1" }))).error).toMatchObject({
        reason: "failed",
        outcome: "not-sent",
      });
      await expect(store.close()).rejects.toBeInstanceOf(StoreUnavailableError);
      stores.splice(stores.indexOf(store), 1);
    }
  });
});

describe("store worker shutdown", () => {
  it("drains queued calls, then closes the database, then releases the instance lock", async () => {
    const layout = await home();
    const store = await open(layout, { inFlight: 1, queued: 4 });
    await loadOrCreateIdentity(store);
    const { flag, release } = gate();
    const events = [];
    const blocked = store.call("test.block", { flag }).then(() => events.push("blocked"));
    const queued = store
      .call("test.run", { sql: "UPDATE config SET revision = 5" })
      .then(() => events.push("queued"));
    const closing = store.close().then(() => events.push("closed"));
    // Closing: new calls are refused unsent; accepted ones still run.
    const refused = await settle(store.call("test.get", { sql: "SELECT 1" }));
    expect(refused.error).toMatchObject({ reason: "closed", outcome: "not-sent" });
    // The lock is held while the store drains.
    expect(await openElsewhere(layout)).toBe("in-use");
    release();
    await Promise.all([blocked, queued, closing]);
    expect(events).toEqual(["blocked", "queued", "closed"]);
    stores.splice(stores.indexOf(store), 1);
    // Released only now, with the drained write durable.
    expect(await openElsewhere(layout)).toBe("opened");
    const reopened = await open(layout);
    expect(await reopened.call("test.get", { sql: "SELECT revision FROM config" })).toEqual({
      revision: 5,
    });
    // A second close is the same close.
    await reopened.close();
    await reopened.close();
    stores.splice(stores.indexOf(reopened), 1);
  });

  it("releases the lock and the worker when opening fails", async () => {
    const layout = await home();
    const broken = [{ version: 1, name: "broken", sql: "CREATE TABLE (;" }];
    const failure = await settle(
      Store.open({
        databasePath: layout.databasePath,
        backupDirectory: layout.backupDirectory,
        migrations: broken,
      }),
    );
    expect(failure.error).toBeInstanceOf(StoreError);
    expect(failure.error.category).toBe("migration");
    expect(await openElsewhere(layout)).toBe("opened");
  });
});
