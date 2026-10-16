import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createM1Fixture } from "./fixtures.mjs";

// S2 (docs/milestones/m1.md): an investigation task on a shared checkout, through the compiled
// `cove` CLI and server. D2 is option C (#92): the workspace entry holds the mount manifest, and a
// checkout is reached through the real path the manifest lists; there is no symlink. Every
// repository lives in the fixture's temporary root.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

// git in `cwd` with the fixture's environment. Reads pass --no-optional-locks so that they never
// refresh the index of the checkout whose bytes the scenario compares.
function git(cwd, ...args) {
  return new Promise((done, fail) =>
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      { cwd, env: fixture.env },
      (error, stdout, stderr) =>
        error ? fail(new Error(`git ${args.join(" ")} failed: ${stderr}`)) : done(stdout),
    ),
  );
}

// Every entry under `root` (including .git) with its type, mode, size, modification time and
// content hash or link target: any write to the checkout would change it.
async function tree(root) {
  const entries = {};
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const info = await lstat(path);
      const key = path.slice(root.length);
      const base = { mode: info.mode, mtimeMs: info.mtimeMs };
      if (info.isDirectory()) {
        entries[key] = { ...base, type: "dir" };
        await walk(path);
      } else if (info.isSymbolicLink()) {
        entries[key] = { ...base, type: "link", target: await readlink(path) };
      } else {
        const hash = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        entries[key] = { ...base, type: "file", size: info.size, hash };
      }
    }
  }
  await walk(root);
  return entries;
}

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

async function createTask(home, title, extra = []) {
  const output = await fixture.coveJson(["task", "create", title, ...extra], { home });
  expect(output.operation).toMatchObject({ method: "task.create", state: "succeeded" });
  return output;
}

test("an investigation task mounts a checkout without creating a branch or worktree and sees its uncommitted changes through the manifest", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const source = await registered(home, "alpha");
  await writeFile(join(source.path, "README.md"), "uncommitted edit\n");
  await writeFile(join(source.path, "notes.txt"), "untracked\n");
  const branches = await git(source.path, "branch", "--list", "--all");
  const worktrees = await git(source.path, "worktree", "list", "--porcelain");
  const before = await tree(source.path);

  const { operation, task } = await createTask(home, "Investigate flaky reconnect", [
    "--checkout",
    source.repoId,
    "--operation-id",
    "s2-create",
  ]);
  const workspaceRoot = join(home, "workspace");
  expect(operation.result).toMatchObject({
    resource: { kind: "task", id: task.taskId, revision: 0 },
    workspaceRevision: 0,
    mounts: [{ state: "ready" }],
  });
  expect(task).toMatchObject({
    title: "Investigate flaky reconnect",
    slug: "investigate-flaky-reconnect",
    archived: false,
    notice: expect.stringContaining("read-only"),
    workspace: { revision: 0, entryState: "ready" },
  });
  const { entryPath } = task.workspace;
  expect(entryPath.startsWith(join(workspaceRoot, "investigate-flaky-reconnect-"))).toBe(true);
  expect(task.workspace.mounts).toEqual([
    {
      mountId: expect.any(String),
      name: "alpha",
      source: "checkout",
      repoId: source.repoId,
      path: source.path,
      entryPath: null,
      state: "ready",
      branch: null,
      baseCommit: null,
      sharedWithTaskIds: [],
      readOnlyUse: true,
    },
  ]);

  // The entry directory exists and holds only the manifest: no symlink, no directory for the
  // checkout (D2 option C).
  expect((await lstat(entryPath)).isDirectory()).toBe(true);
  expect(await readdir(entryPath)).toEqual(["cove-workspace.json"]);
  const manifest = JSON.parse(await readFile(join(entryPath, "cove-workspace.json"), "utf8"));
  expect(manifest).toEqual({
    kind: "cove-workspace",
    version: 1,
    taskId: task.taskId,
    workspaceId: task.workspace.workspaceId,
    workspaceRevision: 0,
    note: expect.stringContaining("read-only"),
    mounts: [
      { name: "alpha", path: source.path, source: "checkout", readOnly: true, state: "ready" },
    ],
  });
  // The source's uncommitted and untracked changes are visible through the manifest's real path.
  const [listed] = manifest.mounts;
  expect(await readFile(join(listed.path, "README.md"), "utf8")).toBe("uncommitted edit\n");
  expect(await readFile(join(listed.path, "notes.txt"), "utf8")).toBe("untracked\n");
  expect(await git(listed.path, "status", "--porcelain")).toBe(" M README.md\n?? notes.txt\n");

  // No branch, no worktree, no write to the checkout.
  expect(await git(source.path, "branch", "--list", "--all")).toBe(branches);
  expect(await git(source.path, "worktree", "list", "--porcelain")).toBe(worktrees);
  expect(await tree(source.path)).toEqual(before);

  // The same operation ID rebuilt from the same arguments returns the original record and
  // creates no second task.
  const again = await fixture.coveJson(
    [
      "task",
      "create",
      "Investigate flaky reconnect",
      "--checkout",
      source.repoId,
      "--operation-id",
      "s2-create",
    ],
    { home },
  );
  expect(again.operation).toEqual(operation);
  expect((await fixture.coveJson(["task", "list"], { home })).tasks).toHaveLength(1);
  expect(await fixture.coveJson(["task", "get", task.taskId], { home })).toEqual(task);
});

