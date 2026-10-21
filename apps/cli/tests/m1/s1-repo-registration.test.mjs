import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { cli, createM1Fixture } from "./fixtures.mjs";

// S1 (docs/milestones/m1.md): repo registration through the compiled `cove` CLI and server.
// Every repository lives in the fixture's temporary root; nothing touches a real clone.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

// git in `cwd` with the fixture's isolated environment; fails the test on a non-zero exit.
function git(cwd, ...args) {
  return new Promise((done, fail) =>
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          ...fixture.env,
          GIT_AUTHOR_NAME: "Cove Fixture",
          GIT_AUTHOR_EMAIL: "fixture@cove.invalid",
          GIT_COMMITTER_NAME: "Cove Fixture",
          GIT_COMMITTER_EMAIL: "fixture@cove.invalid",
        },
      },
      (error, stdout, stderr) =>
        error ? fail(new Error(`git ${args.join(" ")} failed: ${stderr}`)) : done(stdout),
    ),
  );
}

// Every entry under `root` (including .git) with its type, mode, size, modification time and
// content hash or link target: any write by the server would change it.
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

// A failing CLI command: exits non-zero and names the domain error kind.
async function refused(args, home, kind) {
  const result = await fixture.cove(args, { home });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(kind);
  return result;
}

async function register(home, path, extra = []) {
  const operation = await fixture.coveJson(["repo", "register", path, ...extra], { home });
  expect(operation).toMatchObject({ method: "repo.register", state: "succeeded" });
  expect(operation.result.resource).toMatchObject({ kind: "repo", revision: 0 });
  return operation;
}

async function repos(home) {
  return (await fixture.coveJson(["repo", "list"], { home })).repos;
}

test("a clone given through a symlink, a trailing slash or a subdirectory registers once at its real top level", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const clone = await fixture.gitRepo("clones/alpha");
  await mkdir(join(clone.path, "src"));
  const link = join(fixture.root, "alpha-link");
  await symlink(clone.path, link);

  const first = await register(home, `${link}/`);
  const repoId = first.result.resource.id;
  const record = await fixture.coveJson(["repo", "get", repoId], { home });
  expect(record).toEqual({
    repoId,
    revision: 0,
    displayName: "alpha",
    path: clone.path,
    mainBranch: null,
    registeredAtMs: expect.any(Number),
  });

  // Every other spelling of the same clone is the same registration and is refused.
  for (const path of [clone.path, `${clone.path}/`, link, join(clone.path, "src"), `${link}/src/`])
    await refused(["repo", "register", path], home, "REPO_ALREADY_REGISTERED");
  expect(await repos(home)).toEqual([record]);

  // A relative path is resolved against the CLI's directory before it is sent.
  const other = await fixture.gitRepo("clones/beta");
  // Run from inside the alpha clone: `../beta/` is made absolute against the CLI's directory and
  // the server resolves it to beta's real top level.
  const relative = JSON.parse(
    await new Promise((done, fail) =>
      execFile(
        process.execPath,
        [cli, "--home", home, "repo", "register", "--name", "Beta clone", "../beta/"],
        { cwd: clone.path, env: fixture.env },
        (error, stdout, stderr) => (error ? fail(new Error(stderr)) : done(stdout)),
      ),
    ),
  );
  const beta = await fixture.coveJson(["repo", "get", relative.result.resource.id], { home });
  expect(beta).toMatchObject({ displayName: "Beta clone", path: other.path });
  expect((await repos(home)).map((repo) => repo.path).sort()).toEqual(
    [clone.path, other.path].sort(),
  );
});

test("non-Git directories, missing paths and bare repositories are refused and nothing is registered", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const plain = join(fixture.root, "plain");
  await mkdir(join(plain, "nested"), { recursive: true });
  const file = join(plain, "file.txt");
  await writeFile(file, "not a directory\n");
  const clone = await fixture.gitRepo("clones/source");
  const bare = join(fixture.root, "bare.git");
  await git(fixture.root, "clone", "--quiet", "--bare", clone.path, bare);
  // A linked worktree of a bare repository is refused as bare too: the repository has no main
  // working tree to register.
  const bareWorktree = join(fixture.root, "bare-worktree");
  await git(bare, "worktree", "add", "--quiet", bareWorktree, "main");

  for (const path of [plain, join(plain, "nested"), file, join(fixture.root, "missing")])
    await refused(["repo", "register", path], home, "NOT_A_GIT_REPOSITORY");
  // Inside a clone's Git directory is not inside a working tree.
  await refused(["repo", "register", join(clone.path, ".git")], home, "NOT_A_GIT_REPOSITORY");
  for (const path of [bare, join(bare, "refs"), bareWorktree])
    await refused(["repo", "register", path], home, "BARE_REPOSITORY");
  expect(await repos(home)).toEqual([]);
});

