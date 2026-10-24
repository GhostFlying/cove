import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { RepoService } from "../../dist/domain/repos.js";
import { WorkspaceService } from "../../dist/domain/workspaces.js";
import { networkEnvironment, resolveBase, runGitStep } from "../../dist/git/worktree.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { createRecoveryVerifiers } from "../../dist/operations/recovery-verifiers.js";
import { Store } from "../../dist/store/database.js";
import { StoreUnavailableError } from "../../dist/store/store-errors.js";
import { prepareHome } from "../../dist/store/home.js";
import { recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { ProcessLedger, processStartIdentity } from "../../dist/store/processes.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";

// Managed worktree creation (docs/milestones/m1.md T3b) below the CLI: the base resolution order,
// the recorded Git step, partial failure and retry, and what a restart proves about an operation
// frozen between its steps, with operation continue and abandon. Every repository is a temporary
// clone of a local bare remote; nothing touches the network. The service's own Git commands run
// with a temporary HOME and global configuration (see beforeEach), never the user's.
//
// Several tests put a `git` in front of the real one on PATH (hookGit): it does something at one
// exact command (creates a competing branch, hangs, swaps the entry) and then runs the real git,
// so a race that Cove must survive happens deterministically at that point.

const encode = (text) => new TextEncoder().encode(text);
const savedPath = process.env.PATH;
const ISOLATED = [
  "HOME",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "SSH_AUTH_SOCK",
  "SSH_ASKPASS",
  "GIT_DIR",
];
const savedEnv = Object.fromEntries(ISOLATED.map((name) => [name, process.env[name]]));
const testOperations = new URL("./store-test-operations.mjs", import.meta.url).href;
const directories = [];
const stores = [];
const children = [];
let isolatedHome;

async function temporary() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "cove-worktree-test-")));
  directories.push(path);
  return path;
}

