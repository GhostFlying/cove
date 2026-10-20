import { lstat, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createM1Fixture } from "./fixtures.mjs";
import { registeredRemote } from "./s3-worktree-remotes.mjs";

// CLI usability from the M1 trial (PR #134), through the compiled `cove` CLI and server: per-group
// help, `--checkout PATH` and mount commands without a mount ID. Every repository and remote lives
// in the fixture's temporary root.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

const FULL = ["  repo register", "  task create", "  mount add", "  tab create", "  status"];

test("an explicit help request prints the full usage, or one group's, on stdout and exits 0", async () => {
  for (const args of [["--help"], ["help"]]) {
    const result = await fixture.cove(args);
    expect({ args, code: result.code }).toEqual({ args, code: 0 });
    expect(result.stderr).toBe("");
    for (const line of FULL) expect(result.stdout).toContain(line);
  }
  for (const args of [
    ["help", "repo"],
    ["repo", "--help"],
    ["repo", "register", "--help"],
  ]) {
    const result = await fixture.cove(args);
    expect({ args, code: result.code }).toEqual({ args, code: 0 });
    expect(result.stdout).toMatch(/^usage: cove /);
    expect(result.stdout).toContain("  repo register <PATH>");
    expect(result.stdout).not.toContain("  task create");
    expect(result.stdout).toContain("--operation-id ID; the request is saved");
  }
  // A group without write commands has no operation-ID note.
  const status = await fixture.cove(["help", "status"]);
  expect(status.code).toBe(0);
  expect(status.stdout).not.toContain("--operation-id");
  // A --help after `--` belongs to the spawned command, not to cove: the tab command runs (and
  // fails here only for want of a server).
  const recipe = await fixture.cove(["tab", "create", "t1", "--", "prog", "--help"], {
    home: fixture.home("home"),
  });
  expect(recipe.code).toBe(1);
  expect(recipe.stdout).toBe("");
});

test("a group without a subcommand is a usage error that prints only that group's usage", async () => {
  const mount = await fixture.cove(["mount"]);
  expect(mount.code).toBe(2);
  expect(mount.stdout).toBe("");
  expect(mount.stderr).toContain("cove: missing mount command");
  expect(mount.stderr).toContain("  mount convert");
  expect(mount.stderr).not.toContain("  repo register");
  // A usage error inside a group shows that group's usage too.
  const unknown = await fixture.cove(["repo", "frobnicate"]);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain("cove: Unknown repo command frobnicate");
  expect(unknown.stderr).toContain("  repo list");
  expect(unknown.stderr).not.toContain("  mount add");
  // No command and an unknown command keep the full usage.
  for (const args of [[], ["nope"]]) {
    const result = await fixture.cove(args);
    expect({ args, code: result.code }).toEqual({ args, code: 2 });
    for (const line of FULL) expect(result.stderr).toContain(line);
  }
  const unknownGroup = await fixture.cove(["help", "nope"]);
  expect(unknownGroup.code).toBe(2);
  expect(unknownGroup.stderr).toContain("cove: Unknown command group nope");
});

// A registered clone under the isolated HOME (so `~/...` reaches it) with one linked worktree that
// Cove does not manage.
async function registeredClone(home) {
  const clone = await fixture.gitRepo("user-home/alpha");
  const registered = await fixture.coveJson(["repo", "register", clone.path], { home });
  const linked = join(fixture.root, "user-home", "alpha-linked");
  await clone.git("worktree", "add", "--quiet", "-b", "linked", linked);
  return { repoId: registered.result.resource.id, clone: clone.path, linked };
}

const savedRequest = async (home, operationId) =>
  JSON.parse(await readFile(join(home, "cli", "operations", `${operationId}.json`), "utf8"));

test("--checkout PATH names the registered clone or its worktree and sends the REPO_ID request", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const { repoId, clone, linked } = await registeredClone(home);
  // The clone by a subdirectory of it, with a name; the worktree through `~`, which a quoted
  // argument leaves to the CLI.
  await mkdir(join(clone, "sub"));
  const created = await fixture.coveJson(
    [
      "task",
      "create",
      "By path",
      "--checkout",
      `${join(clone, "sub")},name=main-co`,
      "--checkout",
      "~/alpha-linked",
      "--operation-id",
      "by-path",
    ],
    { home },
  );
  expect((await savedRequest(home, "by-path")).params.mounts).toEqual([
    { source: "checkout", repoId, name: "main-co" },
    { source: "checkout", repoId, path: linked },
  ]);
  expect(created.task.workspace.mounts).toEqual([
    expect.objectContaining({ source: "checkout", repoId, name: "main-co", path: clone }),
    expect.objectContaining({ source: "checkout", repoId, path: linked }),
  ]);
  // mount add takes the same form; the REPO_ID form still works beside it.
  const added = await fixture.coveJson(
    ["mount", "add", created.task.taskId, "--checkout", `${clone},name=again`],
    { home },
  );
  expect(added.task.workspace.mounts.at(-1)).toMatchObject({ name: "again", path: clone });
  const byId = await fixture.coveJson(
    ["mount", "add", created.task.taskId, "--checkout", `${repoId},name=by-id`],
    { home },
  );
  expect(byId.task.workspace.mounts.at(-1)).toMatchObject({ name: "by-id", path: clone });
});

