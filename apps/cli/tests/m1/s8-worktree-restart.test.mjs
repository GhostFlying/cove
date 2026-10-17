import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { createM1Fixture } from "./fixtures.mjs";
import { registeredRemote, worktreeMounts } from "./s3-worktree-remotes.mjs";

// S8 (docs/milestones/m1.md): the server is killed (kill -9) while a Git step of a worktree
// creation runs. The step's process group outlives the server; after the restart the operation is
// requires_attention with what was observed, continue and abandon are refused while the recorded
// process may still run, and once it ended they act on a fresh observation without repeating a
// step. The Git step is held by a wrapper on the server's PATH that blocks one chosen command
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
  *"update-ref -m cove: create worktree branch"*) step=branch ;;
  *"worktree add --no-checkout"*) step=worktree ;;
  *"read-tree --reset -u HEAD"*) step=checkout ;;
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
    progress: { completedSteps: ["intent"], recoveryActions: ["continue", "abandon"] },
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
  // The branch the released step created was used, not created again.
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
    progress: { completedSteps: ["intent", "branch"] },
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
    progress: { completedSteps: ["intent", "branch", "worktree"] },
  });
  await refusedWhileActive(home, operationId);
  await released(wrapper, pid);
  const task = await fixture.coveJson(["task", "get", target.result.resource.id], { home });
  const [mount] = worktreeMounts(task);
  // Someone's work in the worktree since: not Cove's to remove.
  await writeFile(join(mount.path, "notes.txt"), "work in progress\n");
  const result = await fixture.cove(
    ["operation", "abandon", operationId, "--operation-id", `${operationId}-abandon`],
    { home },
  );
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("left in place: worktree, branch");
  expect(JSON.parse(result.stdout).target).toMatchObject({
    state: "cancelled",
    progress: { remainingEffects: ["worktree", "branch"] },
  });
  expect(await readFile(join(mount.path, "notes.txt"), "utf8")).toBe("work in progress\n");
  expect(count(await alpha.git("branch", "--list", "cove/*"), /cove\//g)).toBe(1);
});
