import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { cli, createM1Fixture } from "./fixtures.mjs";
import { gitIn, registeredRemote, worktreeMounts } from "./s3-worktree-remotes.mjs";

// S6 (docs/milestones/m1.md T5): a checkout mount is switched to a managed worktree, and a managed
// worktree is deleted, through the compiled `cove` CLI and server. A run that uses the path blocks
// either change; the source checkout keeps its changes and is never written to; a deletion needs
// the owner's confirmation, removes the worktree with its changes and keeps the branch, also for a
// worktree an abandoned preparation left in place, and survives a restart as requires_attention
// that a continue finishes. Every remote is a local bare repository in the fixture's root.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );

// A tab whose run keeps running until it is stopped; the run is live once it reports running.
async function liveTab(home, taskId, name) {
  const created = await fixture.coveJson(
    [
      "tab",
      "create",
      taskId,
      "--name",
      name,
      "--",
      process.execPath,
      "-e",
      "setInterval(() => {}, 1000)",
    ],
    { home },
  );
  const tabId = created.operation.result.resource.id;
  return { tabId, run: created.operation.run };
}

async function stopped(home, tabId) {
  await fixture.coveJson(["tab", "stop", tabId], { home });
  await waitFor(
    "the run to end",
    async () => {
      const read = await fixture.coveJson(["tab", "get", tabId], { home });
      return !["starting", "running"].includes(read.latestRun.lifecycle);
    },
    15_000,
  );
}

async function checkoutTask(home) {
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(
    ["task", "create", "Convert me", "--checkout", alpha.repoId],
    { home },
  );
  return { alpha, task, mount: task.workspace.mounts[0] };
}

