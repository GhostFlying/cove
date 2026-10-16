import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { RepoService } from "../../dist/domain/repos.js";
import { inspectRepository, isValidBranchName, readHead } from "../../dist/git/repository.js";
import { runGit } from "../../dist/git/run.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { Store } from "../../dist/store/database.js";
import { prepareHome } from "../../dist/store/home.js";
import { recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";

// Git queries and repo registration (docs/milestones/m1.md T2) below the CLI: Git answers that
// S1 cannot provoke through the compiled CLI (timeouts, oversized output, a missing git, an
// inherited GIT_DIR, HEAD states) and concurrent registrations.

const encode = (text) => new TextEncoder().encode(text);
const directories = [];
const stores = [];
const savedEnv = { PATH: process.env.PATH, GIT_DIR: process.env.GIT_DIR };

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "cove-repo-test-")));
  directories.push(path);
  return path;
}

// git for building fixtures, with its own HOME and no system configuration.
function git(cwd, home, ...args) {
  return new Promise((done, fail) =>
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          PATH: savedEnv.PATH,
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Cove Test",
          GIT_AUTHOR_EMAIL: "test@cove.invalid",
          GIT_COMMITTER_NAME: "Cove Test",
          GIT_COMMITTER_EMAIL: "test@cove.invalid",
        },
      },
      (error, stdout, stderr) =>
        error ? fail(new Error(`git ${args.join(" ")}: ${stderr}`)) : done(stdout.trim()),
    ),
  );
}

async function clone(root, name, { commit = true } = {}) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await git(path, root, "init", "--quiet", "--initial-branch", "main");
  if (commit) {
    await writeFile(join(path, "README.md"), "test\n");
    await git(path, root, "add", "README.md");
    await git(path, root, "commit", "--quiet", "--no-gpg-sign", "-m", "test");
  }
  return path;
}

// A directory holding a fake `git` executable; putting it first on PATH replaces git for the
// server's runner (runGit looks git up on the PATH it passes to the child).
async function fakeGit(script) {
  const directory = await temporary();
  const path = join(directory, "git");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return directory;
}

