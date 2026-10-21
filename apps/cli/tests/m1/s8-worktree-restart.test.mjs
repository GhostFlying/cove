import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { createM1Fixture } from "./fixtures.mjs";
import { registeredRemote, worktreeMounts } from "./s3-worktree-remotes.mjs";

// S8 (docs/milestones/m1.md): the server is killed (kill -9) while a Git step of a worktree
// creation runs. The step's process group outlives the server; after the restart the operation is
// requires_attention with what its ledger recorded, continue and abandon are refused while the
// recorded process may still run, and once it ended they verify what that step did (the branch by
// its shape, the worktree by its contents) and go on without repeating a step. The Git step is held by a wrapper on the server's PATH that blocks one chosen command
// until the scenario releases it.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

function realGit() {
  return new Promise((done, fail) =>
    execFile("/bin/sh", ["-c", "command -v git"], { env: fixture.env }, (error, stdout) =>
      error ? fail(error) : done(stdout.trim()),
    ),
  );
}

// A `git` on the server's PATH that blocks the step named in <control>/block (branch, worktree
// or checkout) until <control>/release exists, then execs the real git with the same PID (the
// PID the server recorded). Every other command goes straight to the real git.
async function installWrapper() {
  const control = join(fixture.root, "git-control");
  const bin = join(fixture.root, "git-bin");
  await mkdir(control, { recursive: true });
  await mkdir(bin, { recursive: true });
  const script = `#!/bin/sh
case "$*" in
  *"update-ref --no-deref --create-reflog -m cove: create worktree branch"*) step=branch ;;
  *"worktree add --no-checkout"*) step=worktree ;;
  *"read-tree -m -u HEAD"*) step=checkout ;;
  *) step= ;;
esac
if [ -n "$step" ] && [ "$(cat "${control}/block" 2>/dev/null)" = "$step" ]; then
  echo $$ > "${control}/blocked.pid"
  while [ ! -e "${control}/release" ]; do /bin/sleep 0.1; done
fi
exec "${await realGit()}" "$@"
`;
  await writeFile(join(bin, "git"), script);
  await chmod(join(bin, "git"), 0o755);
  fixture.env.PATH = `${bin}:${fixture.env.PATH}`;
  return {
    block: (step) => writeFile(join(control, "block"), step),
    release: () => writeFile(join(control, "release"), ""),
    blockedPid: () =>
      readFile(join(control, "blocked.pid"), "utf8").then(
        (text) => Number(text.trim()),
        () => null,
      ),
  };
}

const alive = (pid) =>
  fixture.signalTracked(pid, 0).then(
    () => true,
    () => false,
  );

// Starts a creation, holds it at `step`, kills the server and restarts it. Returns what the
// scenario needs to go on.
async function interruptedAt(step) {
  const home = fixture.home("home");
  const wrapper = await installWrapper();
  const first = await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  await wrapper.block(step);
  const operationId = `s8-${step}`;
  fixture.spawnCove(
    ["task", "create", "Interrupted", "--worktree", alpha.repoId, "--operation-id", operationId],
    { home },
  );
  let pid = null;
  await waitFor(
    "the held Git step",
    async () => (pid = await wrapper.blockedPid()) !== null,
    30_000,
  );
  await fixture.trackPid(pid);
  await fixture.killServer(first);
  // The step's process group outlived the server.
  expect(await alive(pid)).toBe(true);
  await fixture.startServer(home);
  const target = await fixture.coveJson(["operation", "get", operationId], { home });
  return { home, wrapper, alpha, pid, operationId, target };
}

