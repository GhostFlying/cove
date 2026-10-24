import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { publishPending } from "../../dist/commands/_pending.js";
import { createM1Fixture } from "../m1/fixtures.mjs";
import { waitFor } from "../recording-view.mjs";
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await createM1Fixture();
  cleanup.push(() => f.cleanup());
  return f;
}

// A task-owned raw-mode Node TUI fixture, not an agent provider. It records its exact input
// bytes and treats only CR as submit, so receipt assertions also have application-path evidence.
async function liveFixture() {
  const f = await fixture();
  const home = f.home("server");
  const server = await f.startServer(home);
  const marker = join(f.root, "input.json");
  const tui = join(f.root, "input-tui.mjs");
  await writeFile(
    tui,
    `import { writeFileSync } from 'node:fs';
const path = process.argv[2];
const state = { pid: process.pid, bytes: [], submissions: [], pending: '' };
const save = () => writeFileSync(path, JSON.stringify(state));
process.stdin.setRawMode(true); process.stdin.resume(); save();
process.stdout.write('fixture ready\\r\\n');
process.stdin.on('data', bytes => { for (const byte of bytes) { state.bytes.push(byte); if (byte === 13) {
state.submissions.push(state.pending); state.pending = ''; } else state.pending += String.fromCharCode(byte); } save(); });
`,
  );
  const task = await f.coveJson(
    ["task", "create", "input-fixture", "--operation-id", "create-task"],
    { home },
  );
  const created = await f.coveJson(
    [
      "tab",
      "create",
      task.task.taskId,
      "--operation-id",
      "create-tab",
      "--",
      process.execPath,
      tui,
      marker,
    ],
    { home },
  );
  await waitFor("raw TUI readiness", async () =>
    readFile(marker).then(
      () => true,
      () => false,
    ),
  );
  // Record the task-owned TUI's start identity while it is live; cleanup then proves
  // retirement even if a failed server stop left its child behind.
  await f.trackPid(JSON.parse(await readFile(marker, "utf8")).pid);
  const tabId = created.tab.tabId;
  const observed = await f.coveJson(["tab", "get", tabId], { home });
  expect(observed.control).toMatchObject({ state: "current", epoch: 0, holder: null });
  const run = observed.latestRun.run;
  const args = (id, text, submit = false, epoch = 0) => [
    "tab",
    "send",
    tabId,
    "--operation-id",
    id,
    "--run",
    run.runId,
    "--relay-instance",
    run.relayInstanceId,
    "--if-control-epoch",
    String(epoch),
    ...(submit ? ["--submit"] : []),
    "--json",
    "--",
    text,
  ];
  const read = async () => JSON.parse(await readFile(marker, "utf8"));
  return { f, home, server, run, tabId, args, read };
}

test("tab send validates exact arguments and UTF-8 limits before creating pending state", async () => {
  const f = await fixture();
  const home = f.home("no-server");
  const valid = [
    "tab",
    "send",
    "tab",
    "--operation-id",
    "id",
    "--run",
    "run",
    "--relay-instance",
    "instance",
    "--if-control-epoch",
    "0",
  ];
  for (const args of [
    ["tab", "send", "tab"],
    [...valid, "--control-epoch", "0", "--", "x"],
    [...valid, "--", "x", "y"],
    [...valid, "--", "😀".repeat(1025)],
    [...valid, "--", ""],
  ]) {
    const result = await f.cove(args, { home });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  }
  await expect(readFile(join(home, "cli", "operations", "id.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("compiled CLI sends real PTY text then separate submit; duplicate and resend never write twice", async () => {
  const { f, home, tabId, args, read, server } = await liveFixture();
  const sent = await f.coveJson(args("text", "hello"), { home });
  expect(sent.operation.state).toBe("succeeded");
  expect(sent.operation.result.input).toMatchObject({
    text: { status: "written", writtenBytes: 5 },
    submit: null,
  });
  await waitFor("TUI text receipt", async () => (await read()).pending === "hello");
  expect((await read()).submissions).toEqual([]);
  const submitted = await f.coveJson(args("submit", "", true), { home });
  expect(submitted.operation.result.input.submit.status).toBe("written");
  await waitFor("TUI application submission", async () => (await read()).submissions.length === 1);
  const before = await read();
  expect(before.submissions).toEqual(["hello"]);
  expect(before.bytes).toEqual([104, 101, 108, 108, 111, 13]);
  expect((await f.coveJson(args("text", "hello"), { home })).operation).toEqual(sent.operation);
  expect((await f.coveJson(["operation", "resend", "text"], { home })).state).toBe("succeeded");
  expect(await read()).toEqual(before);
  const control = await f.coveJson(["tab", "get", tabId], { home });
  expect(control.control).toMatchObject({ state: "current", epoch: 0, holder: null });
  const stale = await f.cove(args("stale", "not-written", true, 1), { home });
  expect(stale.code).toBe(1);
  expect(stale.stderr).toContain("STALE_CONTROL");
  expect(await read()).toEqual(before);
  await f.stopServer(server);
  await f.startServer(home);
  const original = await f.coveJson(["operation", "get", "text"], { home });
  expect(original).toEqual(sent.operation);
  expect((await f.coveJson(args("text", "hello"), { home })).operation).toEqual(sent.operation);
}, 30000);

test("a published send with missing server receipt is read-only on both reuse and resend", async () => {
  const { f, home, args, run, tabId, read, server } = await liveFixture();
  await publishPending(home, {
    version: 1,
    serverId: server.record.serverId,
    method: "tab.send",
    params: {
      operationId: "uncertain",
      tabId,
      run,
      ifControlEpoch: 0,
      text: "never-replay",
      submit: true,
    },
    savedAtMs: Date.now(),
  });
  const before = await read();
  const reused = await f.cove(args("uncertain", "never-replay", true), { home });
  expect(reused.code).toBe(1);
  expect(reused.stderr).toContain("OPERATION_NOT_FOUND");
  const resent = await f.cove(["operation", "resend", "uncertain"], { home });
  expect(resent.code).toBe(1);
  expect(resent.stderr).toContain("OPERATION_NOT_FOUND");
  expect(await read()).toEqual(before);
}, 30000);