beforeEach(async () => {
  isolatedHome = await temporary();
  await writeFile(join(isolatedHome, "gitconfig"), "");
  process.env.HOME = isolatedHome;
  process.env.XDG_CONFIG_HOME = join(isolatedHome, "xdg");
  process.env.GIT_CONFIG_GLOBAL = join(isolatedHome, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.SSH_AUTH_SOCK;
});

afterEach(async () => {
  process.env.PATH = savedPath;
  for (const [name, value] of Object.entries(savedEnv))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function git(cwd, ...args) {
  return new Promise((done, fail) =>
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          PATH: savedPath,
          HOME: cwd,
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

let realGit;
async function hookGit(body) {
  realGit ??= await new Promise((done, fail) =>
    execFile("/bin/sh", ["-c", "command -v git"], { env: { PATH: savedPath } }, (error, out) =>
      error ? fail(error) : done(out.trim()),
    ),
  );
  const bin = join(await temporary(), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh\nREAL='${realGit}'\n${body}\nexec "$REAL" "$@"\n`);
  await chmod(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
}

async function commit(path, file, text) {
  await writeFile(join(path, file), text);
  await git(path, "add", file);
  await git(path, "commit", "--quiet", "--no-gpg-sign", "-m", file);
  return git(path, "rev-parse", "HEAD");
}

// An upstream working repository, its bare remote and a clone of that remote (the registered
// clone). `branch` is the remote's default branch.
async function remoteClone(root, name, branch = "main") {
  const upstream = join(root, `${name}-upstream`);
  await mkdir(upstream);
  await git(upstream, "init", "--quiet", "--initial-branch", branch);
  await commit(upstream, "README.md", "test\n");
  await commit(upstream, ".gitignore", "ign/\n");
  const remote = join(root, `${name}.git`);
  await git(root, "clone", "--quiet", "--bare", upstream, remote);
  await git(upstream, "remote", "add", "origin", remote);
  const clone = join(root, name);
  await git(root, "clone", "--quiet", remote, clone);
  return { upstream, remote, clone };
}

// A server-less composition as in workspaces.test.mjs. `wrapStore` puts a facade in front of the
// store for the services; `restart()` stands for the next instance: fresh receipts that recover
// with the registered verifiers, and a fresh workspace service.
async function setup({ wrapStore, service = {} } = {}) {
  const root = await temporary();
  const layout = await prepareHome(join(root, "home"));
  const store = await Store.open({
    databasePath: layout.databasePath,
    backupDirectory: layout.backupDirectory,
    operationModules: [testOperations],
  });
  stores.push(store);
  const instance = async (relayInstanceId, number, on, extra = {}) => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const composition = new RuntimeComposition("server", relayInstanceId, { ...M0_LIMITS }, bytes);
    await recordInstanceStart(store, relayInstanceId, number);
    const receipts = new OperationReceipts(
      composition,
      encode,
      // Receipt timestamps are wall-clock milliseconds, not the instance ordinal: restart
      // starts retention, which would otherwise expire new receipts as if they ended in 1970.
      new SqliteReceiptBackend(on, relayInstanceId),
    );
    const tasks = new WorkspaceService({
      store: on,
      receipts,
      config: { workspaceRoot: async () => join(root, "workspaces") },
      serverId: "server",
      encodeUtf8: encode,
      ...service,
      ...extra,
    });
    return { receipts, tasks };
  };
  const first = await instance("instance", 1, wrapStore ? wrapStore(store) : store);
  const repos = new RepoService({
    store,
    serverId: "server",
    receipts: first.receipts,
    encodeUtf8: encode,
  });
  const register = async (name, branch) => {
    const paths = await remoteClone(root, name, branch);
    const outcome = await repos.register("p", { operationId: `reg-${name}`, path: paths.clone });
    return { ...paths, repoId: outcome.operation.result.resource.id };
  };
  let number = 1;
  const restart = async ({ wrap, service: extra } = {}) => {
    number++;
    const id = `instance${number}`;
    const next = await instance(id, number, wrap ? wrap(store) : store, extra);
    const recovered = await next.receipts.recoverInterrupted(
      createRecoveryVerifiers({ store, serverId: "server", relayInstanceId: id, now: Date.now }),
    );
    return { ...next, recovered };
  };
  const rows = (sqlText, params = []) => store.call("test.all", { sql: sqlText, params });
  return { root, store, ...first, repos, register, restart, rows };
}

const key = (operationId) => ({ serverId: "server", principalId: "p", operationId });
const never = new Promise(() => {});

// A store facade that freezes the first call matching `when`, as a crash there would: the call
// never runs and never returns, so nothing after it runs in this instance. `reached` settles
// once the instance is frozen; only then may a test change what that instance would act on, or
// start the next instance.
const freezeAt = (when) => {
  let reach;
  const reached = new Promise((done) => (reach = done));
  const wrap = (store) => ({
    call: async (name, args) => {
      if (when(name, args)) {
        reach();
        await never;
      }
      return store.call(name, args);
    },
  });
  wrap.reached = reached;
  return wrap;
};
const recording = (name, args, step, outcome) =>
  name === "worktrees.advance" && args.step?.step === step && args.step.outcome === outcome;
// Frozen just before the ledger records that `step` succeeded: the step ran, its record says
// started.
const beforeSuccessOf = (step) =>
  freezeAt((name, args) => recording(name, args, step, "succeeded"));
// Frozen just before `step` is recorded as started: everything before it is recorded complete.
const beforeStartOf = (step) => freezeAt((name, args) => recording(name, args, step, "started"));
const beforeSettle = () => freezeAt((name) => name === "worktrees.settle");

async function worktreeMount(tasks, taskId, mountName) {
  const { task } = await tasks.get(taskId);
  return task.workspace.mounts.find((mount) => mount.name === mountName);
}

async function until(check) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("condition not reached");
}

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

// A task with one worktree mount of a fresh `alpha`, created with --no-fetch.
async function frozenTask(wrapStore, mount = {}) {
  const env = await setup({ wrapStore });
  const alpha = await env.register("alpha");
  const outcome = await env.tasks.create("p", {
    operationId: "c",
    title: "Frozen",
    mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true, ...mount }],
  });
  const taskId = outcome.operation.result.resource.id;
  await wrapStore.reached;
  const { task } = await env.tasks.get(taskId);
  return {
    env,
    alpha,
    taskId,
    path: task.workspace.mounts[0].path,
    entry: task.workspace.entryPath,
  };
}

const frozenAt = (env, call) =>
  until(async () => {
    const [row] = await env.rows("SELECT steps_json FROM worktree_attempts");
    return row ? call(JSON.parse(row.steps_json)) : false;
  });

// The attempt's branch, as a full ref name.
async function ownBranch(clone) {
  return (await git(clone, "branch", "--list", "--format=%(refname)", "cove/*"))
    .split("\n")[0]
    .trim();
}

const credits = (steps, name) =>
  steps.some((step) => step.step === name && step.outcome === "succeeded");

async function idleRecord(tasks, receipts, operationId) {
  await tasks.worktrees.idle();
  return receipts.get(key(operationId));
}

describe("base resolution (D1)", () => {
  it("follows the setting, origin/HEAD, the remote's HEAD, then the candidates, never HEAD", async () => {
    const root = await temporary();
    const { upstream, clone } = await remoteClone(root, "alpha");
    const offline = { base: null, mainBranch: null, offline: true };
    const main = await git(clone, "rev-parse", "refs/remotes/origin/main");
    // origin/HEAD, set by the clone.
    expect(await resolveBase(clone, offline)).toMatchObject({ kind: "resolved", commit: main });
    // A main-branch setting wins and is not replaced when the remote lacks it.
    await git(upstream, "checkout", "--quiet", "-b", "release");
    const release = await commit(upstream, "release.txt", "r\n");
    await git(upstream, "push", "--quiet", "origin", "release");
    await git(clone, "fetch", "--quiet", "origin");
    expect(await resolveBase(clone, { ...offline, mainBranch: "release" })).toMatchObject({
      commit: release,
    });
    expect(await resolveBase(clone, { ...offline, mainBranch: "nope" })).toEqual({
      kind: "unresolved",
    });
    // An explicit base wins over everything; an unknown one is invalid.
    expect(await resolveBase(clone, { ...offline, base: "origin/release" })).toMatchObject({
      commit: release,
    });
    expect(await resolveBase(clone, { ...offline, base: "no-such-ref" })).toEqual({
      kind: "invalid-base",
    });
    // Without origin/HEAD, the remote's HEAD is asked (not with --no-fetch) ...
    await git(clone, "remote", "set-head", "origin", "--delete");
    expect(await resolveBase(clone, { ...offline, offline: false })).toMatchObject({
      commit: main,
    });
    // ... and with --no-fetch the candidates are tried in order.
    expect(await resolveBase(clone, offline)).toMatchObject({ commit: main });
    // No candidate: unresolved, even though the clone has a local HEAD.
    await git(clone, "update-ref", "-d", "refs/remotes/origin/main");
    await git(clone, "update-ref", "-d", "refs/remotes/origin/release");
    expect(await git(clone, "rev-parse", "HEAD")).toBe(main);
    expect(await resolveBase(clone, offline)).toEqual({ kind: "unresolved" });
  });

  it("uses a trunk-only remote's tracking branch", async () => {
    const root = await temporary();
    const { clone } = await remoteClone(root, "alpha", "trunk");
    await git(clone, "remote", "set-head", "origin", "--delete");
    const trunk = await git(clone, "rev-parse", "refs/remotes/origin/trunk");
    expect(await resolveBase(clone, { base: null, mainBranch: null, offline: true })).toMatchObject(
      { ref: "refs/remotes/origin/trunk", commit: trunk },
    );
  });
});

describe("recorded Git steps", () => {
  it("never starts git when the process could not be recorded", async () => {
    const root = await temporary();
    const { clone } = await remoteClone(root, "alpha");
    const main = await git(clone, "rev-parse", "HEAD");
    const result = await runGitStep(["update-ref", "refs/heads/unrecorded", main, ""], {
      cwd: clone,
      timeoutMs: 10_000,
      record: async () => {
        throw new Error("the store is gone");
      },
    });
    expect(result).toEqual({ kind: "not-started" });
    await expect(git(clone, "rev-parse", "--verify", "refs/heads/unrecorded")).rejects.toThrow(
      /rev-parse/,
    );
  });

  it("records the group leader before git runs and reports an exit", async () => {
    const root = await temporary();
    const { clone } = await remoteClone(root, "alpha");
    const main = await git(clone, "rev-parse", "HEAD");
    const recorded = [];
    let ended = 0;
    const result = await runGitStep(["update-ref", "refs/heads/recorded", main, ""], {
      cwd: clone,
      timeoutMs: 10_000,
      record: async (process) => {
        // Recorded while the shell still waits: git has not run yet.
        await expect(git(clone, "rev-parse", "--verify", "refs/heads/recorded")).rejects.toThrow(
          /rev-parse/,
        );
        recorded.push(process);
      },
      ended: async () => void ended++,
    });
    expect(result).toMatchObject({ kind: "exited", code: 0 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].pgid).toBe(recorded[0].pid);
    expect(ended).toBe(1);
    expect(await git(clone, "rev-parse", "refs/heads/recorded")).toBe(main);
  });

  it("stops a step that outlives its time with its whole group", { timeout: 20_000 }, async () => {
    const root = await temporary();
    const bin = join(root, "bin");
    await mkdir(bin);
    // A git that never answers, ignores SIGTERM (as its child does, by inheritance) and leaves a
    // child in its group: only the group's SIGKILL ends them, so the outcome does not depend on
    // how a shell finishes a `wait` interrupted by SIGTERM (it may exit 0). On macOS a group
    // signal sent by a member sometimes misses the group leader (git/worktree.ts SUPERVISOR);
    // the leader then exits 0 once its child is killed, which this test catches when it happens.
    // It reports a supported version, since the server runs no Git older than 2.45.
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nfor last; do :; done\n[ "$last" = version ] && { echo "git version 2.45.0"; exit 0; }\n` +
        `[ "$last" = --exec-path ] && { dirname "$0"; exit 0; }\n` +
        `trap "" TERM\necho $$ > "${join(root, "git.pid")}"\n` +
        `/bin/sleep 60 &\necho $! > "${join(root, "child.pid")}"\nwait\nwait\n`,
    );
    await chmod(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    const result = await runGitStep(["status"], {
      cwd: root,
      // Long enough for the fake git to start under load; the kill is what is under test.
      timeoutMs: 5_000,
      killGraceMs: 500,
      record: async () => {},
    });
    // Killed by a signal: what it did is unknown, and only an observation tells.
    expect(result).toEqual({ kind: "uncertain" });
    const gone = async (file) => {
      let pid;
      try {
        pid = Number(await readFile(join(root, file), "utf8"));
      } catch (error) {
        // Ended before it got to write its PID (the group was signalled first): nothing of it
        // is left to check.
        if (error.code === "ENOENT") return "ESRCH";
        throw error;
      }
      // An orphaned child is reaped by init shortly after the kill.
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          return error.code;
        }
        await new Promise((done) => setTimeout(done, 50));
      }
      return "alive";
    };
    expect(await gone("git.pid")).toBe("ESRCH");
    expect(await gone("child.pid")).toBe("ESRCH");
  });

  it("gives a fetch the SSH agent but nothing that prompts or redirects Git", () => {
    const env = networkEnvironment({
      PATH: "/bin",
      HOME: "/home/x",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      SSH_ASKPASS: "/usr/bin/askpass",
      GIT_ASKPASS: "/usr/bin/askpass",
      DISPLAY: ":0",
      GIT_DIR: "/elsewhere",
      GIT_WORK_TREE: "/elsewhere",
    });
    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: "/home/x",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
    });
    for (const name of ["SSH_ASKPASS", "DISPLAY", "GIT_DIR", "GIT_WORK_TREE"])
      expect(env).not.toHaveProperty(name);
  });
});