test("a checkout with changes and a live run is converted only after the run ended, from the remote's main, and keeps its changes", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const { alpha, task, mount } = await checkoutTask(home);
  // Uncommitted work in the source: one staged, one unstaged, one untracked file.
  await writeFile(join(alpha.clone, "staged.txt"), "staged\n");
  await alpha.git("add", "staged.txt");
  await writeFile(join(alpha.clone, "README.md"), "unstaged edit\n");
  await writeFile(join(alpha.clone, "untracked.txt"), "untracked\n");
  const sourceHead = await alpha.git("rev-parse", "HEAD");
  const sourceStatus = await alpha.git("status", "--porcelain");
  const remoteMain = await alpha.push("feature.txt", "feature\n");

  // A live run of the task uses the checkout: refused, with the run named.
  const { tabId, run } = await liveTab(home, task.taskId, "old");
  const refused = await fixture.cove(["mount", "convert", task.taskId, mount.mountId], { home });
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("LIVE_RUNS_PRESENT");
  expect(refused.stderr).toContain(
    `cove: live run ${run.runId} of tab ${tabId} ("old") uses the path; stop it with ` +
      `\`cove tab stop ${tabId}\``,
  );
  const unchanged = await fixture.coveJson(["task", "get", task.taskId], { home });
  expect(unchanged.workspace).toMatchObject({ revision: task.workspace.revision });
  expect(unchanged.workspace.mounts[0]).toMatchObject({ source: "checkout" });

  await stopped(home, tabId);
  const converted = await fixture.cove(
    ["mount", "convert", task.taskId, mount.mountId, "--branch", "feature/converted"],
    { home },
  );
  expect(converted.code).toBe(0);
  expect(converted.stderr).toContain("1 staged, 1 unstaged, 1 untracked");
  const printed = JSON.parse(converted.stdout);
  expect(printed.operation).toMatchObject({
    method: "binding.convert",
    state: "succeeded",
    result: {
      resource: { kind: "mount", id: mount.mountId },
      mounts: [{ mountId: mount.mountId, state: "ready" }],
      sourceChanges: { staged: 1, unstaged: 1, untracked: 1 },
    },
  });
  const after = printed.task.workspace;
  expect(after.revision).toBeGreaterThan(task.workspace.revision);
  const [worktree] = worktreeMounts(printed.task);
  expect(worktree).toMatchObject({
    mountId: mount.mountId,
    name: mount.name,
    repoId: alpha.repoId,
    state: "ready",
    path: join(after.entryPath, mount.name),
    branch: "feature/converted",
    // The D1 base: the remote's main, fetched now, never the source's HEAD.
    baseCommit: remoteMain,
  });
  const inWorktree = (...args) => alpha.git("-C", worktree.path, ...args);
  expect(await inWorktree("rev-parse", "HEAD")).toBe(remoteMain);
  // Nothing of the source's changes came along, and the source still has all of them.
  expect(await inWorktree("status", "--porcelain")).toBe("");
  expect(await exists(join(worktree.path, "untracked.txt"))).toBe(false);
  expect(await alpha.git("rev-parse", "HEAD")).toBe(sourceHead);
  expect(await alpha.git("symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(await alpha.git("status", "--porcelain")).toBe(sourceStatus);

  // The old run's record still names the checkout.
  const runs = await fixture.coveJson(["tab", "runs", tabId], { home });
  expect(JSON.stringify(runs)).toContain(alpha.clone);
  // A new run works in the worktree; the source is unaffected by its commit.
  const script = join(fixture.root, "commit.mjs");
  await writeFile(
    script,
    `import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const manifest = JSON.parse(readFileSync("cove-workspace.json", "utf8"));
const mount = manifest.mounts.find((item) => item.name === ${JSON.stringify(mount.name)});
writeFileSync(join(mount.path, "work.txt"), "work\\n");
const git = (...args) => execFileSync("git", args, { cwd: mount.path, encoding: "utf8" });
git("add", "work.txt");
git("-c", "user.name=Cove Fixture", "-c", "user.email=fixture@cove.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "work");
`,
  );
  const fresh = await fixture.coveJson(
    ["tab", "create", task.taskId, "--name", "new", "--", process.execPath, script],
    { home },
  );
  await waitFor(
    "the new run to exit",
    async () => {
      const read = await fixture.coveJson(["tab", "get", fresh.operation.result.resource.id], {
        home,
      });
      return read.latestRun.lifecycle === "exited";
    },
    15_000,
  );
  expect(await inWorktree("log", "-1", "--format=%s")).toBe("work");
  expect(await alpha.git("rev-parse", "HEAD")).toBe(sourceHead);
  expect(await alpha.git("rev-parse", "main")).toBe(sourceHead);
  expect(await alpha.git("status", "--porcelain")).toBe(sourceStatus);

  // The history keeps the checkout binding.
  const history = await fixture.coveJson(["mount", "history", task.taskId, mount.mountId], {
    home,
  });
  expect(history.bindings).toEqual([
    expect.objectContaining({
      source: "checkout",
      path: mount.path,
      unboundAtMs: expect.any(Number),
    }),
    expect.objectContaining({
      source: "worktree",
      path: worktree.path,
      branch: "feature/converted",
      // Bound at the conversion's revision; the preparation's outcome bumped it again since.
      workspaceRevision: task.workspace.revision + 1,
      unboundAtMs: null,
    }),
  ]);
  // Only a ready checkout is converted.
  const again = await fixture.cove(["mount", "convert", task.taskId, mount.mountId], { home });
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("INVALID_ARGUMENT");
});

test("a worktree is deleted only when confirmed and no run uses it, with its changes, keeping the branch", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(
    ["task", "create", "Delete me", "--worktree", `${alpha.repoId},branch=feature/kept`],
    { home },
  );
  const [mount] = worktreeMounts(task);
  await writeFile(join(mount.path, "README.md"), "uncommitted\n");
  await writeFile(join(mount.path, "untracked.txt"), "untracked\n");
  const branchHead = await alpha.git("rev-parse", "feature/kept");

  // Without a terminal and without --yes nothing is sent.
  const unconfirmed = await fixture.cove(["mount", "delete-worktree", task.taskId, mount.mountId], {
    home,
  });
  expect(unconfirmed.code).toBe(2);
  expect(unconfirmed.stderr).toContain("confirm with --yes (nothing was sent)");
  expect(await exists(mount.path)).toBe(true);

  // A live run uses the worktree: refused, with the run named.
  const { tabId, run } = await liveTab(home, task.taskId, "busy");
  const busy = await fixture.cove(
    ["mount", "delete-worktree", task.taskId, mount.mountId, "--yes"],
    { home },
  );
  expect(busy.code).toBe(1);
  expect(busy.stderr).toContain("LIVE_RUNS_PRESENT");
  expect(busy.stderr).toContain(
    `cove: live run ${run.runId} of tab ${tabId} ("busy") uses the path; stop it with ` +
      `\`cove tab stop ${tabId}\``,
  );
  expect(await exists(join(mount.path, "untracked.txt"))).toBe(true);

  await stopped(home, tabId);
  const deleted = await fixture.cove(
    ["mount", "delete-worktree", task.taskId, mount.mountId, "--yes"],
    { home },
  );
  expect(deleted.code).toBe(0);
  const printed = JSON.parse(deleted.stdout);
  expect(printed.operation).toMatchObject({
    method: "binding.delete",
    state: "succeeded",
    result: { resource: { kind: "mount", id: mount.mountId } },
  });
  expect(printed.task.workspace.mounts).toEqual([]);
  expect(printed.task.workspace.revision).toBeGreaterThan(task.workspace.revision);
  expect(await exists(mount.path)).toBe(false);
  expect(await alpha.git("worktree", "list", "--porcelain")).not.toContain(mount.path);
  // The branch is kept, at its commit.
  expect(await alpha.git("rev-parse", "feature/kept")).toBe(branchHead);
  // The history outlives the mount.
  const history = await fixture.coveJson(["mount", "history", task.taskId, mount.mountId], {
    home,
  });
  expect(history.bindings).toEqual([
    expect.objectContaining({
      source: "worktree",
      path: mount.path,
      unboundAtMs: expect.any(Number),
    }),
  ]);
  // The mount is gone; a second deletion has nothing to act on.
  const again = await fixture.cove(
    ["mount", "delete-worktree", task.taskId, mount.mountId, "--yes"],
    { home },
  );
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("MOUNT_NOT_FOUND");
});

