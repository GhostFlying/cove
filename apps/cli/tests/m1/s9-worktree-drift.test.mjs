import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createM1Fixture } from "./fixtures.mjs";
import { registeredRemote, worktreeMounts } from "./s3-worktree-remotes.mjs";

// S9 (docs/milestones/m1.md), managed worktree part: Git and filesystem changes made outside Cove
// are reported, never repaired. A managed worktree deleted by hand shows as missing and is not
// recreated; a worktree created with plain Git under the workspace root is not imported; removing a
// mount never deletes the directory it names.

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

test("a managed worktree deleted outside Cove is shown as missing and not recreated", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(["task", "create", "Drift", "--worktree", alpha.repoId], {
    home,
  });
  const [mount] = worktreeMounts(task);
  expect(mount.state).toBe("ready");
  await rm(mount.path, { recursive: true, force: true });
  for (let read = 0; read < 2; read++) {
    const current = await fixture.coveJson(["task", "get", task.taskId], { home });
    expect(worktreeMounts(current)[0]).toMatchObject({ mountId: mount.mountId, state: "missing" });
    expect(await absent(mount.path)).toBe(true);
  }
  // The branch stays; Cove does not prune or repair the clone's worktree list either.
  expect(await alpha.git("branch", "--list", mount.branch)).toContain(mount.branch);
  expect(await alpha.git("worktree", "list", "--porcelain")).toContain(mount.path);
});

test("a worktree created with plain Git under the workspace root is not imported", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(["task", "create", "Owner"], { home });
  const stray = join(task.workspace.entryPath, "..", "stray-worktree");
  await alpha.git("worktree", "add", "--quiet", "-b", "stray", stray);
  const listed = await fixture.coveJson(["task", "list"], { home });
  const tasks = listed.tasks ?? listed;
  expect(tasks.map((item) => item.taskId)).toEqual([task.taskId]);
  const current = await fixture.coveJson(["task", "get", task.taskId], { home });
  expect(current.workspace.mounts).toEqual([]);
  // Nor is it Cove-managed: it may be mounted as a checkout of its clone.
  const added = await fixture.coveJson(
    ["mount", "add", task.taskId, "--checkout", `${alpha.repoId},name=stray,path=${stray}`],
    { home },
  );
  expect(added.operation.state).toBe("succeeded");
});

test("removing a worktree or checkout mount leaves the directory, its branch and the source in place", async () => {
  const home = fixture.home("home");
  await fixture.startServer(home);
  const alpha = await registeredRemote(fixture, home, "alpha");
  const { task } = await fixture.coveJson(
    [
      "task",
      "create",
      "Removal",
      "--checkout",
      `${alpha.repoId},name=source`,
      "--worktree",
      `${alpha.repoId},name=work`,
    ],
    { home },
  );
  const checkout = task.workspace.mounts.find((mount) => mount.name === "source");
  const [worktree] = worktreeMounts(task);
  for (const mount of [worktree, checkout]) {
    const removed = await fixture.coveJson(["mount", "remove", task.taskId, mount.mountId], {
      home,
    });
    expect(removed.operation.state).toBe("succeeded");
  }
  expect(await readFile(join(worktree.path, "README.md"), "utf8")).toBe("alpha\n");
  expect(await alpha.git("branch", "--list", worktree.branch)).toContain(worktree.branch);
  expect(await readFile(join(alpha.clone, "README.md"), "utf8")).toBe("alpha\n");
  expect(await alpha.git("status", "--porcelain")).toBe("");
  // The removed worktree stays Cove-managed: it is still refused as a checkout (T5 deletes it).
  const refused = await fixture.cove(
    ["mount", "add", task.taskId, "--checkout", `${alpha.repoId},name=back,path=${worktree.path}`],
    { home },
  );
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain("MANAGED_WORKTREE_NOT_MOUNTABLE");
});
