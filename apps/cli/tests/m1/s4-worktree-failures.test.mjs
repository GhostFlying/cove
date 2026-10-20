import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createM1Fixture } from "./fixtures.mjs";
import { registeredRemote, worktreeMounts } from "./s3-worktree-remotes.mjs";

// S4 (docs/milestones/m1.md): a worktree creation that fails for one repo reports every repo's
// outcome, keeps what succeeded, and is retried per mount once the cause is fixed; a failed fetch
// or an unresolvable main branch creates nothing and names the explicit way out.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

const absent = (path) =>
  stat(path).then(
    () => false,
    (error) => error.code === "ENOENT",
  );

// A `git` on the server's PATH that, once armed, writes an untracked README.md into the worktree
// right before Cove's checkout (`read-tree -m -u HEAD`, run in the worktree): the checkout refuses
// to overwrite it and plain `git worktree remove` refuses to remove it, so the failed attempt
// leaves its worktree and branch in place, as when someone's work got there first. Installed
// before the server starts.
async function plantingGit() {
  const real = await new Promise((done, fail) =>
    execFile("/bin/sh", ["-c", "command -v git"], { env: fixture.env }, (error, stdout) =>
      error ? fail(error) : done(stdout.trim()),
    ),
  );
  const bin = join(fixture.root, "planting-git");
  const armed = join(fixture.root, "plant-armed");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
case "$*" in
  *"read-tree -m -u HEAD"*)
    if [ -e "${armed}" ]; then rm -f "${armed}"; echo planted > README.md; fi ;;
esac
exec "${real}" "$@"
`,
  );
  await chmod(join(bin, "git"), 0o755);
  fixture.env.PATH = `${bin}:${fixture.env.PATH}`;
  return { arm: () => writeFile(armed, "") };
}

// The commands the hints name, in order.
const hinted = (stderr) => [...stderr.matchAll(/`([^`]*)`/g)].map((match) => match[1]);