// Runs the CLI on a pseudo-terminal (python3's pty module) and answers its question with
// `answer` once it was asked.
async function onTerminal(args, home, answer) {
  const driver = join(fixture.root, "pty-driver.py");
  await writeFile(
    driver,
    `import os, pty, sys
answer = sys.argv[1].encode()
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
seen = b""
sent = False
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    seen += chunk
    if not sent and b"[y/N]" in seen:
        os.write(fd, answer + b"\\n")
        sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(seen.decode(errors="replace"))
sys.exit(os.waitstatus_to_exitcode(status))
`,
  );
  return new Promise((done) =>
    execFile(
      "python3",
      [driver, answer, process.execPath, cli, "--home", home, ...args],
      { env: fixture.env },
      (error, stdout) => done({ code: error ? error.code : 0, output: stdout }),
    ),
  );
}

test("on a terminal the deletion asks first, naming the path and the kept branch", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(
    ["task", "create", "Ask me", "--worktree", `${alpha.repoId},branch=feature/asked`],
    { home },
  );
  const [mount] = worktreeMounts(task);
  const args = ["mount", "delete-worktree", task.taskId, mount.mountId];
  const declined = await onTerminal(args, home, "n");
  expect(declined.code).toBe(1);
  expect(declined.output).toContain(`Delete the worktree at ${mount.path}`);
  expect(declined.output).toContain("The branch feature/asked is kept");
  expect(declined.output).toContain("not confirmed; nothing was sent");
  expect(await exists(mount.path)).toBe(true);
  const accepted = await onTerminal(args, home, "y");
  expect(accepted.code).toBe(0);
  expect(await exists(mount.path)).toBe(false);
  expect(await alpha.git("branch", "--list", "feature/asked")).toContain("feature/asked");
});

