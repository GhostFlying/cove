import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { canonicalWriteIntent } from "@cove/protocol/rpc";
import { inputPartReceipt } from "@cove/protocol/workspace";
import { TabInputService } from "../../dist/operations/tab-input.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { Store } from "../../dist/store/database.js";
import { prepareHome } from "../../dist/store/home.js";
import { recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { ControlArbiter } from "../../dist/terminal/control-arbiter.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";

const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const encode = (text) => new TextEncoder().encode(text);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("fixture progress deadline");
    await tick();
  }
}
const run = { serverId: "server", relayInstanceId: "instance", runId: "run-1" };
const request = (operationId, extra = {}) => ({
  operationId,
  tabId: "tab",
  run,
  ifControlEpoch: 0,
  text: "hello",
  submit: true,
  ...extra,
});
const complete = (bytes, submit = true) => ({
  text: inputPartReceipt(bytes, bytes, 0),
  submit: submit ? inputPartReceipt(1, 1, 0) : null,
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cove-tab-input-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = await prepareHome(join(root, "home"));
  const store = await Store.open({
    databasePath: home.databasePath,
    backupDirectory: home.backupDirectory,
    operationModules: [new URL("./store-test-operations.mjs", import.meta.url).href],
  });
  cleanup.push(() => store.close());
  await recordInstanceStart(store, "instance", 1);
  const sql = (sql, params = []) => store.call("test.run", { sql, params });
  await sql("INSERT INTO tasks VALUES ('task',0,'Task','task',0,1,1)");
  await sql(
    "INSERT INTO workspaces (workspace_id,task_id,revision,entry_path,created_at_ms) VALUES ('ws','task',0,'/fixture',1)",
  );
  await sql("INSERT INTO tabs VALUES ('tab','task',0,'Tab',?, ?,1,NULL)", [
    JSON.stringify({ kind: "shell" }),
    JSON.stringify({ kind: "entry" }),
  ]);
  await sql(`INSERT INTO runs (server_id,relay_instance_id,run_id,tab_id,task_id,workspace_revision,cwd,mounts_json,lifecycle,verification,started_at_ms)
    VALUES ('server','instance','run-1','tab','task',0,'/fixture','[]','running','live',1)`);
  await sql("UPDATE tabs SET latest_run_seq = 1 WHERE tab_id = 'tab'");
  function instance(relayInstanceId = "instance") {
    const composition = new RuntimeComposition(
      "server",
      relayInstanceId,
      { ...M0_LIMITS },
      new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024),
    );
    const worker = {
      serverId: "server",
      relayInstanceId,
      workerId: "w",
      workerIncarnationId: "birth",
    };
    const state = { live: true, epoch: 0, holder: null, seq: 0, writes: [], write: null };
    const status = () => ({
      run,
      status: state.live ? "live" : "exited",
      controlEpoch: state.epoch,
      controlHolder: state.holder,
      geometry: { cols: 80, rows: 24 },
      parsedSeq: state.seq,
      receivedSeq: state.seq,
      recovery: "ready",
      exitCode: null,
      signal: null,
    });
    const runtime = {
      composition,
      pool: { get: () => ({ worker }) },
      registry: { get: () => ({ worker, status: status() }) },
      onEvent: () => ({ dispose() {} }),
      getStatus: async (command) => ({
        ...command,
        type: "result",
        commandType: "status",
        outcome: "accepted",
        runStatus: status(),
      }),
      setControl: async (command) => {
        state.epoch = command.nextEpoch;
        state.holder = command.holder;
        state.seq++;
        return {
          ...command,
          type: "result",
          commandType: "set-control",
          outcome: "accepted",
          atSeq: state.seq,
        };
      },
      writeProgrammatic: async (command, bytes) => {
        state.writes.push({ command, text: new TextDecoder().decode(bytes) });
        const input = state.write
          ? await state.write(command, bytes)
          : complete(bytes.byteLength, command.submit);
        return {
          ...command,
          type: "result",
          commandType: command.type,
          input,
          outcome:
            input.text.status === "written" && (!input.submit || input.submit.status === "written")
              ? "accepted"
              : "unknown",
        };
      },
    };
    const arbiter = new ControlArbiter(runtime);
    cleanup.push(() => arbiter.dispose());
    const receipts = new OperationReceipts(
      composition,
      encode,
      new SqliteReceiptBackend(store, relayInstanceId),
    );
    cleanup.push(() => receipts.dispose());
    const service = new TabInputService({ store, runtime, receipts });
    return { runtime, state, worker, arbiter, receipts, service };
  }
  return { store, sql, instance, ...instance() };
}