test("--checkout PATH outside every registered repo fails before anything is sent", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  await registeredClone(home);
  const other = await fixture.gitRepo("unregistered");
  const plain = join(fixture.root, "plain");
  await mkdir(plain);
  const { task } = await fixture.coveJson(["task", "create", "Nothing"], { home });
  for (const [path, why] of [
    [other.path, ""],
    [plain, " (Git finds no working tree there)"],
  ]) {
    const result = await fixture.cove(
      ["mount", "add", task.taskId, "--checkout", path, "--operation-id", "unmatched"],
      { home },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`--checkout ${path} is not in a registered repo${why}`);
    expect(result.stderr).toContain("nothing was sent");
  }
  // No request was saved, and the task is unchanged.
  await expect(savedRequest(home, "unmatched")).rejects.toThrow("ENOENT");
  const after = await fixture.coveJson(["task", "get", task.taskId], { home });
  expect(after.workspace.mounts).toEqual([]);
  // A value without a slash that names a directory is still a repo ID, refused as such.
  const asId = await fixture.cove(["task", "create", "As id", "--checkout", "plain"], { home });
  expect(asId.code).toBe(1);
  expect(asId.stderr).toContain("REPO_NOT_FOUND");
});

test("mount convert without a mount id converts the task's only checkout mount", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  // A worktree mount beside the checkout is not a candidate.
  const { task } = await fixture.coveJson(
    [
      "task",
      "create",
      "Convert one",
      "--checkout",
      alpha.repoId,
      "--worktree",
      `${alpha.repoId},name=wt`,
    ],
    { home },
  );
  const checkout = task.workspace.mounts.find((mount) => mount.source === "checkout");
  const converted = await fixture.cove(
    ["mount", "convert", task.taskId, "--branch", "converted", "--operation-id", "convert-one"],
    { home },
  );
  expect(converted.stderr).toBe("");
  expect(converted.code).toBe(0);
  expect((await savedRequest(home, "convert-one")).params).toEqual({
    operationId: "convert-one",
    taskId: task.taskId,
    mountId: checkout.mountId,
    branch: "converted",
  });
  const printed = JSON.parse(converted.stdout);
  expect(printed.operation).toMatchObject({
    method: "binding.convert",
    state: "succeeded",
    result: { resource: { kind: "mount", id: checkout.mountId } },
  });
  expect(printed.task.workspace.mounts.map((mount) => mount.source)).toEqual([
    "worktree",
    "worktree",
  ]);
  // Now the task has no checkout mount: nothing is sent.
  const none = await fixture.cove(["mount", "convert", task.taskId], { home });
  expect(none.code).toBe(2);
  expect(none.stdout).toBe("");
  expect(none.stderr).toContain(`task ${task.taskId} has no checkout mount; nothing was sent`);
});

test("mount convert without a mount id lists the checkout mounts when there are several", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const { repoId, clone, linked } = await registeredClone(home);
  const { task } = await fixture.coveJson(
    ["task", "create", "Two", "--checkout", `${repoId},name=a`, "--checkout", `${linked},name=b`],
    { home },
  );
  const [a, b] = task.workspace.mounts;
  const result = await fixture.cove(
    ["mount", "convert", task.taskId, "--operation-id", "convert-two"],
    { home },
  );
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(
    `task ${task.taskId} has 2 checkout mounts; name one: ` +
      `\`cove mount convert ${task.taskId} <mountId>\` (nothing was sent)`,
  );
  expect(result.stderr).toContain(`  ${a.mountId}\ta\t${clone}\n`);
  expect(result.stderr).toContain(`  ${b.mountId}\tb\t${linked}\n`);
  await expect(savedRequest(home, "convert-two")).rejects.toThrow("ENOENT");
});

const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );

