import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { createM1Fixture } from "./fixtures.mjs";

// S7 (docs/milestones/m1.md): a server restart with a running tab, once after an orderly stop and
// once after kill -9, through the compiled `cove` CLI and server. The records stay; the old run
// is never shown as live (D9: stopped-with-server after an orderly stop, interrupted and
// unverifiable after a crash); nothing is started again, which the launch command's marker file
// proves; resending the tab's create returns its record, and only an explicit reopen with a new
// operation ID starts a new run.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

async function markerLines(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(Number);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// A task with a running tab whose command records its PID once in `markers`, then stays alive.
async function runningTab(home, markers) {
  const clone = await fixture.gitRepo("clones/alpha");
  const repo = await fixture.coveJson(["repo", "register", clone.path], { home });
  const { task } = await fixture.coveJson(
    ["task", "create", "Restart", "--checkout", repo.result.resource.id],
    { home },
  );
  const created = await fixture.coveJson(
    [
      ...["tab", "create", task.taskId, "--operation-id", "s7-tab-create", "--"],
      ...["/bin/sh", "-c", `echo $$ >> '${markers}'; exec sleep 600`],
    ],
    { home },
  );
  expect(created.operation).toMatchObject({ method: "tab.create", state: "succeeded" });
  await waitFor(
    "the tab's command to start",
    async () => (await markerLines(markers)).length === 1,
  );
  // Cleanup ends it however the server ends: after kill -9 it may outlive the server.
  for (const pid of await markerLines(markers)) await fixture.trackPid(pid);
  return { task, created, tabId: created.operation.result.resource.id };
}

async function restartChecks(home, before, { tabId, created }, markers, expected) {
  const after = await fixture.startServer(home);
  expect(after.record.serverId).toBe(before.record.serverId);
  expect(after.record.relayInstanceId).not.toBe(before.record.relayInstanceId);

  // The records are kept and the old run is not live.
  const read = await fixture.coveJson(["tab", "get", tabId], { home });
  expect(read.tab).toEqual(created.tab);
  expect(read.latestRun).toMatchObject({ run: created.operation.run, ...expected });
  expect(read.latestRun.exitCode).toBeNull();
  expect(read.latestRun.lastObservedAtMs).not.toBeNull();
  const { runs } = await fixture.coveJson(["tab", "runs", tabId], { home });
  expect(runs).toEqual([read.latestRun]);
  // The old instance's run is not a terminal of the new instance.
  expect((await fixture.coveJson(["terminal", "list"], { home })).runs).toEqual([]);
  expect(await markerLines(markers)).toHaveLength(1);

  // The create's operation is still there, and resending it returns the original record.
  const original = await fixture.coveJson(["operation", "get", "s7-tab-create"], { home });
  expect(original).toEqual(created.operation);
  const resent = await fixture.coveJson(["operation", "resend", "s7-tab-create"], { home });
  expect(resent).toEqual(created.operation);
  expect(await markerLines(markers)).toHaveLength(1);

  // An explicit reopen with a new operation ID starts exactly one new run.
  const reopened = await fixture.coveJson(["tab", "reopen", tabId, "--operation-id", "s7-reopen"], {
    home,
  });
  expect(reopened.operation).toMatchObject({ method: "tab.reopen", state: "succeeded" });
  expect(reopened.operation.run.relayInstanceId).toBe(after.record.relayInstanceId);
  await waitFor(
    "the reopened command to start",
    async () => (await markerLines(markers)).length === 2,
  );
  for (const pid of (await markerLines(markers)).slice(1)) await fixture.trackPid(pid);
  const history = await fixture.coveJson(["tab", "runs", tabId], { home });
  expect(history.runs.map((run) => run.run)).toEqual([
    reopened.operation.run,
    created.operation.run,
  ]);
  expect(history.runs[0]).toMatchObject({ lifecycle: "running", verification: "live" });
  // Run IDs continue across instances: the history never holds one ID twice.
  expect(reopened.operation.run.runId).not.toBe(created.operation.run.runId);
  return after;
}

test("after an orderly stop the running tab's run is recorded as stopped with the server and nothing restarts", async () => {
  const home = fixture.home("home");
  const markers = join(fixture.root, "markers");
  const first = await fixture.startServer(home);
  const tab = await runningTab(home, markers);
  // The orderly stop is complete: the worker reported its exit, which ended every PTY it owned.
  expect(await fixture.stopServer(first)).toBe(0);
  await restartChecks(home, first, tab, markers, {
    lifecycle: "stopped-with-server",
    verification: "final",
  });
  const { latestRun } = await fixture.coveJson(["tab", "get", tab.tabId], { home });
  expect(latestRun.run.relayInstanceId).not.toBe(first.record.relayInstanceId);
  const { runs } = await fixture.coveJson(["tab", "runs", tab.tabId], { home });
  expect(runs[1].endedAtMs).toBeGreaterThanOrEqual(runs[1].startedAtMs);
});

test("after kill -9 the running tab's run is interrupted and unverifiable and nothing restarts", async () => {
  const home = fixture.home("home");
  const markers = join(fixture.root, "markers");
  const first = await fixture.startServer(home);
  const tab = await runningTab(home, markers);
  await fixture.killServer(first);
  const after = await restartChecks(home, first, tab, markers, {
    lifecycle: "interrupted",
    verification: "unverifiable",
    endedAtMs: null,
  });
  // The interrupted run keeps the instance that started it.
  const { runs } = await fixture.coveJson(["tab", "runs", tab.tabId], { home });
  expect(runs[1].run.relayInstanceId).toBe(first.record.relayInstanceId);
  expect(runs[1].run.relayInstanceId).not.toBe(after.record.relayInstanceId);
});
