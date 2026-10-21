import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { canonicalWriteIntent } from "@cove/protocol/rpc";
import { Store, StoreError } from "../../dist/store/database.js";
import { retryRefused, StoreOperationError } from "../../dist/store/store-errors.js";
import { MIGRATIONS } from "../../dist/store/migrations.js";
import { committedSchemaVersion } from "../../dist/store/schema-version.js";
import { prepareHome } from "../../dist/store/home.js";
import { loadOrCreateIdentity, recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { ConfigService, sqliteConfigState } from "../../dist/store/config.js";
import { D6Probe } from "../../dist/entry/d6-probe.js";
import { RunLog } from "../../dist/store/runs.js";
import {
  parseStartIdentity,
  ProcessLedger,
  processStartIdentity,
} from "../../dist/store/processes.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";

const require = createRequire(import.meta.url);
const encode = (text) => new TextEncoder().encode(text);
const directories = [];
const stores = [];

// Inspection and fault-injection operations (store-test-operations.mjs), added to every store the
// tests open: the database itself is only reachable through the store.
const testOperations = new URL("./store-test-operations.mjs", import.meta.url).href;

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
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
    operationModules: [testOperations],
    ...(migrations ? { migrations } : {}),
  });
  stores.push(store);
  return store;
}

async function close(store) {
  stores.splice(stores.indexOf(store), 1);
  await store.close();
}

const all = (store, sql, params = []) => store.call("test.all", { sql, params });
const get = (store, sql, params = []) => store.call("test.get", { sql, params });
const run = (store, sql, params = []) => store.call("test.run", { sql, params });
const pragma = (store, value) => store.call("test.pragma", { pragma: value });

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