test("durable duplicate survives control/run/instance changes and conflicting intent never writes", async () => {
  const f = await fixture();
  const first = await f.service.send("p", request("one"));
  expect(first.operation.state).toBe("succeeded");
  f.state.live = false;
  f.state.epoch = 5;
  expect(await f.service.send("p", request("one"))).toEqual(first);
  const fresh = f.instance("later-instance");
  expect(await fresh.service.send("p", request("one"))).toEqual(first);
  expect((await fresh.service.send("p", request("one", { text: "changed" }))).error.kind).toBe(
    "OPERATION_ID_CONFLICT",
  );
  expect(f.state.writes).toHaveLength(1);
  expect(fresh.state.writes).toEqual([]);
});

test("new exact-run, epoch and human-controller preconditions reject with zero bytes", async () => {
  const f = await fixture();
  expect(
    (await f.service.send("p", request("instance", { run: { ...run, relayInstanceId: "old" } })))
      .error.kind,
  ).toBe("INSTANCE_MISMATCH");
  expect(
    (await f.service.send("p", request("run", { run: { ...run, runId: "other" } }))).error.kind,
  ).toBe("RUN_NOT_FOUND");
  expect((await f.service.send("p", request("epoch", { ifControlEpoch: 1 }))).error.kind).toBe(
    "STALE_CONTROL",
  );
  f.state.holder = {
    connection: { connectionId: "c", generation: 1 },
    viewId: "v",
    subscriptionId: "s",
  };
  expect((await f.service.send("p", request("held"))).error.kind).toBe("CONTROL_HELD");
  expect(f.state.writes).toEqual([]);
  expect((await f.service.observe(run)).holder).toEqual(f.state.holder);
});

test("partial send closes every queued dependent prefix and does not turn later CR into a submission", async () => {
  const f = await fixture();
  let finish;
  f.state.write = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = f.service.send("p", request("first"));
  await until(() => f.state.writes.length === 1);
  const second = f.service.send("p", request("second", { text: "", submit: true }));
  await until(() => f.arbiter.snapshot(run.runId).pending === 2);
  finish({
    text: inputPartReceipt(5, 2, 0, "native-error"),
    submit: inputPartReceipt(1, 0, 0, "text-not-complete"),
  });
  expect((await first).operation.result.input.text.status).toBe("partial");
  const blocked = await second;
  expect(blocked.error).toMatchObject({ kind: "INPUT_REJECTED", acceptance: "not-accepted" });
  expect(f.state.writes).toHaveLength(1);
});

test("ordinary queued human focus runs before later send and its epoch is rechecked", async () => {
  const f = await fixture();
  let finish;
  f.state.write = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = f.service.send("p", request("first"));
  await until(() => f.state.writes.length === 1);
  const subscription = {
    run,
    connection: { connectionId: "human", generation: 1 },
    viewId: "v",
    subscriptionId: "s",
  };
  const focus = f.arbiter.admit(
    {
      type: "focus",
      requestId: "focus",
      run,
      subscription,
      focusSeq: 1,
      geometry: { cols: 80, rows: 24 },
    },
    {
      subscription,
      worker: f.worker,
      requestId: "focus.pipe",
      releaseId: "release",
      current: () => true,
      installed: () => true,
      earlierPending: () => false,
    },
    new Uint8Array(),
  );
  const focused = f.arbiter.execute(focus);
  const later = f.service.send("p", request("later"));
  await until(() => f.arbiter.snapshot(run.runId).pending === 3);
  finish(complete(5));
  expect((await first).operation.state).toBe("succeeded");
  expect((await focused).type).toBe("focus-result");
  expect((await later).error).toMatchObject({ kind: "CONTROL_HELD", acceptance: "not-accepted" });
  expect(f.state.writes).toHaveLength(1);
});