test("existing worktrees are not imported and a linked worktree names its clone", async () => {
  const home = fixture.home("home");
  const clone = await fixture.gitRepo("clones/gamma");
  const external = join(fixture.root, "external", "gamma-feature");
  await git(clone.path, "worktree", "add", "--quiet", "-b", "feature", external);
  const workspaceExternal = join(fixture.home("home"), "workspace", "stray");
  await git(clone.path, "worktree", "add", "--quiet", "-b", "stray", workspaceExternal);
  const server = await fixture.startServer(home);

  // Registering through a linked worktree registers the clone's main working tree.
  const operation = await register(home, external);
  const repoId = operation.result.resource.id;
  expect(await fixture.coveJson(["repo", "get", repoId], { home })).toMatchObject({
    path: clone.path,
    displayName: "gamma",
  });
  for (const path of [clone.path, external, workspaceExternal])
    await refused(["repo", "register", path], home, "REPO_ALREADY_REGISTERED");
  expect((await repos(home)).map((repo) => repo.repoId)).toEqual([repoId]);

  // The registration created no task, workspace, mount or managed worktree: the clone's existing
  // worktrees (one of them under the workspace root) are not imported. Read from the database
  // after an orderly stop, while no server holds it.
  await fixture.stopServer(server);
  const db = new DatabaseSync(join(home, "server", "cove.db"), { readOnly: true });
  try {
    const tables = ["tasks", "workspaces", "mounts", "managed_worktrees", "bindings"];
    expect(
      Object.fromEntries(
        tables.map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]),
      ),
    ).toEqual(Object.fromEntries(tables.map((table) => [table, 0])));
    expect(db.prepare("SELECT path, common_dir FROM repos").all()).toEqual([
      { path: clone.path, common_dir: join(clone.path, ".git") },
    ]);
  } finally {
    db.close();
  }
});

test("the main-branch setting is set, read and cleared through the CLI", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const clone = await fixture.gitRepo("clones/delta", { branch: "trunk" });
  const repoId = (await register(home, clone.path)).result.resource.id;
  const get = () => fixture.coveJson(["repo", "get", repoId], { home });

  const set = await fixture.coveJson(
    ["repo", "set", repoId, "mainBranch", "develop", "--operation-id", "s1-set-main"],
    { home },
  );
  expect(set).toMatchObject({
    state: "succeeded",
    result: { resource: { kind: "repo", id: repoId, revision: 1 } },
  });
  expect(await get()).toMatchObject({ mainBranch: "develop", revision: 1 });

  // The same operation ID rebuilt from the same arguments returns the original record; the
  // revision does not grow again.
  expect(
    await fixture.coveJson(
      ["repo", "set", repoId, "mainBranch", "develop", "--operation-id", "s1-set-main"],
      { home },
    ),
  ).toEqual(set);
  expect(await get()).toMatchObject({ revision: 1 });

  // Only a name Git accepts as a branch is stored; a stale expected revision changes nothing.
  for (const name of ["a..b", "topic.lock", "feature/"])
    await refused(["repo", "set", repoId, "mainBranch", name], home, "INVALID_ARGUMENT");
  await refused(
    ["repo", "set", repoId, "mainBranch", "main", "--expected-revision", "0"],
    home,
    "REVISION_CONFLICT",
  );
  expect(await get()).toMatchObject({ mainBranch: "develop", revision: 1 });

  await fixture.coveJson(
    ["repo", "set", repoId, "displayName", "Delta", "--expected-revision", "1"],
    {
      home,
    },
  );
  const reset = await fixture.coveJson(["repo", "reset", repoId, "mainBranch"], { home });
  expect(reset.result.resource.revision).toBe(3);
  expect(await get()).toMatchObject({ displayName: "Delta", mainBranch: null, revision: 3 });
  await refused(["repo", "get", "no-such-repo"], home, "REPO_NOT_FOUND");
  await refused(["repo", "set", "no-such-repo", "mainBranch", "main"], home, "REPO_NOT_FOUND");
});

test("a resent registration returns its original record after a restart", async () => {
  const home = fixture.home("home");
  const clone = await fixture.gitRepo("clones/epsilon");
  const first = await fixture.startServer(home);
  const original = await register(home, clone.path, ["--operation-id", "s1-register"]);
  await fixture.stopServer(first);

  const second = await fixture.startServer(home);
  expect(second.record.serverId).toBe(first.record.serverId);
  expect(second.record.relayInstanceId).not.toBe(first.record.relayInstanceId);
  // The receipt is found before the duplicate check, so the resend is not refused as already
  // registered, both rebuilt from the same arguments and resent from the saved request.
  expect(
    await fixture.coveJson(["repo", "register", clone.path, "--operation-id", "s1-register"], {
      home,
    }),
  ).toEqual(original);
  expect(await fixture.coveJson(["operation", "resend", "s1-register"], { home })).toEqual(
    original,
  );
  // Another path under the same operation ID is a different request, refused before sending.
  const changed = await fixture.cove(
    ["repo", "register", `${clone.path}/`, "--operation-id", "s1-register"],
    { home },
  );
  expect(changed.code).not.toBe(0);
  expect(changed.stderr).toContain("nothing was sent");
  expect(await repos(home)).toHaveLength(1);
});

