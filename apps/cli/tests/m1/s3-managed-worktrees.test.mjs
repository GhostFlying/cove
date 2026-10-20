import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createM1Fixture } from "./fixtures.mjs";
import { registeredRemote, worktreeMounts } from "./s3-worktree-remotes.mjs";

// S3 (docs/milestones/m1.md): a feature task across several repos creates one managed worktree per
// repo from each remote's freshly fetched main branch, through the compiled `cove` CLI and server;
// the source clones are left alone. Every remote is a local bare repository in the fixture's root.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

async function refused(args, home, kind) {
  const result = await fixture.cove(args, { home });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(kind);
  return result;
}

test("a multi-repo task creates a worktree per repo from each remote's new main commit and leaves the sources alone", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const beta = await registeredRemote(fixture, home, "beta", { branch: "master" });
  // Commits on the remotes that the clones have not fetched.
  const alphaHead = await alpha.push("feature.txt", "alpha\n");
  const betaHead = await beta.push("feature.txt", "beta\n");
  const alphaSource = await alpha.git("rev-parse", "HEAD");
  const alphaStatus = await alpha.git("status", "--porcelain");
  expect(alphaSource).not.toBe(alphaHead);

  const { operation, task } = await fixture.coveJson(
    [
      "task",
      "create",
      "Cross repo feature",
      "--worktree",
      alpha.repoId,
      "--worktree",
      `${beta.repoId},name=be,branch=feature/beta`,
      "--operation-id",
      "s3-create",
    ],
    { home },
  );
  expect(operation).toMatchObject({ method: "task.create", state: "succeeded" });
  expect(operation.result.mounts.map((mount) => mount.state)).toEqual(["ready", "ready"]);
  const [a, b] = worktreeMounts(task);
  const { entryPath } = task.workspace;
  expect(a).toMatchObject({
    name: "alpha",
    source: "worktree",
    repoId: alpha.repoId,
    state: "ready",
    path: join(entryPath, "alpha"),
    entryPath: join(entryPath, "alpha"),
    branch: `cove/${task.slug}`,
    baseCommit: alphaHead,
  });
  expect(b).toMatchObject({ name: "be", branch: "feature/beta", baseCommit: betaHead });
  // Each worktree is checked out at the remote's new commit on its own branch, clean.
  for (const [mount, head] of [
    [a, alphaHead],
    [b, betaHead],
  ]) {
    const git = (...args) => alpha.git("-C", mount.path, ...args);
    expect(await git("rev-parse", "HEAD")).toBe(head);
    expect(await git("symbolic-ref", "--short", "HEAD")).toBe(mount.branch);
    expect(await git("status", "--porcelain")).toBe("");
    expect(await readFile(join(mount.path, "feature.txt"), "utf8")).toMatch(/alpha|beta/);
  }
  // The source clone's own checkout did not move; the fetch only updated origin/*.
  expect(await alpha.git("rev-parse", "HEAD")).toBe(alphaSource);
  expect(await alpha.git("status", "--porcelain")).toBe(alphaStatus);
  expect(await alpha.git("rev-parse", "refs/remotes/origin/main")).toBe(alphaHead);
  // The manifest names every mount by its real path.
  const manifest = JSON.parse(await readFile(join(entryPath, "cove-workspace.json"), "utf8"));
  expect(JSON.stringify(manifest)).toContain(a.path);
  expect(JSON.stringify(manifest)).toContain(b.path);
});