test("the CLI help states that checkout mounts are for read-only use", async () => {
  const help = await fixture.cove([]);
  expect(help.code).toBe(2);
  expect(help.stderr).toContain("task create <TITLE> [--checkout SPEC]");
  expect(help.stderr).toContain("mount add <taskId> (--checkout SPEC | --worktree SPEC)");
  expect(help.stderr).toContain("A checkout mount is an existing directory for read-only use");
});

test("two tasks mounting one checkout both show the sharing, with no lock, and archiving and removing the mounts leaves the source unchanged", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const source = await registered(home, "shared");
  await writeFile(join(source.path, "README.md"), "work in progress\n");
  const before = await tree(source.path);

  const first = (await createTask(home, "Read the parser", ["--checkout", source.repoId])).task;
  const second = (await createTask(home, "Run the tests")).task;
  // Mounted later, by mount add, under another name; nothing is locked.
  const added = await fixture.coveJson(
    ["mount", "add", second.taskId, "--checkout", `${source.repoId},name=src`],
    { home },
  );
  expect(added.operation).toMatchObject({
    method: "mount.add",
    state: "succeeded",
    result: { resource: { kind: "mount", revision: 1 }, workspaceRevision: 1 },
  });
  expect(added.task.notice).toContain("read-only");
  const get = (taskId) => fixture.coveJson(["task", "get", taskId], { home });
  const shared = async (taskId) => (await get(taskId)).workspace.mounts[0].sharedWithTaskIds;
  expect(await shared(first.taskId)).toEqual([second.taskId]);
  expect(await shared(second.taskId)).toEqual([first.taskId]);
  expect((await get(second.taskId)).workspace.mounts[0]).toMatchObject({
    name: "src",
    path: source.path,
    readOnlyUse: true,
  });

  // A registration with mounts cannot be removed, also while the task is archived.
  await refused(["repo", "remove", source.repoId], home, "REPO_IN_USE");
  const archived = await fixture.coveJson(["task", "archive", first.taskId], { home });
  expect(archived).toMatchObject({ state: "succeeded", result: { resource: { revision: 1 } } });
  expect((await get(first.taskId)).archived).toBe(true);
  // An archived task leaves the default list. It keeps its mount (and possibly runs using the
  // checkout), so the other task still shows the sharing.
  expect((await fixture.coveJson(["task", "list"], { home })).tasks.map((t) => t.taskId)).toEqual([
    second.taskId,
  ]);
  expect(
    (await fixture.coveJson(["task", "list", "--archived", "only"], { home })).tasks.map(
      (t) => t.taskId,
    ),
  ).toEqual([first.taskId]);
  expect(await shared(second.taskId)).toEqual([first.taskId]);
  await refused(
    ["mount", "add", first.taskId, "--checkout", `${source.repoId},name=more`],
    home,
    "TASK_ARCHIVED",
  );
  await refused(["repo", "remove", source.repoId], home, "REPO_IN_USE");

  // Remove both mounts, the archived task's included; the sharing shown on the second task ends
  // with the archived task's mount.
  const secondShares = [];
  for (const task of [first, second]) {
    const [mount] = (await get(task.taskId)).workspace.mounts;
    const removed = await fixture.coveJson(["mount", "remove", task.taskId, mount.mountId], {
      home,
    });
    expect(removed.operation).toMatchObject({ method: "mount.remove", state: "succeeded" });
    expect(removed.task.workspace.mounts).toEqual([]);
    const manifest = JSON.parse(
      await readFile(join(task.workspace.entryPath, "cove-workspace.json"), "utf8"),
    );
    expect(manifest.mounts).toEqual([]);
    secondShares.push(
      (await get(second.taskId)).workspace.mounts.map((mount) => mount.sharedWithTaskIds),
    );
  }
  expect(secondShares).toEqual([[[]], []]);
  expect(await tree(source.path)).toEqual(before);
  expect(await readFile(join(source.path, "README.md"), "utf8")).toBe("work in progress\n");

  // Without mounts the registration can go; the clone stays as it was.
  expect(await fixture.coveJson(["repo", "remove", source.repoId], { home })).toMatchObject({
    state: "succeeded",
  });
  expect(await tree(source.path)).toEqual(before);
  const unarchived = await fixture.coveJson(["task", "unarchive", first.taskId], { home });
  expect(unarchived).toMatchObject({ state: "succeeded", result: { resource: { revision: 2 } } });
  expect((await get(first.taskId)).workspace.mounts).toEqual([]);
});