test("a checkout is never deleted", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const { alpha, task, mount } = await checkoutTask(home);
  const result = await fixture.cove(
    ["mount", "delete-worktree", task.taskId, mount.mountId, "--yes"],
    { home },
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("INVALID_ARGUMENT");
  expect(await exists(join(alpha.clone, "README.md"))).toBe(true);
});

function realGit() {
  return new Promise((done, fail) =>
    execFile("/bin/sh", ["-c", "command -v git"], { env: fixture.env }, (error, stdout) =>
      error ? fail(error) : done(stdout.trim()),
    ),
  );
}

// As in S8: a `git` on the server's PATH that blocks the named step until released, then execs
// the real git with the same PID.
async function installWrapper() {
  const control = join(fixture.root, "git-control");
  const bin = join(fixture.root, "git-bin");
  await mkdir(control, { recursive: true });
  await mkdir(bin, { recursive: true });
  const script = `#!/bin/sh
case "$*" in
  *"read-tree -m -u HEAD"*) step=checkout ;;
  *"worktree remove --force"*) step=remove ;;
  *"worktree list --porcelain -z"*) step=list ;;
  *) step= ;;
esac
if [ -n "$step" ] && [ "$(cat "${control}/block" 2>/dev/null)" = "$step" ]; then
  echo $$ > "${control}/$step.pid"
  while [ ! -e "${control}/release-$step" ]; do /bin/sleep 0.1; done
fi
exec "${await realGit()}" "$@"
`;
  await writeFile(join(bin, "git"), script);
  await chmod(join(bin, "git"), 0o755);
  fixture.env.PATH = `${bin}:${fixture.env.PATH}`;
  return {
    block: (step) => writeFile(join(control, "block"), step),
    release: (step) => writeFile(join(control, `release-${step}`), ""),
    blocked: async (step) => {
      let pid = null;
      await waitFor(
        `the held ${step} step`,
        async () =>
          (pid = await readFile(join(control, `${step}.pid`), "utf8").then(
            (text) => Number(text.trim()),
            () => null,
          )) !== null,
        30_000,
      );
      await fixture.trackPid(pid);
      return pid;
    },
  };
}

const alive = (pid) =>
  fixture.signalTracked(pid, 0).then(
    () => true,
    () => false,
  );

