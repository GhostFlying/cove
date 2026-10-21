import { mkdir, readdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { registeredRemote } from "../m1/s3-worktree-remotes.mjs";
import { createAuthFixture } from "./auth-fixtures.mjs";

// m2 S13 (remote path semantics, D11), against the compiled CLI and server. With --server, a path
// argument is a path on the server's host: relative and ~ paths are usage errors (2) before
// anything is saved or sent, and absolute paths are sent exactly as given. The client runs from a
// directory of its own temporary tree, which holds a clone of the same relative name as the
// server's, so a path resolved against the client's directory would name the wrong one. Local
// mode keeps the M1 behavior.

let fixture;
let serverHome;
let client;
let clientCwd;
let serverRepo;

beforeEach(async () => {
  fixture = await createAuthFixture();
  serverHome = fixture.home("server-tree/home");
  serverRepo = await fixture.gitRepo("server-tree/repos/repo");
  // A same-named clone that exists only in the client's tree.
  await fixture.gitRepo("client-tree/work/repo");
  clientCwd = join(fixture.root, "client-tree", "work");
  await fixture.startAuthServer(serverHome);
  client = fixture.home("client-tree/home");
  await fixture.pairOk(client, "box", (await fixture.invite(serverHome)).invitation);
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

const remote = (args) =>
  fixture.coveInput(["--server", "box", ...args], "", { home: client, cwd: clientCwd });

async function pendingRecords() {
  try {
    return await readdir(join(client, "cli", "operations"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function serverRepos() {
  return (await fixture.coveJson(["repo", "list"], { home: serverHome })).repos;
}

test("relative and ~ paths are usage errors with --server, and nothing is saved or sent", async () => {
  for (const args of [
    ["repo", "register", "repo"],
    ["repo", "register", "./repo"],
    ["repo", "register", "~/repo"],
    // A bare word is a repo ID (M1); a path argument starts with /, . or ~ or holds a /.
    ["task", "create", "T", "--checkout", "./repo"],
    ["task", "create", "T", "--checkout", "repo/sub,name=x"],
    ["task", "create", "T", "--checkout", "~"],
    ["task", "create", "T", "--checkout", "~/repo"],
    ["config", "set", "workspaceRoot", "workspaces"],
    ["terminal", "create", "--", "/bin/true"],
    ["terminal", "create", "--cwd", "repo", "--", "/bin/true"],
  ]) {
    const result = await remote(args);
    expect({ args, code: result.code }).toEqual({ args, code: 2 });
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/absolute|--cwd/);
  }
  expect(await pendingRecords()).toEqual([]);
  expect(await serverRepos()).toEqual([]);
  const { tasks } = await fixture.coveJson(["task", "list"], { home: serverHome });
  expect(tasks).toEqual([]);
});

test("absolute paths are sent as given and interpreted on the server's host only", async () => {
  // The server's clone, named by its absolute path from the client's unrelated directory.
  const registered = await remote(["repo", "register", serverRepo.path]);
  expect(registered.code).toBe(0);
  const [repo] = await serverRepos();
  expect(repo.path).toBe(serverRepo.path);

  // --checkout PATH resolves only a registered clone's exact path, as the server reports it.
  const task = await remote(["task", "create", "Remote", "--checkout", serverRepo.path]);
  expect(task.code).toBe(0);
  expect(task.stdout).toContain(repo.repoId);
  const unregistered = await remote([
    "task",
    "create",
    "Other",
    "--checkout",
    join(clientCwd, "repo"),
  ]);
  expect(unregistered.code).toBe(1);
  expect(unregistered.stderr).toContain("not the path of a registered clone on the server");

  // An absolute directory for a run and a setting reach the server unchanged.
  const runDirectory = join(fixture.root, "server-tree", "run-dir");
  await mkdir(runDirectory, { recursive: true });
  const run = await remote([
    "terminal",
    "create",
    "--cwd",
    runDirectory,
    "--",
    "/bin/sh",
    "-c",
    "exec sleep 600",
  ]);
  expect(run.code).toBe(0);
  const root = join(fixture.root, "server-tree", "workspaces");
  const set = await remote(["config", "set", "workspaceRoot", root]);
  expect(set.code).toBe(0);
  const config = await fixture.coveJson(["config", "get"], { home: serverHome });
  expect(JSON.stringify(config)).toContain(JSON.stringify(root));
});

test("local mode still resolves relative paths against the CLI's directory", async () => {
  const local = await fixture.coveInput(["repo", "register", "repo"], "", {
    home: serverHome,
    cwd: join(fixture.root, "server-tree", "repos"),
  });
  expect(local.code).toBe(0);
  expect((await serverRepos()).map((repo) => repo.path)).toEqual([serverRepo.path]);
});

// mount delete-worktree PATH finds the worktree by real path, which only this host's filesystem
// can resolve. With --server it is refused (2) before anything is read, saved or sent, so neither
// a client path that resolves here to the server's worktree (a symlink in the client's tree) nor
// the server's own path deletes anything; the IDs form still does.
test("delete-worktree by path is refused with --server and resolves nothing on the client", async () => {
  const alpha = await registeredRemote(fixture, serverHome, "alpha");
  const { task } = await fixture.coveJson(["task", "create", "Held", "--worktree", alpha.repoId], {
    home: serverHome,
  });
  const [mount] = task.workspace.mounts.filter((item) => item.source === "worktree");
  const alias = join(clientCwd, "worktree-alias");
  await symlink(mount.path, alias);
  for (const path of [alias, mount.path, "./worktree-alias"]) {
    const refused = await remote(["mount", "delete-worktree", path, "--yes"]);
    expect({ path, code: refused.code }).toEqual({ path, code: 2 });
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toMatch(/takes <taskId> <mountId>, not a path|relative/);
  }
  expect(await pendingRecords()).toEqual([]);
  expect((await stat(mount.path)).isDirectory()).toBe(true);
  const deleted = await remote(["mount", "delete-worktree", task.taskId, mount.mountId, "--yes"]);
  expect(deleted.code).toBe(0);
  await expect(stat(mount.path)).rejects.toThrow("ENOENT");
});