async function durableReceipts(store, serverId = "server", instance = "instance") {
  const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
  const composition = new RuntimeComposition(serverId, instance, { ...M0_LIMITS }, bytes);
  await recordInstanceStart(store, instance, 1);
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
    expect(store.schemaVersion).toBe(MIGRATIONS.length);
    expect(await pragma(store, "user_version")).toBe(MIGRATIONS.length);
    expect(await pragma(store, "journal_mode")).toBe("wal");
    expect(await pragma(store, "synchronous")).toBe(2);
    expect(await pragma(store, "foreign_keys")).toBe(1);
    expect(await pragma(store, "busy_timeout")).toBe(0);
    expect(await pragma(store, "locking_mode")).toBe("exclusive");
    const tables = (
      await all(
        store,
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
    )
      .map((row) => row.name)
      .sort();
    expect(tables).toEqual([
      "auth_devices",
      "auth_invitations",
      "binding_conversions",
      "bindings",
      "config",
      "managed_worktrees",
      "mounts",
      "operation_processes",
      "operation_tombstones",
      "operations",
      "principals",
      "relay_instances",
      "repos",
      "runs",
      "server_identity",
      "tabs",
      "tasks",
      "workspaces",
      "worktree_attempts",
      "worktree_deletions",
      "worktree_preparations",
    ]);
    expect(store.backupPath).toBeNull();
  });

  it("refuses a second opener of the same database while the first keeps working", async () => {
    const layout = await home();
    const store = await open(layout);
    await loadOrCreateIdentity(store);
    expect(await openElsewhere(layout)).toBe("in-use");
    // The first connection still reads and writes.
    expect(await run(store, "UPDATE config SET updated_at_ms = 5")).toBe(1);
    expect((await get(store, "SELECT updated_at_ms FROM config")).updated_at_ms).toBe(5);
    await close(store);
    expect(await openElsewhere(layout)).toBe("opened");
  });

  it("refuses a database newer than this build without changing its file", async () => {
    const layout = await home();
    const store = await open(layout);
    await loadOrCreateIdentity(store);
    await pragma(store, `user_version = ${MIGRATIONS.length + 1}`);
    await close(store);
    const before = await sha256(layout.databasePath);
    const files = (await readdir(layout.serverDirectory)).sort();
    await expect(open(layout)).rejects.toMatchObject({ category: "newer-schema" });
    expect(await sha256(layout.databasePath)).toBe(before);
    expect((await readdir(layout.serverDirectory)).sort()).toEqual(files);
  });

  // A process that writes through better-sqlite3 the way the server does, then dies by SIGKILL
  // without closing, leaving its WAL behind (no checkpoint).
  function crashAfter(databasePath, statements) {
    const script = `
      const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
      const db = new Database(${JSON.stringify(databasePath)}, { timeout: 0 });
      db.pragma("locking_mode = EXCLUSIVE");
      db.pragma("journal_mode = WAL");
      db.pragma("wal_autocheckpoint = 0");
      for (const sql of ${JSON.stringify(statements)}) db.exec(sql);
      process.kill(process.pid, "SIGKILL");
    `;
    return new Promise((done) =>
      execFile(process.execPath, ["-e", script], { timeout: 20_000 }, (error) =>
        done(error?.signal),
      ),
    );
  }

  async function digests(directory) {
    const names = (await readdir(directory)).sort();
    return Object.fromEntries(
      await Promise.all(names.map(async (name) => [name, await sha256(join(directory, name))])),
    );
  }

  it("refuses a newer schema committed only to a crash-left WAL without touching any file", async () => {
    const layout = await home();
    const store = await open(layout);
    await loadOrCreateIdentity(store);
    await close(store);
    const newer = MIGRATIONS.length + 1;
    expect(
      await crashAfter(layout.databasePath, [
        `PRAGMA user_version = ${newer}`,
        "CREATE TABLE from_newer_build (x)",
      ]),
    ).toBe("SIGKILL");
    const before = await digests(layout.serverDirectory);
    expect(Object.keys(before)).toContain("cove.db-wal");
    // The database file alone still has this build's version; only the WAL holds the newer one.
    const header = await readFile(layout.databasePath);
    expect(header.readInt32BE(60)).toBe(MIGRATIONS.length);
    expect(await committedSchemaVersion(layout.databasePath)).toBe(newer);

    await expect(open(layout)).rejects.toMatchObject({ category: "newer-schema" });
    expect(await digests(layout.serverDirectory)).toEqual(before);
  });

  it("takes the instance lock before reading the database files", async () => {
    const layout = await home();
    const store = await open(layout);
    await loadOrCreateIdentity(store);
    await close(store);
    const newer = MIGRATIONS.length + 1;
    expect(await crashAfter(layout.databasePath, [`PRAGMA user_version = ${newer}`])).toBe(
      "SIGKILL",
    );
    const before = await digests(layout.serverDirectory);
    // Another process holds only the instance lock, as a running server of this data directory
    // does from before it reads its database until it has closed it.
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
         const lock = new Database(${JSON.stringify(join(layout.serverDirectory, "cove.lock"))}, { timeout: 0 });
         lock.pragma("journal_mode = MEMORY");
         lock.exec("BEGIN EXCLUSIVE");
         console.log("locked");
         process.stdin.on("end", () => { lock.close(); process.exit(0); });
         process.stdin.resume();`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const exited = new Promise((done) => holder.once("exit", done));
    try {
      await new Promise((done) => holder.stdout.once("data", done));
      // While it is held, the opener stops at the lock: in-use, not the newer schema it would
      // read from the files, and nothing is touched.
      await expect(open(layout)).rejects.toMatchObject({ category: "in-use" });
      expect(await digests(layout.serverDirectory)).toEqual(before);
    } finally {
      holder.stdin.end();
      await exited;
    }
    await expect(open(layout)).rejects.toMatchObject({ category: "newer-schema" });
    expect(await digests(layout.serverDirectory)).toEqual(before);
  });

  it("reads the committed schema version from the WAL exactly as SQLite recovers it", async () => {
    const cases = {
      committedInWal: ["CREATE TABLE t (x)", "PRAGMA user_version = 7"],
      uncommittedSpill: [
        "CREATE TABLE t (x)",
        "PRAGMA user_version = 4",
        "PRAGMA cache_size = 2",
        "BEGIN",
        "PRAGMA user_version = 9",
        `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
          INSERT INTO t SELECT randomblob(1000) FROM n`,
      ],
      staleFramesAfterRestart: [
        "CREATE TABLE t (x)",
        "PRAGMA user_version = 5",
        `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
          INSERT INTO t SELECT randomblob(1000) FROM n`,
        "PRAGMA wal_checkpoint(RESTART)",
        "PRAGMA user_version = 6",
      ],
    };
    const expected = { committedInWal: 7, uncommittedSpill: 4, staleFramesAfterRestart: 6 };
    for (const [name, statements] of Object.entries(cases)) {
      const directory = await mkdtemp(join(tmpdir(), "cove-wal-"));
      directories.push(directory);
      const databasePath = join(directory, "cove.db");
      expect(await crashAfter(databasePath, statements)).toBe("SIGKILL");
      const before = await digests(directory);
      const version = await committedSchemaVersion(databasePath);
      expect(await digests(directory)).toEqual(before);
      // SQLite's own recovery, on a copy.
      const copy = await mkdtemp(join(tmpdir(), "cove-wal-copy-"));
      directories.push(copy);
      for (const file of Object.keys(before))
        if (file !== "cove.db-shm") await cp(join(directory, file), join(copy, file));
      const Database = require("better-sqlite3");
      const db = new Database(join(copy, "cove.db"));
      const recovered = db.pragma("user_version", { simple: true });
      db.close();
      expect({ name, version }).toEqual({ name, version: recovered });
      expect({ name, version }).toEqual({ name, version: expected[name] });
    }
  });

  it("backs up an older schema with VACUUM INTO, then migrates in one transaction", async () => {
    const layout = await home();
    const first = [{ version: 1, name: "one", sql: "CREATE TABLE one (value INTEGER) STRICT;" }];
    const store = await open(layout, first);
    await run(store, "INSERT INTO one VALUES (7)");
    await close(store);
    const broken = [...first, { version: 2, name: "broken", sql: "CREATE TABLE two (; " }];
    await expect(open(layout, broken)).rejects.toMatchObject({ category: "migration" });
    const unchanged = await open(layout, first);
    expect(unchanged.schemaVersion).toBe(1);
    expect((await get(unchanged, "SELECT value FROM one")).value).toBe(7);
    await close(unchanged);
    const next = [
      ...first,
      { version: 2, name: "two", sql: "CREATE TABLE two (x INTEGER) STRICT;" },
    ];
    const migrated = await open(layout, next);
    expect(await pragma(migrated, "user_version")).toBe(2);
    expect(migrated.backupPath).toMatch(/cove-schema-1-\d+-[0-9a-f]{8}\.db$/);
    await close(migrated);
    const backups = await readdir(layout.backupDirectory);
    // The failed attempt also took a backup before rolling back; both hold schema 1.
    expect(backups.length).toBe(2);
    const backup = await Store.open({
      databasePath: join(layout.backupDirectory, backups[0]),
      backupDirectory: layout.backupDirectory,
      migrations: first,
      operationModules: [testOperations],
    });
    expect((await get(backup, "SELECT value FROM one")).value).toBe(7);
    await backup.close();
  });

  it("keeps the server identity and local principal across reopening", async () => {
    const layout = await home();
    const store = await open(layout);
    const created = await loadOrCreateIdentity(store);
    expect(created.created).toBe(true);
    await close(store);
    const again = await open(layout);
    const loaded = await loadOrCreateIdentity(again);
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

  it("rolls back a failing operation, keeps its error kind and keeps the connection usable", async () => {
    const layout = await home();
    const store = await open(layout);
    await loadOrCreateIdentity(store);
    const failed = await store
      .call("test.failAfterWrite", { sql: "UPDATE config SET revision = 9" })
      .catch((error) => error);
    expect(failed).toBeInstanceOf(StoreOperationError);
    expect(failed).toMatchObject({ code: "SQLITE_IOERR_WRITE", message: "injected failure" });
    const missing = await all(store, "SELECT * FROM missing").catch((error) => error);
    expect(missing).toBeInstanceOf(StoreOperationError);
    expect(missing.code).toBe("SQLITE_ERROR");
    expect((await get(store, "SELECT revision FROM config")).revision).toBe(0);
    const unknown = await store.call("no.such.operation", {}).catch((error) => error);
    expect(unknown).toBeInstanceOf(StoreOperationError);
    expect(unknown.code).toBeNull();
    // Every call is one transaction and is observed once, with its execution interval.
    const observed = [];
    store.observe((start, end) => observed.push(end >= start));
    await get(store, "SELECT 1");
    expect(observed).toEqual([true]);
  });

  // #144 item 4: only a refusal that can pass is repeated; a persistent error is thrown at once
  // and reported by the store with its operation and code, while the store stays usable.
  it("repeats only transient refusals and reports persistent operation errors", async () => {
    const store = await open(await home());
    const reported = [];
    const unsubscribe = store.onOperationError((operation, code) =>
      reported.push([operation, code]),
    );
    const schedule = { tries: Infinity, delayMs: 1, capMs: 1 };
    const failing = (codes) => {
      const calls = [];
      const call = () => {
        const code = codes[calls.length];
        calls.push(code ?? "ok");
        return code ? store.call("test.failWith", { code }) : get(store, "SELECT 1 AS one");
      };
      return { calls, call };
    };
    const busy = failing(["SQLITE_BUSY", "SQLITE_LOCKED_SHAREDCACHE"]);
    expect(await retryRefused(busy.call, schedule)).toEqual({ one: 1 });
    expect(busy.calls).toEqual(["SQLITE_BUSY", "SQLITE_LOCKED_SHAREDCACHE", "ok"]);
    for (const code of ["SQLITE_READONLY", "SQLITE_CORRUPT", "SQLITE_IOERR_WRITE", "SQLITE_FULL"]) {
      const persistent = failing([code, code]);
      await expect(retryRefused(persistent.call, schedule)).rejects.toMatchObject({ code });
      expect(persistent.calls).toEqual([code]);
    }
    expect(reported).toEqual([
      ["test.failWith", "SQLITE_READONLY"],
      ["test.failWith", "SQLITE_CORRUPT"],
      ["test.failWith", "SQLITE_IOERR_WRITE"],
      ["test.failWith", "SQLITE_FULL"],
    ]);
    unsubscribe();
    await store.call("test.failWith", { code: "SQLITE_READONLY" }).catch(() => undefined);
    expect(reported).toHaveLength(4);
    expect(store.isOpen).toBe(true);
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
    let receipts = await durableReceipts(store);
    expect(await (await receipts.prepare(key("a"), "intent-a")).commit(record("a"))).toBe(true);
    expect(receipts.count).toBe(0);
    expect(await receipts.update(key("a"), record("a", { revision: 1, state: "succeeded" }))).toBe(
      true,
    );
    receipts.dispose();
    await close(store);
    store = await open(layout);
    receipts = await durableReceipts(store, "server", "next-instance");
    expect(await receipts.lookup(key("a"), "intent-a")).toMatchObject({
      kind: "existing",
      record: { revision: 1, state: "succeeded" },
    });
    expect((await receipts.lookup(key("a"), "intent-b")).kind).toBe("conflict");
    expect((await receipts.lookup({ ...key("a"), principalId: "other" }, "intent-a")).kind).toBe(
      "reserve",
    );
    expect(await receipts.update(key("a"), record("a", { revision: 2, state: "running" }))).toBe(
      false,
    );
    expect(await receipts.prepare(key("a"), "intent-a")).toBeNull();
    receipts.dispose();
  });

  it("refuses stale successors with a compare-and-set on the stored revision", async () => {
    const layout = await home();
    const store = await open(layout);
    const receipts = await durableReceipts(store);
    expect(await (await receipts.prepare(key("b"), "intent")).commit(record("b"))).toBe(true);
    expect(await receipts.update(key("b"), record("b", { revision: 2, state: "running" }))).toBe(
      false,
    );
    expect(await receipts.update(key("b"), record("b", { revision: 1, state: "running" }))).toBe(
      true,
    );
    expect(await receipts.update(key("b"), record("b", { revision: 1, state: "succeeded" }))).toBe(
      false,
    );
    expect(await receipts.get(key("b"))).toMatchObject({ revision: 1, state: "running" });
    receipts.dispose();
  });

  it("moves unfinished receipts of an earlier instance to requires_attention without running them", async () => {
    const layout = await home();
    let store = await open(layout);
    let receipts = await durableReceipts(store);
    const run = { serverId: "server", relayInstanceId: "instance", runId: "run-1" };
    const create = { ...record("c"), method: "terminal.create", run };
    for (const id of ["accepted", "running", "done", "failed"])
      expect(
        await (
          await receipts.prepare(key(id), `intent-${id}`)
        ).commit({
          ...create,
          operationId: id,
        }),
      ).toBe(true);
    for (const [id, state] of [
      ["running", "running"],
      ["done", "succeeded"],
      ["failed", "failed"],
    ])
      expect(
        await receipts.update(key(id), { ...create, operationId: id, revision: 1, state }),
      ).toBe(true);
    receipts.dispose();
    await close(store);
    store = await open(layout);
    receipts = await durableReceipts(store, "server", "restarted");
    const verified = await receipts.recoverInterrupted();
    expect(verified.map((item) => [item.operationId, item.state, item.revision]).sort()).toEqual([
      ["accepted", "requires_attention", 2],
      ["running", "requires_attention", 3],
    ]);
    for (const id of ["accepted", "running"]) {
      const current = await receipts.get(key(id));
      expect(current).toMatchObject({ state: "requires_attention", run });
      expect(current.error).toMatchObject({ kind: "RESULT_UNKNOWN", acceptance: "unknown" });
      // A same-intent resend only returns the record; a late result cannot replace it.
      expect((await receipts.lookup(key(id), `intent-${id}`)).kind).toBe("existing");
      expect(
        await receipts.update(key(id), {
          ...current,
          revision: current.revision + 1,
          state: "succeeded",
        }),
      ).toBe(false);
    }
    expect(await receipts.get(key("done"))).toMatchObject({ state: "succeeded", revision: 1 });
    expect(await receipts.get(key("failed"))).toMatchObject({ state: "failed", revision: 1 });
    // Explicit recovery still works on the durable record.
    const attention = await receipts.get(key("running"));
    expect(
      await receipts.recover(key("running"), attention.revision, {
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
    let receipts = await durableReceipts(store);
    expect(
      await (
        await receipts.prepare(key("v"), "intent")
      ).commit(record("v", { method: "mount.retry" })),
    ).toBe(true);
    receipts.dispose();
    receipts = await durableReceipts(store, "server", "second");
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
    let receipts = await durableReceipts(store);
    for (const id of ["proven", "throws"])
      expect(
        await (
          await receipts.prepare(key(id), `intent-${id}`)
        ).commit(record(id, { method: "mount.retry" })),
      ).toBe(true);
    receipts.dispose();
    receipts = await durableReceipts(store, "server", "second");
    const seen = [];
    const outcomes = await receipts.recoverInterrupted({
      "mount.retry": async (current) => {
        // The move to recovering is durable before the verifier inspects anything, so a crash
        // during verification is retried by the next start.
        seen.push([
          current.operationId,
          (
            await get(store, "SELECT state FROM operations WHERE operation_id = ?", [
              current.operationId,
            ])
          ).state,
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

describe("operation receipt retention (m2 D13)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const RETENTION = 30 * DAY;
  const T0 = 1_700_000_000_000;
  const key = (operationId) => ({ serverId: "server", principalId: "principal", operationId });
  const intent = (operationId) => `intent-${operationId}`;

  // Receipts whose backend stamps records with `clock.now`, the wall clock the purge also reads.
  async function clocked(store, retention = {}) {
    const clock = { now: T0 };
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const composition = new RuntimeComposition("server", "instance", { ...M0_LIMITS }, bytes);
    await recordInstanceStart(store, "instance", T0);
    const receipts = new OperationReceipts(
      composition,
      encode,
      new SqliteReceiptBackend(store, "instance", () => clock.now),
      { now: () => clock.now, ...retention },
    );
    return { clock, receipts };
  }

  // Commits operationId as accepted and, unless `state` is accepted, moves it to `state`.
  async function settled(receipts, operationId, state, extra = {}) {
    const accepted = {
      operationId,
      method: "config.set",
      revision: 0,
      state: "accepted",
      ...extra,
    };
    expect(
      await (await receipts.prepare(key(operationId), intent(operationId))).commit(accepted),
    ).toBe(true);
    const moved =
      state === "accepted" ||
      (await receipts.update(key(operationId), { ...accepted, revision: 1, state }));
    expect(moved).toBe(true);
  }

  const states = async (store) =>
    Object.fromEntries(
      (await all(store, "SELECT operation_id, state FROM operations")).map((row) => [
        row.operation_id,
        row.state,
      ]),
    );
  const tombstones = (store) =>
    all(store, "SELECT * FROM operation_tombstones ORDER BY operation_id");

  it("replaces ended receipts 30 days after they ended with permanent tombstones and keeps the rest", async () => {
    const layout = await home();
    const store = await open(layout);
    const { clock, receipts } = await clocked(store);
    for (const state of ["succeeded", "failed", "cancelled", "requires_attention", "running"])
      await settled(receipts, state, state);
    await settled(receipts, "accepted", "accepted");
    clock.now = T0 + DAY;
    await settled(receipts, "young", "succeeded");

    // One millisecond short of the retention period nothing is due.
    clock.now = T0 + RETENTION - 1;
    expect(await receipts.purgeExpired()).toBe(0);
    clock.now = T0 + RETENTION;
    expect(await receipts.purgeExpired()).toBe(3);
    expect(await states(store)).toEqual({
      accepted: "accepted",
      requires_attention: "requires_attention",
      running: "running",
      young: "succeeded",
    });
    const rows = await tombstones(store);
    expect(rows).toEqual(
      ["cancelled", "failed", "succeeded"].map((state) => ({
        server_id: "server",
        principal_id: "principal",
        operation_id: state,
        method: "config.set",
        state,
        intent_digest: createHash("sha256").update(intent(state)).digest("hex").slice(0, 32),
        ended_at_ms: T0,
        purged_at_ms: T0 + RETENTION,
      })),
    );
    // About a hundred bytes, and nothing of the request or its result.
    for (const row of rows) expect(JSON.stringify(row).length).toBeLessThan(260);

    // The same request is expired, another one under the ID conflicts; neither can be reserved.
    expect((await receipts.lookup(key("succeeded"), intent("succeeded"))).kind).toBe("expired");
    expect((await receipts.lookup(key("succeeded"), "another")).kind).toBe("conflict");
    expect(await receipts.prepare(key("succeeded"), intent("succeeded"))).toBeNull();
    expect(await receipts.read(key("failed"))).toBe("expired");
    expect(await receipts.get(key("failed"))).toBeNull();
    expect(await receipts.read(key("never-used"))).toBeNull();
    // A tombstoned receipt never changes again.
    expect(
      await receipts.update(key("succeeded"), {
        operationId: "succeeded",
        method: "config.set",
        revision: 2,
        state: "running",
      }),
    ).toBe(false);

    // Tombstones are never purged, however long after.
    clock.now = T0 + 10 * RETENTION;
    expect(await receipts.purgeExpired()).toBe(1);
    expect((await tombstones(store)).map((row) => row.operation_id)).toEqual([
      "cancelled",
      "failed",
      "succeeded",
      "young",
    ]);
    expect(Object.keys(await states(store)).sort()).toEqual([
      "accepted",
      "requires_attention",
      "running",
    ]);
    receipts.dispose();
  });

  it("never purges early when the clock goes back", async () => {
    const layout = await home();
    const store = await open(layout);
    const { clock, receipts } = await clocked(store);
    await settled(receipts, "a", "succeeded");
    // The clock went back after the receipt ended: it looks younger, never older.
    clock.now = T0 - 5 * DAY;
    expect(await receipts.purgeExpired()).toBe(0);
    clock.now = T0 + RETENTION - DAY;
    expect(await receipts.purgeExpired()).toBe(0);
    // A receipt stamped while the clock was ahead waits for the clock to pass its end.
    clock.now = T0 + 100 * DAY;
    await settled(receipts, "ahead", "succeeded");
    clock.now = T0 + 40 * DAY;
    expect(await receipts.purgeExpired()).toBe(1);
    expect(await states(store)).toEqual({ ahead: "succeeded" });
    receipts.dispose();
  });

  it("purges in bounded batches, each one transaction that a failure rolls back whole", async () => {
    const layout = await home();
    const store = await open(layout);
    const { clock, receipts } = await clocked(store, { batchSize: 2 });
    for (const id of ["a", "b", "c", "d", "e"]) {
      await settled(receipts, id, "succeeded");
      clock.now += 1;
    }
    clock.now = T0 + RETENTION + 10;
    const calls = [];
    const backend = new SqliteReceiptBackend(store, "instance", () => clock.now);
    const purge = backend.purge.bind(backend);
    backend.purge = async (batch) => {
      calls.push(batch);
      return purge(batch);
    };
    // The second batch (c, d) fails half way through: deleting d is refused.
    await run(
      store,
      `CREATE TRIGGER refuse_d BEFORE DELETE ON operations WHEN OLD.operation_id = 'd'
       BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const batched = new OperationReceipts(
      new RuntimeComposition("server", "instance", { ...M0_LIMITS }, bytes),
      encode,
      backend,
      { now: () => clock.now, batchSize: 2 },
    );
    await expect(batched.purgeExpired()).rejects.toThrow("injected");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ limit: 2, retentionMs: RETENTION, now: T0 + RETENTION + 10 });
    // a and b were purged by the first batch; c is whole again, with no tombstone.
    expect((await tombstones(store)).map((row) => row.operation_id)).toEqual(["a", "b"]);
    expect(Object.keys(await states(store)).sort()).toEqual(["c", "d", "e"]);
    // The next pass purges what is still due.
    await run(store, "DROP TRIGGER refuse_d");
    expect(await batched.purgeExpired()).toBe(3);
    expect(calls.slice(2).map((call) => call.limit)).toEqual([2, 2]);
    expect(await states(store)).toEqual({});
    expect(await tombstones(store)).toHaveLength(5);
    batched.dispose();
    receipts.dispose();
  });

  it("keeps a receipt that a worktree mount, a live process or the run high-water mark still needs", async () => {
    const layout = await home();
    const store = await open(layout);
    const { clock, receipts } = await clocked(store);
    for (const id of ["current", "abandon", "earlier", "process", "ended-process", "plain"])
      await settled(receipts, id, "succeeded");
    const runRef = (runId) => ({ serverId: "server", relayInstanceId: "instance", runId });
    await settled(receipts, "run-high", "failed", {
      method: "terminal.create",
      run: runRef("run-7"),
    });
    await settled(receipts, "run-low", "succeeded", {
      method: "terminal.create",
      run: runRef("run-3"),
    });
    // A worktree mount whose current attempt belongs to "current" and was claimed by "abandon";
    // an earlier attempt of the same mount belongs to "earlier".
    await run(
      store,
      "INSERT INTO tasks (task_id, revision, title, slug, archived, created_at_ms, updated_at_ms) VALUES ('t1', 0, 'T', 't', 0, 1, 1)",
    );
    await run(
      store,
      "INSERT INTO workspaces (workspace_id, task_id, revision, entry_path, created_at_ms) VALUES ('w1', 't1', 0, '/w1', 1)",
    );
    await run(
      store,
      `INSERT INTO mounts (mount_id, workspace_id, name, source, repo_id, path, state, created_at_ms)
       VALUES ('m1', 'w1', 'm', 'worktree', 'r1', '/m1', 'failed', 1)`,
    );
    const attempt = (attemptId, operationId, abandon) =>
      run(
        store,
        `INSERT INTO worktree_attempts (attempt_id, operation_server_id, operation_principal_id,
           operation_id, position, mount_id, workspace_id, path, branch, no_fetch, phase,
           steps_json, outcome, abandon_server_id, abandon_principal_id, abandon_operation_id,
           created_at_ms, updated_at_ms)
         VALUES (?, 'server', 'principal', ?, 0, 'm1', 'w1', '/m1', 'b', 0, 'planned', '[]',
           'failed', ?, ?, ?, 1, 1)`,
        [
          attemptId,
          operationId,
          ...(abandon ? ["server", "principal", abandon] : [null, null, null]),
        ],
      );
    await attempt("a-earlier", "earlier");
    await attempt("a-current", "current", "abandon");
    await run(
      store,
      "INSERT INTO worktree_preparations (mount_id, spec_branch, spec_base_ref, spec_no_fetch, attempt_id) VALUES ('m1', NULL, NULL, 0, 'a-current')",
    );
    const processRow = (processId, operationId, endedAt) =>
      run(
        store,
        `INSERT INTO operation_processes (process_id, operation_server_id, operation_principal_id,
           operation_id, pid, pgid, start_identity, started_by_instance_id, started_at_ms,
           ended_at_ms)
         VALUES (?, 'server', 'principal', ?, ?, ?, 'boot:start', 'instance', 1, ?)`,
        [processId, operationId, processId === "p1" ? 101 : 102, 100, endedAt],
      );
    await processRow("p1", "process", null);
    await processRow("p2", "ended-process", 5);

    clock.now = T0 + RETENTION;
    expect(await receipts.purgeExpired()).toBe(4);
    expect(Object.keys(await states(store)).sort()).toEqual([
      "abandon",
      "current",
      "process",
      "run-high",
    ]);
    expect((await tombstones(store)).map((row) => row.operation_id)).toEqual([
      "earlier",
      "ended-process",
      "plain",
      "run-low",
    ]);
    // The ended process's attribution went with its receipt; the live one stays.
    expect(
      (await all(store, "SELECT process_id FROM operation_processes")).map((r) => r.process_id),
    ).toEqual(["p1"]);

    // Once that state is gone the receipts become due: the process ended, the mount was removed
    // (its preparation goes with it), and a later run raised the high-water mark.
    await run(store, "UPDATE operation_processes SET ended_at_ms = 9 WHERE process_id = 'p1'");
    await run(store, "DELETE FROM mounts WHERE mount_id = 'm1'");
    clock.now = T0 + RETENTION + DAY;
    await settled(receipts, "run-higher", "succeeded", {
      method: "terminal.create",
      run: runRef("run-8"),
    });
    expect(await receipts.purgeExpired()).toBe(4);
    expect(Object.keys(await states(store))).toEqual(["run-higher"]);
    receipts.dispose();
  });

  it("refuses a tombstoned ID in the write transaction and at the database itself", async () => {
    const layout = await home();
    const store = await open(layout);
    const { clock, receipts } = await clocked(store);
    await settled(receipts, "gone", "succeeded");
    clock.now = T0 + RETENTION;
    expect(await receipts.purgeExpired()).toBe(1);
    const backend = new SqliteReceiptBackend(store, "instance", () => clock.now);
    const limits = { serverId: "server", operationRecordBytes: M0_LIMITS.operationRecordBytes };
    const write = (canonicalIntent) =>
      backend.write(
        {
          key: key("gone"),
          canonicalIntent,
          method: "config.set",
          apply: { name: "config.set", args: { workspaceRoot: "/elsewhere", expectedRevision: 0 } },
        },
        limits,
      );
    expect(await write(intent("gone"))).toMatchObject({
      error: { kind: "OPERATION_HISTORY_EXPIRED", acceptance: "not-accepted" },
    });
    expect(await write("another")).toMatchObject({ error: { kind: "OPERATION_ID_CONFLICT" } });
    // Any insert of a receipt under the key is refused by the database.
    await expect(
      backend.insert({
        key: key("gone"),
        canonicalIntent: intent("gone"),
        record: { operationId: "gone", method: "config.set", revision: 0, state: "accepted" },
      }),
    ).rejects.toThrow(/operation history expired/);
    expect(await states(store)).toEqual({});
    receipts.dispose();
  });

  it("starts after startup verification, repeats on its interval and stops on dispose", async () => {
    const layout = await home();
    const store = await open(layout);
    const scheduled = [];
    const cleared = [];
    const timers = {
      set: (callback, ms) => {
        const handle = { callback, ms };
        scheduled.push(handle);
        return handle;
      },
      clear: (handle) => cleared.push(handle),
    };
    const { clock, receipts } = await clocked(store, { timers, intervalMs: 5000 });
    await settled(receipts, "old", "succeeded");
    clock.now = T0 + RETENTION;
    expect(scheduled).toEqual([]);
    await receipts.recoverInterrupted();
    expect(scheduled.map((handle) => handle.ms)).toEqual([0]);
    scheduled[0].callback();
    await receipts.purgeExpired();
    // The pass ran, and the next one is scheduled after it ended.
    await new Promise((done) => setImmediate(done));
    expect(await states(store)).toEqual({});
    expect(scheduled.map((handle) => handle.ms)).toEqual([0, 5000]);
    receipts.dispose();
    expect(cleared).toEqual([scheduled[1]]);
    // A callback that fires after dispose does nothing and schedules nothing.
    scheduled[1].callback();
    await new Promise((done) => setImmediate(done));
    expect(scheduled).toHaveLength(2);
    expect(await receipts.purgeExpired()).toBe(0);
  });

  it("uses an unref'd timer by default, so a scheduled pass never keeps the process alive", async () => {
    const layout = await home();
    const store = await open(layout);
    const { receipts } = await clocked(store, { intervalMs: 60_000 });
    const created = [];
    const set = globalThis.setTimeout;
    const clear = globalThis.clearTimeout;
    const clearedHandles = [];
    globalThis.setTimeout = (...args) => {
      const handle = set(...args);
      created.push(handle);
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      clearedHandles.push(handle);
      return clear(handle);
    };
    try {
      await receipts.recoverInterrupted();
      // Scheduling the first pass is the last thing startup verification does.
      const timer = created.at(-1);
      expect(timer.hasRef()).toBe(false);
      receipts.dispose();
      expect(clearedHandles).toContain(timer);
    } finally {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    }
  });
});