test("an existing worktree is mounted by explicit path, other clones are refused, and a vanished checkout is shown as missing", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const source = await registered(home, "gamma");
  const other = await registered(home, "delta");
  const linked = join(fixture.root, "gamma-feature");
  await git(source.path, "worktree", "add", "--quiet", "-b", "feature", linked);
  // Worktrees made with Git directly, one of them under the workspace root, are not tasks (S1,
  // design §2.5): the task list comes from Cove's records only.
  const stray = join(home, "workspace", "stray");
  await git(source.path, "worktree", "add", "--quiet", "-b", "stray", stray);
  expect(
    (await fixture.coveJson(["task", "list", "--archived", "include"], { home })).tasks,
  ).toEqual([]);
  const { task } = await createTask(home, "Compare branches", [
    "--checkout",
    source.repoId,
    "--checkout",
    `${source.repoId},name=feature,path=${linked}/`,
  ]);
  expect(task.workspace.mounts.map((mount) => [mount.name, mount.path])).toEqual([
    ["gamma", source.path],
    ["feature", linked],
  ]);
  // A worktree of another clone is not a checkout of this repo; nothing is added.
  await refused(
    ["mount", "add", task.taskId, "--checkout", `${source.repoId},name=x,path=${other.path}`],
    home,
    "INVALID_ARGUMENT",
  );
  await refused(
    ["mount", "add", task.taskId, "--checkout", `${source.repoId},name=feature`],
    home,
    "MOUNT_NAME_CONFLICT",
  );
  await refused(
    ["mount", "add", task.taskId, "--checkout", other.repoId, "--expected-revision", "3"],
    home,
    "REVISION_CONFLICT",
  );

  // The linked worktree is deleted outside Cove: the mount stays and is shown as missing.
  await rm(linked, { recursive: true });
  const after = await fixture.coveJson(["task", "get", task.taskId], { home });
  expect(after.workspace.mounts.map((mount) => [mount.name, mount.state])).toEqual([
    ["gamma", "ready"],
    ["feature", "missing"],
  ]);
  expect(after.workspace.revision).toBe(0);
});