test("repo remove deletes only the registration and leaves the clone directory unchanged", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const clone = await fixture.gitRepo("clones/zeta");
  await writeFile(join(clone.path, "untracked.txt"), "untracked\n");
  await writeFile(join(clone.path, "README.md"), "modified\n");
  const external = join(fixture.root, "zeta-feature");
  await git(clone.path, "worktree", "add", "--quiet", "-b", "feature", external);
  const repoId = (await register(home, clone.path)).result.resource.id;
  await fixture.coveJson(["repo", "set", repoId, "mainBranch", "main"], { home });
  const before = { clone: await tree(clone.path), external: await tree(external) };

  await refused(["repo", "remove", repoId, "--expected-revision", "0"], home, "REVISION_CONFLICT");
  const removed = await fixture.coveJson(
    ["repo", "remove", repoId, "--expected-revision", "1", "--operation-id", "s1-remove"],
    { home },
  );
  expect(removed).toMatchObject({
    method: "repo.remove",
    state: "succeeded",
    result: { resource: { kind: "repo", id: repoId, revision: 1 } },
  });
  // A resend returns the original record although the registration no longer exists.
  expect(await fixture.coveJson(["operation", "resend", "s1-remove"], { home })).toEqual(removed);
  await refused(["repo", "get", repoId], home, "REPO_NOT_FOUND");
  await refused(["repo", "remove", repoId], home, "REPO_NOT_FOUND");
  expect(await repos(home)).toEqual([]);
  expect({ clone: await tree(clone.path), external: await tree(external) }).toEqual(before);

  // The clone can be registered again; it is a new registration.
  const again = await register(home, clone.path);
  expect(again.result.resource.id).not.toBe(repoId);
});

test("a request Git cannot answer is refused as GIT_UNAVAILABLE, not as a non-repository", async () => {
  const home = fixture.home("home");
  const clone = await fixture.gitRepo("clones/eta");
  const plain = join(fixture.root, "plain");
  await mkdir(plain);
  // The server finds this `git` first on its PATH; it reports a supported version, but every
  // other output exceeds the server's bound, so no Git query gets an answer. Only the server is
  // started with it.
  const fake = join(fixture.root, "fake-bin");
  await mkdir(fake);
  await writeFile(
    join(fake, "git"),
    '#!/bin/sh\nfor last; do :; done\n[ "$last" = version ] && { echo "git version 2.45.0"; exit 0; }\nexec yes\n',
    { mode: 0o755 },
  );
  const path = fixture.env.PATH;
  fixture.env.PATH = `${fake}:${path}`;
  try {
    await fixture.startServer(home);
  } finally {
    fixture.env.PATH = path;
  }

  const unanswered = await refused(["repo", "register", clone.path], home, "GIT_UNAVAILABLE");
  expect(unanswered.stderr).toContain("not-accepted");
  // A domain refusal ends the CLI with the same status whatever its kind.
  const notRepo = await refused(
    ["repo", "register", join(fixture.root, "missing")],
    home,
    "NOT_A_GIT_REPOSITORY",
  );
  expect(unanswered.code).toBe(notRepo.code);
  // The plain directory exists, so only Git could tell; it is not misreported as a non-repository.
  await refused(["repo", "register", plain], home, "GIT_UNAVAILABLE");
  expect(await repos(home)).toEqual([]);
});

// #126 item 3: Cove does not support Git older than 2.45 (GIT_NO_LAZY_FETCH, which keeps a query
// from fetching a partial clone's missing objects, exists only from 2.45). A server whose git is
// older does not start, and says why, before it opens the data directory.
test("a server whose git is older than 2.45 refuses to start and says why", async () => {
  const home = fixture.home("home");
  const fake = join(fixture.root, "old-git-bin");
  await mkdir(fake);
  await writeFile(
    join(fake, "git"),
    '#!/bin/sh\nfor last; do :; done\n[ "$last" = version ] && { echo "git version 2.44.2"; exit 0; }\nexit 1\n',
    { mode: 0o755 },
  );
  const path = fixture.env.PATH;
  fixture.env.PATH = `${fake}:${path}`;
  try {
    await expect(fixture.startServer(home)).rejects.toThrow(
      "git 2.44.2 is too old: Cove requires Git 2.45 or later; put a newer git (such as " +
        "Homebrew's) first on PATH",
    );
  } finally {
    fixture.env.PATH = path;
  }
  // Nothing was opened: a server with a supported git starts on the same data directory.
  await fixture.startServer(home);
  expect(await repos(home)).toEqual([]);
});