test("an existing branch fails one repo, the other keeps its worktree, a resend returns the record and a retry finishes it", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const beta = await registeredRemote(fixture, home, "beta");
  await beta.git("branch", "taken");
  const args = [
    "task",
    "create",
    "Partial",
    "--worktree",
    `${alpha.repoId},branch=taken`,
    "--worktree",
    `${beta.repoId},branch=taken`,
    "--operation-id",
    "s4-partial",
  ];
  const first = await fixture.cove(args, { home });
  expect(first.code).toBe(1);
  expect(first.stderr).toContain("task.create s4-partial failed: BRANCH_EXISTS");
  expect(first.stderr).toContain("--branch NEW");
  const { operation, task } = JSON.parse(first.stdout);
  const [a, b] = worktreeMounts(task);
  expect(operation).toMatchObject({ state: "failed", error: { kind: "BRANCH_EXISTS" } });
  expect(operation.result.mounts).toEqual([
    { mountId: a.mountId, state: "ready" },
    { mountId: b.mountId, state: "failed", errorKind: "BRANCH_EXISTS" },
  ]);
  expect(a.state).toBe("ready");
  expect(b).toMatchObject({ state: "failed", error: { kind: "BRANCH_EXISTS" } });
  expect(await absent(b.path)).toBe(true);
  // The existing branch is not Cove's and stays where it was.
  expect(await beta.git("rev-parse", "taken")).toBe(await beta.git("rev-parse", "HEAD"));
  // The same request, sent again, answers with the recorded outcome and creates nothing.
  for (const again of [
    await fixture.cove(args, { home }),
    await fixture.cove(["operation", "resend", "s4-partial"], { home }),
  ]) {
    const output = JSON.parse(again.stdout);
    expect(output.operation ?? output).toEqual(operation);
  }
  expect((await alpha.git("worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(
    2,
  );
  // Fixing the cause: the retry reuses the mount's own spec.
  await beta.git("branch", "-D", "taken");
  const retried = await fixture.coveJson(
    ["mount", "retry", task.taskId, b.mountId, "--operation-id", "s4-retry"],
    { home },
  );
  expect(retried.operation).toMatchObject({ method: "mount.retry", state: "succeeded" });
  const fixed = worktreeMounts(retried.task).find((mount) => mount.mountId === b.mountId);
  expect(fixed).toMatchObject({ state: "ready", branch: "taken" });
  expect(await beta.git("-C", fixed.path, "symbolic-ref", "--short", "HEAD")).toBe("taken");
  // A ready mount is not retried.
  const ready = await fixture.cove(["mount", "retry", task.taskId, a.mountId], { home });
  expect(ready.code).not.toBe(0);
});

test("an unreachable remote fails with FETCH_FAILED, creates nothing and is retried with --no-fetch", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  await alpha.git("remote", "set-url", "origin", join(fixture.root, "no-such-remote.git"));
  const failed = await fixture.cove(
    ["task", "create", "Offline", "--worktree", alpha.repoId, "--operation-id", "s4-fetch"],
    { home },
  );
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain("FETCH_FAILED");
  expect(failed.stderr).toContain("--no-fetch");
  const { task } = JSON.parse(failed.stdout);
  const [mount] = worktreeMounts(task);
  expect(mount).toMatchObject({ state: "failed", error: { kind: "FETCH_FAILED" } });
  expect(await absent(mount.path)).toBe(true);
  expect(await alpha.git("branch", "--list", "cove/*")).toBe("");
  expect((await alpha.git("worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(
    1,
  );
  // Without --no-fetch the retry fails the same way; with it, it uses the commits fetched before.
  const again = await fixture.cove(["mount", "retry", task.taskId, mount.mountId], { home });
  expect(again.stderr).toContain("FETCH_FAILED");
  const retried = await fixture.coveJson(
    ["mount", "retry", task.taskId, mount.mountId, "--no-fetch"],
    { home },
  );
  expect(retried.operation.state).toBe("succeeded");
  expect(worktreeMounts(retried.task)[0]).toMatchObject({
    state: "ready",
    baseCommit: await alpha.git("rev-parse", "refs/remotes/origin/main"),
  });
});

test("an unresolvable main branch fails with MAIN_BRANCH_UNRESOLVED and is retried with --base", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha", { branch: "work" });
  await alpha.git("remote", "set-head", "origin", "--delete");
  const failed = await fixture.cove(
    ["task", "create", "No main", "--worktree", `${alpha.repoId},no-fetch`],
    { home },
  );
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain("MAIN_BRANCH_UNRESOLVED");
  expect(failed.stderr).toContain("--base REF");
  const { task } = JSON.parse(failed.stdout);
  const [mount] = worktreeMounts(task);
  expect(await absent(mount.path)).toBe(true);
  const retried = await fixture.coveJson(
    ["mount", "retry", task.taskId, mount.mountId, "--base", "origin/work"],
    { home },
  );
  expect(worktreeMounts(retried.task)[0]).toMatchObject({
    state: "ready",
    baseCommit: await alpha.git("rev-parse", "refs/remotes/origin/work"),
  });
});

test("a retry removes what a failed attempt left at the path once Git can, and says how until then (#126 item 4)", async () => {
  const planting = await plantingGit();
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  await planting.arm();
  const created = await fixture.cove(["task", "create", "Stranded", "--worktree", alpha.repoId], {
    home,
  });
  expect(created.code).toBe(1);
  const { task } = JSON.parse(created.stdout);
  const [mount] = worktreeMounts(task);
  expect(JSON.parse(created.stdout).operation.result.mounts).toEqual([
    {
      mountId: mount.mountId,
      state: "failed",
      errorKind: "GIT_UNAVAILABLE",
      left: "both",
      branch: "cove/Stranded",
    },
  ]);
  // Git still refuses to remove the worktree: the retry is accepted, tries, and fails naming what
  // holds the path and the ways out. The leftover's branch makes the retry choose the next name.
  const held = await fixture.cove(["mount", "retry", task.taskId, mount.mountId], { home });
  expect(held.code).toBe(1);
  const printed = JSON.parse(held.stdout);
  expect(printed.operation).toMatchObject({
    method: "mount.retry",
    state: "failed",
    result: {
      mounts: [
        {
          mountId: mount.mountId,
          state: "failed",
          errorKind: "MOUNT_NAME_CONFLICT",
          left: "both",
          branch: "cove/Stranded",
        },
      ],
    },
  });
  const repo = printed.leftovers[0].repoPath;
  expect(hinted(held.stderr)).toEqual([
    `cove mount retry ${task.taskId} ${mount.mountId}`,
    `cove mount delete-worktree ${task.taskId} ${mount.mountId}`,
    `git -C ${repo} worktree remove ${mount.path}`,
    `git -C ${repo} branch -d cove/Stranded`,
  ]);
  expect(await readFile(join(mount.path, "README.md"), "utf8")).toBe("planted\n");
  // Once nothing in it would be lost, the retry the hint names removes the leftover and finishes.
  await rm(join(mount.path, "README.md"));
  const retried = await fixture.cove(hinted(held.stderr)[0].split(" ").slice(1), { home });
  expect({ code: retried.code, stderr: retried.stderr }).toEqual({ code: 0, stderr: "" });
  const fixed = worktreeMounts(JSON.parse(retried.stdout).task)[0];
  expect(fixed).toMatchObject({ state: "ready", path: mount.path, branch: "cove/Stranded-2" });
  expect(await readFile(join(mount.path, "README.md"), "utf8")).toBe("alpha\n");
  // The leftover's branch went with it.
  expect(await alpha.git("for-each-ref", "--format=%(refname:short)", "refs/heads/cove/")).toBe(
    "cove/Stranded-2",
  );
});

test("a conversion whose target Git does not remove names the branch it left in place (#132)", async () => {
  const planting = await plantingGit();
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(
    ["task", "create", "Leftover", "--checkout", alpha.repoId],
    { home },
  );
  const [checkout] = task.workspace.mounts;
  const target = join(task.workspace.entryPath, checkout.name);
  await planting.arm();
  const failed = await fixture.cove(["mount", "convert", task.taskId], { home });
  expect(failed.code).toBe(1);
  const printed = JSON.parse(failed.stdout);
  expect(printed.operation).toMatchObject({
    method: "binding.convert",
    state: "failed",
    result: {
      mounts: [
        {
          mountId: checkout.mountId,
          state: "failed",
          errorKind: "GIT_UNAVAILABLE",
          left: "both",
          branch: "cove/Leftover",
        },
      ],
    },
  });
  expect(printed.leftovers).toEqual([
    {
      mountId: checkout.mountId,
      path: target,
      branch: "cove/Leftover",
      repoPath: expect.any(String),
      effects: ["worktree", "branch"],
    },
  ]);
  const repo = printed.leftovers[0].repoPath;
  expect(hinted(failed.stderr)).toEqual(
    expect.arrayContaining([
      `git -C ${repo} worktree remove ${target}`,
      `git -C ${repo} branch -d cove/Leftover`,
    ]),
  );
  expect(failed.stderr).not.toContain("<branch>");
  // Nothing of the planted work was removed, and the checkout stays mounted.
  expect(await readFile(join(target, "README.md"), "utf8")).toBe("planted\n");
  expect(printed.task.workspace.mounts[0]).toMatchObject({ source: "checkout", state: "ready" });
});