test("a worktree an abandoned preparation left in place is deleted; a deletion interrupted by a restart is continued", async () => {
  const home = fixture.home("home");
  const wrapper = await installWrapper();
  let server = await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");

  // A creation killed during its checkout step and abandoned after work appeared in the worktree:
  // the worktree and its branch are left in place (S8).
  await wrapper.block("checkout");
  fixture.spawnCove(
    ["task", "create", "Leftover", "--worktree", alpha.repoId, "--operation-id", "s6-create"],
    { home },
  );
  const checkoutPid = await wrapper.blocked("checkout");
  await fixture.killServer(server);
  server = await fixture.startServer(home);
  await wrapper.release("checkout");
  await waitFor("the checkout step to end", async () => !(await alive(checkoutPid)), 30_000);
  const created = await fixture.coveJson(["operation", "get", "s6-create"], { home });
  const taskId = created.result.resource.id;
  const [mount] = worktreeMounts(await fixture.coveJson(["task", "get", taskId], { home }));
  await writeFile(join(mount.path, "notes.txt"), "work in progress\n");
  const abandoned = await fixture.coveJson(
    ["operation", "abandon", "s6-create", "--operation-id", "s6-abandon"],
    { home },
  );
  expect(abandoned.target.result.mounts).toEqual([
    expect.objectContaining({ mountId: mount.mountId, state: "failed", left: "both" }),
  ]);
  expect(await exists(join(mount.path, "notes.txt"))).toBe(true);

  // Its deletion is held in `git worktree remove --force` and the server killed.
  await wrapper.block("remove");
  fixture.spawnCove(
    ["mount", "delete-worktree", taskId, mount.mountId, "--yes", "--operation-id", "s6-delete"],
    { home },
  );
  const removePid = await wrapper.blocked("remove");
  await fixture.killServer(server);
  server = await fixture.startServer(home);
  const target = await fixture.coveJson(["operation", "get", "s6-delete"], { home });
  expect(target).toMatchObject({
    method: "binding.delete",
    state: "requires_attention",
    progress: {
      remainingEffects: ["remove-worktree", "record", "git-process"],
      recoveryActions: ["continue"],
    },
  });
  // The mount stays pending: no other operation acts on it meanwhile.
  const pending = await fixture.coveJson(["task", "get", taskId], { home });
  expect(pending.workspace.mounts[0]).toMatchObject({ mountId: mount.mountId, state: "pending" });
  // Refused while the recorded Git process may still run; a deletion is never abandoned.
  const early = await fixture.cove(
    ["operation", "continue", "s6-delete", "--operation-id", "s6-continue-early"],
    { home },
  );
  expect(early.code).not.toBe(0);
  expect(early.stderr).toContain("OPERATION_EFFECTS_ACTIVE");
  const abandon = await fixture.cove(
    ["operation", "abandon", "s6-delete", "--operation-id", "s6-abandon-delete"],
    { home },
  );
  expect(abandon.code).not.toBe(0);
  expect(abandon.stderr).toContain("OPERATION_NOT_RESUMABLE");

  // The held removal finishes on its own; the continue observes that and records the deletion.
  await wrapper.release("remove");
  await waitFor("the removal to end", async () => !(await alive(removePid)), 30_000);
  const continued = await fixture.coveJson(
    ["operation", "continue", "s6-delete", "--operation-id", "s6-continue"],
    { home },
  );
  expect(continued.target).toMatchObject({ operationId: "s6-delete", state: "succeeded" });
  const task = await fixture.coveJson(["task", "get", taskId], { home });
  expect(task.workspace.mounts).toEqual([]);
  expect(await exists(mount.path)).toBe(false);
  expect(await gitIn(fixture, alpha.clone, "worktree", "list", "--porcelain")).not.toContain(
    mount.path,
  );
  // The branch is kept.
  expect(await alpha.git("branch", "--list", mount.branch)).toContain(mount.branch);
});

// The workspace manifest's view of a mount.
async function manifestMount(entryPath, name) {
  const manifest = JSON.parse(await readFile(join(entryPath, "cove-workspace.json"), "utf8"));
  return manifest.mounts.find((mount) => mount.name === name);
}

