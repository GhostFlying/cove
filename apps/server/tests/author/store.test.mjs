import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { canonicalWriteIntent } from "@cove/protocol/rpc";
import { Store, StoreError } from "../../dist/store/database.js";
import { MIGRATIONS } from "../../dist/store/migrations.js";
import { prepareHome } from "../../dist/store/home.js";
import { loadOrCreateIdentity, recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { ConfigService, memoryConfigState, sqliteConfigState } from "../../dist/store/config.js";
import { RunLog } from "../../dist/store/runs.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";

const encode = (text) => new TextEncoder().encode(text);
const directories = [];
const stores = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function home() {
  const path = await mkdtemp(join(tmpdir(), "cove-store-test-"));
  directories.push(path);
  return prepareHome(join(path, "home"));
}

async function open(layout, migrations) {
  const store = await Store.open({
    databasePath: layout.databasePath,
    backupDirectory: layout.backupDirectory,
    ...(migrations ? { migrations } : {}),
  });
  stores.push(store);
  return store;
}

function close(store) {
  stores.splice(stores.indexOf(store), 1);
  store.close();
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

// Opens the database from a separate process: SQLite locks belong to processes.
function openElsewhere(layout) {
  const script = `
    const { Store } = await import(${JSON.stringify(new URL("../../dist/store/database.js", import.meta.url).href)});
    try {
      const store = await Store.open(${JSON.stringify({ databasePath: layout.databasePath, backupDirectory: layout.backupDirectory })});
      store.close();
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

function durableReceipts(store, serverId = "server", instance = "instance") {
  const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
  const composition = new RuntimeComposition(serverId, instance, { ...M0_LIMITS }, bytes);
  recordInstanceStart(store, instance, 1);
  return new OperationReceipts(
    composition,
    encode,
    new SqliteReceiptBackend(store, instance, () => 1),
  );
}

describe("store opening, migrations and the data directory lock", () => {
  it("creates every M1 table under WAL, FULL synchronous, foreign keys and no busy wait", async () => {
    const layout = await home();
    expect((await stat(layout.home)).mode & 0o777).toBe(0o700);
    expect((await stat(layout.serverDirectory)).mode & 0o777).toBe(0o700);
    const store = await open(layout);
    const db = store.db;
    expect(store.schemaVersion).toBe(MIGRATIONS.length);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(0);
    expect(db.pragma("locking_mode", { simple: true })).toBe("exclusive");
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name)
      .sort();
    expect(tables).toEqual([
      "bindings",
      "config",
      "managed_worktrees",
      "mounts",
      "operations",
      "principals",
      "relay_instances",
      "repos",
      "runs",
      "server_identity",
      "tabs",
      "tasks",
      "workspaces",
    ]);
    expect(store.backupPath).toBeNull();
  });

  it("refuses a second opener of the same database while the first keeps working", async () => {
    const layout = await home();
    const store = await open(layout);
    loadOrCreateIdentity(store);
    expect(await openElsewhere(layout)).toBe("in-use");
    // The first connection still reads and writes.
    store.transaction(() => store.db.prepare("UPDATE config SET updated_at_ms = 5").run());
    expect(store.db.prepare("SELECT updated_at_ms FROM config").get().updated_at_ms).toBe(5);
    close(store);
    expect(await openElsewhere(layout)).toBe("opened");
  });

  it("refuses a database newer than this build without changing its file", async () => {
    const layout = await home();
    const store = await open(layout);
    loadOrCreateIdentity(store);
    store.db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    close(store);
    const before = await sha256(layout.databasePath);
    const files = (await readdir(layout.serverDirectory)).sort();
    await expect(open(layout)).rejects.toMatchObject({ category: "newer-schema" });
    expect(await sha256(layout.databasePath)).toBe(before);
    expect((await readdir(layout.serverDirectory)).sort()).toEqual(files);
  });

  it("backs up an older schema with VACUUM INTO, then migrates in one transaction", async () => {
    const layout = await home();
    const first = [{ version: 1, name: "one", sql: "CREATE TABLE one (value INTEGER) STRICT;" }];
    const store = await open(layout, first);
    store.transaction(() => store.db.prepare("INSERT INTO one VALUES (7)").run());
    close(store);
    const broken = [...first, { version: 2, name: "broken", sql: "CREATE TABLE two (; " }];
    await expect(open(layout, broken)).rejects.toMatchObject({ category: "migration" });
    const unchanged = await open(layout, first);
    expect(unchanged.schemaVersion).toBe(1);
    expect(unchanged.db.prepare("SELECT value FROM one").get().value).toBe(7);
    close(unchanged);
    const next = [
      ...first,
      { version: 2, name: "two", sql: "CREATE TABLE two (x INTEGER) STRICT;" },
    ];
    const migrated = await open(layout, next);
    expect(migrated.db.pragma("user_version", { simple: true })).toBe(2);
    expect(migrated.backupPath).toMatch(/cove-schema-1-\d+-[0-9a-f]{8}\.db$/);
    close(migrated);
    const backups = await readdir(layout.backupDirectory);
    // The failed attempt also took a backup before rolling back; both hold schema 1.
    expect(backups.length).toBe(2);
    const backup = await Store.open({
      databasePath: join(layout.backupDirectory, backups[0]),
      backupDirectory: layout.backupDirectory,
      migrations: first,
    });
    expect(backup.db.prepare("SELECT value FROM one").get().value).toBe(7);
    backup.close();
  });

  it("keeps the server identity and local principal across reopening", async () => {
    const layout = await home();
    const store = await open(layout);
    const created = loadOrCreateIdentity(store);
    expect(created.created).toBe(true);
    close(store);
    const again = await open(layout);
    const loaded = loadOrCreateIdentity(again);
    expect(loaded).toEqual({ ...created, created: false });
    expect(loaded.principalId).not.toBe(loaded.serverId);
  });

  it("refuses a file that is not a Cove database without changing it", async () => {
    const layout = await home();
    await writeFile(layout.databasePath, "not a database, but someone's file\n".repeat(200));
    const before = await sha256(layout.databasePath);
    const error = await open(layout).catch((failure) => failure);
    expect(error).toBeInstanceOf(StoreError);
    expect(error.category).toBe("unavailable");
    expect(await sha256(layout.databasePath)).toBe(before);
  });

  it("rolls back a failing transaction and keeps the connection usable", async () => {
    const layout = await home();
    const store = await open(layout);
    loadOrCreateIdentity(store);
    expect(() =>
      store.transaction(() => {
        store.db.prepare("UPDATE config SET revision = 9").run();
        store.db.exec("SELECT * FROM missing");
      }),
    ).toThrow(/no such table/);
    expect(store.db.prepare("SELECT revision FROM config").get().revision).toBe(0);
    const observed = [];
    store.observe((start, end) => observed.push(end >= start));
    store.transaction(() => store.transaction(() => store.db.prepare("SELECT 1").get()));
    // Only the outermost transaction is observed (D6 probe correlation).
    expect(observed).toEqual([true]);
  });
});

describe("durable operation receipts", () => {
  const key = (operationId) => ({ serverId: "server", principalId: "principal", operationId });
  const record = (operationId, extra = {}) => ({
    operationId,
    method: "config.set",
    revision: 0,
    state: "accepted",
    ...extra,
  });

  it("keeps committed receipts, their intent and their guards across reopening", async () => {
    const layout = await home();
    let store = await open(layout);
    let receipts = durableReceipts(store);
    expect(receipts.prepare(key("a"), "intent-a").commit(record("a"))).toBe(true);
    expect(receipts.count).toBe(0);
    expect(receipts.update(key("a"), record("a", { revision: 1, state: "succeeded" }))).toBe(true);
    receipts.dispose();
    close(store);
    store = await open(layout);
    receipts = durableReceipts(store, "server", "next-instance");
    expect(receipts.lookup(key("a"), "intent-a")).toMatchObject({
      kind: "existing",
      record: { revision: 1, state: "succeeded" },
    });
    expect(receipts.lookup(key("a"), "intent-b").kind).toBe("conflict");
    expect(receipts.lookup({ ...key("a"), principalId: "other" }, "intent-a").kind).toBe("reserve");
    expect(receipts.update(key("a"), record("a", { revision: 2, state: "running" }))).toBe(false);
    expect(receipts.prepare(key("a"), "intent-a")).toBeNull();
    receipts.dispose();
  });

  it("refuses stale successors with a compare-and-set on the stored revision", async () => {
    const layout = await home();
    const store = await open(layout);
    const receipts = durableReceipts(store);
    expect(receipts.prepare(key("b"), "intent").commit(record("b"))).toBe(true);
    expect(receipts.update(key("b"), record("b", { revision: 2, state: "running" }))).toBe(false);
    expect(receipts.update(key("b"), record("b", { revision: 1, state: "running" }))).toBe(true);
    expect(receipts.update(key("b"), record("b", { revision: 1, state: "succeeded" }))).toBe(false);
    expect(receipts.get(key("b"))).toMatchObject({ revision: 1, state: "running" });
    receipts.dispose();
  });

  it("moves unfinished receipts of an earlier instance to requires_attention without running them", async () => {
    const layout = await home();
    let store = await open(layout);
    let receipts = durableReceipts(store);
    const run = { serverId: "server", relayInstanceId: "instance", runId: "run-1" };
    const create = { ...record("c"), method: "terminal.create", run };
    for (const id of ["accepted", "running", "done", "failed"])
      expect(receipts.prepare(key(id), `intent-${id}`).commit({ ...create, operationId: id })).toBe(
        true,
      );
    for (const [id, state] of [
      ["running", "running"],
      ["done", "succeeded"],
      ["failed", "failed"],
    ])
      expect(receipts.update(key(id), { ...create, operationId: id, revision: 1, state })).toBe(
        true,
      );
    receipts.dispose();
    close(store);
    store = await open(layout);
    receipts = durableReceipts(store, "server", "restarted");
    const verified = await receipts.recoverInterrupted();
    expect(verified.map((item) => [item.operationId, item.state, item.revision]).sort()).toEqual([
      ["accepted", "requires_attention", 2],
      ["running", "requires_attention", 3],
    ]);
    for (const id of ["accepted", "running"]) {
      const current = receipts.get(key(id));
      expect(current).toMatchObject({ state: "requires_attention", run });
      expect(current.error).toMatchObject({ kind: "RESULT_UNKNOWN", acceptance: "unknown" });
      // A same-intent resend only returns the record; a late result cannot replace it.
      expect(receipts.lookup(key(id), `intent-${id}`).kind).toBe("existing");
      expect(
        receipts.update(key(id), {
          ...current,
          revision: current.revision + 1,
          state: "succeeded",
        }),
      ).toBe(false);
    }
    expect(receipts.get(key("done"))).toMatchObject({ state: "succeeded", revision: 1 });
    expect(receipts.get(key("failed"))).toMatchObject({ state: "failed", revision: 1 });
    // Explicit recovery still works on the durable record.
    const attention = receipts.get(key("running"));
    expect(
      receipts.recover(key("running"), attention.revision, {
        ...attention,
        revision: attention.revision + 1,
        state: "cancelled",
      }),
    ).toBe(true);
    expect(await receipts.recoverInterrupted()).toEqual([]);
    receipts.dispose();
  });

  it("accepts a verifier's proven outcome instead of requires_attention", async () => {
    const layout = await home();
    const store = await open(layout);
    let receipts = durableReceipts(store);
    expect(
      receipts.prepare(key("v"), "intent").commit(record("v", { method: "mount.retry" })),
    ).toBe(true);
    receipts.dispose();
    receipts = durableReceipts(store, "server", "second");
    const [outcome] = await receipts.recoverInterrupted({
      // Verifiers may inspect external state asynchronously.
      "mount.retry": async (current) => ({
        ...current,
        revision: current.revision + 1,
        state: "failed",
      }),
    });
    expect(outcome).toMatchObject({ state: "failed", revision: 2 });
    receipts.dispose();
  });

  it("commits recovering before an asynchronous verifier and keeps the generic outcome when it throws", async () => {
    const layout = await home();
    const store = await open(layout);
    let receipts = durableReceipts(store);
    for (const id of ["proven", "throws"])
      expect(
        receipts.prepare(key(id), `intent-${id}`).commit(record(id, { method: "mount.retry" })),
      ).toBe(true);
    receipts.dispose();
    receipts = durableReceipts(store, "server", "second");
    const seen = [];
    const outcomes = await receipts.recoverInterrupted({
      "mount.retry": async (current) => {
        // The move to recovering is durable before the verifier inspects anything, so a crash
        // during verification is retried by the next start.
        seen.push([
          current.operationId,
          store.db
            .prepare("SELECT state FROM operations WHERE operation_id = ?")
            .get(current.operationId).state,
        ]);
        await new Promise((done) => setTimeout(done, 1));
        if (current.operationId === "throws") throw new Error("inspection failed");
        return { ...current, revision: current.revision + 1, state: "succeeded" };
      },
    });
    expect(seen.sort()).toEqual([
      ["proven", "recovering"],
      ["throws", "recovering"],
    ]);
    expect(Object.fromEntries(outcomes.map((item) => [item.operationId, item.state]))).toEqual({
      proven: "succeeded",
      throws: "requires_attention",
    });
    receipts.dispose();
  });
});

describe("server configuration", () => {
  function service(store, receipts, state = sqliteConfigState(store)) {
    return new ConfigService({
      home: "/home/owner/.cove",
      serverId: "server",
      receipts,
      state,
      encodeUtf8: encode,
    });
  }

  it("changes workspaceRoot once per operation ID and survives reopening", async () => {
    const layout = await home();
    let store = await open(layout);
    loadOrCreateIdentity(store);
    let receipts = durableReceipts(store);
    let config = service(store, receipts);
    expect(config.record()).toEqual({
      revision: 0,
      settings: { workspaceRoot: { value: "/home/owner/.cove/workspace", isDefault: true } },
    });
    const params = { operationId: "set-1", patch: { workspaceRoot: "/srv/work" } };
    const first = config.set("principal", params);
    expect(first.operation).toMatchObject({
      state: "succeeded",
      result: { resource: { kind: "config", id: "server", revision: 1 } },
    });
    receipts.dispose();
    close(store);
    store = await open(layout);
    receipts = durableReceipts(store, "server", "restarted");
    config = service(store, receipts);
    expect(config.set("principal", params)).toEqual(first);
    expect(config.record().revision).toBe(1);
    expect(config.workspaceRoot()).toBe("/srv/work");
    expect(config.set("principal", { ...params, patch: { workspaceRoot: null } })).toMatchObject({
      error: { kind: "OPERATION_ID_CONFLICT" },
    });
    expect(
      config.set("principal", {
        operationId: "set-2",
        expectedRevision: 0,
        patch: { workspaceRoot: null },
      }),
    ).toMatchObject({ error: { kind: "REVISION_CONFLICT" } });
    // A refused precondition leaves no receipt: the same request may be sent once it holds.
    expect(receipts.get(key("set-2"))).toBeNull();
    for (const workspaceRoot of ["relative/dir", "/srv/../x", "/srv/x/"])
      expect(
        config.set("principal", {
          operationId: `bad-${workspaceRoot.length}`,
          patch: { workspaceRoot },
        }),
      ).toMatchObject({ error: { kind: "INVALID_ARGUMENT" } });
    const reset = config.set("principal", {
      operationId: "set-3",
      expectedRevision: 1,
      patch: { workspaceRoot: null },
    });
    expect(reset.operation.result.resource.revision).toBe(2);
    expect(config.record().settings.workspaceRoot.isDefault).toBe(true);
    receipts.dispose();
  });

  it("rolls the receipt back with the change when the transaction fails", async () => {
    const layout = await home();
    const store = await open(layout);
    loadOrCreateIdentity(store);
    const receipts = durableReceipts(store);
    const state = sqliteConfigState(store);
    const failing = {
      ...state,
      write: () => {
        throw new Error("disk failure");
      },
    };
    const config = service(store, receipts, failing);
    expect(
      config.set("principal", { operationId: "fails", patch: { workspaceRoot: "/srv/x" } }),
    ).toMatchObject({ error: { kind: "BUSY" } });
    expect(receipts.get(key("fails"))).toBeNull();
    expect(receipts.count).toBe(0);
    receipts.dispose();
  });

  it("serves the D6 control phase from memory with the same results", async () => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const composition = new RuntimeComposition("server", "instance", { ...M0_LIMITS }, bytes);
    const receipts = new OperationReceipts(composition, encode);
    const config = service(null, receipts, memoryConfigState({ revision: 4, workspaceRoot: null }));
    const params = { operationId: "mem", patch: { workspaceRoot: "/srv/mem" } };
    expect(config.set("principal", params).operation.result.resource.revision).toBe(5);
    expect(config.set("principal", params).operation.result.resource.revision).toBe(5);
    expect(canonicalWriteIntent("config.set", params, encode)).toContain("config.set");
    receipts.dispose();
  });

  function key(operationId) {
    return { serverId: "server", principalId: "principal", operationId };
  }
});

describe("durable run records", () => {
  const run = (instance, runId) => ({ serverId: "server", relayInstanceId: instance, runId });

  it("records run starts and exits, ends runs with an orderly stop and interrupts the rest", async () => {
    const layout = await home();
    const store = await open(layout);
    let now = 10;
    const runs = new RunLog(store, () => now);
    recordInstanceStart(store, "old", 1);
    runs.started(run("old", "run-1"), "/work", "op-1");
    runs.spawned(run("old", "run-1"));
    runs.started(run("old", "run-2"), "/work", "op-2");
    runs.spawned(run("old", "run-2"));
    now = 20;
    runs.exited(run("old", "run-2"), 3, null);
    runs.started(run("old", "run-3"), "/work", "op-3");
    runs.notStarted(run("old", "run-3"));
    expect(runs.live("old").map((item) => item.run.runId)).toEqual(["run-1"]);
    recordInstanceStart(store, "orderly", 2);
    runs.started(run("orderly", "run-1"), "/work", "op-4");
    runs.spawned(run("orderly", "run-1"));
    now = 30;
    expect(runs.stoppedWithServer("orderly", true)).toBe(1);
    recordInstanceStart(store, "current", 3);
    expect(runs.interruptEarlier("current")).toBe(1);
    const rows = store.db
      .prepare(
        "SELECT relay_instance_id, run_id, lifecycle, verification, ended_at_ms, exit_code, last_observed_at_ms FROM runs ORDER BY run_seq",
      )
      .all();
    expect(rows).toEqual([
      {
        relay_instance_id: "old",
        run_id: "run-1",
        lifecycle: "interrupted",
        verification: "unverifiable",
        ended_at_ms: null,
        exit_code: null,
        last_observed_at_ms: 10,
      },
      {
        relay_instance_id: "old",
        run_id: "run-2",
        lifecycle: "exited",
        verification: "final",
        ended_at_ms: 20,
        exit_code: 3,
        last_observed_at_ms: 20,
      },
      {
        relay_instance_id: "orderly",
        run_id: "run-1",
        lifecycle: "stopped-with-server",
        verification: "final",
        ended_at_ms: 30,
        exit_code: null,
        last_observed_at_ms: 30,
      },
    ]);
  });
});