test("tasks, mounts and their entries survive a server restart, and a resent create returns its record", async () => {
  const home = fixture.home("home");
  const first = await fixture.startServer(home);
  const source = await registered(home, "epsilon");
  const { operation, task } = await createTask(home, "Survive restart", [
    "--checkout",
    source.repoId,
    "--operation-id",
    "s2-restart",
  ]);
  await fixture.stopServer(first);
  const second = await fixture.startServer(home);
  expect(second.record.serverId).toBe(first.record.serverId);
  expect(await fixture.coveJson(["task", "get", task.taskId], { home })).toEqual(task);
  expect(await fixture.coveJson(["operation", "resend", "s2-restart"], { home })).toEqual(
    operation,
  );
  expect((await fixture.coveJson(["task", "list"], { home })).tasks).toHaveLength(1);
  const renamed = await fixture.coveJson(
    ["task", "rename", task.taskId, "Renamed", "--expected-revision", "0"],
    { home },
  );
  expect(renamed.result.resource.revision).toBe(1);
  // Renaming never moves the entry: the slug is fixed at creation.
  expect(await fixture.coveJson(["task", "get", task.taskId], { home })).toMatchObject({
    title: "Renamed",
    slug: "survive-restart",
    workspace: { entryPath: task.workspace.entryPath, entryState: "ready" },
  });
});

test("task list pages many tasks sharing one checkout in responses within the RPC limits", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const source = await registered(home, "many");
  // Each record lists the other 55 tasks as sharing the checkout: one page of all of them would
  // exceed the 4096-value structure limit of a response.
  const count = 56;
  const taskIds = [];
  for (let start = 0; start < count; start += 4) {
    const batch = await Promise.all(
      [0, 1, 2, 3].map((offset) =>
        createTask(home, `Task ${start + offset}`, ["--checkout", source.repoId]),
      ),
    );
    taskIds.push(...batch.map((output) => output.task.taskId));
  }
  const { tasks } = await fixture.coveJson(["task", "list"], { home });
  expect(tasks.map((task) => task.taskId)).toEqual([...taskIds].sort());
  expect(tasks.map((task) => task.workspace.mounts[0].sharedWithTaskIds.length)).toEqual(
    Array(count).fill(count - 1),
  );
});

test("a mount that would make its task too large for one response is refused before anything is recorded", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  // A clone at the deepest path of control characters (escaped to six bytes each in JSON) the
  // host resolves: PATH_MAX is 1024 bytes on macOS and 4096 on Linux. It is registered and
  // mounted through a short symlink, so every request stays small while the recorded real path
  // does not.
  let deep = "deep";
  for (let level = 0; level < (process.platform === "darwin" ? 3 : 15); level += 1)
    deep = join(deep, "\u0001".repeat(250));
  await mkdir(join(fixture.root, deep), { recursive: true });
  const clone = await fixture.gitRepo(deep);
  const short = join(fixture.root, "short");
  await symlink(clone.path, short);
  const registration = await fixture.coveJson(["repo", "register", short], { home });
  const repoId = registration.result.resource.id;
  const { task } = await createTask(home, "Deep");
  // Sixteen such mounts fit one response on macOS; on Linux the first that would not fit (with
  // the longest title, the largest counters and each checkout shared with 128 tasks) is refused.
  const refusals = [];
  let accepted = 0;
  while (accepted < 16 && !refusals.length) {
    const result = await fixture.cove(
      ["mount", "add", task.taskId, "--checkout", `${repoId},name=m${accepted}`],
      { home },
    );
    if (result.code === 0) accepted += 1;
    else refusals.push(result.stderr.includes("INVALID_ARGUMENT") ? "INVALID_ARGUMENT" : result);
  }
  expect(refusals).toEqual(process.platform === "darwin" ? [] : ["INVALID_ARGUMENT"]);
  // What was accepted is recorded and readable in one response; the refused mount is not.
  const read = await fixture.coveJson(["task", "get", task.taskId], { home });
  expect(read.workspace.mounts).toHaveLength(accepted);
  expect(read.workspace.revision).toBe(accepted);
  expect(read.workspace.mounts.every((mount) => mount.path === clone.path)).toBe(true);
});