test("while a conversion prepares its target the checkout stays bound, and the switch waits for the task's runs", async () => {
  const home = fixture.home("home");
  const wrapper = await installWrapper();
  await fixture.startServer(home);
  const { alpha, task, mount } = await checkoutTask(home);
  const remoteMain = await alpha.push("feature.txt", "feature\n");
  const { entryPath } = task.workspace;

  // The preparation is held in its checkout step.
  await wrapper.block("checkout");
  const command = fixture.spawnCove(
    ["mount", "convert", task.taskId, mount.mountId, "--operation-id", "s6-held"],
    { home },
  );
  await wrapper.blocked("checkout");
  // Nothing about the mount changed yet: same binding, same revision, same manifest.
  const during = await fixture.coveJson(["task", "get", task.taskId], { home });
  expect(during.workspace.revision).toBe(task.workspace.revision);
  expect(during.workspace.mounts).toEqual([
    expect.objectContaining({
      mountId: mount.mountId,
      source: "checkout",
      state: "ready",
      path: alpha.clone,
    }),
  ]);
  expect(await manifestMount(entryPath, mount.name)).toMatchObject({
    source: "checkout",
    path: alpha.clone,
  });
  const history = await fixture.coveJson(["mount", "history", task.taskId, mount.mountId], {
    home,
  });
  expect(history.bindings).toEqual([
    expect.objectContaining({ source: "checkout", path: alpha.clone, unboundAtMs: null }),
  ]);
  // A run started from the entry now sees the checkout, not the unready target.
  const { tabId, run } = await liveTab(home, task.taskId, "during");
  const started = await fixture.coveJson(["tab", "get", tabId], { home });
  expect(started.latestRun.mounts).toEqual([
    { name: mount.name, source: "checkout", path: alpha.clone },
  ]);

  // The target is ready, but that run of the task still uses the checkout: not switched.
  await wrapper.release("checkout");
  let held;
  await waitFor(
    "the conversion to stop before switching",
    async () =>
      (held = await fixture.coveJson(["operation", "get", "s6-held"], { home })).state ===
      "requires_attention",
    30_000,
  );
  expect(held).toMatchObject({
    method: "binding.convert",
    error: { kind: "LIVE_RUNS_PRESENT" },
    progress: { remainingEffects: ["switch-binding"], recoveryActions: ["continue", "abandon"] },
  });
  // The stopped record names no runs; the command lists the task's live tab runs instead.
  const reported = await command.done;
  expect(reported.code).toBe(1);
  expect(reported.stderr).toContain(
    `cove: live run ${run.runId} of tab ${tabId} ("during") uses the path; stop it with ` +
      `\`cove tab stop ${tabId}\``,
  );
  const unswitched = await fixture.coveJson(["task", "get", task.taskId], { home });
  expect(unswitched.workspace.revision).toBe(task.workspace.revision);
  expect(unswitched.workspace.mounts[0]).toMatchObject({ source: "checkout", path: alpha.clone });

  // Once the run ended, continue switches the binding.
  await stopped(home, tabId);
  const continued = await fixture.coveJson(
    ["operation", "continue", "s6-held", "--operation-id", "s6-held-continue"],
    { home },
  );
  expect(continued.target).toMatchObject({
    operationId: "s6-held",
    state: "succeeded",
    result: { mounts: [{ mountId: mount.mountId, state: "ready" }] },
  });
  const after = await fixture.coveJson(["task", "get", task.taskId], { home });
  expect(after.workspace.revision).toBe(task.workspace.revision + 1);
  expect(after.workspace.mounts[0]).toMatchObject({
    mountId: mount.mountId,
    source: "worktree",
    state: "ready",
    path: join(entryPath, mount.name),
    baseCommit: remoteMain,
  });
  expect(await manifestMount(entryPath, mount.name)).toMatchObject({
    source: "worktree",
    path: join(entryPath, mount.name),
  });
});

test("a stopped conversion names only the live runs that use the checkout", async () => {
  const home = fixture.home("home");
  const wrapper = await installWrapper();
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(["task", "create", "Later checkout"], { home });
  // This run started before the checkout was mounted: its mapping does not include it, so it
  // neither blocks the switch nor belongs in the hint.
  const before = await liveTab(home, task.taskId, "before");
  const added = await fixture.coveJson(["mount", "add", task.taskId, "--checkout", alpha.repoId], {
    home,
  });
  const [mount] = added.task.workspace.mounts;
  await wrapper.block("checkout");
  const command = fixture.spawnCove(
    ["mount", "convert", task.taskId, mount.mountId, "--operation-id", "s6-filter"],
    { home },
  );
  await wrapper.blocked("checkout");
  const during = await liveTab(home, task.taskId, "during");
  await wrapper.release("checkout");
  const reported = await command.done;
  expect(reported.code).toBe(1);
  expect(reported.stderr).toContain("LIVE_RUNS_PRESENT");
  expect(reported.stderr).toContain(
    `cove: live run ${during.run.runId} of tab ${during.tabId} ("during") uses the path`,
  );
  expect(reported.stderr).not.toContain(`live run ${before.run.runId} `);
});