test("interrupted send remains query-only and atomic abandon retains unknown effects against late update", async () => {
  const f = await fixture();
  const params = request("crashed");
  const key = { serverId: "server", principalId: "p", operationId: "crashed" };
  const reservation = await f.receipts.prepare(
    key,
    canonicalWriteIntent("tab.send", params, encode),
  );
  const accepted = {
    operationId: "crashed",
    method: "tab.send",
    revision: 0,
    state: "accepted",
    run,
    result: {
      input: {
        text: inputPartReceipt(5, 0, 5, "pending"),
        submit: inputPartReceipt(1, 0, 1, "pending"),
      },
    },
  };
  expect(await reservation.commit(accepted)).toBe(true);
  const next = f.instance("restarted");
  await next.receipts.recoverInterrupted();
  const recovered = (await next.service.send("p", params)).operation;
  expect(recovered.state).toBe("requires_attention");
  expect(next.state.writes).toEqual([]);
  expect(
    (
      await next.service.act("p", "operation.continue", {
        operationId: "continue",
        targetOperationId: "crashed",
      })
    ).error.kind,
  ).toBe("OPERATION_NOT_RESUMABLE");
  const abandon = await next.service.act("p", "operation.abandon", {
    operationId: "abandon",
    targetOperationId: "crashed",
  });
  expect(abandon.operation.state).toBe("succeeded");
  const ended = await next.receipts.get(key);
  expect(ended.state).toBe("cancelled");
  expect(ended.result.input).toEqual(recovered.result.input);
  expect(
    await next.receipts.update(key, {
      ...ended,
      revision: ended.revision + 1,
      state: "succeeded",
      result: { input: complete(5) },
    }),
  ).toBe(false);
  expect((await next.receipts.get(key)).state).toBe("cancelled");
});

test("a failed durable completion never reports not-accepted or writes a second time", async () => {
  const f = await fixture();
  const update = f.receipts.update.bind(f.receipts);
  f.receipts.update = async (key, record) => {
    if (record.state === "succeeded") throw new Error("fixture receipt store refused completion");
    return update(key, record);
  };
  const params = request("completion-lost");
  expect((await f.service.send("p", params)).error).toMatchObject({
    kind: "RESULT_UNKNOWN",
    acceptance: "unknown",
  });
  expect(f.state.writes).toHaveLength(1);
  expect((await f.service.send("p", params)).operation.state).toBe("running");
  expect(f.state.writes).toHaveLength(1);
  const restarted = f.instance("later");
  await restarted.receipts.recoverInterrupted();
  expect((await restarted.service.send("p", params)).operation.state).toBe("requires_attention");
  expect(restarted.state.writes).toEqual([]);
});

test("programmatic pending count is bounded without enlarging existing input/command budgets", async () => {
  const f = await fixture();
  for (let n = 0; n < 32; n++) {
    const admitted = f.arbiter.admitProgrammatic(
      {
        type: "programmatic-input",
        run,
        worker: f.worker,
        requestId: `queued-${n}`,
        operationId: `queued-${n}`,
        epoch: 0,
        textBytes: 1,
        submit: false,
      },
      encode("x"),
    );
    expect(admitted.kind).toBe("programmatic");
  }
  const full = f.arbiter.admitProgrammatic(
    {
      type: "programmatic-input",
      run,
      worker: f.worker,
      requestId: "overflow",
      operationId: "overflow",
      epoch: 0,
      textBytes: 1,
      submit: false,
    },
    encode("x"),
  );
  expect(full.kind).toBe("BUSY");
  expect(f.arbiter.snapshot(run.runId).pending).toBe(32);
  expect(f.state.writes).toEqual([]);
  expect(
    (await f.service.send("p", request("escaped", { text: "\u0001".repeat(2000) }))).error.kind,
  ).toBe("INVALID_ARGUMENT");
});

test("an unverifiable registry cache is refreshed in order instead of rejecting a current worker epoch", async () => {
  const f = await fixture();
  const cached = f.runtime.registry.get.bind(f.runtime.registry);
  f.runtime.registry.get = () => {
    const entry = cached();
    return { ...entry, status: { ...entry.status, status: "unverifiable", controlEpoch: 0 } };
  };
  f.state.epoch = 1;
  const result = await f.service.send("p", request("fresh-observation", { ifControlEpoch: 1 }));
  expect(result.operation.state).toBe("succeeded");
  expect(f.state.writes).toHaveLength(1);
  expect(await f.service.observe(run)).toMatchObject({ state: "current", epoch: 1 });
});