describe("worktree creation", () => {
  it("creates worktrees of several repos from freshly fetched remote main branches", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const beta = await env.register("beta", "master");
    // New remote commits the clones have not fetched yet.
    const alphaHead = await commit(alpha.upstream, "new.txt", "a\n");
    await git(alpha.upstream, "push", "--quiet", "origin", "main");
    const betaHead = await commit(beta.upstream, "new.txt", "b\n");
    await git(beta.upstream, "push", "--quiet", "origin", "master");
    const sourceHead = await git(alpha.clone, "rev-parse", "HEAD");
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Two repos",
      mounts: [
        { source: "worktree", repoId: alpha.repoId },
        { source: "worktree", repoId: beta.repoId, branch: "feature/beta" },
      ],
    });
    expect(outcome.operation.state).toBe("running");
    const taskId = outcome.operation.result.resource.id;
    const settled = await idleRecord(env.tasks, env.receipts, "c");
    expect(settled).toMatchObject({ state: "succeeded" });
    expect(settled.result.mounts.map((mount) => mount.state)).toEqual(["ready", "ready"]);
    const { task } = await env.tasks.get(taskId);
    const [a, b] = task.workspace.mounts;
    expect(await git(a.path, "rev-parse", "HEAD")).toBe(alphaHead);
    expect(await git(a.path, "symbolic-ref", "--short", "HEAD")).toBe(`cove/${task.slug}`);
    expect(await git(b.path, "rev-parse", "HEAD")).toBe(betaHead);
    expect(await git(b.path, "symbolic-ref", "--short", "HEAD")).toBe("feature/beta");
    expect(await git(a.path, "status", "--porcelain")).toBe("");
    // The source clone's checkout is untouched.
    expect(await git(alpha.clone, "rev-parse", "HEAD")).toBe(sourceHead);
    expect(await git(alpha.clone, "status", "--porcelain")).toBe("");
    // Every mount state change advanced the workspace revision.
    expect(task.workspace.revision).toBe(settled.result.workspaceRevision);
    expect(await env.rows("SELECT state FROM managed_worktrees ORDER BY path")).toEqual([
      { state: "ready" },
      { state: "ready" },
    ]);
    const [ledger] = await env.rows(
      "SELECT steps_json, phase, outcome FROM worktree_attempts ORDER BY position LIMIT 1",
    );
    expect(ledger).toMatchObject({ phase: "intent", outcome: "ready" });
    // Each attempt's ledger: every effect seen to succeed, in order.
    expect(JSON.parse(ledger.steps_json)).toEqual(
      ["fetch", "branch", "worktree", "checkout"].map((step) => ({
        step,
        outcome: "succeeded",
      })),
    );
    // The branch's creation names the attempt in its reflog.
    expect(
      await git(alpha.clone, "reflog", "show", "--format=%gs", `refs/heads/cove/${task.slug}`),
    ).toMatch(/^cove: create worktree branch [0-9a-f-]+$/);
    // No process of the operation is left open.
    expect(
      await env.rows("SELECT COUNT(*) AS open FROM operation_processes WHERE ended_at_ms IS NULL"),
    ).toEqual([{ open: 0 }]);
  });

  it("fails one mount, keeps the other and retries it once the cause is gone (S4)", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const beta = await env.register("beta");
    // The branch exists already in beta.
    await git(beta.clone, "branch", "taken");
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Partial",
      mounts: [
        { source: "worktree", repoId: alpha.repoId, branch: "taken" },
        { source: "worktree", repoId: beta.repoId, branch: "taken" },
      ],
    });
    const taskId = outcome.operation.result.resource.id;
    const settled = await idleRecord(env.tasks, env.receipts, "c");
    expect(settled).toMatchObject({ state: "failed", error: { kind: "BRANCH_EXISTS" } });
    expect(settled.result.mounts).toEqual([
      { mountId: expect.any(String), state: "ready" },
      { mountId: expect.any(String), state: "failed", errorKind: "BRANCH_EXISTS" },
    ]);
    // The same request answers with the record and creates nothing more.
    const again = await env.tasks.create("p", {
      operationId: "c",
      title: "Partial",
      mounts: [
        { source: "worktree", repoId: alpha.repoId, branch: "taken" },
        { source: "worktree", repoId: beta.repoId, branch: "taken" },
      ],
    });
    expect(again.operation).toEqual(settled);
    const failedMount = await worktreeMount(env.tasks, taskId, "beta");
    expect(failedMount.state).toBe("failed");
    await expect(stat(failedMount.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await worktreeMount(env.tasks, taskId, "alpha")).state).toBe("ready");
    // A retry of a ready mount is refused; the failed one retries with a new branch.
    const ready = await worktreeMount(env.tasks, taskId, "alpha");
    expect(
      (await env.tasks.worktrees.retry("p", { operationId: "r0", taskId, mountId: ready.mountId }))
        .error,
    ).toBeDefined();
    const retried = await env.tasks.worktrees.retry("p", {
      operationId: "r",
      taskId,
      mountId: failedMount.mountId,
      branch: "taken-2",
    });
    expect(retried.operation.state).toBe("running");
    expect(await idleRecord(env.tasks, env.receipts, "r")).toMatchObject({ state: "succeeded" });
    const fixed = await worktreeMount(env.tasks, taskId, "beta");
    expect(fixed.state).toBe("ready");
    expect(await git(fixed.path, "symbolic-ref", "--short", "HEAD")).toBe("taken-2");
    // The first attempt's outcome stays as it was recorded.
    expect(await env.receipts.get(key("c"))).toEqual(settled);
  });

  it("fails without creating anything when the fetch fails, and retries with --no-fetch", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    await rm(alpha.remote, { recursive: true, force: true });
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Offline",
      mounts: [{ source: "worktree", repoId: alpha.repoId }],
    });
    const taskId = outcome.operation.result.resource.id;
    expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({
      state: "failed",
      error: { kind: "FETCH_FAILED" },
    });
    const mount = await worktreeMount(env.tasks, taskId, "alpha");
    await expect(stat(mount.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await env.rows("SELECT COUNT(*) AS n FROM managed_worktrees")).toEqual([{ n: 0 }]);
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).toBe("");
    await env.tasks.worktrees.retry("p", {
      operationId: "r",
      taskId,
      mountId: mount.mountId,
      noFetch: true,
    });
    expect(await idleRecord(env.tasks, env.receipts, "r")).toMatchObject({ state: "succeeded" });
  });

  it("fails with MAIN_BRANCH_UNRESOLVED instead of guessing a base", async () => {
    const env = await setup();
    const alpha = await env.register("alpha", "work");
    await git(alpha.clone, "remote", "set-head", "origin", "--delete");
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "No main",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({
      state: "failed",
      error: { kind: "MAIN_BRANCH_UNRESOLVED" },
    });
    // An explicit base resolves it.
    const taskId = outcome.operation.result.resource.id;
    const mount = await worktreeMount(env.tasks, taskId, "alpha");
    await env.tasks.worktrees.retry("p", {
      operationId: "r",
      taskId,
      mountId: mount.mountId,
      base: "origin/work",
      noFetch: true,
    });
    expect(await idleRecord(env.tasks, env.receipts, "r")).toMatchObject({ state: "succeeded" });
  });

  it("never takes over a branch someone else created just before Cove's update-ref", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    // Between Cove's check that the branch is free and its create-only update-ref, another
    // process creates the branch at the very base Cove would use.
    await hookGit(
      `case "$*" in *"cove: create worktree branch"*)
  ref=; base=; take=
  for arg in "$@"; do
    if [ -n "$take" ]; then base=$arg; break; fi
    case "$arg" in refs/heads/*) ref=$arg; take=1 ;; esac
  done
  "$REAL" update-ref "$ref" "$base" ;;
esac`,
    );
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Raced",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    const taskId = outcome.operation.result.resource.id;
    // Cove's own command failed: the matching branch is not Cove's, so nothing goes on from it.
    expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({
      state: "failed",
      error: { kind: "BRANCH_EXISTS" },
    });
    const mount = await worktreeMount(env.tasks, taskId, "alpha");
    expect(mount.state).toBe("failed");
    expect(await exists(mount.path)).toBe(false);
    // The other process's branch is still there, and nothing was recorded as Cove's.
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).not.toBe("");
    expect(await env.rows("SELECT state FROM managed_worktrees")).toEqual([{ state: "abandoned" }]);
  });

  it("refuses a request that would drive more worktree operations than allowed (BUSY)", async () => {
    const env = await setup({
      wrapStore: freezeAt((name) => name === "worktrees.advance"),
      service: { worktrees: { actors: 1, queue: 0 } },
    });
    const alpha = await env.register("alpha");
    const first = await env.tasks.create("p", {
      operationId: "c1",
      title: "First",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    expect(first.operation.state).toBe("running");
    // The first operation's actor holds the only seat: a second is refused before acceptance.
    const second = await env.tasks.create("p", {
      operationId: "c2",
      title: "Second",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    expect(second.error).toMatchObject({ kind: "BUSY", acceptance: "not-accepted" });
    expect(await env.receipts.get(key("c2"))).toBeNull();
    const taskId = first.operation.result.resource.id;
    const added = await env.tasks.addMount("p", {
      operationId: "m",
      taskId,
      mount: { source: "worktree", repoId: alpha.repoId, name: "again", noFetch: true },
    });
    expect(added.error).toMatchObject({ kind: "BUSY" });
  });

  it("runs the preparation's Git work in the shared Git slots", { timeout: 30_000 }, async () => {
    const env = await setup({ service: { gitConcurrency: 1, writeStepBudgetMs: 1_000 } });
    const alpha = await env.register("alpha");
    const beta = await env.register("beta");
    const go = join(env.root, "go");
    // The fetch waits until the test lets it go, holding its slot meanwhile.
    await hookGit(
      `case "$*" in *" fetch "*) while [ ! -f '${go}' ]; do /bin/sleep 0.05; done ;; esac`,
    );
    await env.tasks.create("p", {
      operationId: "c",
      title: "Fetching",
      mounts: [{ source: "worktree", repoId: alpha.repoId }],
    });
    await until(async () =>
      (await env.rows("SELECT steps_json FROM worktree_attempts"))[0]?.steps_json.includes("fetch"),
    );
    // A checkout admission needs a Git slot too, and the only one is the fetch's.
    const refused = await env.tasks.create("p", {
      operationId: "k",
      title: "Checkout",
      mounts: [{ source: "checkout", repoId: beta.repoId }],
    });
    expect(refused.error).toMatchObject({ kind: "BUSY" });
    await writeFile(go, "");
    expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({ state: "succeeded" });
  });

  it(
    "checks a new worktree's branch name in the shared Git slots (BUSY when none is free)",
    {
      timeout: 30_000,
    },
    async () => {
      const env = await setup({ service: { gitConcurrency: 1, writeStepBudgetMs: 1_000 } });
      const alpha = await env.register("alpha");
      const go = join(env.root, "go");
      const checks = join(env.root, "checks");
      await hookGit(
        `case "$*" in
  *" fetch "*) while [ ! -f '${go}' ]; do /bin/sleep 0.05; done ;;
  *check-ref-format*) echo check >> '${checks}' ;;
esac`,
      );
      const first = await env.tasks.create("p", {
        operationId: "c",
        title: "Fetching",
        mounts: [{ source: "worktree", repoId: alpha.repoId }],
      });
      await until(async () =>
        (await env.rows("SELECT steps_json FROM worktree_attempts"))[0]?.steps_json.includes(
          "fetch",
        ),
      );
      await rm(checks, { force: true });
      // The fetch holds the only slot: the branch check of another request gets none in time, and
      // no Git runs for it.
      const refused = await env.tasks.create("p", {
        operationId: "c2",
        title: "Second",
        mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
      });
      expect(refused.error).toMatchObject({ kind: "BUSY", acceptance: "not-accepted" });
      const added = await env.tasks.addMount("p", {
        operationId: "m",
        taskId: first.operation.result.resource.id,
        mount: { source: "worktree", repoId: alpha.repoId, name: "again", noFetch: true },
      });
      expect(added.error).toMatchObject({ kind: "BUSY" });
      expect(await exists(checks)).toBe(false);
      await writeFile(go, "");
      expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({ state: "succeeded" });
    },
  );

  it("checks the entry again once a step holds its Git slot", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const target = join(env.root, "target");
    const elsewhere = join(env.root, "elsewhere");
    const once = join(env.root, "swapped");
    await mkdir(elsewhere);
    // The entry is replaced by Git work that runs after Cove's earlier entry checks and before
    // the worktree add gets its slot.
    await hookGit(
      `case "$*" in *" worktree list"*)
  if [ ! -f '${once}' ]; then
    : > '${once}'
    while [ ! -f '${target}' ]; do /bin/sleep 0.05; done
    entry=$(cat '${target}'); mv "$entry" "$entry.moved"; ln -s '${elsewhere}' "$entry"
  fi ;;
esac`,
    );
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Swapped",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    const { task } = await env.tasks.get(outcome.operation.result.resource.id);
    await writeFile(target, task.workspace.entryPath);
    expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({
      state: "requires_attention",
    });
    // Nothing was created through the replacement.
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("fetches with the operator's SSH agent and an isolated home", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const seen = join(env.root, "fetch-env");
    process.env.SSH_AUTH_SOCK = join(env.root, "agent.sock");
    process.env.SSH_ASKPASS = "/usr/bin/false";
    process.env.GIT_DIR = "/nonexistent";
    await hookGit(
      `case "$*" in *" fetch "*) echo "$SSH_AUTH_SOCK|\${SSH_ASKPASS-unset}|\${GIT_DIR-unset}|` +
        `$GIT_TERMINAL_PROMPT|$SSH_ASKPASS_REQUIRE|$HOME|$GIT_CONFIG_GLOBAL" > '${seen}' ;; esac`,
    );
    await env.tasks.create("p", {
      operationId: "c",
      title: "Agent",
      mounts: [{ source: "worktree", repoId: alpha.repoId }],
    });
    expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({ state: "succeeded" });
    expect((await readFile(seen, "utf8")).trim()).toBe(
      [
        join(env.root, "agent.sock"),
        "unset",
        "unset",
        "0",
        "never",
        isolatedHome,
        join(isolatedHome, "gitconfig"),
      ].join("|"),
    );
  });

  it("stops when the workspace entry is replaced during the fetch", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const go = join(env.root, "go");
    const target = join(env.root, "target");
    const elsewhere = join(env.root, "elsewhere");
    await mkdir(elsewhere);
    await hookGit(
      `case "$*" in *" fetch "*)
  while [ ! -f '${go}' ]; do /bin/sleep 0.05; done
  entry=$(cat '${target}'); mv "$entry" "$entry.moved"; ln -s '${elsewhere}' "$entry" ;;
esac`,
    );
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Swapped",
      mounts: [{ source: "worktree", repoId: alpha.repoId }],
    });
    const { task } = await env.tasks.get(outcome.operation.result.resource.id);
    await writeFile(target, task.workspace.entryPath);
    await writeFile(go, "");
    expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({
      state: "requires_attention",
      progress: { completedSteps: ["fetch"] },
    });
    // Nothing was created through the replacement.
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).toBe("");
    expect(await env.rows("SELECT COUNT(*) AS n FROM managed_worktrees")).toEqual([{ n: 0 }]);
  });

  it("reports a fetch whose end was not seen as requires_attention, not FETCH_FAILED", async () => {
    const env = await setup({
      service: { worktrees: { timeouts: { fetchMs: 1_000, killGraceMs: 200 } } },
    });
    const alpha = await env.register("alpha");
    await hookGit(`case "$*" in *" fetch "*) trap "" TERM; /bin/sleep 30 ;; esac`);
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Hung fetch",
      mounts: [{ source: "worktree", repoId: alpha.repoId }],
    });
    const record = await idleRecord(env.tasks, env.receipts, "c");
    expect(record).toMatchObject({ state: "requires_attention" });
    expect(record.progress.remainingEffects).toContain("fetch");
    expect(record.result.mounts).toEqual([{ mountId: expect.any(String), state: "pending" }]);
    // Once the remote answers, an explicit continue runs it again.
    process.env.PATH = savedPath;
    await env.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({ state: "succeeded" });
    const mount = await worktreeMount(env.tasks, outcome.operation.result.resource.id, "alpha");
    expect(mount.state).toBe("ready");
  });

  it("does not accept a checkout whose end was not seen, however clean it looks", async () => {
    const env = await setup({
      service: { worktrees: { timeouts: { stepMs: 1_500, killGraceMs: 200 } } },
    });
    const alpha = await env.register("alpha");
    // The checkout completes, then its process hangs on past its deadline.
    await hookGit(
      `case "$*" in *" read-tree "*) "$REAL" "$@"; trap "" TERM; /bin/sleep 30; exit 0 ;; esac`,
    );
    await env.tasks.create("p", {
      operationId: "c",
      title: "Hung checkout",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    const record = await idleRecord(env.tasks, env.receipts, "c");
    expect(record).toMatchObject({ state: "requires_attention" });
    expect(record.progress.completedSteps).not.toContain("checkout");
    // Its process is gone now; a continue verifies the checkout from the state and finishes.
    process.env.PATH = savedPath;
    await env.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({ state: "succeeded" });
    const [ledger] = await env.rows("SELECT steps_json FROM worktree_attempts");
    expect(JSON.parse(ledger.steps_json).at(-1)).toEqual({ step: "checkout", outcome: "verified" });
  });

  it("keeps a settled mount and its retry for the operation until the operation ends", async () => {
    let first;
    // The second attempt never gets past its first record.
    const atSecond = freezeAt(
      (name, args) => name === "worktrees.advance" && (first ??= args.attemptId) !== args.attemptId,
    );
    const env = await setup({ wrapStore: atSecond });
    const alpha = await env.register("alpha");
    const beta = await env.register("beta");
    await git(alpha.clone, "branch", "taken");
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Atomic",
      mounts: [
        { source: "worktree", repoId: alpha.repoId, branch: "taken", noFetch: true },
        { source: "worktree", repoId: beta.repoId, noFetch: true },
      ],
    });
    const taskId = outcome.operation.result.resource.id;
    await atSecond.reached;
    expect((await worktreeMount(env.tasks, taskId, "alpha")).state).toBe("failed");
    expect((await env.receipts.get(key("c"))).state).toBe("running");
    const failedMount = await worktreeMount(env.tasks, taskId, "alpha");
    // The operation that recorded the failure has not ended: its mount is neither removed nor
    // retried, so the outcome it will record cannot be lost.
    const removed = await env.tasks.removeMount("p", {
      operationId: "rm",
      taskId,
      mountId: failedMount.mountId,
    });
    expect(removed.error).toMatchObject({ kind: "OPERATION_EFFECTS_ACTIVE" });
    const retried = await env.tasks.worktrees.retry("p", {
      operationId: "r",
      taskId,
      mountId: failedMount.mountId,
    });
    expect(retried.error).toMatchObject({ kind: "OPERATION_EFFECTS_ACTIVE" });
    // After a restart the outcome is still the one recorded.
    const next = await env.restart();
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "requires_attention",
      result: {
        mounts: [
          { mountId: failedMount.mountId, state: "failed", errorKind: "BRANCH_EXISTS" },
          { mountId: expect.any(String), state: "pending" },
        ],
      },
    });
  });

  it("refuses a retry while a process of the previous attempt may still run", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    await rm(alpha.remote, { recursive: true, force: true });
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Offline",
      mounts: [{ source: "worktree", repoId: alpha.repoId }],
    });
    const taskId = outcome.operation.result.resource.id;
    expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({ state: "failed" });
    const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    children.push(child);
    await new ProcessLedger(env.store, "instance", Date.now).record(key("c"), {
      pid: child.pid,
      pgid: child.pid,
      startIdentity: await processStartIdentity(child.pid),
    });
    const mount = await worktreeMount(env.tasks, taskId, "alpha");
    const refused = await env.tasks.worktrees.retry("p", {
      operationId: "r",
      taskId,
      mountId: mount.mountId,
      noFetch: true,
    });
    expect(refused.error).toMatchObject({
      kind: "OPERATION_EFFECTS_ACTIVE",
      acceptance: "not-accepted",
    });
    child.kill("SIGKILL");
    await new Promise((done) => child.once("exit", done));
    await env.tasks.worktrees.retry("p", {
      operationId: "r",
      taskId,
      mountId: mount.mountId,
      noFetch: true,
    });
    expect(await idleRecord(env.tasks, env.receipts, "r")).toMatchObject({ state: "succeeded" });
  });
});