test("a conversion whose preparation fails leaves the checkout bound and the revision unchanged", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const { alpha, task, mount } = await checkoutTask(home);
  // The remote is unreachable: the fetch fails before anything is created.
  await alpha.git("remote", "set-url", "origin", join(fixture.root, "no-such-remote.git"));
  const result = await fixture.cove(["mount", "convert", task.taskId, mount.mountId], { home });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("FETCH_FAILED");
  const printed = JSON.parse(result.stdout);
  expect(printed.operation).toMatchObject({
    method: "binding.convert",
    state: "failed",
    result: { mounts: [{ mountId: mount.mountId, state: "failed" }] },
  });
  expect(printed.task.workspace.revision).toBe(task.workspace.revision);
  expect(printed.task.workspace.mounts).toEqual([
    expect.objectContaining({
      mountId: mount.mountId,
      source: "checkout",
      state: "ready",
      path: alpha.clone,
    }),
  ]);
  const history = await fixture.coveJson(["mount", "history", task.taskId, mount.mountId], {
    home,
  });
  expect(history.bindings).toEqual([
    expect.objectContaining({ source: "checkout", path: alpha.clone, unboundAtMs: null }),
  ]);
  expect(await exists(join(task.workspace.entryPath, mount.name))).toBe(false);
  // The checkout is still usable as the mount's cwd.
  const tab = await fixture.coveJson(
    ["tab", "create", task.taskId, "--cwd", `mount:${mount.mountId}`, "--start", "no"],
    { home },
  );
  expect(tab.operation.state).toBe("succeeded");
  // The hints convert again (the mount is still the checkout, so `mount retry` would refuse it);
  // the --no-fetch one works from the commits the clone already has.
  const convert = `cove mount convert ${task.taskId} ${mount.mountId}`;
  expect(result.stderr).toContain(`run \`${convert}\`, or create it from the commits already`);
  expect(result.stderr).not.toContain("mount retry");
  const again = await fixture.cove([...convert.split(" ").slice(1), "--no-fetch"], { home });
  expect({ code: again.code, stderr: again.stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(again.stdout).task.workspace.mounts).toEqual([
    expect.objectContaining({ mountId: mount.mountId, source: "worktree", state: "ready" }),
  ]);
});

