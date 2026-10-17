import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { createM1Fixture } from "./fixtures.mjs";

// S5 (docs/milestones/m1.md): tabs and runs through the compiled `cove` CLI and server. A tab's
// run starts in the workspace entry, finds a checkout through the entry's mount manifest (D2 C),
// works in it, and its exit is recorded while the tab stays; reopening starts a new run and keeps
// the old one in the history; a run keeps running with no client connected. Every repository and
// process lives in the fixture's temporary root.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

async function refused(args, home, kind) {
  const result = await fixture.cove(args, { home });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(kind);
  return result;
}

async function registered(home, name) {
  const clone = await fixture.gitRepo(`clones/${name}`);
  const operation = await fixture.coveJson(["repo", "register", clone.path], { home });
  return { ...clone, repoId: operation.result.resource.id };
}

async function checkoutTask(home, title) {
  const source = await registered(home, "alpha");
  const { task } = await fixture.coveJson(["task", "create", title, "--checkout", source.repoId], {
    home,
  });
  expect(task.workspace.entryState).toBe("ready");
  return { source, task };
}

// The tab's latest run once `done(run)` holds.
async function latestRun(home, tabId, what, done) {
  let read;
  await waitFor(
    what,
    async () => {
      read = await fixture.coveJson(["tab", "get", tabId], { home });
      return read.latestRun !== null && done(read.latestRun);
    },
    15_000,
  );
  return read.latestRun;
}

const ended = (run) => !["starting", "running"].includes(run.lifecycle);

test("a tab's run starts in the workspace entry, works in a checkout through the manifest and records its exit", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const { source, task } = await checkoutTask(home, "Build in a checkout");
  const entry = task.workspace.entryPath;
  const [mount] = task.workspace.mounts;
  await writeFile(join(source.path, "README.md"), "uncommitted edit\n");

  // The run's own view: its cwd and the entry listing, the checkout's real path read from the
  // manifest, `git status` there, and a build artifact written into the checkout. It exits 7.
  const report = join(fixture.root, "report.json");
  const script = join(fixture.root, "run.mjs");
  await writeFile(
    script,
    `import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const manifest = JSON.parse(readFileSync("cove-workspace.json", "utf8"));
const checkout = manifest.mounts.find((mount) => mount.source === "checkout");
const status = execFileSync("git", ["status", "--porcelain"], { cwd: checkout.path, encoding: "utf8" });
mkdirSync(join(checkout.path, "build"), { recursive: true });
writeFileSync(join(checkout.path, "build", "artifact.txt"), "built\\n");
writeFileSync(${JSON.stringify(report)}, JSON.stringify({
  cwd: process.cwd(),
  entries: readdirSync("."),
  mounts: manifest.mounts.map((mount) => ({ name: mount.name, path: mount.path })),
  status,
}));
process.exit(7);
`,
  );
  const created = await fixture.coveJson(
    ["tab", "create", task.taskId, "--name", "build", "--", process.execPath, script],
    { home },
  );
  expect(created.operation).toMatchObject({ method: "tab.create", state: "succeeded" });
  const tabId = created.operation.result.resource.id;
  expect(created.tab).toMatchObject({
    tabId,
    taskId: task.taskId,
    name: "build",
    recipe: { kind: "command", executable: process.execPath, argv: [script] },
    cwd: { kind: "entry" },
  });
  const first = created.operation.run;
  expect(created.tab.latestRun).toEqual(first);
  // A tab's run is an ordinary terminal run of this server.
  expect(first.serverId).toBe((await fixture.coveJson(["status"], { home })).serverId);

  const exited = await latestRun(home, tabId, "the first run to exit", ended);
  expect(exited).toMatchObject({
    run: first,
    tabId,
    taskId: task.taskId,
    workspaceRevision: task.workspace.revision,
    cwd: entry,
    mounts: [{ name: mount.name, source: "checkout", path: source.path }],
    lifecycle: "exited",
    verification: "final",
    exitCode: 7,
  });
  expect(exited.endedAtMs).toBeGreaterThanOrEqual(exited.startedAtMs);

  const seen = JSON.parse(await readFile(report, "utf8"));
  expect(seen.cwd).toBe(entry);
  expect(seen.entries).toContain("cove-workspace.json");
  expect(seen.mounts).toEqual([{ name: mount.name, path: source.path }]);
  expect(seen.status).toContain("README.md");
  // The artifact is in the source clone itself: the checkout is that directory.
  expect((await stat(join(source.path, "build", "artifact.txt"))).isFile()).toBe(true);

  // The tab stays after its run exited.
  const listed = await fixture.coveJson(["tab", "list", task.taskId], { home });
  expect(listed.tabs.map((tab) => tab.tabId)).toEqual([tabId]);

  // Reopen: a new run ID with the recorded recipe; the old run stays in the history.
  const reopened = await fixture.coveJson(["tab", "reopen", tabId], { home });
  expect(reopened.operation).toMatchObject({ method: "tab.reopen", state: "succeeded" });
  const second = reopened.operation.run;
  expect(second.runId).not.toBe(first.runId);
  await latestRun(home, tabId, "the second run to exit", ended);
  const { runs } = await fixture.coveJson(["tab", "runs", tabId], { home });
  expect(runs.map((run) => run.run)).toEqual([second, first]);
  expect(runs[1]).toEqual(exited);
  expect(runs[0]).toMatchObject({ lifecycle: "exited", exitCode: 7, cwd: entry });
});

