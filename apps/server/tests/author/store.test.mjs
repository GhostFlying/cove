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
import { MIGRATIONS } from "../../dist/store/migrations.js";
import { committedSchemaVersion } from "../../dist/store/schema-version.js";
import { prepareHome } from "../../dist/store/home.js";
import { loadOrCreateIdentity, recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { ConfigService, memoryConfigState, sqliteConfigState } from "../../dist/store/config.js";
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
      "operation_processes",
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
    loadOrCreateIdentity(store);
    close(store);
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
    loadOrCreateIdentity(store);
    close(store);
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

describe("operation process ownership", () => {
  const operation = { serverId: "server", principalId: "principal", operationId: "git-op" };
  // Leaders the test spawned, as owned ChildProcess handles: registered at spawn, before anything
  // is awaited, so teardown retires them even when a later step (readiness, identity) fails.
  // Teardown closes their stdin (their release) and waits; only a leader that still has not exited
  // is killed, through its handle, which Node never signals after the child was reaped.
  const leaders = [];
  // Group members the leaders started, by PID with the start identity read while they ran. They
  // are released through a FIFO handshake; teardown signals one only while it still carries its
  // recorded identity, so a PID an unrelated process reused is never signalled.
  const members = [];

  afterEach(async () => {
    for (const { child, exited } of leaders.splice(0)) {
      child.stdin.destroy();
      if ((await Promise.race([exited, delay(5_000).then(() => "timeout")])) === "timeout") {
        child.kill("SIGKILL");
        await exited;
      }
    }
    for (const { pid, identity } of members.splice(0)) await signalIfSame(pid, identity, "SIGKILL");
  });

  const delay = (ms) => new Promise((done) => setTimeout(done, ms));

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
    const receipts = durableReceipts(store);
    expect(
      receipts
        .prepare(operation, "intent")
        .commit({ operationId: "git-op", method: "config.set", revision: 0, state: "accepted" }),
    ).toBe(true);
    receipts.dispose();
    return { store, ledger: new ProcessLedger(store, "instance", () => 5) };
  }

  // A shell leading a process group of its own, as T3b runs Git. It prints `ready` (after the
  // optional setup in `before`), then waits for one line on stdin before it exits, so the test
  // decides when the leader ends.
  async function spawnLeader(before = "", env = {}) {
    const child = spawn("/bin/sh", ["-c", `${before} echo ready; read line; exit 0`], {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ...env },
    });
    const exited = new Promise((done) => child.once("exit", done));
    leaders.push({ child, exited });
    const lines = [];
    let buffered = "";
    const ready = new Promise((done) =>
      child.stdout.on("data", (chunk) => {
        buffered += chunk;
        const parts = buffered.split("\n");
        buffered = parts.pop();
        for (const line of parts) {
          if (line === "ready") done("ready");
          else lines.push(line);
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
      lines,
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
    store.db
      .prepare(
        `INSERT INTO operation_processes (process_id, operation_server_id, operation_principal_id,
           operation_id, pid, pgid, start_identity, started_by_instance_id, started_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'instance', 1)`,
      )
      .run(
        `raw-${startIdentity}`,
        operation.serverId,
        operation.principalId,
        operation.operationId,
        pid,
        pgid,
        startIdentity,
      );
  }

  it("identifies a recorded process by PID and start identity until it ends", async () => {
    const layout = await home();
    const { store, ledger } = await ledgerWithOperation(layout);
    const leader = await spawnLeader();
    expect(parseStartIdentity(leader.identity)).toMatchObject({
      platform: process.platform,
    });
    const recorded = ledger.record(operation, {
      pid: leader.pid,
      pgid: leader.pid,
      startIdentity: leader.identity,
    });
    expect(ledger.open(operation)).toEqual([recorded]);
    expect(await ledger.check(operation)).toBe("alive");
    close(store);
    leader.release();
    await leader.exited;
    await until(() => ProcessLedger.liveness(recorded).then((state) => state === "ended"));
    // The record survives a restart; the next instance observes the end and records it.
    const reopened = await open(layout);
    const next = new ProcessLedger(reopened, "next", () => 9);
    expect(next.open(operation)).toEqual([recorded]);
    expect(await next.check(operation)).toBe("ended");
    expect(next.open(operation)).toEqual([]);
    close(reopened);
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
    ledger.record(operation, {
      pid: process.pid,
      pgid: ended.pid,
      startIdentity: `${platform}:${boot}:${start}`,
    });
    await until(() => ledger.check(operation).then((state) => state === "ended"));
    expect(ledger.open(operation)).toEqual([]);
    close(store);
  });

  it("treats a process recorded during another boot as ended without probing its IDs", async () => {
    const { store, ledger } = await ledgerWithOperation();
    // A live group under the recorded PID and PGID: after a reboot they belong to unrelated
    // processes, which must not keep the operation blocked.
    const unrelated = await spawnLeader();
    const { platform, boot, start } = parseStartIdentity(unrelated.identity);
    const earlierBoot = "00000000-0000-4000-8000-000000000000";
    expect(earlierBoot).not.toBe(boot);
    ledger.record(operation, {
      pid: unrelated.pid,
      pgid: unrelated.pid,
      startIdentity: `${platform}:${earlierBoot}:${start}`,
    });
    expect(await ledger.check(operation)).toBe("ended");
    expect(ledger.open(operation)).toEqual([]);
    close(store);
  });

  it("never ends a live group recorded with an identity it cannot parse", async () => {
    const { store, ledger } = await ledgerWithOperation();
    const live = await spawnLeader();
    const { platform } = parseStartIdentity(live.identity);
    // The macOS format before microsecond start times, a malformed value and an unknown format.
    const identities = [
      "darwin:1791441670:Thu Oct  8 14:41:10 2026",
      `${platform}:not-a-boot-id:1`,
      `v9:${live.identity}`,
    ];
    for (const startIdentity of identities) {
      expect(() =>
        ledger.record(operation, { pid: live.pid, pgid: live.pid, startIdentity }),
      ).toThrow(/current format/);
      insertRaw(store, { pid: live.pid, pgid: live.pid, startIdentity });
    }
    for (const record of ledger.open(operation))
      expect(await ProcessLedger.liveness(record)).toBe("unverifiable");
    expect(await ledger.check(operation)).toBe("unverifiable");
    expect(ledger.open(operation)).toHaveLength(3);
    // Once neither the PID nor its group exists, the records end.
    live.release();
    await live.exited;
    await until(() => ledger.check(operation).then((state) => state === "ended"));
    expect(ledger.open(operation)).toEqual([]);
    close(store);
  });

  it("stays unverifiable while the group outlives its leader", async () => {
    const { store, ledger } = await ledgerWithOperation();
    // The leader starts a member of its group that waits on a FIFO, and reports its PID before
    // `ready`; the test releases the member by writing to the FIFO.
    const directory = await mkdtemp(join(tmpdir(), "cove-ledger-"));
    directories.push(directory);
    const fifo = join(directory, "release");
    await new Promise((done, fail) =>
      execFile("mkfifo", [fifo], (error) => (error ? fail(error) : done())),
    );
    const leader = await spawnLeader(`sh -c 'read line < "$FIFO"' & echo $!;`, { FIFO: fifo });
    const member = Number(leader.lines[0]);
    const memberIdentity = await processStartIdentity(member);
    expect(memberIdentity).not.toBeNull();
    members.push({ pid: member, identity: memberIdentity });
    ledger.record(operation, { pid: leader.pid, pgid: leader.pid, startIdentity: leader.identity });
    leader.release();
    await leader.exited;
    expect(await ledger.check(operation)).toBe("unverifiable");
    // Release the member: O_NONBLOCK fails (ENXIO) instead of blocking if it is no longer reading.
    const writer = await openFile(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    await writer.write("go\n");
    await writer.close();
    await until(() => ledger.check(operation).then((state) => state === "ended"));
    close(store);
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