test("no run is accepted in a worktree while its deletion waits to remove it", async () => {
  const home = fixture.home("home");
  const wrapper = await installWrapper();
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(
    ["task", "create", "Delete while busy", "--worktree", alpha.repoId],
    { home },
  );
  const [mount] = worktreeMounts(task);
  // A tab in the worktree that has no run, so it does not block the deletion; reopening it would
  // start one.
  const idle = await fixture.coveJson(
    ["tab", "create", task.taskId, "--cwd", `mount:${mount.mountId}`, "--start", "no"],
    { home },
  );
  const idleTabId = idle.operation.result.resource.id;
  // The deletion passed its run checks and is held in Git before `worktree remove --force`.
  await wrapper.block("list");
  fixture.spawnCove(
    ["mount", "delete-worktree", task.taskId, mount.mountId, "--yes", "--operation-id", "s6-busy"],
    { home },
  );
  await wrapper.blocked("list");
  // An entry tab maps every mount of the workspace, the worktree among them; a terminal run would
  // start in it. Both are refused while the deletion is pending.
  const entryTab = await fixture.cove(
    ["tab", "create", task.taskId, "--", process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { home },
  );
  expect(entryTab.code).toBe(1);
  expect(entryTab.stderr).toContain("OPERATION_EFFECTS_ACTIVE");
  // A tab whose cwd is the worktree is refused for the same reason, not as an invalid cwd: it can
  // be retried once the deletion ended.
  const mountTab = await fixture.cove(
    ["tab", "create", task.taskId, "--cwd", `mount:${mount.mountId}`, "--start", "no"],
    { home },
  );
  expect(mountTab.code).toBe(1);
  expect(mountTab.stderr).toContain("OPERATION_EFFECTS_ACTIVE");
  const reopened = await fixture.cove(["tab", "reopen", idleTabId], { home });
  expect(reopened.code).toBe(1);
  expect(reopened.stderr).toContain("OPERATION_EFFECTS_ACTIVE");
  const terminal = await fixture.cove(
    [
      "terminal",
      "create",
      "--cwd",
      mount.path,
      "--",
      process.execPath,
      "-e",
      "setInterval(() => {}, 1000)",
    ],
    { home },
  );
  expect(terminal.code).toBe(1);
  expect(terminal.stderr).toContain("OPERATION_EFFECTS_ACTIVE");

  await wrapper.release("list");
  let deleted;
  await waitFor(
    "the deletion to end",
    async () =>
      (deleted = await fixture.coveJson(["operation", "get", "s6-busy"], { home })).state !==
      "running",
    30_000,
  );
  expect(deleted.state).toBe("succeeded");
  expect(await exists(mount.path)).toBe(false);
  // Runs are accepted again once it ended.
  const after = await fixture.coveJson(["tab", "create", task.taskId, "--start", "no"], { home });
  expect(after.operation.state).toBe("succeeded");
});

// A task with one worktree and an alias of its workspace entry that exists before any of this
// (like macOS /tmp for /private/tmp): the same directory under another spelling. `terminal`
// starts a long-running terminal run in the worktree through the alias.
async function aliasedWorktree(home) {
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(
    ["task", "create", "Aliased", "--worktree", alpha.repoId],
    { home },
  );
  const [mount] = worktreeMounts(task);
  const alias = join(fixture.root, "alias");
  await symlink(task.workspace.entryPath, alias);
  const terminal = () =>
    fixture.cove(
      [
        "terminal",
        "create",
        "--cwd",
        join(alias, mount.name),
        "--",
        process.execPath,
        "-e",
        "setInterval(() => {}, 1000)",
      ],
      { home },
    );
  return { task, mount, terminal };
}

test("a terminal run started through a path alias of the worktree blocks its deletion", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const { task, mount, terminal } = await aliasedWorktree(home);
  const started = await terminal();
  expect(started.code).toBe(0);
  const run = JSON.parse(started.stdout);
  const busy = await fixture.cove(
    ["mount", "delete-worktree", task.taskId, mount.mountId, "--yes"],
    { home },
  );
  expect(busy.code).toBe(1);
  expect(busy.stderr).toContain("LIVE_RUNS_PRESENT");
  // A run of `terminal create` belongs to no tab.
  expect(busy.stderr).toContain(
    `cove: live run ${run.runId} (a terminal run, in no tab of the task) uses the path; stop ` +
      `it with \`cove terminal stop ${run.runId}\``,
  );
  expect(await exists(mount.path)).toBe(true);
  await fixture.coveJson(["terminal", "stop", run.runId], { home });
});

test("a terminal run through a path alias is refused while the worktree is being deleted", async () => {
  const home = fixture.home("home");
  const wrapper = await installWrapper();
  await fixture.startServer(home);
  const { task, mount, terminal } = await aliasedWorktree(home);
  // The deletion passed its run checks and is held in Git before `worktree remove --force`.
  await wrapper.block("list");
  fixture.spawnCove(
    ["mount", "delete-worktree", task.taskId, mount.mountId, "--yes", "--operation-id", "s6-alias"],
    { home },
  );
  await wrapper.blocked("list");
  const refused = await terminal();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("OPERATION_EFFECTS_ACTIVE");
  await wrapper.release("list");
  let deleted;
  await waitFor(
    "the deletion to end",
    async () =>
      (deleted = await fixture.coveJson(["operation", "get", "s6-alias"], { home })).state !==
      "running",
    30_000,
  );
  expect(deleted.state).toBe("succeeded");
  expect(await exists(mount.path)).toBe(false);
});