test("a run keeps running while no client is connected and stops on tab stop", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const { task } = await checkoutTask(home, "Long run");
  // Appends a line every 50 ms; the file growing proves the process runs.
  const beats = join(fixture.root, "beats");
  const created = await fixture.coveJson(
    [
      "tab",
      "create",
      task.taskId,
      "--",
      "/bin/sh",
      "-c",
      `echo $$ > '${beats}.pid'; while :; do echo beat >> '${beats}'; sleep 0.05; done`,
    ],
    { home },
  );
  const tabId = created.operation.result.resource.id;
  await waitFor("the run's pid", () => readFile(`${beats}.pid`, "utf8").then(Boolean, () => false));
  await fixture.trackPid(Number((await readFile(`${beats}.pid`, "utf8")).trim()));
  const count = async () => (await readFile(beats, "utf8")).split("\n").filter(Boolean).length;

  // Every CLI command has exited: no client is connected to the server now.
  await waitFor("the first beats", async () => (await count().catch(() => 0)) > 0);
  const before = await count();
  await new Promise((done) => setTimeout(done, 1_000));
  expect(await count()).toBeGreaterThan(before + 5);
  const live = await fixture.coveJson(["tab", "get", tabId], { home });
  expect(live.latestRun).toMatchObject({ lifecycle: "running", verification: "live" });

  // A live run blocks reopen and close; both are refused and change nothing.
  const blocked = await refused(["tab", "reopen", tabId], home, "LIVE_RUNS_PRESENT");
  expect(blocked.stdout).toBe("");
  await refused(["tab", "close", tabId], home, "LIVE_RUNS_PRESENT");

  const stopped = await fixture.coveJson(["tab", "stop", tabId], { home });
  expect(stopped.operation).toMatchObject({
    method: "tab.stop",
    state: "succeeded",
    run: created.operation.run,
  });
  expect(stopped.latestRun).toMatchObject({ lifecycle: "exited", verification: "final" });
  const after = await count();
  await new Promise((done) => setTimeout(done, 300));
  expect(await count()).toBe(after);

  const closed = await fixture.coveJson(["tab", "close", tabId], { home });
  expect(closed).toMatchObject({ method: "tab.close", state: "succeeded" });
  expect((await fixture.coveJson(["tab", "list", task.taskId], { home })).tabs).toEqual([]);
  await refused(["tab", "get", tabId], home, "TAB_NOT_FOUND");
});

test("a tab can start in a mount, be created without a run, and its create is deduplicated", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const { source, task } = await checkoutTask(home, "Mount cwd");
  const [mount] = task.workspace.mounts;
  const report = join(fixture.root, "cwd.txt");
  const args = [
    "tab",
    "create",
    task.taskId,
    "--cwd",
    `mount:${mount.mountId}`,
    "--start",
    "no",
    "--operation-id",
    "s5-idle",
    "--",
    "/bin/sh",
    "-c",
    `pwd -P >> '${report}'`,
  ];
  const created = await fixture.coveJson(args, { home });
  expect(created.operation).toMatchObject({ state: "succeeded" });
  expect(created.operation.run).toBeUndefined();
  expect(created.tab).toMatchObject({ cwd: { kind: "mount", mountId: mount.mountId } });
  expect(created.latestRun).toBeNull();
  const tabId = created.operation.result.resource.id;
  // The same request with the same operation ID returns the original record; nothing new.
  const again = await fixture.coveJson(args, { home });
  expect(again.operation).toEqual(created.operation);
  expect((await fixture.coveJson(["tab", "list", task.taskId], { home })).tabs).toHaveLength(1);

  // The first run comes from reopen and starts in the mount's real directory.
  const reopened = await fixture.coveJson(["tab", "reopen", tabId], { home });
  const run = await latestRun(home, tabId, "the run to exit", ended);
  expect(run).toMatchObject({ run: reopened.operation.run, cwd: source.path, exitCode: 0 });
  expect((await readFile(report, "utf8")).trim()).toBe(source.path);

  // A tab of an unknown task or with an unknown mount is refused and nothing is recorded.
  await refused(["tab", "create", "no-such-task", "--", "/bin/true"], home, "TASK_NOT_FOUND");
  await refused(
    ["tab", "create", task.taskId, "--cwd", "mount:no-such-mount", "--", "/bin/true"],
    home,
    "MOUNT_NOT_FOUND",
  );
  expect((await fixture.coveJson(["tab", "list", task.taskId], { home })).tabs).toHaveLength(1);
});