describe("operation process ownership", () => {
  const operation = { serverId: "server", principalId: "principal", operationId: "git-op" };
  // Leaders the test spawned, as owned ChildProcess handles: registered at spawn, before anything
  // is awaited, so teardown retires them even when a later step (readiness, identity) fails.
  // Teardown closes their stdin (their release) and waits; only a leader that still has not exited
  // is killed, through its handle, which Node never signals after the child was reaped.
  const leaders = [];
  // Group members the leaders start, each waiting on a FIFO: `{ fifo, pid, identity }`. A member
  // is registered before its leader is spawned, so teardown releases it through the FIFO whatever
  // step failed, and then confirms it exited: by its recorded identity disappearing or, if its
  // identity was never read, by its PID disappearing (a probe, no signal). A member that does not
  // exit is SIGKILLed only while it carries its recorded identity; one that still does not exit
  // fails the test.
  const members = [];

  afterEach(async () => {
    const failures = [];
    for (const member of members.splice(0)) {
      if (!member.released) await releaseFifo(member.fifo, 1_000);
      if (member.pid === undefined) continue;
      const gone = async () =>
        member.identity === undefined
          ? !pidExists(member.pid)
          : (await processStartIdentity(member.pid)) !== member.identity;
      if (await waitUntil(gone, 2_000)) continue;
      if (member.identity !== undefined) await signalIfSame(member.pid, member.identity, "SIGKILL");
      if (!(await waitUntil(gone, 3_000)))
        failures.push(new Error(`group member ${member.pid} did not exit`));
    }
    for (const { child, exited } of leaders.splice(0)) {
      child.stdin.destroy();
      if ((await Promise.race([exited, delay(5_000).then(() => "timeout")])) === "timeout") {
        child.kill("SIGKILL");
        await exited;
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "process teardown failed");
  });

  const delay = (ms) => new Promise((done) => setTimeout(done, ms));

  async function waitUntil(predicate, ms) {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) return false;
      await delay(20);
    }
    return true;
  }

  // Existence probe (signal 0 sends nothing).
  function pidExists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  }

  // Writes the release line to a FIFO member. The open is non-blocking, so it fails with ENXIO
  // instead of hanging while no reader has the FIFO open; that is retried until `ms` passes.
  // Returns whether the line was written.
  async function releaseFifo(fifo, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
      let writer;
      try {
        writer = await openFile(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      } catch (error) {
        if (error.code !== "ENXIO" || Date.now() > deadline) return false;
        await delay(20);
        continue;
      }
      try {
        await writer.write("go\n");
        return true;
      } finally {
        await writer.close();
      }
    }
  }

  // Signals `pid` only while it is the process recorded with `identity`; an unreadable or
  // different identity means the recorded process is gone, and nothing is signalled.
  async function signalIfSame(pid, identity, signal) {
    if ((await processStartIdentity(pid)) !== identity) return false;
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  async function ledgerWithOperation(layout) {
    const store = await open(layout ?? (await home()));
    const receipts = await durableReceipts(store);
    expect(
      await (
        await receipts.prepare(operation, "intent")
      ).commit({ operationId: "git-op", method: "config.set", revision: 0, state: "accepted" }),
    ).toBe(true);
    receipts.dispose();
    return { store, ledger: new ProcessLedger(store, "instance", () => 5) };
  }

  // A shell leading a process group of its own, as T3b runs Git. It prints `ready` (after the
  // optional setup in `before`), then waits for one line on stdin before it exits, so the test
  // decides when the leader ends.
  async function spawnLeader(before = "", env = {}, onLine = () => {}) {
    const child = spawn("/bin/sh", ["-c", `${before} echo ready; read line; exit 0`], {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ...env },
    });
    const exited = new Promise((done) => child.once("exit", done));
    leaders.push({ child, exited });
    let buffered = "";
    const ready = new Promise((done) =>
      child.stdout.on("data", (chunk) => {
        buffered += chunk;
        const parts = buffered.split("\n");
        buffered = parts.pop();
        for (const line of parts) {
          if (line === "ready") done("ready");
          else onLine(line);
        }
      }),
    );
    if ((await Promise.race([ready, exited.then(() => "exited")])) !== "ready")
      throw new Error("the leader exited before it was ready");
    const identity = await processStartIdentity(child.pid);
    if (identity === null) throw new Error(`the start identity of ${child.pid} is unreadable`);
    return {
      pid: child.pid,
      identity,
      exited,
      release: () => child.stdin.end("go\n"),
    };
  }

  async function until(predicate) {
    const deadline = Date.now() + 5_000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error("timed out");
      await delay(20);
    }
  }

  // Inserted directly: record() accepts only identities in the current format.
  function insertRaw(store, { pid, pgid, startIdentity }) {
    return run(
      store,
      `INSERT INTO operation_processes (process_id, operation_server_id, operation_principal_id,
         operation_id, pid, pgid, start_identity, started_by_instance_id, started_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'instance', 1)`,
      [
        `raw-${startIdentity}`,
        operation.serverId,
        operation.principalId,
        operation.operationId,
        pid,
        pgid,
        startIdentity,
      ],
    );
  }

  it("identifies a recorded process by PID and start identity until it ends", async () => {
    const layout = await home();
    const { store, ledger } = await ledgerWithOperation(layout);
    const leader = await spawnLeader();
    expect(parseStartIdentity(leader.identity)).toMatchObject({
      platform: process.platform,
    });
    const recorded = await ledger.record(operation, {
      pid: leader.pid,
      pgid: leader.pid,
      startIdentity: leader.identity,
    });
    expect(await ledger.open(operation)).toEqual([recorded]);
    expect(await ledger.check(operation)).toBe("alive");
    await close(store);
    leader.release();
    await leader.exited;
    await until(() => ProcessLedger.liveness(recorded).then((state) => state === "ended"));
    // The record survives a restart; the next instance observes the end and records it.
    const reopened = await open(layout);
    const next = new ProcessLedger(reopened, "next", () => 9);
    expect(await next.open(operation)).toEqual([recorded]);
    expect(await next.check(operation)).toBe("ended");
    expect(await next.open(operation)).toEqual([]);
    await close(reopened);
  });

  it("treats a live PID with another start identity as a reused PID", async () => {
    const { store, ledger } = await ledgerWithOperation();
    const ended = await spawnLeader();
    ended.release();
    await ended.exited;
    // This test process is alive but is not the process that was recorded: same boot, another
    // start time; the recorded group (the ended leader's) has no members.
    const { platform, boot } = parseStartIdentity(ended.identity);
    const start = platform === "darwin" ? "1.000000" : "1";
    await ledger.record(operation, {
      pid: process.pid,
      pgid: ended.pid,
      startIdentity: `${platform}:${boot}:${start}`,
    });
    await until(() => ledger.check(operation).then((state) => state === "ended"));
    expect(await ledger.open(operation)).toEqual([]);
    await close(store);
  });

  it("treats a process recorded during another boot as ended without probing its IDs", async () => {
    const { store, ledger } = await ledgerWithOperation();
    // A live group under the recorded PID and PGID: after a reboot they belong to unrelated
    // processes, which must not keep the operation blocked.
    const unrelated = await spawnLeader();
    const { platform, boot, start } = parseStartIdentity(unrelated.identity);
    const earlierBoot = "00000000-0000-4000-8000-000000000000";
    expect(earlierBoot).not.toBe(boot);
    await ledger.record(operation, {
      pid: unrelated.pid,
      pgid: unrelated.pid,
      startIdentity: `${platform}:${earlierBoot}:${start}`,
    });
    expect(await ledger.check(operation)).toBe("ended");
    expect(await ledger.open(operation)).toEqual([]);
    await close(store);
  });

  it("never ends a live group recorded with an identity it cannot parse", async () => {
    const { store, ledger } = await ledgerWithOperation();
    const live = await spawnLeader();
    const { platform } = parseStartIdentity(live.identity);
    // The macOS format before microsecond start times, a malformed value and an unknown format.
    // Platform names that are inherited object properties must not find a format either.
    const identities = [
      "darwin:1791441670:Thu Oct  8 14:41:10 2026",
      `${platform}:not-a-boot-id:1`,
      `v9:${live.identity}`,
      "__proto__:bad:1",
      "constructor:bad:1",
      "toString:bad:1",
    ];
    for (const startIdentity of identities) expect(parseStartIdentity(startIdentity)).toBeNull();
    for (const startIdentity of identities) {
      await expect(
        ledger.record(operation, { pid: live.pid, pgid: live.pid, startIdentity }),
      ).rejects.toThrow(/current format/);
      await insertRaw(store, { pid: live.pid, pgid: live.pid, startIdentity });
    }
    for (const record of await ledger.open(operation))
      expect(await ProcessLedger.liveness(record)).toBe("unverifiable");
    expect(await ledger.check(operation)).toBe("unverifiable");
    expect(await ledger.open(operation)).toHaveLength(identities.length);
    // Once neither the PID nor its group exists, the records end.
    live.release();
    await live.exited;
    await until(() => ledger.check(operation).then((state) => state === "ended"));
    expect(await ledger.open(operation)).toEqual([]);
    await close(store);
  });

  it("stays unverifiable while the group outlives its leader", async () => {
    const { store, ledger } = await ledgerWithOperation();
    const directory = await mkdtemp(join(tmpdir(), "cove-ledger-"));
    directories.push(directory);
    const fifo = join(directory, "release");
    await new Promise((done, fail) =>
      execFile("mkfifo", [fifo], (error) => (error ? fail(error) : done())),
    );
    // Registered before the member can start (see teardown).
    const member = { fifo, pid: undefined, identity: undefined, released: false };
    members.push(member);
    // The member opens the FIFO read-write (which does not wait for a writer), so it is a reader
    // before it announces its PID; it then waits for the release line.
    const leader = await spawnLeader(
      `sh -c 'exec 3<>"$FIFO"; echo member $$; read line <&3' &`,
      { FIFO: fifo },
      (line) => {
        const announced = /^member (\d+)$/.exec(line);
        if (announced) member.pid = Number(announced[1]);
      },
    );
    await until(() => member.pid !== undefined);
    member.identity = await processStartIdentity(member.pid);
    expect(member.identity).not.toBeNull();
    await ledger.record(operation, {
      pid: leader.pid,
      pgid: leader.pid,
      startIdentity: leader.identity,
    });
    leader.release();
    await leader.exited;
    expect(await ledger.check(operation)).toBe("unverifiable");
    expect(await releaseFifo(fifo, 5_000)).toBe(true);
    member.released = true;
    await until(async () => (await processStartIdentity(member.pid)) !== member.identity);
    await until(() => ledger.check(operation).then((state) => state === "ended"));
    await close(store);
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
    await loadOrCreateIdentity(store);
    let receipts = await durableReceipts(store);
    let config = service(store, receipts);
    expect(await config.record()).toEqual({
      revision: 0,
      settings: { workspaceRoot: { value: "/home/owner/.cove/workspace", isDefault: true } },
    });
    const params = { operationId: "set-1", patch: { workspaceRoot: "/srv/work" } };
    const first = await config.set("principal", params);
    expect(first.operation).toMatchObject({
      state: "succeeded",
      result: { resource: { kind: "config", id: "server", revision: 1 } },
    });
    receipts.dispose();
    await close(store);
    store = await open(layout);
    receipts = await durableReceipts(store, "server", "restarted");
    config = service(store, receipts);
    expect(await config.set("principal", params)).toEqual(first);
    expect((await config.record()).revision).toBe(1);
    expect(await config.workspaceRoot()).toBe("/srv/work");
    expect(
      await config.set("principal", { ...params, patch: { workspaceRoot: null } }),
    ).toMatchObject({
      error: { kind: "OPERATION_ID_CONFLICT" },
    });
    expect(
      await config.set("principal", {
        operationId: "set-2",
        expectedRevision: 0,
        patch: { workspaceRoot: null },
      }),
    ).toMatchObject({ error: { kind: "REVISION_CONFLICT" } });
    // A refused precondition leaves no receipt: the same request may be sent once it holds.
    expect(await receipts.get(key("set-2"))).toBeNull();
    for (const workspaceRoot of ["relative/dir", "/srv/../x", "/srv/x/"])
      expect(
        await config.set("principal", {
          operationId: `bad-${workspaceRoot.length}`,
          patch: { workspaceRoot },
        }),
      ).toMatchObject({ error: { kind: "INVALID_ARGUMENT" } });
    const reset = await config.set("principal", {
      operationId: "set-3",
      expectedRevision: 1,
      patch: { workspaceRoot: null },
    });
    expect(reset.operation.result.resource.revision).toBe(2);
    expect((await config.record()).settings.workspaceRoot.isDefault).toBe(true);
    receipts.dispose();
  });

  it("rolls the receipt back with the change when the transaction fails", async () => {
    const layout = await home();
    const store = await open(layout);
    await loadOrCreateIdentity(store);
    const receipts = await durableReceipts(store);
    const config = service(store, receipts);
    // The receipt insert fails after the configuration row was written in the same transaction.
    await run(
      store,
      `CREATE TEMP TRIGGER refuse_receipts BEFORE INSERT ON operations
       BEGIN SELECT RAISE(ABORT, 'disk failure'); END`,
    );
    expect(
      await config.set("principal", { operationId: "fails", patch: { workspaceRoot: "/srv/x" } }),
    ).toMatchObject({ error: { kind: "BUSY", acceptance: "not-accepted" } });
    expect(await get(store, "SELECT revision, workspace_root FROM config")).toEqual({
      revision: 0,
      workspace_root: null,
    });
    expect(await receipts.get(key("fails"))).toBeNull();
    expect(receipts.count).toBe(0);
    receipts.dispose();
  });

  it("serves the D6 control phase from memory with the same results", async () => {
    const layout = await home();
    const store = await open(layout);
    await loadOrCreateIdentity(store);
    await store.call("config.initialize", { workspaceRoot: "/srv/initial", at: 1 });
    const probe = new D6Probe(layout.serverDirectory);
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const composition = new RuntimeComposition("server", "instance", { ...M0_LIMITS }, bytes);
    await recordInstanceStart(store, "instance", 1);
    const sqlite = new SqliteReceiptBackend(store, "instance", () => 1);
    const receipts = new OperationReceipts(composition, encode, probe.receipts(sqlite));
    const config = service(store, receipts, probe.config(sqliteConfigState(store)));
    // The control phase (SIGUSR2 in the probe server) is selected directly.
    probe.mode = "memory";
    const params = { operationId: "mem", patch: { workspaceRoot: "/srv/mem" } };
    const first = await config.set("principal", params);
    expect(first.operation.result.resource.revision).toBe(2);
    expect(await config.set("principal", params)).toEqual(first);
    expect(
      await config.set("principal", { ...params, patch: { workspaceRoot: null } }),
    ).toMatchObject({ error: { kind: "OPERATION_ID_CONFLICT" } });
    // Concurrent control writes each advance the revision once.
    const concurrent = await Promise.all(
      ["c1", "c2", "c3"].map((operationId) =>
        config.set("principal", { operationId, patch: { workspaceRoot: "/srv/c" } }),
      ),
    );
    expect(concurrent.map((item) => item.operation.result.resource.revision).sort()).toEqual([
      3, 4, 5,
    ]);
    expect(await config.record()).toMatchObject({ revision: 5 });
    expect(canonicalWriteIntent("config.set", params, encode)).toContain("config.set");
    // Nothing reached the database.
    expect(await get(store, "SELECT revision, workspace_root FROM config")).toEqual({
      revision: 1,
      workspace_root: "/srv/initial",
    });
    expect(await get(store, "SELECT count(*) AS n FROM operations")).toEqual({ n: 0 });
    receipts.dispose();
  });

  function key(operationId) {
    return { serverId: "server", principalId: "principal", operationId };
  }
});