test("mount delete-worktree without a mount id deletes the task's only managed worktree", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  // A checkout beside the worktree is not a candidate.
  const { task } = await fixture.coveJson(
    ["task", "create", "One", "--checkout", alpha.repoId, "--worktree", `${alpha.repoId},name=wt`],
    { home },
  );
  const worktree = task.workspace.mounts.find((mount) => mount.source === "worktree");
  const deleted = await fixture.cove(
    ["mount", "delete-worktree", task.taskId, "--yes", "--operation-id", "delete-one"],
    { home },
  );
  expect(deleted.code).toBe(0);
  expect((await savedRequest(home, "delete-one")).params).toEqual({
    operationId: "delete-one",
    taskId: task.taskId,
    mountId: worktree.mountId,
    confirmed: true,
  });
  const printed = JSON.parse(deleted.stdout);
  expect(printed.operation).toMatchObject({ method: "binding.delete", state: "succeeded" });
  expect(printed.task.workspace.mounts).toEqual([
    expect.objectContaining({ source: "checkout", path: alpha.clone }),
  ]);
  expect(await exists(worktree.path)).toBe(false);
  // No managed worktree is left: nothing is sent.
  const none = await fixture.cove(["mount", "delete-worktree", task.taskId, "--yes"], { home });
  expect(none.code).toBe(2);
  expect(none.stderr).toContain(
    `task ${task.taskId} has no managed worktree mount; nothing was sent`,
  );
  // Several: they are listed, and nothing is deleted.
  const two = await fixture.coveJson(
    [
      "task",
      "create",
      "Two",
      "--worktree",
      `${alpha.repoId},name=a,branch=two-a`,
      "--worktree",
      `${alpha.repoId},name=b,branch=two-b`,
    ],
    { home },
  );
  const [a, b] = two.task.workspace.mounts;
  const ambiguous = await fixture.cove(["mount", "delete-worktree", two.task.taskId, "--yes"], {
    home,
  });
  expect(ambiguous.code).toBe(2);
  expect(ambiguous.stdout).toBe("");
  expect(ambiguous.stderr).toContain(
    `task ${two.task.taskId} has 2 managed worktree mounts; name one: ` +
      `\`cove mount delete-worktree ${two.task.taskId} <mountId>\` (nothing was sent)`,
  );
  expect(ambiguous.stderr).toContain(`  ${a.mountId}\ta\t${a.path}\n`);
  expect(ambiguous.stderr).toContain(`  ${b.mountId}\tb\t${b.path}\n`);
  expect(await exists(a.path)).toBe(true);
  expect(await exists(b.path)).toBe(true);
});

test("mount delete-worktree PATH finds the managed worktree by its real path, in archived tasks too", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(
    [
      "task",
      "create",
      "By path",
      "--worktree",
      `${alpha.repoId},name=a,branch=path-a`,
      "--worktree",
      `${alpha.repoId},name=b,branch=path-b`,
    ],
    { home },
  );
  const [, b] = task.workspace.mounts;
  await fixture.coveJson(["task", "archive", task.taskId], { home });
  // Without a terminal and without --yes nothing is looked up or sent, as before.
  const unconfirmed = await fixture.cove(["mount", "delete-worktree", b.path], { home });
  expect(unconfirmed.code).toBe(2);
  expect(unconfirmed.stderr).toContain("confirm with --yes (nothing was sent)");
  // Named through a symlink to the workspace entry.
  const alias = join(fixture.root, "alias");
  await symlink(task.workspace.entryPath, alias);
  const deleted = await fixture.cove(
    ["mount", "delete-worktree", join(alias, "b"), "--yes", "--operation-id", "delete-path"],
    { home },
  );
  expect(deleted.code).toBe(0);
  expect((await savedRequest(home, "delete-path")).params).toEqual({
    operationId: "delete-path",
    taskId: task.taskId,
    mountId: b.mountId,
    confirmed: true,
  });
  const printed = JSON.parse(deleted.stdout);
  expect(printed.operation).toMatchObject({ method: "binding.delete", state: "succeeded" });
  expect(printed.task.workspace.mounts.map((mount) => mount.mountId)).not.toContain(b.mountId);
  expect(await exists(b.path)).toBe(false);
  // The branch is kept.
  expect(await alpha.git("branch", "--list", "path-b")).toContain("path-b");

  // A path that is not a managed worktree mount: nothing is sent, and the hint names the
  // commands for a checkout or an unmanaged worktree.
  const { task: reader } = await fixture.coveJson(
    ["task", "create", "Reader", "--checkout", alpha.clone],
    { home },
  );
  for (const path of [alpha.clone, b.path, join(fixture.root, "nowhere")]) {
    const result = await fixture.cove(
      ["mount", "delete-worktree", path, "--yes", "--operation-id", "delete-none"],
      { home },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`no Cove-managed worktree mount is at ${path}`);
    expect(result.stderr).toContain("`cove mount remove <taskId> <mountId>` unmounts it");
  }
  await expect(savedRequest(home, "delete-none")).rejects.toThrow("ENOENT");
  expect(await exists(join(alpha.clone, "README.md"))).toBe(true);
  const unchanged = await fixture.coveJson(["task", "get", reader.taskId], { home });
  expect(unchanged.workspace.mounts).toHaveLength(1);
  // The PATH form takes no mount id.
  const extra = await fixture.cove(["mount", "delete-worktree", alpha.clone, "m1", "--yes"], {
    home,
  });
  expect(extra.code).toBe(2);
  expect(extra.stderr).toContain("mount delete-worktree PATH takes no mount id");
});