async function refusedWhileActive(home, operationId) {
  for (const verb of ["continue", "abandon"]) {
    const result = await fixture.cove(
      ["operation", verb, operationId, "--operation-id", `${operationId}-${verb}`],
      { home },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("OPERATION_EFFECTS_ACTIVE");
  }
  const still = await fixture.coveJson(["operation", "get", operationId], { home });
  expect(still.state).toBe("requires_attention");
}

async function released(wrapper, pid) {
  await wrapper.release();
  await waitFor("the held Git step to finish", async () => !(await alive(pid)), 30_000);
}

const count = (text, pattern) => (text.match(pattern) ?? []).length;

test("killed during the branch step: requires_attention, refused while git runs, then continue finishes it without repeating a step", async () => {
  const { home, wrapper, alpha, pid, operationId, target } = await interruptedAt("branch");
  expect(target).toMatchObject({
    method: "task.create",
    state: "requires_attention",
    error: { kind: "RESULT_UNKNOWN" },
    progress: {
      completedSteps: ["fetch", "base", "intent"],
      recoveryActions: ["continue", "abandon"],
    },
  });
  expect(target.progress.remainingEffects).toEqual(
    expect.arrayContaining(["branch", "worktree", "checkout", "record", "git-process"]),
  );
  await refusedWhileActive(home, operationId);
  await released(wrapper, pid);
  // The refused continue was not accepted; the same request may be sent again now.
  const continued = await fixture.coveJson(
    ["operation", "continue", operationId, "--operation-id", `${operationId}-continue`],
    { home },
  );
  expect(continued.operation).toMatchObject({
    method: "operation.continue",
    state: "succeeded",
    result: { targetOperationId: operationId },
  });
  expect(continued.target).toMatchObject({ operationId, state: "succeeded" });
  // The branch the released step created was verified by its shape and used, not created again.
  expect(count(await alpha.git("branch", "--list", "cove/*"), /cove\//g)).toBe(1);
  expect(count(await alpha.git("worktree", "list", "--porcelain"), /^worktree /gm)).toBe(2);
  const resent = await fixture.coveJson(["operation", "resend", operationId], { home });
  expect(resent).toMatchObject({ operationId, state: "succeeded" });
  const task = await fixture.coveJson(["task", "get", resent.result.resource.id], { home });
  expect(worktreeMounts(task)[0].state).toBe("ready");
});

test("killed during the worktree step: abandon removes the unchecked worktree and the branch", async () => {
  const { home, wrapper, alpha, pid, operationId, target } = await interruptedAt("worktree");
  expect(target).toMatchObject({
    state: "requires_attention",
    progress: { completedSteps: ["fetch", "base", "intent", "branch"] },
  });
  await refusedWhileActive(home, operationId);
  await released(wrapper, pid);
  const abandoned = await fixture.coveJson(
    ["operation", "abandon", operationId, "--operation-id", `${operationId}-abandon`],
    { home },
  );
  expect(abandoned.operation).toMatchObject({ method: "operation.abandon", state: "succeeded" });
  expect(abandoned.target).toMatchObject({
    state: "cancelled",
    progress: { remainingEffects: [] },
  });
  expect(abandoned.leftovers).toEqual([]);
  expect(await alpha.git("branch", "--list", "cove/*")).toBe("");
  expect(count(await alpha.git("worktree", "list", "--porcelain"), /^worktree /gm)).toBe(1);
  const task = await fixture.coveJson(["task", "get", target.result.resource.id], { home });
  expect(worktreeMounts(task)[0]).toMatchObject({
    state: "failed",
    error: { kind: "OPERATION_NOT_RESUMABLE" },
  });
  // A resend returns the cancelled record; nothing is created again.
  const resent = await fixture.coveJson(["operation", "resend", operationId], { home });
  expect(resent.state).toBe("cancelled");
  expect(await alpha.git("branch", "--list", "cove/*")).toBe("");
});

test("killed during the checkout step: abandon leaves a worktree with changes and its branch in place", async () => {
  const { home, wrapper, alpha, pid, operationId, target } = await interruptedAt("checkout");
  expect(target).toMatchObject({
    state: "requires_attention",
    progress: { completedSteps: ["fetch", "base", "intent", "branch", "worktree"] },
  });
  await refusedWhileActive(home, operationId);
  await released(wrapper, pid);
  const task = await fixture.coveJson(["task", "get", target.result.resource.id], { home });
  const [mount] = worktreeMounts(task);
  // Someone's work in the worktree since: the checkout cannot be proven complete any more, and the
  // worktree is not Cove's to remove.
  await writeFile(join(mount.path, "notes.txt"), "work in progress\n");
  const result = await fixture.cove(
    ["operation", "abandon", operationId, "--operation-id", `${operationId}-abandon`],
    { home },
  );
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("left in place: worktree, branch");
  const printed = JSON.parse(result.stdout);
  expect(printed.target).toMatchObject({
    state: "cancelled",
    progress: { remainingEffects: ["worktree", "branch"] },
    result: { mounts: [{ mountId: mount.mountId, state: "failed", left: "both" }] },
  });
  // What is left, where to find it, and how to remove it by hand once checked; Cove runs neither.
  const repoPath = await alpha.git("rev-parse", "--show-toplevel");
  expect(printed.leftovers).toEqual([
    {
      mountId: mount.mountId,
      path: mount.path,
      branch: mount.branch,
      repoPath: expect.any(String),
      effects: ["worktree", "branch"],
    },
  ]);
  expect(await realpath(printed.leftovers[0].repoPath)).toBe(await realpath(repoPath));
  expect(result.stderr).toContain(
    `\`git -C ${printed.leftovers[0].repoPath} worktree remove ${mount.path}\`, then ` +
      `\`git -C ${printed.leftovers[0].repoPath} branch -d ${mount.branch}\``,
  );
  expect(await readFile(join(mount.path, "notes.txt"), "utf8")).toBe("work in progress\n");
  expect(count(await alpha.git("branch", "--list", "cove/*"), /cove\//g)).toBe(1);
});

test("recovery hints offer exactly the actions the server advertises, and the leftovers' commands", async () => {
  const { operationHints } = await import("../../dist/commands/_workspace.js");
  const attention = (operationId, method, recoveryActions) => ({
    operationId,
    method,
    state: "requires_attention",
    progress: { completedSteps: [], remainingEffects: [], recoveryActions },
  });
  // The target of a create: both continue and abandon.
  expect(operationHints(attention("c", "task.create", ["continue", "abandon"]))).toEqual([
    "inspect it with `cove operation get c`, then `cove operation continue c` or " +
      "`cove operation abandon c`",
  ]);
  // An abandon that could not finish is continued, never abandoned.
  expect(operationHints(attention("a", "operation.abandon", ["continue"]))).toEqual([
    "inspect it with `cove operation get a`, then `cove operation continue a`",
  ]);
  expect(operationHints(attention("x", "task.create", []))).toEqual([
    "inspect it with `cove operation get x`",
  ]);
  // Paths that need it are quoted for the shell.
  const { leftoverHints } = await import("../../dist/commands/_workspace.js");
  expect(
    leftoverHints([
      {
        mountId: "m",
        path: "/tmp/a b",
        branch: "cove/x",
        repoPath: "/r/it's",
        effects: ["worktree"],
      },
      { mountId: "n", path: null, branch: null, repoPath: null, effects: ["branch"] },
    ]),
  ).toEqual([
    "mount m: left in place (worktree), not removed because deleting it could lose work; " +
      "check it, then " +
      "remove it yourself if it is not needed: `git -C '/r/it'\\''s' worktree remove '/tmp/a b'`",
    "mount n: left in place (branch), not removed because deleting it could lose work; " +
      "check it, then " +
      "remove it yourself if it is not needed: `git -C <repo> branch -d <branch>`",
  ]);
});

test("an accepted continue or abandon whose outcome cannot be read still prints its receipt (#126 item 11)", async () => {
  // The compiled ending of continue/abandon after the server accepted the write, with a client
  // whose reads fail: stdout used to be empty although the write was accepted. The receipt is
  // printed with `targetReadError` (no target or leftovers, which the failed read says nothing
  // about), stderr names both operations, and the exit is 1.
  const { finishAction } = await import("../../dist/commands/operation.js");
  const failing = {
    ok: false,
    kind: "local-error",
    error: { category: "transport", reason: "connection-closed" },
  };
  const client = { getOperation: async () => failing };
  const capture = async (accepted) => {
    const stdout = [];
    const stderr = [];
    const out = process.stdout.write;
    const err = process.stderr.write;
    process.stdout.write = (chunk) => stdout.push(String(chunk)) > 0;
    process.stderr.write = (chunk) => stderr.push(String(chunk)) > 0;
    let code;
    try {
      code = await finishAction(client, accepted, "target-1");
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    return { code, stdout: JSON.parse(stdout.join("")), stderr: stderr.join("") };
  };
  // continue settled, then the target's operation.get fails.
  const continued = {
    operationId: "continue-1",
    method: "operation.continue",
    revision: 1,
    state: "succeeded",
  };
  const afterContinue = await capture(continued);
  expect(afterContinue.code).toBe(1);
  expect(afterContinue.stdout).toEqual({
    operation: continued,
    targetReadError: "operation.get failed: transport connection-closed",
  });
  expect(afterContinue.stderr).toContain("operation.continue continue-1 was accepted");
  expect(afterContinue.stderr).toContain("the outcome of target-1 is unknown");
  expect(afterContinue.stderr).toContain("`cove operation get target-1`");
  // abandon accepted while running, then polling its own state fails.
  const abandoning = {
    operationId: "abandon-1",
    method: "operation.abandon",
    revision: 0,
    state: "running",
  };
  const afterAbandon = await capture(abandoning);
  expect(afterAbandon.code).toBe(1);
  expect(afterAbandon.stdout.operation).toEqual(abandoning);
  expect(afterAbandon.stdout.targetReadError).toContain(
    "operation abandon-1 was accepted, but polling its state failed",
  );
  expect(afterAbandon.stdout).not.toHaveProperty("target");
  expect(afterAbandon.stderr).toContain("`cove operation get abandon-1`");
});

test("a continue or abandon whose poll fails after a successful one prints the last record read (#144 item 5)", async () => {
  // The compiled ending of continue/abandon: the first poll reads a newer record (revision 1,
  // still running), the next read fails. The output used to be the revision-0 receipt the write
  // was accepted with; it is the last record read.
  const { finishAction } = await import("../../dist/commands/operation.js");
  const accepted = {
    operationId: "abandon-2",
    method: "operation.abandon",
    revision: 0,
    state: "accepted",
  };
  const seen = { ...accepted, revision: 1, state: "running" };
  const failing = {
    ok: false,
    kind: "local-error",
    error: { category: "transport", reason: "connection-closed" },
  };
  const reads = [{ ok: true, value: { operation: seen } }];
  const client = { getOperation: async () => reads.shift() ?? failing };
  const stdout = [];
  const stderr = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (chunk) => stdout.push(String(chunk)) > 0;
  process.stderr.write = (chunk) => stderr.push(String(chunk)) > 0;
  let code;
  try {
    code = await finishAction(client, accepted, "target-2");
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  expect(code).toBe(1);
  const printed = JSON.parse(stdout.join(""));
  expect(printed.operation).toEqual(seen);
  expect(printed.targetReadError).toContain(
    "operation abandon-2 was accepted, but polling its state failed",
  );
  expect(stderr.join("")).toContain("(last seen running)");
});