describe("Git runner", () => {
  it("passes only the allowlisted environment and disables prompts and pagers", async () => {
    process.env.PATH = `${await fakeGit("env")}:${savedEnv.PATH}`;
    process.env.GIT_DIR = "/elsewhere/.git";
    const result = await runGit(["status"], { cwd: await temporary() });
    expect(result.kind).toBe("exited");
    const env = Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(env.GIT_DIR).toBeUndefined();
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    });
    const allowed = new Set([
      ...["PATH", "HOME", "XDG_CONFIG_HOME", "TMPDIR", "GIT_CONFIG_NOSYSTEM"],
      ...["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "LC_ALL", "LANG", "GIT_TERMINAL_PROMPT"],
      ...["GIT_PAGER", "PAGER", "GIT_EDITOR", "GIT_OPTIONAL_LOCKS"],
      // Set by the shell running the fake git itself.
      ...["PWD", "SHLVL", "_", "OLDPWD"],
    ]);
    expect(Object.keys(env).filter((name) => !allowed.has(name))).toEqual([]);
  });

  it("reports a timeout, oversized output and a missing git as failures without an answer", async () => {
    const cwd = await temporary();
    process.env.PATH = `${await fakeGit("exec sleep 30")}:${savedEnv.PATH}`;
    const started = Date.now();
    expect(await runGit(["status"], { cwd, timeoutMs: 200 })).toEqual({
      kind: "failed",
      reason: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    // A query that gets no answer is not "not a repository".
    expect(await inspectRepository(cwd)).toEqual({ kind: "unavailable" });

    process.env.PATH = `${await fakeGit("exec yes")}:${savedEnv.PATH}`;
    expect(await runGit(["status"], { cwd, maxOutputBytes: 4096 })).toEqual({
      kind: "failed",
      reason: "overflow",
    });

    process.env.PATH = await temporary();
    expect(await runGit(["status"], { cwd })).toEqual({ kind: "failed", reason: "spawn" });
    expect(await isValidBranchName("main")).toBeNull();
  });
});

describe("repository queries", () => {
  it("reads HEAD on a branch, detached and unborn", async () => {
    const root = await temporary();
    const path = await clone(root, "repo");
    const commit = await git(path, root, "rev-parse", "HEAD");
    expect(await readHead(path)).toEqual({ kind: "head", branch: "main", commit });
    await git(path, root, "checkout", "--quiet", "--detach");
    expect(await readHead(path)).toEqual({ kind: "head", branch: null, commit });
    const empty = await clone(root, "empty", { commit: false });
    expect(await readHead(empty)).toEqual({ kind: "head", branch: "main", commit: null });
    expect(await readHead(await temporary())).toEqual({ kind: "not-repository" });
  });

  it("ignores an inherited GIT_DIR and resolves a linked worktree to its clone", async () => {
    const root = await temporary();
    const main = await clone(root, "main");
    const other = await clone(root, "other");
    process.env.GIT_DIR = join(other, ".git");
    const linked = join(root, "linked");
    await git(main, root, "worktree", "add", "--quiet", "-b", "topic", linked);
    const expected = { kind: "clone", topLevel: main, commonDir: join(main, ".git") };
    expect(await inspectRepository(main)).toEqual(expected);
    expect(await inspectRepository(`${linked}/`)).toEqual(expected);
    expect(await inspectRepository("relative/path")).toEqual({ kind: "not-repository" });
  });

  it("refuses a linked worktree whose clone's main working tree no longer exists", async () => {
    const root = await temporary();
    const main = join(root, "main");
    const gitDir = join(root, "git-dirs", "main");
    await mkdir(join(root, "git-dirs"));
    await git(root, root, "init", "--quiet", "-b", "main", "--separate-git-dir", gitDir, main);
    await writeFile(join(main, "README.md"), "test\n");
    await git(main, root, "add", "README.md");
    await git(main, root, "commit", "--quiet", "--no-gpg-sign", "-m", "test");
    expect(await inspectRepository(main)).toEqual({
      kind: "clone",
      topLevel: main,
      commonDir: gitDir,
    });
    const linked = join(root, "linked");
    await git(main, root, "worktree", "add", "--quiet", "-b", "topic", linked);
    // The Git directory and the linked worktree remain, but no directory is the clone any more,
    // so there is nothing a registration could name.
    await rm(main, { recursive: true });
    expect(await inspectRepository(linked)).toEqual({ kind: "not-repository" });
  });

  it("checks branch names with Git's own rules", async () => {
    for (const name of ["main", "release/1.0", "feature-x"])
      expect(await isValidBranchName(name)).toBe(true);
    for (const name of ["a..b", "topic.lock", "feature/", "x@{1}", "HEAD/x."])
      expect(await isValidBranchName(name)).toBe(false);
  });
});

async function service() {
  const layout = await prepareHome(join(await temporary(), "home"));
  const store = await Store.open({
    databasePath: layout.databasePath,
    backupDirectory: layout.backupDirectory,
  });
  stores.push(store);
  const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
  const composition = new RuntimeComposition("server", "instance", { ...M0_LIMITS }, bytes);
  recordInstanceStart(store, "instance", 1);
  const receipts = new OperationReceipts(
    composition,
    encode,
    new SqliteReceiptBackend(store, "instance", () => 1),
  );
  return {
    store,
    repos: new RepoService({ store, serverId: "server", receipts, encodeUtf8: encode }),
  };
}

describe("repo registration", () => {
  it("lets exactly one of two concurrent registrations of one clone succeed", async () => {
    const root = await temporary();
    const path = await clone(root, "repo");
    const { repos } = await service();
    const outcomes = await Promise.all([
      repos.register("principal", { operationId: "a", path }),
      repos.register("principal", { operationId: "b", path: `${path}/` }),
      repos.register("principal", { operationId: "a", path }),
    ]);
    // The Git checks run concurrently; the transactions then serialize. Whichever request commits
    // first wins: if `a` wins, its second request returns the same receipt and `b` is refused; if
    // `b` wins, both `a` requests are refused. Never two registrations, never another error.
    const summary = outcomes.map((outcome) =>
      "error" in outcome
        ? outcome.error.kind
        : `${outcome.operation.operationId}:${outcome.operation.state}`,
    );
    expect([
      ["a:succeeded", "REPO_ALREADY_REGISTERED", "a:succeeded"],
      ["REPO_ALREADY_REGISTERED", "b:succeeded", "REPO_ALREADY_REGISTERED"],
    ]).toContainEqual(summary);
    // Both requests with operation ID `a` got the same answer: one receipt or the same refusal.
    expect(outcomes[2]).toEqual(outcomes[0]);
    expect(repos.list({ limit: 10 }).repos).toHaveLength(1);
  });

  it("answers a resend from its receipt without consulting Git", async () => {
    const root = await temporary();
    const path = await clone(root, "repo");
    const { repos } = await service();
    const first = await repos.register("principal", { operationId: "op", path });
    expect(first.operation.state).toBe("succeeded");
    // The clone is gone and git cannot even be started: the receipt alone answers.
    await rm(path, { recursive: true });
    process.env.PATH = await temporary();
    expect(await repos.register("principal", { operationId: "op", path })).toEqual(first);
    expect(
      (await repos.register("principal", { operationId: "op", path: `${path}/` })).error.kind,
    ).toBe("OPERATION_ID_CONFLICT");
    // A new request is checked: the missing path is refused before Git runs, and an existing
    // directory Git cannot answer for is refused as GIT_UNAVAILABLE, not as "not a repository".
    expect((await repos.register("principal", { operationId: "new", path })).error.kind).toBe(
      "NOT_A_GIT_REPOSITORY",
    );
    expect((await repos.register("principal", { operationId: "new", path: root })).error).toEqual(
      expect.objectContaining({ kind: "GIT_UNAVAILABLE", acceptance: "not-accepted" }),
    );
    expect(repos.list({ limit: 10 }).repos).toHaveLength(1);
  });
});
