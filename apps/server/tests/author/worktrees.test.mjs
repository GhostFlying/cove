import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { RepoService } from "../../dist/domain/repos.js";
import { WorkspaceService } from "../../dist/domain/workspaces.js";
import { resolveBase, runGitStep } from "../../dist/git/worktree.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { createRecoveryVerifiers } from "../../dist/operations/recovery-verifiers.js";
import { Store } from "../../dist/store/database.js";
import { prepareHome } from "../../dist/store/home.js";
import { recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { ProcessLedger, processStartIdentity } from "../../dist/store/processes.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";

// Managed worktree creation (docs/milestones/m1.md T3b) below the CLI: the base resolution order,
// the recorded Git step, partial failure and retry, and what a restart proves about an operation
// frozen between its steps, with operation continue and abandon. Every repository is a temporary
// clone of a local bare remote; nothing touches the network.

const encode = (text) => new TextEncoder().encode(text);
const savedPath = process.env.PATH;
const testOperations = new URL("./store-test-operations.mjs", import.meta.url).href;
const directories = [];
const stores = [];
const children = [];

afterEach(async () => {
  process.env.PATH = savedPath;
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "cove-worktree-test-")));
  directories.push(path);
  return path;
}

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
  const remote = join(root, `${name}.git`);
  await git(root, "clone", "--quiet", "--bare", upstream, remote);
  await git(upstream, "remote", "add", "origin", remote);
  const clone = join(root, name);
  await git(root, "clone", "--quiet", remote, clone);
  return { upstream, remote, clone };
}