test("the base follows the main-branch setting, origin/HEAD, the remote's HEAD, the candidates and --base, never the local HEAD", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(["task", "create", "Bases"], { home });
  const add = async (name, spec) => {
    const output = await fixture.coveJson(
      [
        "mount",
        "add",
        task.taskId,
        "--worktree",
        `${alpha.repoId},name=${name},branch=${name}${spec}`,
      ],
      { home },
    );
    expect(output.operation.state).toBe("succeeded");
    return output.task.workspace.mounts.find((mount) => mount.name === name);
  };
  const main = await alpha.push("main.txt", "main\n");
  const release = await alpha.push("release.txt", "release\n", "release");
  // 1. The repo's main-branch setting.
  await fixture.coveJson(["repo", "set", alpha.repoId, "mainBranch", "release"], { home });
  expect((await add("setting", "")).baseCommit).toBe(release);
  // A setting the remote does not have is not replaced by another branch.
  await fixture.coveJson(["repo", "set", alpha.repoId, "mainBranch", "gone"], { home });
  const unresolved = await fixture.cove(
    ["mount", "add", task.taskId, "--worktree", `${alpha.repoId},name=gone,branch=gone`],
    { home },
  );
  expect(unresolved.code).toBe(1);
  expect(unresolved.stderr).toContain("MAIN_BRANCH_UNRESOLVED");
  await fixture.coveJson(["repo", "reset", alpha.repoId, "mainBranch"], { home });
  // 2. origin/HEAD (set by the clone).
  expect((await add("origin-head", "")).baseCommit).toBe(main);
  // 3. Without origin/HEAD, the remote's HEAD, which now names release.
  await alpha.git("remote", "set-head", "origin", "--delete");
  await alpha.git("--git-dir", alpha.remote, "symbolic-ref", "HEAD", "refs/heads/release");
  expect((await add("remote-head", "")).baseCommit).toBe(release);
  // 4. --no-fetch does not ask the remote: the candidates, main first.
  expect((await add("candidate", ",no-fetch")).baseCommit).toBe(main);
  // 5. An explicit base wins over everything.
  expect((await add("explicit", ",base=origin/release,no-fetch")).baseCommit).toBe(release);
  // Never the local HEAD: with no candidate left, the mount fails although HEAD exists.
  await alpha.git("update-ref", "-d", "refs/remotes/origin/main");
  await alpha.git("update-ref", "-d", "refs/remotes/origin/release");
  const none = await fixture.cove(
    ["mount", "add", task.taskId, "--worktree", `${alpha.repoId},name=none,branch=none,no-fetch`],
    { home },
  );
  expect(none.code).toBe(1);
  expect(none.stderr).toContain("MAIN_BRANCH_UNRESOLVED");
  expect(none.stderr).toContain("--base REF");
});

test("a trunk-only remote resolves to its tracking branch", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha", { branch: "trunk" });
  await alpha.git("remote", "set-head", "origin", "--delete");
  const trunk = await alpha.git("rev-parse", "refs/remotes/origin/trunk");
  const { task } = await fixture.coveJson(
    ["task", "create", "Trunk", "--worktree", `${alpha.repoId},no-fetch`],
    { home },
  );
  expect(worktreeMounts(task)[0]).toMatchObject({ state: "ready", baseCommit: trunk });
});

test("a managed worktree cannot be mounted as a checkout, also after its task is archived", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(["task", "create", "Owner", "--worktree", alpha.repoId], {
    home,
  });
  const [mount] = worktreeMounts(task);
  const asCheckout = `${alpha.repoId},name=again,path=${mount.path}`;
  await refused(
    ["task", "create", "Borrower", "--checkout", asCheckout],
    home,
    "MANAGED_WORKTREE_NOT_MOUNTABLE",
  );
  const { task: other } = await fixture.coveJson(["task", "create", "Other"], { home });
  await refused(
    ["mount", "add", other.taskId, "--checkout", asCheckout],
    home,
    "MANAGED_WORKTREE_NOT_MOUNTABLE",
  );
  await fixture.coveJson(["task", "archive", task.taskId], { home });
  await refused(
    ["mount", "add", other.taskId, "--checkout", asCheckout],
    home,
    "MANAGED_WORKTREE_NOT_MOUNTABLE",
  );
  // Nothing was added by the refusals.
  const current = await fixture.coveJson(["task", "get", other.taskId], { home });
  expect(current.workspace.mounts).toEqual([]);
});

test("a clone that links its worktrees by relative paths gets a ready worktree (#126 item 8)", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  // Git 2.48+ then writes the worktree's `.git` file and its administrative backlink relative to
  // their own directories.
  await alpha.git("config", "worktree.useRelativePaths", "true");
  const created = await fixture.cove(
    ["task", "create", "Relative links", "--worktree", alpha.repoId],
    { home },
  );
  const { operation, task } = JSON.parse(created.stdout);
  const [mount] = worktreeMounts(task);
  expect((await readFile(join(mount.path, ".git"), "utf8")).startsWith("gitdir: ../")).toBe(true);
  expect({ code: created.code, stderr: created.stderr }).toEqual({ code: 0, stderr: "" });
  expect(operation).toMatchObject({ state: "succeeded", result: { mounts: [{ state: "ready" }] } });
  expect(mount.state).toBe("ready");
  expect(await readFile(join(mount.path, "README.md"), "utf8")).toBe("alpha\n");
});
