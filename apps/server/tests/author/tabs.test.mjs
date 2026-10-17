import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import { encodePipeFrame } from "@cove/protocol/pipe";
import { validateRpcResultForCall } from "@cove/protocol/rpc";
import { defaultTabName, liveRunsUsing, TabService } from "../../dist/domain/tabs.js";
import { RecordingRunRegistry } from "../../dist/entry/recording-run-registry.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { TerminalOperations } from "../../dist/operations/terminal-operations.js";
import { Store } from "../../dist/store/database.js";
import { prepareHome } from "../../dist/store/home.js";
import { recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { RunLog } from "../../dist/store/runs.js";
import { LocalRuntime } from "../../dist/terminal/local-runtime.js";
import { RunRegistry } from "../../dist/terminal/run-registry.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import { WorkerPipeSession } from "../../dist/terminal/worker-pipe-session.js";
import { WorkerPool } from "../../dist/terminal/worker-pool.js";

// Tabs and runs (docs/milestones/m1.md T4) below the CLI: what S5 and S7 cannot provoke through
// the compiled server. A synthetic worker answers spawns and stops on demand, the store is real,
// and the task, workspace and mounts are rows inserted directly (T3a owns how they are made).

const codec = {
  encode: (text) => new TextEncoder().encode(text),
  decode: (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
};
const encode = codec.encode;
const settled = () => new Promise((resolve) => setImmediate(resolve));
const testOperations = new URL("./store-test-operations.mjs", import.meta.url).href;
const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function counter(prefix) {
  let next = 0;
  return () => `${prefix}${++next}`;
}

// One server instance on `store`: a synthetic worker, the runtime, receipts, terminal operations
// and the tab service. `recording: false` leaves exit facts out of the store, as when the
// registry's best-effort write failed. `runsPerWorker` lowers the pool's placement limit so a
// test can fill it with a few runs.
function instance(
  store,
  relayInstanceId,
  { recording = true, responseBytes, runsPerWorker = M0_LIMITS.maxRuns } = {},
) {
  const worker = {
    serverId: "server",
    relayInstanceId,
    workerId: "worker",
    workerIncarnationId: "birth",
  };
  const budgets = { ...M0_LIMITS };
  const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
  const composition = new RuntimeComposition("server", relayInstanceId, budgets, bytes);
  const commands = [];
  const session = new WorkerPipeSession({
    worker,
    composition,
    codec,
    buildVersion: "author",
    transport: {
      write: (data, done, handing) => {
        const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(8);
        const metadata = JSON.parse(codec.decode(data.subarray(16, 16 + length)));
        const payload = data.subarray(16 + length);
        handing();
        if (metadata.type !== "hello")
          commands.push({
            ...metadata,
            ...(metadata.type === "spawn" ? { spawn: JSON.parse(codec.decode(payload)) } : {}),
          });
        done();
        return true;
      },
    },
    now: () => 0,
    timeoutMs: 100_000,
    identityLimit: 32,
  });
  session.start();
  const frame = (message, kind = message.type === "error" ? 4 : 2) =>
    session.receive(encodePipeFrame(kind, encode(JSON.stringify(message)), new Uint8Array()).value);
  frame({ type: "ready", worker, pipeVersion: 2, buildVersion: "peer", effectiveBudgets: budgets });
  const runLog = new RunLog(store);
  const registry = recording
    ? new RecordingRunRegistry(composition, runLog)
    : new RunRegistry(composition);
  const runtime = new LocalRuntime(new WorkerPool(composition, 1, runsPerWorker), registry, encode);
  runtime.addWorker(session);
  const receipts = new OperationReceipts(
    composition,
    encode,
    new SqliteReceiptBackend(store, relayInstanceId),
  );
  const operations = new TerminalOperations({
    composition,
    runtime,
    receipts,
    encodeUtf8: encode,
    runs: runLog,
  });
  const tabs = new TabService({
    store,
    receipts,
    operations,
    encodeUtf8: encode,
    newId: counter(`tab-${relayInstanceId}-`),
    loginShell: () => "/bin/synthetic-shell",
    ...(responseBytes ? { responseBytes } : {}),
  });
  const status = (run, state, extra = {}) => ({
    run,
    status: state,
    geometry: { cols: 80, rows: 24 },
    controlEpoch: 0,
    controlHolder: null,
    receivedSeq: 0,
    parsedSeq: 0,
    recovery: "unavailable",
    exitCode: null,
    signal: null,
    ...extra,
  });
  // Waits for the next command of `type` the worker received and answers it.
  // The store runs in a worker thread, so the command arrives after real (bounded) time.
  async function answer(type, outcome = "accepted", runStatus, pending, error) {
    let command;
    let answered = false;
    void pending?.then((value) => (answered = value));
    const deadline = Date.now() + 5_000;
    while (!command && Date.now() < deadline && !answered) {
      command = commands.find((item) => item.type === type && !item.answered);
      if (!command) await new Promise((done) => setTimeout(done, 2));
    }
    if (!command)
      throw new Error(`no ${type} command reached the worker: ${JSON.stringify(answered)}`);
    command.answered = true;
    if (error) {
      frame({
        type: "error",
        worker,
        run: command.run,
        requestId: command.requestId,
        commandType: type,
        error,
      });
      return command;
    }
    frame({
      type: "result",
      worker,
      run: command.run,
      requestId: command.requestId,
      commandType: type,
      operationId: command.operationId,
      outcome,
      ...(outcome === "unknown"
        ? {}
        : runStatus === null
          ? {}
          : { runStatus: runStatus ?? status(command.run, "live") }),
    });
    return command;
  }
  // Waits for the next command of `type` and answers it with the worker's definite refusal, as a
  // real worker answers a spawn its native factory rejected before any PTY existed.
  async function refuse(type, errorKind, pending) {
    const command = await answer(type, "accepted", undefined, pending, domainError(errorKind));
    return { outcome: await pending, command };
  }
  // A launch whose spawn the worker accepts.
  async function launched(promise, outcome = "accepted") {
    const command = await answer(
      "spawn",
      outcome,
      outcome === "rejected" ? null : undefined,
      promise,
    );
    return { outcome: await promise, command };
  }
  const exit = (run, exitCode = 0, signal = null) =>
    registry.observeExit(worker, run, { exitCode, signal });
  const close = () => {
    operations.dispose();
    receipts.dispose();
    runtime.dispose();
    session.transportReleased();
  };
  cleanups.push(async () => close());
  return {
    worker,
    composition,
    session,
    commands,
    registry,
    runtime,
    receipts,
    operations,
    tabs,
    runLog,
    answer,
    refuse,
    launched,
    exit,
    status,
    close,
  };
}

async function setup(options) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cove-tabs-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const layout = await prepareHome(join(root, "home"));
  const store = await Store.open({
    databasePath: layout.databasePath,
    backupDirectory: layout.backupDirectory,
    operationModules: [testOperations],
  });
  cleanups.push(() => store.close());
  await recordInstanceStart(store, "instance", 1);
  const sql = (text, params = []) => store.call("test.run", { sql: text, params });
  const rows = (text, params = []) => store.call("test.all", { sql: text, params });
  // A task whose workspace has two ready checkouts and one pending worktree.
  const entry = join(root, "workspaces", "task-1");
  await sql(
    `INSERT INTO tasks (task_id, revision, title, slug, archived, created_at_ms, updated_at_ms)
     VALUES ('task-1', 0, 'T', 't', 0, 1, 1)`,
  );
  await sql(
    `INSERT INTO workspaces (workspace_id, task_id, revision, entry_path, created_at_ms)
     VALUES ('ws-1', 'task-1', 3, ?, 1)`,
    [entry],
  );
  const mount = (id, name, source, path, state = "ready", at = 1) =>
    sql(
      `INSERT INTO mounts (mount_id, workspace_id, name, source, repo_id, path, entry_path, state,
         created_at_ms) VALUES (?, 'ws-1', ?, ?, 'repo-1', ?, NULL, ?, ?)`,
      [id, name, source, path, state, at],
    );
  await mount("m-alpha", "alpha", "checkout", join(root, "clones", "alpha"), "ready", 1);
  await mount("m-beta", "beta", "checkout", join(root, "clones", "beta"), "ready", 2);
  await mount("m-wt", "wt", "worktree", join(entry, "wt"), "pending", 3);
  const env = instance(store, "instance", options);
  return {
    root,
    store,
    sql,
    rows,
    entry,
    ...env,
    instance: (id, more) => instance(store, id, more),
  };
}

const kind = (outcome) => outcome.error?.kind;
const command = (argv = []) => ({ kind: "command", executable: "/bin/synthetic", argv });
const create = (operationId, extra = {}) => ({
  operationId,
  taskId: "task-1",
  recipe: command(["run"]),
  ...extra,
});

describe("tab launches", () => {
  it("records the run with the workspace snapshot before the spawn and spawns the recipe in the entry", async () => {
    const env = await setup();
    const pending = env.tabs.create("p", create("c1"));
    const spawn = await env.answer("spawn");
    // The worker got the spawn only after the run and the accepted receipt were committed.
    const [row] = await env.rows("SELECT lifecycle, tab_id, mounts_json FROM runs");
    expect(row.tab_id).toBe("tab-instance-1");
    expect(spawn.spawn).toEqual({ executable: "/bin/synthetic", argv: ["run"], cwd: env.entry });
    const outcome = await pending;
    expect(outcome.operation).toMatchObject({
      method: "tab.create",
      state: "succeeded",
      run: { serverId: "server", relayInstanceId: "instance", runId: "run-1" },
      result: { resource: { kind: "tab", id: "tab-instance-1", revision: 0 } },
    });
    expect(validateRpcResultForCall("tab.create", create("c1"), outcome)).toBe(true);
    const read = await env.tabs.get("tab-instance-1");
    expect(validateRpcResultForCall("tab.get", { tabId: "tab-instance-1" }, read)).toBe(true);
    expect(read.tab).toMatchObject({ name: "synthetic", cwd: { kind: "entry" }, revision: 0 });
    expect(read.latestRun).toMatchObject({
      run: outcome.operation.run,
      tabId: "tab-instance-1",
      taskId: "task-1",
      workspaceRevision: 3,
      cwd: env.entry,
      lifecycle: "running",
      verification: "live",
      mounts: [
        { name: "alpha", source: "checkout", path: join(env.root, "clones", "alpha") },
        { name: "beta", source: "checkout", path: join(env.root, "clones", "beta") },
        { name: "wt", source: "worktree", path: join(env.entry, "wt") },
      ],
    });
  });

  it("starts the login shell for a shell recipe and refuses a cwd mount that is not ready or gone", async () => {
    const env = await setup();
    const shell = env.tabs.create(
      "p",
      create("c1", { recipe: { kind: "shell" }, cwd: { kind: "mount", mountId: "m-beta" } }),
    );
    const { command: spawned } = await env.launched(shell);
    expect(spawned.spawn).toEqual({
      executable: "/bin/synthetic-shell",
      argv: ["-l"],
      cwd: join(env.root, "clones", "beta"),
    });
    expect((await env.tabs.get("tab-instance-1")).tab.name).toBe("shell");
    const pendingMount = await env.tabs.create(
      "p",
      create("c2", { cwd: { kind: "mount", mountId: "m-wt" } }),
    );
    expect(kind(pendingMount)).toBe("INVALID_ARGUMENT");
    const gone = await env.tabs.create(
      "p",
      create("c3", { cwd: { kind: "mount", mountId: "nope" } }),
    );
    expect(kind(gone)).toBe("MOUNT_NOT_FOUND");
    expect(kind(await env.tabs.create("p", create("c4", { taskId: "nope" })))).toBe(
      "TASK_NOT_FOUND",
    );
    // Refused launches record nothing and leave no reservation behind.
    expect(await env.rows("SELECT tab_id FROM tabs")).toEqual([{ tab_id: "tab-instance-1" }]);
    expect(await env.rows("SELECT operation_id FROM operations ORDER BY operation_id")).toEqual([
      { operation_id: "c1" },
    ]);
    expect(env.registry.count).toBe(1);
    expect(env.commands.filter((item) => item.type === "spawn")).toHaveLength(1);
  });

  it("keeps the tab without a run when the worker refuses the first spawn, and reverts a refused reopen", async () => {
    const env = await setup();
    const { outcome } = await env.launched(env.tabs.create("p", create("c1")), "rejected");
    expect(outcome.operation).toMatchObject({
      state: "failed",
      result: { resource: { kind: "tab", id: "tab-instance-1" } },
    });
    let read = await env.tabs.get("tab-instance-1");
    expect(read.latestRun).toBeNull();
    expect(read.tab).toMatchObject({ latestRun: null, revision: 1 });
    expect(await env.rows("SELECT run_id FROM runs")).toEqual([]);

    const first = await env.launched(
      env.tabs.reopen("p", { operationId: "r1", tabId: "tab-instance-1" }),
    );
    env.exit(first.outcome.operation.run, 3);
    await settled();
    const refused = await env.launched(
      env.tabs.reopen("p", { operationId: "r2", tabId: "tab-instance-1" }),
      "rejected",
    );
    expect(refused.outcome.operation.state).toBe("failed");
    read = await env.tabs.get("tab-instance-1");
    expect(read.tab.latestRun).toEqual(first.outcome.operation.run);
    expect(read.latestRun).toMatchObject({ lifecycle: "exited", exitCode: 3 });
    // Every launch and every refused spawn's revert is a new revision: 0 (create), 1 (revert),
    // 2 (reopen), 3 (reopen), 4 (revert to the earlier run).
    expect(read.tab.revision).toBe(4);
  });

  it("refuses a reopen while a run has no end record, also when its worker is out of contact", async () => {
    const env = await setup();
    const { outcome } = await env.launched(env.tabs.create("p", create("c1")));
    const run = outcome.operation.run;
    const live = await env.tabs.reopen("p", { operationId: "r1", tabId: "tab-instance-1" });
    expect(live.error).toMatchObject({ kind: "LIVE_RUNS_PRESENT", details: { runs: [run] } });
    expect(kind(await env.tabs.close("p", { operationId: "x1", tabId: "tab-instance-1" }))).toBe(
      "LIVE_RUNS_PRESENT",
    );
    env.registry.contactLost(env.worker);
    // Loss of contact is not an exit: the run is unverifiable and still blocks.
    expect((await env.tabs.get("tab-instance-1")).latestRun).toMatchObject({
      lifecycle: "running",
      verification: "unverifiable",
    });
    expect(kind(await env.tabs.reopen("p", { operationId: "r2", tabId: "tab-instance-1" }))).toBe(
      "LIVE_RUNS_PRESENT",
    );
    expect(await env.rows("SELECT operation_id FROM operations ORDER BY operation_id")).toEqual([
      { operation_id: "c1" },
    ]);
  });

  it("records an exit the store missed from the registry before a reopen or a read", async () => {
    const env = await setup({ recording: false });
    const { outcome } = await env.launched(env.tabs.create("p", create("c1")));
    env.exit(outcome.operation.run, 0, "SIGTERM");
    await settled();
    const [stored] = await env.rows("SELECT lifecycle FROM runs");
    expect(stored.lifecycle).toBe("running");
    const reopened = await env.launched(
      env.tabs.reopen("p", { operationId: "r1", tabId: "tab-instance-1" }),
    );
    expect(reopened.outcome.operation).toMatchObject({
      state: "succeeded",
      run: { runId: "run-2" },
    });
    const runs = await env.tabs.runs({ tabId: "tab-instance-1", limit: 10 });
    expect(runs.runs.map((run) => [run.run.runId, run.lifecycle, run.signal])).toEqual([
      ["run-2", "running", null],
      ["run-1", "exited", "SIGTERM"],
    ]);
  });

  it("refuses new runs on an archived task but still stops and closes its tabs", async () => {
    const env = await setup();
    const { outcome } = await env.launched(env.tabs.create("p", create("c1")));
    await env.sql("UPDATE tasks SET archived = 1");
    expect(kind(await env.tabs.create("p", create("c2")))).toBe("TASK_ARCHIVED");
    expect(kind(await env.tabs.create("p", create("c3", { start: false })))).toBe("TASK_ARCHIVED");
    const stopping = env.tabs.stop("p", { operationId: "s1", tabId: "tab-instance-1" });
    await env.answer(
      "stop",
      "accepted",
      env.status(outcome.operation.run, "exited", { exitCode: 0 }),
    );
    expect((await stopping).operation).toMatchObject({
      method: "tab.stop",
      state: "succeeded",
      run: outcome.operation.run,
      result: { resource: { kind: "tab", id: "tab-instance-1" } },
    });
    expect(kind(await env.tabs.reopen("p", { operationId: "r1", tabId: "tab-instance-1" }))).toBe(
      "TASK_ARCHIVED",
    );
    expect(
      (await env.tabs.close("p", { operationId: "x1", tabId: "tab-instance-1" })).operation,
    ).toMatchObject({ state: "succeeded" });
    // The run stays in the history without its tab.
    expect(await env.rows("SELECT run_id, tab_id, task_id, lifecycle FROM runs")).toEqual([
      { run_id: "run-1", tab_id: null, task_id: "task-1", lifecycle: "exited" },
    ]);
  });

  it("answers a resend from its receipt before any check and refuses a changed intent", async () => {
    const env = await setup();
    const { outcome } = await env.launched(env.tabs.create("p", create("c1")));
    env.exit(outcome.operation.run);
    await settled();
    expect(
      (await env.tabs.close("p", { operationId: "x1", tabId: "tab-instance-1" })).operation,
    ).toMatchObject({ state: "succeeded" });
    // The tab is gone, but the same requests return their records and spawn nothing.
    expect(await env.tabs.create("p", create("c1"))).toEqual(outcome);
    expect(
      (await env.tabs.close("p", { operationId: "x1", tabId: "tab-instance-1" })).operation,
    ).toMatchObject({ method: "tab.close", state: "succeeded" });
    expect(kind(await env.tabs.create("p", create("c1", { name: "other" })))).toBe(
      "OPERATION_ID_CONFLICT",
    );
    expect(env.commands.filter((item) => item.type === "spawn")).toHaveLength(1);
  });
});

describe("tab stops", () => {
  it("stops the latest run, refuses a stale pinned run and a run of an earlier instance", async () => {
    const env = await setup();
    const { outcome } = await env.launched(env.tabs.create("p", create("c1")));
    const run = outcome.operation.run;
    const stale = await env.tabs.stop("p", {
      operationId: "s0",
      tabId: "tab-instance-1",
      run: { ...run, runId: "run-0" },
    });
    expect(kind(stale)).toBe("REVISION_CONFLICT");
    // The stop stays running until the exit is observed, then completes on a read.
    const stopping = env.tabs.stop("p", { operationId: "s1", tabId: "tab-instance-1", run });
    await env.answer("stop");
    expect((await stopping).operation.state).toBe("running");
    env.exit(run, null, "SIGHUP");
    await settled();
    expect((await env.operations.get("p", "s1")).operation).toMatchObject({
      state: "succeeded",
      result: { resource: { kind: "tab", id: "tab-instance-1" } },
    });

    // A restart: the next instance cannot stop the earlier instance's run.
    const pending = env.tabs.reopen("p", { operationId: "r1", tabId: "tab-instance-1" });
    const reopened = (await env.launched(pending)).outcome.operation.run;
    env.close();
    const next = env.instance("next");
    await recordInstanceStart(env.store, "next", 2);
    expect(await next.runLog.interruptEarlier("next")).toBe(1);
    const refused = await next.tabs.stop("p", { operationId: "s2", tabId: "tab-instance-1" });
    expect(kind(refused)).toBe("INSTANCE_MISMATCH");
    expect((await next.tabs.get("tab-instance-1")).latestRun).toMatchObject({
      run: reopened,
      lifecycle: "interrupted",
      verification: "unverifiable",
    });
  });
});

describe("run history and identity", () => {
  it("continues run numbering after the highest recorded run, so one tab never holds an ID twice", async () => {
    const env = await setup();
    await env.launched(env.tabs.create("p", create("c1")));
    const second = await env.launched(env.tabs.create("p", create("c2")));
    expect(second.outcome.operation.run.runId).toBe("run-2");
    env.close();
    await recordInstanceStart(env.store, "next", 2);
    const next = env.instance("next");
    await next.runLog.interruptEarlier("next");
    const reopened = await next.launched(
      next.tabs.reopen("p", { operationId: "r1", tabId: "tab-instance-1" }),
    );
    expect(reopened.outcome.operation.run).toEqual({
      serverId: "server",
      relayInstanceId: "next",
      runId: "run-3",
    });
  });

  it("pages a tab's runs newest first by run ID and within the response budget", async () => {
    // A budget that holds two run records of this workspace but not three.
    const env = await setup({ responseBytes: 6_000 });
    const runs = [];
    let outcome = (await env.launched(env.tabs.create("p", create("c1")))).outcome;
    for (let i = 0; ; i++) {
      runs.unshift(outcome.operation.run);
      env.exit(outcome.operation.run);
      await settled();
      if (i === 3) break;
      outcome = (
        await env.launched(env.tabs.reopen("p", { operationId: `r${i}`, tabId: "tab-instance-1" }))
      ).outcome;
    }
    const seen = [];
    let beforeRunId;
    let pages = 0;
    do {
      const page = await env.tabs.runs({ tabId: "tab-instance-1", limit: 128, beforeRunId });
      expect(page.runs.length).toBeGreaterThan(0);
      expect(page.runs.length).toBeLessThan(4);
      expect(
        validateRpcResultForCall(
          "tab.runs",
          { tabId: "tab-instance-1", limit: 128, ...(beforeRunId ? { beforeRunId } : {}) },
          page,
        ),
      ).toBe(true);
      seen.push(...page.runs.map((run) => run.run));
      beforeRunId = page.nextBeforeRunId;
      pages++;
    } while (beforeRunId);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(runs);
    expect(
      kind(await env.tabs.runs({ tabId: "tab-instance-1", limit: 1, beforeRunId: "run-99" })),
    ).toBe("RUN_NOT_FOUND");
    expect(kind(await env.tabs.runs({ tabId: "nope", limit: 1 }))).toBe("TAB_NOT_FOUND");
    expect(kind(await env.tabs.list({ taskId: "nope", limit: 1 }))).toBe("TASK_NOT_FOUND");
  });

  it("refuses a launch whose tab.get would not fit one response, before anything runs", async () => {
    const env = await setup({ responseBytes: 2_600 });
    expect(kind(await env.tabs.create("p", create("c1")))).toBe("INVALID_ARGUMENT");
    expect(await env.rows("SELECT 1 FROM tabs")).toEqual([]);
    expect(await env.rows("SELECT 1 FROM runs")).toEqual([]);
    expect(env.commands.filter((item) => item.type === "spawn")).toEqual([]);
  });

  it("keeps a run's snapshot when the workspace changes later", async () => {
    const env = await setup();
    await env.launched(env.tabs.create("p", create("c1")));
    await env.sql("DELETE FROM mounts WHERE mount_id = 'm-alpha'");
    await env.sql("UPDATE workspaces SET revision = 4");
    const { latestRun } = await env.tabs.get("tab-instance-1");
    expect(latestRun.workspaceRevision).toBe(3);
    expect(latestRun.mounts.map((mount) => mount.name)).toEqual(["alpha", "beta", "wt"]);
  });

  it("names the runs without an end record that use a path through their cwd or mount mapping", async () => {
    const env = await setup();
    const entryRun = (await env.launched(env.tabs.create("p", create("c1")))).outcome.operation.run;
    const betaRun = (
      await env.launched(
        env.tabs.create("p", create("c2", { cwd: { kind: "mount", mountId: "m-beta" } })),
      )
    ).outcome.operation.run;
    // A terminal.create run outside the workspace.
    const outside = join(env.root, "clones", "alphabet");
    const plain = env.operations.create("p", {
      operationId: "t1",
      expectedRelayInstanceId: "instance",
      executable: "/bin/synthetic",
      argv: [],
      cwd: outside,
      geometry: { cols: 80, rows: 24 },
    });
    await env.answer("spawn");
    const plainRun = (await plain).operation.run;
    const using = async (path) =>
      (await liveRunsUsing(env.store, env.runtime, path)).map((run) => run.run.runId);
    const ids = (...runs) => runs.map((run) => run.runId);
    expect(await using(join(env.entry, "wt"))).toEqual(ids(entryRun, betaRun));
    expect(await using(join(env.root, "clones", "beta"))).toEqual(ids(entryRun, betaRun));
    // A path prefix that is not a parent directory does not match.
    expect(await using(join(env.root, "clones", "alpha"))).toEqual(ids(entryRun, betaRun));
    expect(await using(join(env.root, "clones", "alph"))).toEqual([]);
    expect(await using(outside)).toEqual(ids(plainRun));
    expect(await using(join(env.root, "clones"))).toEqual(ids(entryRun, betaRun, plainRun));
    // An exit the registry observed ends the use, also before the store records it.
    env.exit(betaRun);
    expect(await using(join(env.root, "clones", "beta"))).toEqual(ids(entryRun));
  });
});

describe("refused spawns", () => {
  const plainCreate = (operationId) => ({
    operationId,
    expectedRelayInstanceId: "instance",
    executable: "/bin/synthetic",
    argv: [],
    cwd: "/",
    geometry: { cols: 80, rows: 24 },
  });
  // A run whose spawn the worker definitely refused started nothing, so the runtime keeps no trace
  // of it: no terminal (terminal.list/get, and attach reads the registry too), no placement, no
  // session route, and its stop has no run to address.
  async function retired(env, run) {
    const cache = env.runtime.previews.cache;
    expect(env.registry.get(run)).toBeNull();
    expect(env.registry.count).toBe(0);
    expect(env.runtime.pool.get(run)).toBeNull();
    expect(env.session.forgetUnstartedRun(run)).toBe(false);
    expect(cache.getRecord(run)).toBeNull();
    expect(cache.list({ limit: 10 }).runs).toEqual([]);
    const stop = await env.operations.stop("p", {
      operationId: `stop-${run.runId}`,
      expectedRelayInstanceId: "instance",
      run,
    });
    expect(kind(stop)).toBe("RUN_NOT_FOUND");
  }

  it("retires a terminal.create run the worker refused and reuses its capacity", async () => {
    const env = await setup({ runsPerWorker: 1 });
    const { outcome } = await env.refuse(
      "spawn",
      "WORKER_UNAVAILABLE",
      env.operations.create("p", plainCreate("t1")),
    );
    expect(outcome.operation).toMatchObject({ state: "failed", run: { runId: "run-1" } });
    await retired(env, outcome.operation.run);
    // The only placement is free again.
    const next = await env.launched(env.operations.create("p", plainCreate("t2")));
    expect(next.outcome.operation).toMatchObject({ state: "succeeded", run: { runId: "run-2" } });
    expect(env.registry.count).toBe(1);
  });

  it("retires a tab launch the worker refused and reuses its capacity", async () => {
    const env = await setup({ runsPerWorker: 1 });
    const { outcome } = await env.refuse(
      "spawn",
      "WORKER_UNAVAILABLE",
      env.tabs.create("p", create("c1")),
    );
    expect(outcome.operation).toMatchObject({ state: "failed", run: { runId: "run-1" } });
    await retired(env, outcome.operation.run);
    expect((await env.tabs.get("tab-instance-1")).latestRun).toBeNull();
    const reopened = await env.launched(
      env.tabs.reopen("p", { operationId: "r1", tabId: "tab-instance-1" }),
    );
    expect(reopened.outcome.operation).toMatchObject({
      state: "succeeded",
      run: { runId: "run-2" },
    });
  });

  it("keeps a run whose spawn result is unknown, since the worker may have started it", async () => {
    const env = await setup({ runsPerWorker: 1 });
    const { command: spawned } = await env.launched(
      env.operations.create("p", plainCreate("t1")),
      "unknown",
    );
    expect(env.registry.get(spawned.run)).not.toBeNull();
    expect(kind(await env.operations.create("p", plainCreate("t2")))).toBe("BUSY");
  });
});

describe("tab names", () => {
  it("defaults to the executable's file name or shell", () => {
    expect(defaultTabName({ kind: "shell" })).toBe("shell");
    expect(defaultTabName(command())).toBe("synthetic");
    expect(defaultTabName({ kind: "command", executable: "/", argv: [] })).toBe("tab");
  });
});