describe("restart, continue and abandon (S8)", () => {
  it("verifies a branch whose step was not seen to end by its shape, then continues", async () => {
    const { env, alpha, taskId } = await frozenTask(beforeSuccessOf("branch"));
    await until(async () =>
      (await git(alpha.clone, "branch", "--list", "cove/*").catch(() => "")).includes("cove/"),
    );
    expect((await env.receipts.get(key("c"))).state).toBe("running");
    const next = await env.restart();
    const record = await next.receipts.get(key("c"));
    // Never succeeded by itself; the branch step is recorded started, so it is not counted yet.
    expect(record).toMatchObject({
      state: "requires_attention",
      progress: {
        completedSteps: ["base", "intent"],
        remainingEffects: ["branch", "worktree", "checkout", "record"],
        recoveryActions: ["continue", "abandon"],
      },
    });
    expect(next.recovered.map((recovered) => recovered.operationId)).toContain("c");
    // Continue is its own write; the target goes on from its ledger.
    const continued = await next.tasks.worktrees.continueOperation("p", {
      operationId: "k",
      targetOperationId: "c",
    });
    expect(continued.operation).toMatchObject({
      state: "succeeded",
      result: { targetOperationId: "c" },
    });
    expect(await idleRecord(next.tasks, next.receipts, "c")).toMatchObject({ state: "succeeded" });
    const mount = await worktreeMount(next.tasks, taskId, "alpha");
    expect(mount.state).toBe("ready");
    expect(await readFile(join(mount.path, "README.md"), "utf8")).toBe("test\n");
    // One branch, one worktree: nothing was repeated.
    expect((await git(alpha.clone, "branch", "--list", "cove/*")).split("\n")).toHaveLength(1);
    expect(
      (await git(alpha.clone, "worktree", "list", "--porcelain")).match(/^worktree /gm),
    ).toHaveLength(2);
    const [ledger] = await env.rows("SELECT steps_json FROM worktree_attempts");
    expect(JSON.parse(ledger.steps_json)[0]).toEqual({ step: "branch", outcome: "verified" });
    // A retention pass must keep the newly completed continue. Explicitly finish a pass here
    // so the initial restart pass's scheduling cannot hide a mismatched fixture clock.
    await next.receipts.purgeExpired();
    const repeated = await next.tasks.worktrees.continueOperation("p", {
      operationId: "k",
      targetOperationId: "c",
    });
    // The same continue answers with its whole record; a new one is refused (nothing to continue).
    expect(repeated).toEqual({ operation: continued.operation });
    expect(
      (
        await next.tasks.worktrees.continueOperation("p", {
          operationId: "k2",
          targetOperationId: "c",
        })
      ).error.kind,
    ).toBe("OPERATION_NOT_RESUMABLE");
  });

  it("does not credit a branch whose step was not seen to end once it has moved", async () => {
    const { env, alpha } = await frozenTask(beforeSuccessOf("branch"));
    await until(async () =>
      (await git(alpha.clone, "branch", "--list", "cove/*").catch(() => "")).includes("cove/"),
    );
    // Someone commits on the branch before the restart: it is no longer what the step made.
    const branch = await ownBranch(alpha.clone);
    const base = await git(alpha.clone, "rev-parse", branch);
    const moved = await git(alpha.clone, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "mine");
    await git(alpha.clone, "update-ref", branch, moved, base);
    const next = await env.restart();
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    const record = await idleRecord(next.tasks, next.receipts, "c");
    expect(record).toMatchObject({ state: "requires_attention" });
    // The step is not credited: the moved branch is not the attempt's to use or to delete.
    expect(record.progress.completedSteps).not.toContain("branch");
    expect(
      (await git(alpha.clone, "worktree", "list", "--porcelain")).match(/^worktree /gm),
    ).toHaveLength(1);
    expect(await git(alpha.clone, "rev-parse", branch)).toBe(moved);
  });

  it("never reports success before every attempt is recorded ready", async () => {
    // Every step recorded complete, the attempt itself not yet settled.
    const { env, taskId } = await frozenTask(beforeSettle());
    await frozenAt(env, (steps) =>
      steps.some((step) => step.step === "checkout" && step.outcome === "succeeded"),
    );
    const next = await env.restart();
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "requires_attention",
      progress: {
        completedSteps: ["base", "intent", "branch", "worktree", "checkout"],
        remainingEffects: ["record"],
      },
      result: { mounts: [{ state: "pending" }] },
    });
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "c")).toMatchObject({ state: "succeeded" });
    expect((await worktreeMount(next.tasks, taskId, "alpha")).state).toBe("ready");
  });

  it("proves a running operation whose attempts were all recorded ready", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    await env.tasks.create("p", {
      operationId: "c",
      title: "Done",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    const done = await idleRecord(env.tasks, env.receipts, "c");
    // A receipt left running although its attempts all ended (as before atomic settlement).
    const running = { ...done, state: "running" };
    await env.store.call("test.run", {
      sql: "UPDATE operations SET state = 'running', record_json = ? WHERE operation_id = 'c'",
      params: [JSON.stringify(running)],
    });
    const next = await env.restart();
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "succeeded",
      result: { mounts: [{ state: "ready" }] },
    });
  });

  it("refuses continue and abandon while a recorded process may still run", async () => {
    const { env, alpha } = await frozenTask(beforeSuccessOf("branch"));
    await until(async () =>
      (await git(alpha.clone, "branch", "--list", "cove/*").catch(() => "")).includes("cove/"),
    );
    const next = await env.restart();
    // A process recorded under the operation that is still alive.
    const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    children.push(child);
    const ledger = new ProcessLedger(env.store, "instance2", Date.now);
    await ledger.record(key("c"), {
      pid: child.pid,
      pgid: child.pid,
      startIdentity: await processStartIdentity(child.pid),
    });
    for (const write of ["continueOperation", "abandonOperation"]) {
      const refused = await next.tasks.worktrees[write]("p", {
        operationId: `x-${write}`,
        targetOperationId: "c",
      });
      expect(refused.error).toMatchObject({
        kind: "OPERATION_EFFECTS_ACTIVE",
        acceptance: "not-accepted",
      });
    }
    expect((await next.receipts.get(key("c"))).state).toBe("requires_attention");
    child.kill("SIGKILL");
    await new Promise((done) => child.once("exit", done));
    await next.tasks.worktrees.abandonOperation("p", { operationId: "a", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "a")).toMatchObject({ state: "succeeded" });
    expect(await next.receipts.get(key("c"))).toMatchObject({ state: "cancelled" });
  });

  it("abandons a worktree frozen before its checkout, removing exactly what it created", async () => {
    const { env, alpha, taskId } = await frozenTask(beforeStartOf("checkout"));
    await until(async () =>
      (await git(alpha.clone, "worktree", "list", "--porcelain")).includes("cove/"),
    );
    const next = await env.restart();
    expect((await next.receipts.get(key("c"))).state).toBe("requires_attention");
    const abandoned = await next.tasks.worktrees.abandonOperation("p", {
      operationId: "a",
      targetOperationId: "c",
    });
    expect(abandoned.operation).toMatchObject({ state: "running" });
    expect(await idleRecord(next.tasks, next.receipts, "a")).toMatchObject({ state: "succeeded" });
    const cancelled = await next.receipts.get(key("c"));
    expect(cancelled).toMatchObject({
      state: "cancelled",
      progress: { completedSteps: ["branch", "worktree"], remainingEffects: [] },
    });
    expect(cancelled.result.mounts[0]).not.toHaveProperty("left");
    const mount = await worktreeMount(next.tasks, taskId, "alpha");
    expect(mount).toMatchObject({ state: "failed" });
    await expect(stat(mount.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).toBe("");
    expect(
      (await git(alpha.clone, "worktree", "list", "--porcelain")).match(/^worktree /gm),
    ).toHaveLength(1);
    expect(await env.rows("SELECT state FROM managed_worktrees")).toEqual([{ state: "abandoned" }]);
    // A retry starts a new attempt at the same path.
    await next.tasks.worktrees.retry("p", { operationId: "r", taskId, mountId: mount.mountId });
    expect(await idleRecord(next.tasks, next.receipts, "r")).toMatchObject({ state: "succeeded" });
  });

  it("abandons a worktree never checked out whose links are relative (#126 item 8)", async () => {
    const frozen = beforeStartOf("checkout");
    const env = await setup({ wrapStore: frozen });
    const alpha = await env.register("alpha");
    await git(alpha.clone, "config", "worktree.useRelativePaths", "true");
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Relative",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    await frozen.reached;
    const path = (await worktreeMount(env.tasks, outcome.operation.result.resource.id, "alpha"))
      .path;
    expect(await readFile(join(path, ".git"), "utf8")).toMatch(/^gitdir: \.\.\//);
    const next = await env.restart();
    await next.tasks.worktrees.abandonOperation("p", { operationId: "a", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "a")).toMatchObject({ state: "succeeded" });
    // Proven to hold nothing but its own `.git` file, it is removed with its branch.
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "cancelled",
      progress: { remainingEffects: [] },
    });
    expect(await exists(path)).toBe(false);
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).toBe("");
  });

  it("accepts an abandon before removing anything and resumes it after a restart", async () => {
    const { env, alpha, path } = await frozenTask(beforeStartOf("checkout"));
    await until(async () =>
      (await git(alpha.clone, "worktree", "list", "--porcelain")).includes("cove/"),
    );
    // This instance stops at the abandon's first removal.
    const atRemoval = freezeAt((name, args) => recording(name, args, "remove-worktree", "started"));
    const next = await env.restart({ wrap: atRemoval });
    const abandoned = await next.tasks.worktrees.abandonOperation("p", {
      operationId: "a",
      targetOperationId: "c",
    });
    expect(abandoned.operation).toMatchObject({ state: "running" });
    await atRemoval.reached;
    // Accepted durably, the target's attempt claimed, and nothing removed yet.
    expect(await env.rows("SELECT abandon_operation_id FROM worktree_attempts")).toEqual([
      { abandon_operation_id: "a" },
    ]);
    expect(await exists(path)).toBe(true);
    // While the abandon holds the target, neither a continue nor a second abandon acts on it.
    for (const write of ["continueOperation", "abandonOperation"])
      expect(
        (
          await next.tasks.worktrees[write]("p", {
            operationId: `x-${write}`,
            targetOperationId: "c",
          })
        ).error,
      ).toMatchObject({ acceptance: "not-accepted" });
    const third = await env.restart();
    expect(await third.receipts.get(key("a"))).toMatchObject({
      state: "requires_attention",
      progress: { recoveryActions: ["continue"] },
    });
    expect((await third.receipts.get(key("c"))).state).toBe("requires_attention");
    await third.tasks.worktrees.continueOperation("p", {
      operationId: "k",
      targetOperationId: "a",
    });
    expect(await idleRecord(third.tasks, third.receipts, "a")).toMatchObject({
      state: "succeeded",
    });
    expect(await third.receipts.get(key("c"))).toMatchObject({
      state: "cancelled",
      progress: { remainingEffects: [] },
    });
    expect(await exists(path)).toBe(false);
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).toBe("");
  });

  // A retry interrupted while it removes what the failed creation `c` left (a worktree holding
  // someone's README.md, and its branch): its actor freezes at the leftover's ledger record of
  // `outcome` for remove-worktree, and the next instance finds the retry requires_attention.
  // `clear`: the file is removed before the retry, so the removal can succeed (and has, once the
  // record after it is reached); otherwise Git refuses it, and the freeze comes before it ran.
  async function interruptedClearing({ clear }) {
    const wrap = freezeAt(
      (name, args) =>
        name === "worktrees.advance" &&
        args.prior === true &&
        args.step?.step === "remove-worktree" &&
        (clear ? args.step.outcome !== "started" : args.step.outcome === "started"),
    );
    const env = await setup({ wrapStore: wrap });
    const alpha = await env.register("alpha");
    const armed = join(env.root, "armed");
    await writeFile(armed, "");
    // Someone's file in the worktree before the checkout: it refuses to overwrite it, and plain
    // `worktree remove` keeps the worktree, and with it the branch.
    await hookGit(
      `case "$*" in *" read-tree -m -u HEAD"*) [ -e '${armed}' ] && rm '${armed}' && echo mine > README.md ;; esac`,
    );
    const created = await env.tasks.create("p", {
      operationId: "c",
      title: "Leftover",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    const taskId = created.operation.result.resource.id;
    expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({
      state: "failed",
      result: { mounts: [{ left: "both", branch: "cove/Leftover" }] },
    });
    const { path, mountId } = await worktreeMount(env.tasks, taskId, "alpha");
    if (clear) await rm(join(path, "README.md"));
    const retried = await env.tasks.worktrees.retry("p", {
      operationId: "r",
      taskId,
      mountId,
      noFetch: true,
    });
    expect(retried.operation).toMatchObject({ state: "running" });
    await wrap.reached;
    expect(await exists(path)).toBe(!clear);
    const next = await env.restart();
    expect(await next.receipts.get(key("r"))).toMatchObject({ state: "requires_attention" });
    const leftover = async () => {
      const rows = await env.rows("SELECT operation_id, steps_json FROM worktree_attempts");
      return JSON.parse(rows.find((row) => row.operation_id === "c").steps_json).slice(-2);
    };
    const branches = () =>
      git(alpha.clone, "for-each-ref", "--format=%(refname:short)", "refs/heads/cove/");
    return { env, next, taskId, path, leftover, branches };
  }

  it("a retry interrupted while removing an earlier attempt's leftover finishes it on a continue (#126 item 4)", async () => {
    const { env, next, taskId, leftover, branches } = await interruptedClearing({ clear: true });
    // The continue proves the removal from the state, deletes the leftover's branch, then
    // creates the retry's own worktree.
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "r" });
    expect(await idleRecord(next.tasks, next.receipts, "r")).toMatchObject({ state: "succeeded" });
    expect(await worktreeMount(next.tasks, taskId, "alpha")).toMatchObject({
      state: "ready",
      branch: "cove/Leftover-2",
    });
    expect(await branches()).toBe("cove/Leftover-2");
    expect(await leftover()).toEqual([
      { step: "remove-worktree", outcome: "removed" },
      { step: "delete-branch", outcome: "removed" },
    ]);
    expect(await env.rows("SELECT state FROM managed_worktrees ORDER BY state")).toEqual([
      { state: "ready" },
    ]);
  });

  it("an abandon of such a retry resolves the leftover's removal before it ends (#141 review)", async () => {
    const { env, next, taskId, path, leftover, branches } = await interruptedClearing({
      clear: true,
    });
    await next.tasks.worktrees.abandonOperation("p", { operationId: "a", targetOperationId: "r" });
    expect(await idleRecord(next.tasks, next.receipts, "a")).toMatchObject({ state: "succeeded" });
    // The removal is proven from the state and the branch deleted: nothing is left, the path is
    // free again.
    const cancelled = await next.receipts.get(key("r"));
    expect(cancelled).toMatchObject({ state: "cancelled", progress: { remainingEffects: [] } });
    expect(cancelled.result.mounts[0]).not.toHaveProperty("left");
    expect(await leftover()).toEqual([
      { step: "remove-worktree", outcome: "removed" },
      { step: "delete-branch", outcome: "removed" },
    ]);
    expect(await exists(path)).toBe(false);
    expect(await branches()).toBe("");
    expect(await env.rows("SELECT state FROM managed_worktrees")).toEqual([{ state: "abandoned" }]);
    expect(await worktreeMount(next.tasks, taskId, "alpha")).toMatchObject({ state: "failed" });
  });

  it("an abandon of such a retry keeps and lists a leftover Git still refuses to remove (#141 review)", async () => {
    const { env, next, path, leftover, branches } = await interruptedClearing({ clear: false });
    await next.tasks.worktrees.abandonOperation("p", { operationId: "a", targetOperationId: "r" });
    expect(await idleRecord(next.tasks, next.receipts, "a")).toMatchObject({ state: "succeeded" });
    // The unfinished removal is observed void and tried again; Git refuses, so the worktree,
    // with the file, and its branch stay, and the cancelled retry lists them.
    const cancelled = await next.receipts.get(key("r"));
    expect(cancelled).toMatchObject({
      state: "cancelled",
      progress: { remainingEffects: ["worktree", "branch"] },
      result: { mounts: [{ left: "both", branch: "cove/Leftover" }] },
    });
    expect(await leftover()).toEqual([
      { step: "remove-worktree", outcome: "preserved" },
      { step: "delete-branch", outcome: "preserved" },
    ]);
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("mine\n");
    expect(await branches()).toBe("cove/Leftover");
    expect(await env.rows("SELECT state FROM managed_worktrees")).toEqual([{ state: "intent" }]);
  });

  // A store facade that refuses the calls matching `when` before they are sent, as a full store
  // queue does; `refusals` counts them.
  const refusing = (when) => {
    const wrap = (store) => ({
      call: async (name, args) => {
        if (when(name, args)) {
          wrap.refusals++;
          throw new StoreUnavailableError("busy", "not-sent");
        }
        return store.call(name, args);
      },
    });
    wrap.refusals = 0;
    return wrap;
  };

  it("repeats a ledger read or write the store refused, and the operation still ends (#126 item 9)", async () => {
    let reads = 0;
    let writes = 0;
    const wrap = refusing(
      (name) =>
        (name === "worktrees.attempts" && ++reads <= 2) ||
        (name === "worktrees.advance" && ++writes <= 3),
    );
    const env = await setup({ wrapStore: wrap });
    const alpha = await env.register("alpha");
    await env.tasks.create("p", {
      operationId: "c",
      title: "Refused",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    expect(await idleRecord(env.tasks, env.receipts, "c")).toMatchObject({ state: "succeeded" });
    expect(wrap.refusals).toBe(5);
  });

  it("hands an operation whose settle the store keeps refusing to requires_attention (#126 item 9)", async () => {
    const wrap = refusing((name) => name === "worktrees.settle");
    const env = await setup({ wrapStore: wrap });
    const alpha = await env.register("alpha");
    await env.tasks.create("p", {
      operationId: "c",
      title: "Unsettled",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    // Never left running without an actor, and nothing reported as success: a continue settles
    // the verified attempt once the store takes the write.
    const record = await idleRecord(env.tasks, env.receipts, "c");
    expect(record).toMatchObject({ state: "requires_attention" });
    expect(record.progress.completedSteps).toEqual(
      expect.arrayContaining(["branch", "worktree", "checkout"]),
    );
    expect(wrap.refusals).toBeGreaterThan(1);
    const next = await env.restart();
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "c")).toMatchObject({ state: "succeeded" });
  });

  it("finishes an abandon whose ledger repeated uncertain runs had filled (#126 item 10)", async () => {
    const { env, alpha, path } = await frozenTask(beforeStartOf("checkout"));
    await frozenAt(env, (steps) => credits(steps, "worktree"));
    // As after 62 fetches that were never seen to end, each made void by a continue: the ledger
    // of an earlier build held 64 entries, its cap, and refused every removal step after that.
    const [row] = await env.rows("SELECT steps_json FROM worktree_attempts");
    const filled = [
      ...Array.from({ length: 62 }, () => ({ step: "fetch", outcome: "void" })),
      ...JSON.parse(row.steps_json),
    ];
    expect(filled).toHaveLength(64);
    await env.store.call("test.run", {
      sql: "UPDATE worktree_attempts SET steps_json = ?",
      params: [JSON.stringify(filled)],
    });
    const next = await env.restart();
    await next.tasks.worktrees.abandonOperation("p", { operationId: "a", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "a")).toMatchObject({ state: "succeeded" });
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "cancelled",
      progress: { completedSteps: ["branch", "worktree"], remainingEffects: [] },
    });
    expect(await exists(path)).toBe(false);
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).toBe("");
    // The ledger keeps one entry per step: the last run of each.
    const [after] = await env.rows("SELECT steps_json FROM worktree_attempts");
    expect(JSON.parse(after.steps_json)).toEqual([
      { step: "fetch", outcome: "void" },
      { step: "branch", outcome: "succeeded" },
      { step: "worktree", outcome: "succeeded" },
      { step: "remove-worktree", outcome: "removed" },
      { step: "delete-branch", outcome: "removed" },
    ]);
  });

  it("removes a clean checked-out worktree and its branch when abandoning after a crash", async () => {
    // Every step done, the attempt never settled: the worktree was never reported ready.
    const { env, alpha, path } = await frozenTask(beforeSettle());
    await until(() => exists(join(path, "README.md")));
    const next = await env.restart();
    await next.tasks.worktrees.abandonOperation("p", { operationId: "a", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "a")).toMatchObject({ state: "succeeded" });
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "cancelled",
      progress: { remainingEffects: [] },
    });
    expect((await next.receipts.get(key("c"))).result.mounts[0].left).toBeUndefined();
    expect(await exists(path)).toBe(false);
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).toBe("");
    expect(
      (await git(alpha.clone, "worktree", "list", "--porcelain")).match(/^worktree /gm),
    ).toHaveLength(1);
  });

  it("keeps a checked-out worktree Git refuses to remove for an edited tracked file", async () => {
    const { env, alpha, path } = await frozenTask(beforeSettle());
    await until(() => exists(join(path, "README.md")));
    await writeFile(join(path, "README.md"), "someone's edit\n");
    const next = await env.restart();
    await next.tasks.worktrees.abandonOperation("p", { operationId: "a", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "a")).toMatchObject({ state: "succeeded" });
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "cancelled",
      progress: { remainingEffects: ["worktree", "branch"] },
      result: { mounts: [{ state: "failed", left: "both" }] },
    });
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("someone's edit\n");
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).not.toBe("");
  });

  it("leaves a changed worktree and its branch in place when abandoning", async () => {
    const { env, alpha, path } = await frozenTask(beforeSettle());
    await until(async () => {
      try {
        return (await readFile(join(path, "README.md"), "utf8")) === "test\n";
      } catch {
        return false;
      }
    });
    await writeFile(join(path, "work.txt"), "someone's work\n");
    const next = await env.restart();
    expect((await next.receipts.get(key("c"))).state).toBe("requires_attention");
    await next.tasks.worktrees.abandonOperation("p", { operationId: "a", targetOperationId: "c" });
    await next.tasks.worktrees.idle();
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "cancelled",
      progress: { remainingEffects: ["worktree", "branch"] },
      result: { mounts: [{ state: "failed", left: "both" }] },
    });
    expect(await readFile(join(path, "work.txt"), "utf8")).toBe("someone's work\n");
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).not.toBe("");
    // The path stays held: what is left there is not Cove's to reuse.
    expect(await env.rows("SELECT state FROM managed_worktrees")).toEqual([{ state: "intent" }]);
  });

  it("abandons a checkout whose end was not seen, keeping the worktree Git will not remove", async () => {
    // The checkout ran; its end was never recorded.
    const { env, alpha, path } = await frozenTask(beforeSuccessOf("checkout"));
    await until(() => exists(join(path, "README.md")));
    await writeFile(join(path, "notes.txt"), "work in progress\n");
    const next = await env.restart();
    await next.tasks.worktrees.abandonOperation("p", { operationId: "a", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "a")).toMatchObject({ state: "succeeded" });
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "cancelled",
      progress: { remainingEffects: ["worktree", "branch"] },
    });
    expect(await readFile(join(path, "notes.txt"), "utf8")).toBe("work in progress\n");
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).not.toBe("");
  });

  it("never deletes through a symbolic ref that replaced the branch", async () => {
    const { env, alpha } = await frozenTask(beforeStartOf("worktree"));
    await frozenAt(env, (steps) => credits(steps, "branch"));
    const branch = (await git(alpha.clone, "branch", "--list", "--format=%(refname)", "cove/*"))
      .split("\n")[0]
      .trim();
    const main = await git(alpha.clone, "rev-parse", "refs/heads/main");
    await git(alpha.clone, "symbolic-ref", branch, "refs/heads/main");
    const next = await env.restart();
    await next.tasks.worktrees.abandonOperation("p", { operationId: "a", targetOperationId: "c" });
    await next.tasks.worktrees.idle();
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "cancelled",
      progress: { remainingEffects: ["branch"] },
      result: { mounts: [{ left: "branch" }] },
    });
    // main, which the symbolic ref points at, is intact.
    expect(await git(alpha.clone, "rev-parse", "refs/heads/main")).toBe(main);
  });

  it("keeps a worktree whose checkout may have run, with what is staged in it", async () => {
    // The checkout ran; its end was never recorded. Someone stages a change and then removes
    // every file, so the directory holds only `.git` again: only the index tells.
    const { env, alpha, path } = await frozenTask(beforeSuccessOf("checkout"));
    await until(() => exists(join(path, "README.md")));
    await writeFile(join(path, "staged.txt"), "staged work\n");
    await git(path, "add", "staged.txt");
    for (const name of await readdir(path))
      if (name !== ".git") await rm(join(path, name), { recursive: true });
    const index = await git(path, "rev-parse", "--path-format=absolute", "--git-path", "index");
    const next = await env.restart();
    await next.tasks.worktrees.abandonOperation("p", { operationId: "a", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "a")).toMatchObject({ state: "succeeded" });
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "cancelled",
      progress: { remainingEffects: ["worktree", "branch"] },
    });
    expect(await exists(join(path, ".git"))).toBe(true);
    expect(await exists(index)).toBe(true);
    expect(await git(path, "ls-files", "--cached", "staged.txt")).toBe("staged.txt");
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).not.toBe("");
  });

  it("refuses a continue while a removal that outlived its deadline may still run", async () => {
    const { env, path } = await frozenTask(beforeStartOf("checkout"));
    await until(() => exists(join(path, ".git")));
    let release;
    const held = new Promise((done) => (release = done));
    let entered;
    const reached = new Promise((done) => (entered = done));
    const next = await env.restart({
      service: {
        worktrees: {
          fsDeadlineMs: 2_000,
          hooks: {
            beforeUncheckedRemoval: async () => {
              entered();
              await held;
            },
          },
        },
      },
    });
    await next.tasks.worktrees.abandonOperation("p", { operationId: "a", targetOperationId: "c" });
    await reached;
    // The removal got no answer in time: the abandon stops, and nothing acts on it meanwhile.
    expect(await idleRecord(next.tasks, next.receipts, "a")).toMatchObject({
      state: "requires_attention",
    });
    const refused = await next.tasks.worktrees.continueOperation("p", {
      operationId: "k1",
      targetOperationId: "a",
    });
    expect(refused.error).toMatchObject({
      kind: "OPERATION_EFFECTS_ACTIVE",
      acceptance: "not-accepted",
    });
    expect(await exists(path)).toBe(true);
    // Once it settled, a continue re-verifies what it did.
    release();
    await until(async () => !(await exists(path)));
    await until(async () => {
      const outcome = await next.tasks.worktrees.continueOperation("p", {
        operationId: "k2",
        targetOperationId: "a",
      });
      return outcome.error?.kind !== "OPERATION_EFFECTS_ACTIVE";
    });
    expect(await idleRecord(next.tasks, next.receipts, "a")).toMatchObject({ state: "succeeded" });
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "cancelled",
      progress: { remainingEffects: [] },
    });
  });

  it("does not check out into a worktree someone put a file in", async () => {
    const { env, path } = await frozenTask(beforeStartOf("checkout"));
    await until(() => exists(join(path, ".git")));
    // Before the checkout, someone writes a file the checkout would have written.
    await writeFile(join(path, "README.md"), "mine\n");
    const next = await env.restart();
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    // No longer what `worktree add --no-checkout` left: nothing runs, and the file stays.
    expect(await idleRecord(next.tasks, next.receipts, "c")).toMatchObject({
      state: "requires_attention",
    });
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("mine\n");
  });

  it("checks out without overwriting a file that appears as the checkout starts", async () => {
    const { env, path } = await frozenTask(beforeStartOf("checkout"));
    await until(() => exists(join(path, ".git")));
    const next = await env.restart();
    // The file appears after Cove's check, right before Git's checkout runs.
    await hookGit(
      `case "$*" in *" read-tree -m -u HEAD"*) echo mine > '${join(path, "README.md")}' ;; esac`,
    );
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    // The checkout refuses rather than overwrite it; the worktree, holding that file, stays.
    expect(await idleRecord(next.tasks, next.receipts, "c")).toMatchObject({ state: "failed" });
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("mine\n");
    expect(await env.rows("SELECT state FROM managed_worktrees")).toEqual([{ state: "intent" }]);
  });

  it("does not check out over a modification someone staged", async () => {
    const { env, path } = await frozenTask(beforeStartOf("checkout"));
    await until(() => exists(join(path, ".git")));
    await writeFile(join(path, "README.md"), "mine\n");
    await git(path, "add", "README.md");
    const next = await env.restart();
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "c")).toMatchObject({
      state: "requires_attention",
    });
    // The staged content and the file are as they were left.
    expect(await git(path, "show", ":README.md")).toBe("mine");
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("mine\n");
  });

  it("does not check out over an addition someone staged", async () => {
    const { env, path } = await frozenTask(beforeStartOf("checkout"));
    await until(() => exists(join(path, ".git")));
    // Staged, then removed from the directory: the worktree holds only `.git` again, but its
    // index is someone's.
    await writeFile(join(path, "added.txt"), "mine\n");
    await git(path, "add", "added.txt");
    await rm(join(path, "added.txt"));
    const next = await env.restart();
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "c")).toMatchObject({
      state: "requires_attention",
    });
    expect(await git(path, "show", ":added.txt")).toBe("mine");
  });

  it("does not report ready when the checked-out worktree has disappeared", async () => {
    const { env, path } = await frozenTask(beforeSettle());
    await until(() => exists(join(path, "README.md")));
    // Deleted without `git worktree prune`: Git still lists the worktree.
    await rm(path, { recursive: true, force: true });
    const next = await env.restart();
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "c")).toMatchObject({
      state: "requires_attention",
    });
    expect(await exists(path)).toBe(false);
  });

  it("does not report ready when the entry was replaced after every step completed", async () => {
    const { env, path, entry } = await frozenTask(beforeSettle());
    await until(() => exists(join(path, "README.md")));
    // The entry becomes a symbolic link to the moved directory: the checkout is still reachable
    // at its path, but the entry is no longer the directory Cove recorded.
    await rename(entry, `${entry}.moved`);
    await symlink(`${entry}.moved`, entry);
    const next = await env.restart();
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "c")).toMatchObject({
      state: "requires_attention",
    });
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("test\n");
  });

  it("leaves a worktree whose step was not seen to end alone when files appeared in it", async () => {
    const { env, path } = await frozenTask(beforeSuccessOf("worktree"));
    await until(() => exists(join(path, ".git")));
    await writeFile(join(path, "README.md"), "mine\n");
    const next = await env.restart();
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "c")).toMatchObject({
      state: "requires_attention",
    });
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("mine\n");
  });

  it("stops instead of recreating a recorded worktree that has disappeared", async () => {
    const { env, alpha, path } = await frozenTask(beforeStartOf("checkout"));
    await until(() => exists(join(path, ".git")));
    await git(alpha.clone, "worktree", "remove", "--force", path);
    const next = await env.restart();
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "c")).toMatchObject({
      state: "requires_attention",
    });
    expect(await exists(path)).toBe(false);
  });

  it("resumes from a completed fetch without fetching again", async () => {
    const atBase = freezeAt(
      (name, args) => name === "worktrees.advance" && args.phase === "resolved",
    );
    const env = await setup({ wrapStore: atBase });
    const alpha = await env.register("alpha");
    const fetched = await git(alpha.clone, "rev-parse", "refs/remotes/origin/main");
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Fetched",
      mounts: [{ source: "worktree", repoId: alpha.repoId }],
    });
    await atBase.reached;
    expect(await env.rows("SELECT phase FROM worktree_attempts")).toEqual([{ phase: "fetched" }]);
    const next = await env.restart();
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "requires_attention",
      progress: { completedSteps: ["fetch"] },
    });
    // The remote moves on; the continue does not fetch it again.
    await commit(alpha.upstream, "later.txt", "later\n");
    await git(alpha.upstream, "push", "--quiet", "origin", "main");
    await next.tasks.worktrees.continueOperation("p", { operationId: "k", targetOperationId: "c" });
    expect(await idleRecord(next.tasks, next.receipts, "c")).toMatchObject({ state: "succeeded" });
    const mount = await worktreeMount(next.tasks, outcome.operation.result.resource.id, "alpha");
    expect(await git(mount.path, "rev-parse", "HEAD")).toBe(fetched);
  });
});