// A server-less composition as in workspaces.test.mjs. `wrapStore` puts a facade in front of the
// store for the services; `restart()` stands for the next instance: fresh receipts that recover
// with the registered verifiers, and a fresh workspace service on the plain store.
async function setup({ wrapStore } = {}) {
  const root = await temporary();
  const layout = await prepareHome(join(root, "home"));
  const store = await Store.open({
    databasePath: layout.databasePath,
    backupDirectory: layout.backupDirectory,
    operationModules: [testOperations],
  });
  stores.push(store);
  const instance = async (relayInstanceId, number, on) => {
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const composition = new RuntimeComposition("server", relayInstanceId, { ...M0_LIMITS }, bytes);
    await recordInstanceStart(store, relayInstanceId, number);
    const receipts = new OperationReceipts(
      composition,
      encode,
      new SqliteReceiptBackend(on, relayInstanceId, () => number),
    );
    const tasks = new WorkspaceService({
      store: on,
      receipts,
      config: { workspaceRoot: async () => join(root, "workspaces") },
      serverId: "server",
      encodeUtf8: encode,
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
  const restart = async () => {
    const next = await instance("instance2", 2, store);
    const recovered = await next.receipts.recoverInterrupted(
      createRecoveryVerifiers({
        store,
        serverId: "server",
        relayInstanceId: "instance2",
        now: Date.now,
      }),
    );
    return { ...next, recovered };
  };
  const rows = (sqlText, params = []) => store.call("test.all", { sql: sqlText, params });
  return { root, store, ...first, repos, register, restart, rows };
}

const key = (operationId) => ({ serverId: "server", principalId: "p", operationId });
const never = new Promise(() => {});

// A store facade that freezes the first preparation step matching `when`, as a crash there would:
// the call never returns, so nothing after it runs in this instance.
const freezeAt = (when) => (store) => ({
  call: async (name, args) => {
    if (when(name, args)) await never;
    return store.call(name, args);
  },
});
const afterSteps = (step) =>
  freezeAt((name, args) => name === "worktrees.recordSteps" && args.steps.includes(step));

async function worktreeMount(tasks, taskId, mountName) {
  const { task } = await tasks.get(taskId);
  return task.workspace.mounts.find((mount) => mount.name === mountName);
}

// Waits for the frozen executor to reach the frozen call (the receipt is running meanwhile).
async function until(check) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("condition not reached");
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
    // A git that never answers and leaves a child in its group.
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\necho $$ > "${join(root, "git.pid")}"\n/bin/sleep 60 &\nwait\n`,
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
    const pid = Number(await readFile(join(root, "git.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
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
    await env.tasks.worktrees.idle();
    const settled = await env.receipts.get(key("c"));
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
    await env.tasks.worktrees.idle();
    const settled = await env.receipts.get(key("c"));
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
      (
        await env.tasks.worktrees.retry("p", {
          operationId: "r0",
          taskId,
          mountId: ready.mountId,
        })
      ).error,
    ).toBeDefined();
    const retried = await env.tasks.worktrees.retry("p", {
      operationId: "r",
      taskId,
      mountId: failedMount.mountId,
      branch: "taken-2",
    });
    expect(retried.operation.state).toBe("running");
    await env.tasks.worktrees.idle();
    expect(await env.receipts.get(key("r"))).toMatchObject({ state: "succeeded" });
    const fixed = await worktreeMount(env.tasks, taskId, "beta");
    expect(fixed.state).toBe("ready");
    expect(await git(fixed.path, "symbolic-ref", "--short", "HEAD")).toBe("taken-2");
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
    await env.tasks.worktrees.idle();
    expect(await env.receipts.get(key("c"))).toMatchObject({
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
    await env.tasks.worktrees.idle();
    expect(await env.receipts.get(key("r"))).toMatchObject({ state: "succeeded" });
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
    await env.tasks.worktrees.idle();
    expect(await env.receipts.get(key("c"))).toMatchObject({
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
    await env.tasks.worktrees.idle();
    expect(await env.receipts.get(key("r"))).toMatchObject({ state: "succeeded" });
  });
});

describe("restart, continue and abandon (S8)", () => {
  async function frozen(step) {
    const env = await setup({ wrapStore: afterSteps(step) });
    const alpha = await env.register("alpha");
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Frozen",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    // The caller waits for the step's effect in Git: the frozen call is the one that records it.
    return { env, alpha, taskId: outcome.operation.result.resource.id };
  }

  it("reports a running operation frozen after its branch as requires_attention, then continues", async () => {
    const { env, alpha, taskId } = await frozen("branch");
    await until(async () =>
      (await git(alpha.clone, "branch", "--list", "cove/*").catch(() => "")).includes("cove/"),
    );
    expect((await env.receipts.get(key("c"))).state).toBe("running");
    const next = await env.restart();
    const record = await next.receipts.get(key("c"));
    // Never succeeded by itself: the branch exists, the worktree does not.
    expect(record).toMatchObject({
      state: "requires_attention",
      progress: {
        completedSteps: ["intent", "branch"],
        recoveryActions: ["continue", "abandon"],
      },
    });
    expect(record.progress.remainingEffects).toEqual(
      expect.arrayContaining(["worktree", "checkout", "record"]),
    );
    expect(next.recovered.map((recovered) => recovered.operationId)).toContain("c");
    // Continue is its own write; the target is driven from what is observed now.
    const continued = await next.tasks.worktrees.continueOperation("p", {
      operationId: "k",
      targetOperationId: "c",
    });
    expect(continued.operation).toMatchObject({
      state: "succeeded",
      result: { targetOperationId: "c" },
    });
    await next.tasks.worktrees.idle();
    expect(await next.receipts.get(key("c"))).toMatchObject({ state: "succeeded" });
    const mount = await worktreeMount(next.tasks, taskId, "alpha");
    expect(mount.state).toBe("ready");
    expect(await readFile(join(mount.path, "README.md"), "utf8")).toBe("test\n");
    // One branch, one worktree: nothing was repeated.
    expect((await git(alpha.clone, "branch", "--list", "cove/*")).split("\n")).toHaveLength(1);
    expect(
      (await git(alpha.clone, "worktree", "list", "--porcelain")).match(/^worktree /gm),
    ).toHaveLength(2);
    // The same continue answers with its record; a second one is refused (nothing to continue).
    expect(
      (
        await next.tasks.worktrees.continueOperation("p", {
          operationId: "k",
          targetOperationId: "c",
        })
      ).operation,
    ).toEqual(continued.operation);
    expect(
      (
        await next.tasks.worktrees.continueOperation("p", {
          operationId: "k2",
          targetOperationId: "c",
        })
      ).error.kind,
    ).toBe("OPERATION_NOT_RESUMABLE");
  });

  it("proves a running operation whose mounts all ended", async () => {
    // Frozen in the final record: every mount is ready, the receipt still running.
    const env = await setup({
      wrapStore: freezeAt((name) => name === "worktrees.workspaceRevision"),
    });
    const alpha = await env.register("alpha");
    await env.tasks.create("p", {
      operationId: "c",
      title: "Done",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    await until(async () =>
      (await env.rows("SELECT state FROM managed_worktrees")).some((row) => row.state === "ready"),
    );
    expect((await env.receipts.get(key("c"))).state).toBe("running");
    const next = await env.restart();
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "succeeded",
      result: { mounts: [{ state: "ready" }] },
    });
  });

  it("refuses continue and abandon while a recorded process may still run", async () => {
    const { env, alpha } = await frozen("branch");
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
    const abandoned = await next.tasks.worktrees.abandonOperation("p", {
      operationId: "a",
      targetOperationId: "c",
    });
    expect(abandoned.operation.state).toBe("succeeded");
  });

  it("abandons a worktree frozen before its checkout, removing exactly what it created", async () => {
    const { env, alpha, taskId } = await frozen("worktree");
    await until(async () =>
      (await git(alpha.clone, "worktree", "list", "--porcelain")).includes("cove/"),
    );
    const next = await env.restart();
    expect((await next.receipts.get(key("c"))).state).toBe("requires_attention");
    const abandoned = await next.tasks.worktrees.abandonOperation("p", {
      operationId: "a",
      targetOperationId: "c",
    });
    expect(abandoned.operation).toMatchObject({ state: "succeeded" });
    const target = await next.receipts.get(key("c"));
    expect(target).toMatchObject({
      state: "cancelled",
      progress: { remainingEffects: [] },
    });
    const mount = await worktreeMount(next.tasks, taskId, "alpha");
    expect(mount).toMatchObject({ state: "failed" });
    await expect(stat(mount.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).toBe("");
    expect(await env.rows("SELECT state FROM managed_worktrees")).toEqual([{ state: "abandoned" }]);
    // A retry starts a new attempt at the same path.
    await next.tasks.worktrees.retry("p", { operationId: "r", taskId, mountId: mount.mountId });
    await next.tasks.worktrees.idle();
    expect(await next.receipts.get(key("r"))).toMatchObject({ state: "succeeded" });
  });

  it("leaves a changed worktree and its branch in place when abandoning", async () => {
    const env = await setup({
      wrapStore: freezeAt(
        (name, args) => name === "worktrees.recordSteps" && args.steps.includes("checkout"),
      ),
    });
    const alpha = await env.register("alpha");
    const outcome = await env.tasks.create("p", {
      operationId: "c",
      title: "Dirty",
      mounts: [{ source: "worktree", repoId: alpha.repoId, noFetch: true }],
    });
    const taskId = outcome.operation.result.resource.id;
    const { task } = await env.tasks.get(taskId);
    const path = task.workspace.mounts[0].path;
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
    expect(await next.receipts.get(key("c"))).toMatchObject({
      state: "cancelled",
      progress: { remainingEffects: ["worktree", "branch"] },
    });
    expect(await readFile(join(path, "work.txt"), "utf8")).toBe("someone's work\n");
    expect(await git(alpha.clone, "branch", "--list", "cove/*")).not.toBe("");
  });
});