describe("durable run records", () => {
  const ref = (instance, runId) => ({ serverId: "server", relayInstanceId: instance, runId });

  it("records run starts and exits, ends runs with an orderly stop and interrupts the rest", async () => {
    const layout = await home();
    const store = await open(layout);
    let now = 10;
    const runs = new RunLog(store, () => now);
    await recordInstanceStart(store, "old", 1);
    // Not awaited one by one: the store executes calls in the order they are made.
    const pending = [
      runs.started(ref("old", "run-1"), "/work", "op-1"),
      runs.spawned(ref("old", "run-1")),
      runs.started(ref("old", "run-2"), "/work", "op-2"),
      runs.spawned(ref("old", "run-2")),
    ];
    now = 20;
    pending.push(
      runs.exited(ref("old", "run-2"), 3, null),
      runs.started(ref("old", "run-3"), "/work", "op-3"),
      runs.notStarted(ref("old", "run-3")),
    );
    await Promise.all(pending);
    expect((await runs.live("old")).map((item) => item.run.runId)).toEqual(["run-1"]);
    await recordInstanceStart(store, "orderly", 2);
    await runs.started(ref("orderly", "run-1"), "/work", "op-4");
    await runs.spawned(ref("orderly", "run-1"));
    now = 30;
    expect(await runs.stoppedWithServer("orderly", true)).toBe(1);
    await recordInstanceStart(store, "current", 3);
    expect(await runs.interruptEarlier("current")).toBe(1);
    const rows = await all(
      store,
      "SELECT relay_instance_id, run_id, lifecycle, verification, ended_at_ms, exit_code, last_observed_at_ms FROM runs ORDER BY run_seq",
    );
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
