import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
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
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { canonicalWriteIntent, validateRpcResultForCall } from "@cove/protocol/rpc";
import { RepoService } from "../../dist/domain/repos.js";
import {
  FsPermits,
  Slots,
  WorkspaceService,
  defaultMountName,
  taskSlug,
} from "../../dist/domain/workspaces.js";
import { discoverRepository } from "../../dist/git/repository.js";
import { checkoutDirectory } from "../../dist/workspace-fs/checkout.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { Store } from "../../dist/store/database.js";
import { MIGRATIONS } from "../../dist/store/migrations.js";
import { prepareHome } from "../../dist/store/home.js";
import { recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import {
  inspectEntry,
  MAX_MANIFEST_BYTES,
  manifestText,
  pathOccupied,
  publishEntry,
  realWorkspaceRoot,
  replaceManifest,
  syncEntry,
} from "../../dist/workspace-fs/entry.js";

// Tasks, workspaces and checkout mounts (docs/milestones/m1.md T3a) below the CLI: what S2 cannot
// provoke through the compiled CLI. Managed worktree records (T3b) are inserted directly, and the
// entry writes are replaced to order and fail them.

const encode = (text) => new TextEncoder().encode(text);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const savedPath = process.env.PATH;
const testOperations = new URL("./store-test-operations.mjs", import.meta.url).href;
const directories = [];
const stores = [];

afterEach(async () => {
  process.env.PATH = savedPath;
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "cove-workspace-test-")));
  directories.push(path);
  return path;
}

function git(cwd, home, ...args) {
  return new Promise((done, fail) =>
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          PATH: process.env.PATH,
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

async function clone(root, name) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await git(path, root, "init", "--quiet", "--initial-branch", "main");
  await writeFile(join(path, "README.md"), "test\n");
  await git(path, root, "add", "README.md");
  await git(path, root, "commit", "--quiet", "--no-gpg-sign", "-m", "test");
  return path;
}

// Predictable resource IDs (id0001, id0002, ...), so a test knows an entry path in advance.
function counter() {
  let next = 0;
  return () => `id${String(++next).padStart(4, "0")}`;
}

// A server-less composition: the store, durable receipts, a repo service and the workspace
// service with replaceable filesystem steps and IDs. `wrapStore` puts a facade in front of the
// store that the receipts and the workspace service use, to interleave or fail their calls;
// `restart()` builds a fresh workspace service on the plain store, as a restarted server would.
async function setup({
  fs,
  newId,
  git: gitSteps,
  wrapStore,
  readBudgetMs,
  gitConcurrency,
  fsConcurrency,
  entryWriteBudgetMs,
  writeStepBudgetMs,
  responseBytes,
} = {}) {
  const root = await temporary();
  const layout = await prepareHome(join(root, "home"));
  const store = await Store.open({
    databasePath: layout.databasePath,
    backupDirectory: layout.backupDirectory,
    operationModules: [testOperations],
  });
  stores.push(store);
  const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
  const composition = new RuntimeComposition("server", "instance", { ...M0_LIMITS }, bytes);
  await recordInstanceStart(store, "instance", 1);
  const facade = wrapStore ? wrapStore(store) : store;
  const receipts = new OperationReceipts(
    composition,
    encode,
    new SqliteReceiptBackend(facade, "instance", () => 1),
  );
  const workspaceRoot = join(root, "workspaces");
  const service = (on) =>
    new WorkspaceService({
      store: on,
      receipts,
      config: { workspaceRoot: async () => workspaceRoot },
      serverId: "server",
      encodeUtf8: encode,
      fs,
      newId,
      git: gitSteps,
      readBudgetMs,
      gitConcurrency,
      fsConcurrency,
      entryWriteBudgetMs,
      writeStepBudgetMs,
      responseBytes,
    });
  const tasks = service(facade);
  const restart = () => service(store);
  const repos = new RepoService({ store, serverId: "server", receipts, encodeUtf8: encode });
  const register = async (name) => {
    const path = await clone(root, name);
    const outcome = await repos.register("p", { operationId: `reg-${name}`, path });
    return { path, repoId: outcome.operation.result.resource.id };
  };
  const sql = (sqlText, params = []) => store.call("test.run", { sql: sqlText, params });
  const rows = (sqlText, params = []) => store.call("test.all", { sql: sqlText, params });
  return { root, store, receipts, tasks, restart, repos, register, sql, rows, workspaceRoot };
}

const kind = (outcome) => outcome.error?.kind;

async function created(tasks, operationId, title, mounts = []) {
  const outcome = await tasks.create("p", { operationId, title, mounts });
  expect(outcome.operation).toBeDefined();
  return { operation: outcome.operation, taskId: outcome.operation.result.resource.id };
}

// Records a managed worktree the way T3b will (migration 001, managed_worktrees).
async function recordManaged(env, { path, repoId, taskId, state = "ready" }) {
  const [{ workspace_id: workspaceId }] = await env.rows(
    "SELECT workspace_id FROM workspaces WHERE task_id = ?",
    [taskId],
  );
  const [{ common_dir: commonDir }] = await env.rows(
    "SELECT common_dir FROM repos WHERE repo_id = ?",
    [repoId],
  );
  await env.sql(
    `INSERT INTO managed_worktrees (worktree_id, path, repo_id, common_dir, branch, base_commit,
       task_id, workspace_id, mount_id, operation_server_id, operation_principal_id,
       operation_id, state, completed_steps_json, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 'cove/x', ?, ?, ?, NULL, 'server', 'p', 'op-wt', ?, '[]', 1, 1)`,
    [
      `wt-${path.length}-${taskId}`,
      path,
      repoId,
      commonDir,
      "a".repeat(40),
      taskId,
      workspaceId,
      state,
    ],
  );
}

describe("task naming", () => {
  it("derives a fixed slug and a default mount name that are single safe segments", () => {
    expect(taskSlug("Fix the Reconnect bug!")).toBe("fix-the-reconnect-bug");
    expect(taskSlug("  --Ünïcödé  ")).toBe("unicode");
    expect(taskSlug("调查")).toBe("task");
    expect(taskSlug("a".repeat(80))).toHaveLength(48);
    expect(defaultMountName("My App")).toBe("My-App");
    expect(defaultMountName("..hidden")).toBe("hidden");
    expect(defaultMountName("调查")).toBeNull();
  });
});

describe("tasks and checkout mounts", () => {
  it("records a task, writes its entry and manifest, and answers a resend from its receipt", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const { operation, taskId } = await created(env.tasks, "c1", "Investigate", [
      { source: "checkout", repoId: alpha.repoId },
    ]);
    expect(operation).toMatchObject({ method: "task.create", state: "succeeded", revision: 1 });
    const { task } = await env.tasks.get(taskId);
    expect(task.workspace.entryState).toBe("ready");
    expect(task.workspace.entryPath.startsWith(`${env.workspaceRoot}/investigate-`)).toBe(true);
    expect(task.workspace.mounts).toEqual([
      expect.objectContaining({
        name: "alpha",
        source: "checkout",
        path: alpha.path,
        entryPath: null,
        state: "ready",
        sharedWithTaskIds: [],
      }),
    ]);
    const manifest = JSON.parse(
      await readFile(join(task.workspace.entryPath, "cove-workspace.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      kind: "cove-workspace",
      taskId,
      workspaceRevision: 0,
      mounts: [{ name: "alpha", path: alpha.path, source: "checkout", readOnly: true }],
    });
    // The resend returns the same record even though the checkout is gone now.
    await rm(alpha.path, { recursive: true });
    expect(
      await env.tasks.create("p", {
        operationId: "c1",
        title: "Investigate",
        mounts: [{ source: "checkout", repoId: alpha.repoId }],
      }),
    ).toEqual({ operation });
    expect(
      kind(await env.tasks.create("p", { operationId: "c1", title: "Other", mounts: [] })),
    ).toBe("OPERATION_ID_CONFLICT");
    // The binding is reported missing, never dropped.
    const after = (await env.tasks.get(taskId)).task;
    expect(after.workspace.mounts.map((mount) => mount.state)).toEqual(["missing"]);
  });

  it("admits a clone's existing worktree by path and refuses other clones and non-repositories", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const beta = await env.register("beta");
    const linked = join(env.root, "alpha-linked");
    await git(alpha.path, env.root, "worktree", "add", "--quiet", "-b", "side", linked);
    const { taskId } = await created(env.tasks, "c1", "T", [
      { source: "checkout", repoId: alpha.repoId, name: "side", path: `${linked}/` },
    ]);
    expect((await env.tasks.get(taskId)).task.workspace.mounts[0]).toMatchObject({
      name: "side",
      path: linked,
    });
    let attempt = 0;
    const refusal = async (path) =>
      kind(
        await env.tasks.create("p", {
          operationId: `x-${attempt++}`,
          title: "T",
          mounts: [{ source: "checkout", repoId: alpha.repoId, path }],
        }),
      );
    expect(await refusal(beta.path)).toBe("INVALID_ARGUMENT");
    expect(await refusal(env.root)).toBe("NOT_A_GIT_REPOSITORY");
    expect(await refusal(join(env.root, "nowhere"))).toBe("NOT_A_GIT_REPOSITORY");
    expect(await refusal("relative/path")).toBe("INVALID_ARGUMENT");
    expect(
      kind(
        await env.tasks.create("p", {
          operationId: "x-repo",
          title: "T",
          mounts: [{ source: "checkout", repoId: "no-such-repo" }],
        }),
      ),
    ).toBe("REPO_NOT_FOUND");
    expect((await env.tasks.list({ limit: 10 })).tasks).toHaveLength(1);
  });

  // Each guard on its own: the recorded path is refused before Git is asked, a path inside a
  // managed worktree only by the check inside the write (Git resolves it to the top level).
  it("refuses a managed worktree by its recorded path before Git is asked, also once its task is archived or the directory is gone", async () => {
    const asked = [];
    const env = await setup({
      git: {
        discoverRepository: async (path) => {
          asked.push(path);
          return discoverRepository(path);
        },
      },
    });
    const alpha = await env.register("alpha");
    const owner = await created(env.tasks, "owner", "Owner");
    const managed = join(env.root, "managed");
    await git(alpha.path, env.root, "worktree", "add", "--quiet", "-b", "cove/owner", managed);
    await recordManaged(env, { path: managed, repoId: alpha.repoId, taskId: owner.taskId });
    const other = await created(env.tasks, "other", "Other");
    const attempt = async (suffix, path) => [
      kind(
        await env.tasks.create("p", {
          operationId: `c-${suffix}`,
          title: "T",
          mounts: [{ source: "checkout", repoId: alpha.repoId, path }],
        }),
      ),
      kind(
        await env.tasks.addMount("p", {
          operationId: `a-${suffix}`,
          taskId: other.taskId,
          mount: { source: "checkout", repoId: alpha.repoId, path },
        }),
      ),
    ];
    const refused = ["MANAGED_WORKTREE_NOT_MOUNTABLE", "MANAGED_WORKTREE_NOT_MOUNTABLE"];
    asked.length = 0;
    expect(await attempt("live", managed)).toEqual(refused);
    expect(await attempt("slash", `${managed}/`)).toEqual(refused);
    await env.tasks.setArchived("p", { operationId: "ar", taskId: owner.taskId }, true);
    expect(await attempt("archived", managed)).toEqual(refused);
    await rm(managed, { recursive: true });
    expect(await attempt("gone", managed)).toEqual(refused);
    expect(asked).toEqual([]);
    expect((await env.tasks.get(other.taskId)).task.workspace.mounts).toEqual([]);
  });

  it("refuses a directory inside a managed worktree inside the write, where Git has resolved it to the managed top level", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const owner = await created(env.tasks, "owner", "Owner");
    const managed = join(env.root, "managed");
    await git(alpha.path, env.root, "worktree", "add", "--quiet", "-b", "cove/owner", managed);
    await recordManaged(env, { path: managed, repoId: alpha.repoId, taskId: owner.taskId });
    const inside = join(managed, "src");
    await mkdir(inside);
    await writeFile(join(inside, "main.c"), "int main(void) { return 0; }\n");
    const other = await created(env.tasks, "other", "Other");
    const spec = { source: "checkout", repoId: alpha.repoId, path: inside };
    for (const suffix of ["live", "archived"]) {
      if (suffix === "archived")
        await env.tasks.setArchived("p", { operationId: "ar", taskId: owner.taskId }, true);
      expect(
        kind(
          await env.tasks.create("p", { operationId: `c-${suffix}`, title: "T", mounts: [spec] }),
        ),
      ).toBe("MANAGED_WORKTREE_NOT_MOUNTABLE");
      expect(
        kind(
          await env.tasks.addMount("p", {
            operationId: `a-${suffix}`,
            taskId: other.taskId,
            mount: spec,
          }),
        ),
      ).toBe("MANAGED_WORKTREE_NOT_MOUNTABLE");
    }
    expect(await env.rows("SELECT COUNT(*) AS n FROM tasks")).toEqual([{ n: 2 }]);
    expect(await env.rows("SELECT mount_id FROM mounts")).toEqual([]);
  });

  it("shows a shared checkout on both tasks without locking, an archived task's share included until its mount is removed", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const spec = [{ source: "checkout", repoId: alpha.repoId }];
    const one = await created(env.tasks, "one", "One", spec);
    const two = await created(env.tasks, "two", "Two", spec);
    const shares = async (taskId) =>
      (await env.tasks.get(taskId)).task.workspace.mounts[0].sharedWithTaskIds;
    expect(await shares(one.taskId)).toEqual([two.taskId]);
    expect(await shares(two.taskId)).toEqual([one.taskId]);
    await env.tasks.setArchived("p", { operationId: "ar", taskId: two.taskId }, true);
    expect(await shares(one.taskId)).toEqual([two.taskId]);
    const [mount] = (await env.tasks.get(two.taskId)).task.workspace.mounts;
    await env.tasks.removeMount("p", {
      operationId: "rm",
      taskId: two.taskId,
      mountId: mount.mountId,
    });
    expect(await shares(one.taskId)).toEqual([]);
  });

  it("checks names, revisions and the archived state inside the write", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const checkout = { source: "checkout", repoId: alpha.repoId };
    expect(
      kind(
        await env.tasks.create("p", {
          operationId: "dup",
          title: "T",
          mounts: [checkout, checkout],
        }),
      ),
    ).toBe("MOUNT_NAME_CONFLICT");
    const { taskId } = await created(env.tasks, "c", "T", [checkout]);
    const add = (operationId, extra) =>
      env.tasks.addMount("p", { operationId, taskId, mount: checkout, ...extra });
    expect(kind(await add("a1"))).toBe("MOUNT_NAME_CONFLICT");
    expect(
      kind(
        await env.tasks.addMount("p", {
          operationId: "a2",
          taskId,
          mount: { ...checkout, name: "cove-workspace.json" },
        }),
      ),
    ).toBe("MOUNT_NAME_CONFLICT");
    expect(
      kind(
        await env.tasks.addMount("p", {
          operationId: "a3",
          taskId,
          expectedWorkspaceRevision: 5,
          mount: { ...checkout, name: "second" },
        }),
      ),
    ).toBe("REVISION_CONFLICT");
    const added = await env.tasks.addMount("p", {
      operationId: "a4",
      taskId,
      expectedWorkspaceRevision: 0,
      mount: { ...checkout, name: "second" },
    });
    expect(added.operation.result).toMatchObject({
      resource: { kind: "mount", revision: 1 },
      workspaceRevision: 1,
      mounts: [{ state: "ready" }],
    });
    expect(
      (await env.tasks.rename("p", { operationId: "r", taskId, title: "Renamed" })).operation.result
        .resource,
    ).toMatchObject({ kind: "task", revision: 1 });
    const task = (await env.tasks.get(taskId)).task;
    expect(task).toMatchObject({ title: "Renamed", slug: "t", revision: 1 });
    expect(task.workspace).toMatchObject({ revision: 1, entryState: "ready" });
    await env.tasks.setArchived("p", { operationId: "ar1", taskId }, true);
    expect(kind(await env.tasks.setArchived("p", { operationId: "ar2", taskId }, true))).toBe(
      "TASK_ARCHIVED",
    );
    expect(kind(await add("a5", { mount: { ...checkout, name: "third" } }))).toBe("TASK_ARCHIVED");
    // Removing a mount of an archived task is allowed: it is how a repo registration is freed.
    const removed = await env.tasks.removeMount("p", {
      operationId: "rm",
      taskId,
      mountId: added.operation.result.resource.id,
    });
    expect(removed.operation.result).toMatchObject({ workspaceRevision: 2 });
    await env.tasks.setArchived("p", { operationId: "un1", taskId }, false);
    expect(kind(await env.tasks.setArchived("p", { operationId: "un2", taskId }, false))).toBe(
      "INVALID_ARGUMENT",
    );
    expect(
      kind(await env.tasks.removeMount("p", { operationId: "rm2", taskId, mountId: "gone" })),
    ).toBe("MOUNT_NOT_FOUND");
    expect(kind(await env.tasks.get("no-such-task"))).toBe("TASK_NOT_FOUND");
  });

  it("lists active tasks by default and pages in task order", async () => {
    const env = await setup();
    const ids = [];
    for (const name of ["a", "b", "c"]) ids.push((await created(env.tasks, name, name)).taskId);
    await env.tasks.setArchived("p", { operationId: "ar", taskId: ids[1] }, true);
    const sorted = [...ids].sort();
    const active = sorted.filter((id) => id !== ids[1]);
    expect((await env.tasks.list({ limit: 10 })).tasks.map((task) => task.taskId)).toEqual(active);
    expect(
      (await env.tasks.list({ limit: 10, archived: "only" })).tasks.map((task) => task.taskId),
    ).toEqual([ids[1]]);
    const first = await env.tasks.list({ limit: 2, archived: "include" });
    expect(first.tasks.map((task) => task.taskId)).toEqual(sorted.slice(0, 2));
    const second = await env.tasks.list({
      limit: 2,
      archived: "include",
      afterTaskId: first.nextAfterTaskId,
    });
    expect(second).toEqual({ tasks: [expect.objectContaining({ taskId: sorted[2] })] });
  });
});

describe("response size", () => {
  // The JSON-RPC response of `result` with the longest request ID: what must fit the transport.
  const responseBytes = (result) =>
    Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "\u0001".repeat(128), result }));

  it("ends a task.list page before the task that would take it past the structure limit and continues after the last task it holds", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const taskIds = [];
    for (let index = 0; index < 48; index += 1) {
      const mounts = [{ source: "checkout", repoId: alpha.repoId, name: "shared" }];
      taskIds.push((await created(env.tasks, `c${index}`, `T${index}`, mounts)).taskId);
    }
    const pages = [];
    let afterTaskId;
    do {
      const params = { limit: 100, ...(afterTaskId ? { afterTaskId } : {}) };
      const page = await env.tasks.list(params);
      expect(validateRpcResultForCall("task.list", params, page)).toBe(true);
      expect(responseBytes(page)).toBeLessThanOrEqual(M0_LIMITS.rpcResponseBytes);
      pages.push(page);
      afterTaskId = page.nextAfterTaskId;
    } while (afterTaskId);
    // 48 tasks sharing one checkout do not fit one page; together the pages hold every task once,
    // and each page but the last continues after the last task it holds.
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.tasks.map((task) => task.taskId))).toEqual(
      [...taskIds].sort(),
    );
    expect(pages.map((page) => page.nextAfterTaskId)).toEqual(
      pages.map((page, index) =>
        index < pages.length - 1 ? page.tasks[page.tasks.length - 1].taskId : undefined,
      ),
    );
  });

  it("refuses before the commit a mount that would make the task too large for one task.get response", async () => {
    // A short path (a symlink, say) to a working tree whose real top level is long, of
    // characters JSON escapes to six bytes; the request stays small, the record does not. The
    // host filesystem need not hold such a path: Git and the directory check answer for it here.
    const short = "/cove-test-short";
    const long = `/${"\u0001".repeat(4000)}`;
    let commonDir;
    const env = await setup({
      git: {
        discoverRepository: async (path, options) =>
          path === short || path === long
            ? { kind: "work-tree", gitDir: `${long}/.git`, commonDir, topLevel: long }
            : discoverRepository(path, options),
      },
      fs: {
        checkoutDirectory: async (path) => (path === long ? "present" : checkoutDirectory(path)),
      },
    });
    const alpha = await env.register("alpha");
    [{ common_dir: commonDir }] = await env.rows("SELECT common_dir FROM repos");
    const { taskId } = await created(env.tasks, "c", "T");
    let refused = null;
    for (let index = 0; index < 16 && !refused; index += 1) {
      const outcome = await env.tasks.addMount("p", {
        operationId: `add-${index}`,
        taskId,
        mount: { source: "checkout", repoId: alpha.repoId, name: `m${index}`, path: short },
      });
      if (outcome.error) refused = { index, error: outcome.error };
    }
    expect(refused).toMatchObject({ error: { kind: "INVALID_ARGUMENT" } });
    expect(refused.index).toBeGreaterThan(1);
    // Nothing of the refused mount is recorded.
    const { task } = await env.tasks.get(taskId);
    expect(task.workspace.mounts).toHaveLength(refused.index);
    expect(task.workspace.revision).toBe(refused.index);
    // The accepted record still fits at its largest: the longest title, the largest counters,
    // the longest states and every checkout shared with as many tasks as a record lists. One
    // more mount like the refused one would not.
    const largest = (mounts) => ({
      task: {
        ...task,
        revision: Number.MAX_SAFE_INTEGER,
        title: "\u0001".repeat(256),
        workspace: {
          ...task.workspace,
          revision: Number.MAX_SAFE_INTEGER,
          entryState: "unavailable",
          mounts: mounts.map((mount) => ({
            ...mount,
            state: "unavailable",
            sharedWithTaskIds: Array(128).fill("i".repeat(40)),
          })),
        },
      },
    });
    const accepted = largest(task.workspace.mounts);
    expect(validateRpcResultForCall("task.get", { taskId }, accepted)).toBe(true);
    expect(responseBytes(accepted)).toBeLessThanOrEqual(M0_LIMITS.rpcResponseBytes);
    const more = largest([...task.workspace.mounts, task.workspace.mounts[0]]);
    expect(responseBytes(more)).toBeGreaterThan(M0_LIMITS.rpcResponseBytes);
  });
});

describe("checks inside the write", () => {
  // Runs `step` once, right after the next admission query, while the request waits between its
  // checks and its write.
  async function racing() {
    let step = null;
    const env = await setup({
      git: {
        discoverRepository: async (path) => {
          const found = await discoverRepository(path);
          const pending = step;
          step = null;
          return pending ? pending(found) : found;
        },
      },
    });
    env.meanwhile = (next) => {
      step = next;
    };
    return env;
  }

  it("refuses a path recorded as a managed worktree after the admission check", async () => {
    const env = await racing();
    const alpha = await env.register("alpha");
    const owner = await created(env.tasks, "owner", "Owner");
    env.meanwhile(async (found) => {
      await recordManaged(env, { path: alpha.path, repoId: alpha.repoId, taskId: owner.taskId });
      return found;
    });
    expect(
      kind(
        await env.tasks.create("p", {
          operationId: "c",
          title: "T",
          mounts: [{ source: "checkout", repoId: alpha.repoId }],
        }),
      ),
    ).toBe("MANAGED_WORKTREE_NOT_MOUNTABLE");
    expect(await env.rows("SELECT task_id FROM tasks")).toEqual([{ task_id: owner.taskId }]);
  });

  it("answers with the record of an identical request that committed while this one waited, also instead of a later refusal", async () => {
    const env = await racing();
    const alpha = await env.register("alpha");
    const params = (operationId) => ({
      operationId,
      title: "T",
      mounts: [{ source: "checkout", repoId: alpha.repoId }],
    });
    let first;
    env.meanwhile(async (found) => {
      first = await env.tasks.create("p", params("same"));
      return found;
    });
    const second = await env.tasks.create("p", params("same"));
    expect(first.operation.state).toBe("succeeded");
    expect(second).toEqual(first);
    // This request's own checks would refuse it now; the committed record answers instead.
    let committed;
    env.meanwhile(async () => {
      committed = await env.tasks.create("p", params("later"));
      return { kind: "not-repository" };
    });
    const answered = await env.tasks.create("p", params("later"));
    expect(committed.operation.state).toBe("succeeded");
    expect(answered).toEqual(committed);
    expect(await env.rows("SELECT COUNT(*) AS n FROM tasks")).toEqual([{ n: 2 }]);
  });

  it("answers a duplicate that only the recheck inside the write transaction finds with the committed record", async () => {
    const env = await setup();
    const params = { operationId: "dup", title: "T", mounts: [] };
    const request = (taskId) => ({
      key: { serverId: "server", principalId: "p", operationId: "dup" },
      canonicalIntent: canonicalWriteIntent("task.create", params, encode),
      method: "task.create",
      apply: {
        name: "task.create",
        args: {
          taskId,
          workspaceId: `w-${taskId}`,
          title: "T",
          slug: "t",
          entryPath: join(env.workspaceRoot, `t-${taskId}`),
          mounts: [],
          responseBytes: M0_LIMITS.rpcResponseBytes,
          at: 1,
        },
      },
    });
    // Straight to the store's write, past the receipt lookups before it.
    const first = await env.receipts.write(request("a"));
    expect(first).toMatchObject({ committed: true, operation: { state: "succeeded" } });
    const second = await env.receipts.write(request("b"));
    expect(second).toEqual({ operation: first.operation });
    expect(await env.rows("SELECT task_id FROM tasks")).toEqual([{ task_id: "a" }]);
  });

  it("refuses a mount whose repo registration was removed while it was being admitted", async () => {
    const env = await racing();
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c", "T");
    let removed;
    env.meanwhile(async (found) => {
      removed = await env.repos.remove("p", { operationId: "rr", repoId: alpha.repoId });
      return found;
    });
    expect(
      kind(
        await env.tasks.addMount("p", {
          operationId: "a",
          taskId,
          mount: { source: "checkout", repoId: alpha.repoId },
        }),
      ),
    ).toBe("REPO_NOT_FOUND");
    expect(removed.operation.state).toBe("succeeded");
    expect(await env.rows("SELECT mount_id FROM mounts")).toEqual([]);
  });

  it("refuses a mount added to a task archived while it was being admitted", async () => {
    const env = await racing();
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c", "T");
    env.meanwhile(async (found) => {
      await env.tasks.setArchived("p", { operationId: "ar", taskId }, true);
      return found;
    });
    expect(
      kind(
        await env.tasks.addMount("p", {
          operationId: "a",
          taskId,
          mount: { source: "checkout", repoId: alpha.repoId },
        }),
      ),
    ).toBe("TASK_ARCHIVED");
    expect((await env.tasks.get(taskId)).task).toMatchObject({
      archived: true,
      workspace: { revision: 0, mounts: [] },
    });
  });
});

describe("checkout identity", () => {
  const states = async (env, taskId) =>
    (await env.tasks.get(taskId)).task.workspace.mounts.map((mount) => mount.state);

  // A clone is identified by the path of its Git common directory (T2), so a clone re-created at
  // the same path is the same registration; what changes the identity is another clone's working
  // tree, a directory that is no repository, or a symlink at the recorded path.
  it("reports a checkout replaced by another clone's worktree, a plain directory, a symlink or a managed worktree as missing, and one Git cannot check as unavailable", async () => {
    let gitDown = false;
    const env = await setup({
      git: {
        discoverRepository: async (path) =>
          gitDown ? { kind: "unavailable" } : discoverRepository(path),
      },
    });
    const alpha = await env.register("alpha");
    const beta = await env.register("beta");
    const linked = join(env.root, "alpha-linked");
    await git(alpha.path, env.root, "worktree", "add", "--quiet", "-b", "side", linked);
    const { taskId } = await created(env.tasks, "c", "T", [
      { source: "checkout", repoId: alpha.repoId, name: "main" },
      { source: "checkout", repoId: alpha.repoId, name: "side", path: linked },
    ]);
    expect(await states(env, taskId)).toEqual(["ready", "ready"]);
    // A worktree of another clone at the linked worktree's path.
    await rename(linked, `${linked}.aside`);
    await git(beta.path, env.root, "worktree", "add", "--quiet", "-b", "other", linked);
    expect(await states(env, taskId)).toEqual(["ready", "missing"]);
    await rm(linked, { recursive: true });
    await rename(`${linked}.aside`, linked);
    expect(await states(env, taskId)).toEqual(["ready", "ready"]);
    // A plain directory in place of the clone (its linked worktree breaks with it).
    const aside = `${alpha.path}.aside`;
    await rename(alpha.path, aside);
    await mkdir(alpha.path);
    expect(await states(env, taskId)).toEqual(["missing", "missing"]);
    await rm(alpha.path, { recursive: true });
    // The same clone, reached through a symlink in its place.
    await symlink(aside, alpha.path);
    expect((await states(env, taskId))[0]).toBe("missing");
    await rm(alpha.path);
    await rename(aside, alpha.path);
    expect(await states(env, taskId)).toEqual(["ready", "ready"]);
    // Git does not answer: neither present nor gone.
    gitDown = true;
    expect(await states(env, taskId)).toEqual(["unavailable", "unavailable"]);
    gitDown = false;
    // Recorded as a managed worktree since.
    await recordManaged(env, { path: linked, repoId: alpha.repoId, taskId });
    expect(await states(env, taskId)).toEqual(["ready", "missing"]);
    // The records are kept throughout, and the clone is untouched.
    expect(await readFile(join(alpha.path, "README.md"), "utf8")).toBe("test\n");
  });

  it("checks every new checkout once more right before the write and records nothing when it changed", async () => {
    let afterDiscovery = async () => undefined;
    const env = await setup({
      git: {
        discoverRepository: async (path) => {
          const found = await discoverRepository(path);
          const step = afterDiscovery;
          afterDiscovery = async () => undefined;
          await step();
          return found;
        },
      },
    });
    const alpha = await env.register("alpha");
    const beta = await env.register("beta");
    const aside = `${alpha.path}.aside`;
    const attempt = (operationId) =>
      env.tasks.create("p", {
        operationId,
        title: "T",
        mounts: [{ source: "checkout", repoId: alpha.repoId }],
      });
    // Replaced by a symlink to itself between the admission check and the write.
    afterDiscovery = async () => {
      await rename(alpha.path, aside);
      await symlink(aside, alpha.path);
    };
    expect(kind(await attempt("c1"))).toBe("NOT_A_GIT_REPOSITORY");
    await rm(alpha.path);
    // Replaced by a plain directory.
    afterDiscovery = async () => {
      await rename(alpha.path, `${aside}2`);
      await mkdir(alpha.path);
    };
    await rename(aside, alpha.path);
    expect(kind(await attempt("c2"))).toBe("NOT_A_GIT_REPOSITORY");
    await rm(alpha.path, { recursive: true });
    await rename(`${aside}2`, alpha.path);
    expect(await env.rows("SELECT task_id FROM tasks")).toEqual([]);
    // An existing worktree replaced by another clone's worktree, on mount.add.
    const linked = join(env.root, "alpha-linked");
    await git(alpha.path, env.root, "worktree", "add", "--quiet", "-b", "side", linked);
    const { taskId } = await created(env.tasks, "c3", "T");
    afterDiscovery = async () => {
      await rename(linked, `${linked}.aside`);
      await git(beta.path, env.root, "worktree", "add", "--quiet", "-b", "other", linked);
    };
    expect(
      kind(
        await env.tasks.addMount("p", {
          operationId: "a",
          taskId,
          mount: { source: "checkout", repoId: alpha.repoId, path: linked },
        }),
      ),
    ).toBe("INVALID_ARGUMENT");
    expect(await env.rows("SELECT mount_id FROM mounts")).toEqual([]);
  });

  it("reports a checkout whose Git metadata cannot be read or that Git refuses as unsafe as unavailable, and one whose metadata is gone as missing", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c", "T", [
      { source: "checkout", repoId: alpha.repoId, name: "main" },
    ]);
    const dotGit = join(alpha.path, ".git");
    await chmod(dotGit, 0o000);
    try {
      expect(await states(env, taskId)).toEqual(["unavailable"]);
    } finally {
      await chmod(dotGit, 0o755);
    }
    expect(await states(env, taskId)).toEqual(["ready"]);
    // A safe.directory refusal (Git's dubious-ownership message, from a git first on PATH).
    const bin = await temporary();
    await writeFile(
      join(bin, "git"),
      "#!/bin/sh\necho \"fatal: detected dubious ownership in repository at '$PWD'\" >&2\nexit 128\n",
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      expect(await states(env, taskId)).toEqual(["unavailable"]);
    } finally {
      process.env.PATH = savedPath;
    }
    // Registering a path Git refuses like that is still refused as not a repository (T2).
    const beta = await clone(env.root, "beta");
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      expect(
        (await env.repos.register("p", { operationId: "reg-unsafe", path: beta })).error,
      ).toMatchObject({ kind: "NOT_A_GIT_REPOSITORY" });
    } finally {
      process.env.PATH = savedPath;
    }
    // The metadata gone.
    await rename(dotGit, join(env.root, "alpha.git-aside"));
    expect(await states(env, taskId)).toEqual(["missing"]);
  });

  it("answers a read within its budget and reports a checkout check still running as unavailable", async () => {
    let slow = false;
    const left = [];
    const env = await setup({
      readBudgetMs: 300,
      git: {
        discoverRepository: async (path, options) => {
          if (slow) {
            left.push(options?.deadline - performance.now());
            await sleep(1500);
          }
          return discoverRepository(path, options);
        },
      },
    });
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c", "T", [
      { source: "checkout", repoId: alpha.repoId, name: "main" },
    ]);
    slow = true;
    const started = performance.now();
    expect(await states(env, taskId)).toEqual(["unavailable"]);
    expect(performance.now() - started).toBeLessThan(1000);
    // The discovery was given the read's deadline, not Git's own 10 s.
    expect(left).toHaveLength(1);
    expect(left[0]).toBeGreaterThan(0);
    expect(left[0]).toBeLessThanOrEqual(300);
    await sleep(1500);
  });

  // A git first on PATH that takes 400 ms before running the real one, without holding the
  // output pipes while it waits.
  async function slowGit() {
    const real = await new Promise((done, fail) =>
      execFile("sh", ["-c", "command -v git"], (error, stdout) =>
        error ? fail(error) : done(stdout.trim()),
      ),
    );
    const bin = await temporary();
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nsleep 0.4 </dev/null >/dev/null 2>&1\nexec "${real}" "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${savedPath}`;
  }

  it("bounds a discovery as a whole by its deadline: its second Git command gets only what the first left", async () => {
    const root = await temporary();
    const alpha = await clone(root, "alpha");
    await slowGit();
    // Without a deadline both commands run to the end (and the first, cold, start is paid here).
    expect(await discoverRepository(alpha)).toMatchObject({ kind: "work-tree", topLevel: alpha });
    // Each of the two commands fits the deadline alone; both together do not, and the second is
    // stopped at the deadline rather than given a full 600 ms of its own (some 950 ms in all).
    const started = performance.now();
    expect(await discoverRepository(alpha, { deadline: started + 600 })).toEqual({
      kind: "unavailable",
    });
    expect(performance.now() - started).toBeLessThan(720);
  });

  it("starts no probe for a deadline already passed and never leaves a failed probe unhandled", async () => {
    const unhandled = [];
    const record = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const missing = join(await temporary(), "missing", "path");
      let gated = 0;
      // A gate (see ProbeGate) that lets every probe start at once.
      const count = (work) => {
        gated += 1;
        return Promise.resolve({ settled: work() });
      };
      // Already past: nothing is started.
      const past = performance.now() - 1;
      expect(await discoverRepository(missing, { deadline: past, probe: count })).toEqual({
        kind: "unavailable",
      });
      expect(gated).toBe(0);
      // A probe that starts in time but fails after the deadline: its answer is given up, and
      // its later ENOENT is handled.
      const late = (work) => sleep(60).then(() => ({ settled: work() }));
      expect(
        await discoverRepository(missing, { deadline: performance.now() + 10, probe: late }),
      ).toEqual({ kind: "unavailable" });
      await sleep(150);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("does not give a Git slot to a waiter whose deadline passed before its timer ran", async () => {
    let hold = false;
    let releaseFirst;
    const calls = [];
    const env = await setup({
      readBudgetMs: 200,
      gitConcurrency: 1,
      git: {
        discoverRepository: async (path, options) => {
          if (!hold) return discoverRepository(path, options);
          calls.push(path);
          if (calls.length === 1) {
            await new Promise((done) => (releaseFirst = done));
            return { kind: "unavailable" };
          }
          return discoverRepository(path, options);
        },
      },
    });
    const alpha = await env.register("alpha");
    const beta = await env.register("beta");
    const one = await created(env.tasks, "c1", "One", [
      { source: "checkout", repoId: alpha.repoId, name: "a" },
    ]);
    const two = await created(env.tasks, "c2", "Two", [
      { source: "checkout", repoId: beta.repoId, name: "b" },
    ]);
    hold = true;
    const first = env.tasks.get(one.taskId);
    await sleep(80);
    // The second read waits for the slot the first holds.
    const second = env.tasks.get(two.taskId);
    await sleep(80);
    // The event loop is busy past the second read's deadline; the slot comes free in the same
    // turn, before the waiter's timer can run.
    const until = performance.now() + 300;
    while (performance.now() < until);
    releaseFirst();
    await Promise.all([first, second]);
    await sleep(50);
    expect(calls).toEqual([alpha.path]);
  });

  it("shares an in-flight checkout check and entry materialization across requests instead of starting more", async () => {
    let holdCheck = false;
    let holdEntry = false;
    let freeCheck;
    let freeEntry;
    const checkGate = new Promise((done) => (freeCheck = done));
    const entryGate = new Promise((done) => (freeEntry = done));
    const calls = { check: 0, entry: 0 };
    const env = await setup({
      readBudgetMs: 100,
      fs: {
        checkoutDirectory: async (path) => {
          if (holdCheck) {
            calls.check += 1;
            await checkGate;
          }
          return checkoutDirectory(path);
        },
        inspectEntry: async (...args) => {
          if (holdEntry) {
            calls.entry += 1;
            await entryGate;
          }
          return inspectEntry(...args);
        },
      },
    });
    const alpha = await env.register("alpha");
    const mounts = [{ source: "checkout", repoId: alpha.repoId, name: "shared" }];
    const one = await created(env.tasks, "c1", "One", mounts);
    const two = await created(env.tasks, "c2", "Two", mounts);
    // A checkout check that outlives its reads: later requests join it.
    holdCheck = true;
    for (let round = 0; round < 5; round += 1) {
      const read = await Promise.all([one, two].map((task) => states(env, task.taskId)));
      expect(read).toEqual([["unavailable"], ["unavailable"]]);
    }
    expect(calls.check).toBe(1);
    holdCheck = false;
    freeCheck();
    // A materialization that outlives its reads: later requests join the one waiting behind it.
    holdEntry = true;
    for (let round = 0; round < 5; round += 1)
      expect((await env.tasks.get(one.taskId)).task.workspace.entryState).toBe("unavailable");
    freeEntry();
    await sleep(200);
    // The one that was running and the one that waited, not one per read.
    expect(calls.entry).toBe(2);
    expect((await env.tasks.get(one.taskId)).task.workspace.entryState).toBe("ready");
  });

  it("bounds the filesystem work left running past the deadlines and starts no more once it is reached", async () => {
    let hang = false;
    let started = 0;
    const env = await setup({
      readBudgetMs: 100,
      // A discovery resolves its three Git paths at once, so a write needs three permits.
      fsConcurrency: 4,
      fs: {
        checkoutDirectory: async (path) => {
          if (!hang) return checkoutDirectory(path);
          started += 1;
          return new Promise(() => undefined);
        },
      },
    });
    const taskIds = [];
    for (const name of ["b1", "b2", "b3", "b4", "b5", "b6"]) {
      const repo = await env.register(name);
      const mounts = [{ source: "checkout", repoId: repo.repoId, name: "m" }];
      taskIds.push((await created(env.tasks, `c-${name}`, name, mounts)).taskId);
    }
    hang = true;
    for (let round = 0; round < 3; round += 1) {
      const begun = performance.now();
      const read = await Promise.all(taskIds.map((taskId) => states(env, taskId)));
      expect(read).toEqual(Array(6).fill(["unavailable"]));
      expect(performance.now() - begun).toBeLessThan(1000);
    }
    // Four permits, each held by a probe that never settles; nothing more was started.
    expect(started).toBe(4);
  });

  it("verifies every entry and checkout of a healthy page larger than the filesystem permits, on every read", async () => {
    const env = await setup({ fsConcurrency: 4 });
    for (let index = 0; index < 10; index += 1) {
      const repo = await env.register(`p${index}`);
      const mounts = [{ source: "checkout", repoId: repo.repoId, name: "m" }];
      await created(env.tasks, `c-p${index}`, `P${index}`, mounts);
    }
    // The page's own work waits for permits it is itself using, rather than failing fast; so does
    // the work of concurrent pages that fill every permit with work that is still within its
    // deadline.
    for (let round = 0; round < 3; round += 1) {
      const pages = await Promise.all(
        Array.from({ length: round ? 3 : 1 }, () => env.tasks.list({ limit: 20 })),
      );
      for (const { tasks } of pages) {
        expect(tasks).toHaveLength(10);
        for (const task of tasks) {
          expect(task.workspace.entryState).toBe("ready");
          expect(task.workspace.mounts.map((mount) => mount.state)).toEqual(["ready"]);
        }
      }
    }
  });

  it("keeps the work of one page from taking every filesystem permit", async () => {
    const hung = new Set();
    let started = 0;
    const env = await setup({
      // Room for the healthy read's Git discovery on a slow runner.
      readBudgetMs: 1000,
      fsConcurrency: 4,
      newId: counter(),
      fs: {
        checkoutDirectory: (path) => {
          if (!hung.has(path)) return checkoutDirectory(path);
          started += 1;
          return new Promise(() => undefined);
        },
      },
    });
    for (const name of ["h1", "h2", "h3", "h4"]) {
      const repo = await env.register(name);
      const mounts = [{ source: "checkout", repoId: repo.repoId, name: "m" }];
      await created(env.tasks, `c-${name}`, name, mounts);
    }
    const healthy = await env.register("healthy");
    // Created last, so its ID sorts after the page below.
    const { taskId } = await created(env.tasks, "c-healthy", "Healthy", [
      { source: "checkout", repoId: healthy.repoId, name: "m" },
    ]);
    for (const name of ["h1", "h2", "h3", "h4"]) hung.add(join(env.root, name));
    const { tasks } = await env.tasks.list({ limit: 4 });
    expect(tasks.map((task) => task.workspace.mounts[0].state)).toEqual(
      Array(4).fill("unavailable"),
    );
    // Half of the permits, held by checks that never settle; the rest of the page waited.
    expect(started).toBe(2);
    const { task } = await env.tasks.get(taskId);
    expect(task.workspace.entryState).toBe("ready");
    expect(task.workspace.mounts.map((mount) => mount.state)).toEqual(["ready"]);
  });

  // Fills every filesystem permit (fsConcurrency 2, one per request) with abandoned work: a read of
  // each blocker task whose checkout check never settles until `release`.
  async function saturable(options = {}) {
    const hung = new Set();
    const waiting = [];
    let afterAdmission = null;
    const calls = [];
    let counting = false;
    const count = (name, work) => {
      if (counting) calls.push(name);
      return work();
    };
    const env = await setup({
      // Room for the blockers' entry checks on a slow runner, so that their checkout checks start.
      readBudgetMs: 300,
      fsConcurrency: 2,
      fs: {
        checkoutDirectory: (path) =>
          hung.has(path)
            ? new Promise((done) => waiting.push(done))
            : count("checkoutDirectory", () => checkoutDirectory(path)),
        realWorkspaceRoot: (path) => count("realWorkspaceRoot", () => realWorkspaceRoot(path)),
        pathOccupied: (path) => count("pathOccupied", () => pathOccupied(path)),
        realpath: (path) => count("realpath", () => realpath(path)),
      },
      git: {
        // Runs `afterAdmission` once, right after the next discovery: the request's admission.
        discoverRepository: async (path, discoveryOptions) => {
          const found = await count("discoverRepository", () =>
            discoverRepository(path, discoveryOptions),
          );
          const step = afterAdmission;
          afterAdmission = null;
          if (step) await step();
          return found;
        },
      },
      ...options,
    });
    const blockers = [];
    for (const name of ["b1", "b2"]) {
      const repo = await env.register(name);
      const mounts = [{ source: "checkout", repoId: repo.repoId, name: "m" }];
      blockers.push({ path: repo.path, ...(await created(env.tasks, `c-${name}`, name, mounts)) });
    }
    const fill = async () => {
      for (const blocker of blockers) hung.add(blocker.path);
      const reads = await Promise.all(blockers.map((blocker) => env.tasks.get(blocker.taskId)));
      for (const read of reads) expect(read.task.workspace.mounts[0].state).toBe("unavailable");
      // A read answers by a timer at its deadline, and a timer can fire up to a millisecond
      // before performance.now() reaches a fractional deadline. The hung checks count as
      // abandoned (and saturate the permits) only once their holders are past it; a write
      // probing before then would wait for a permit until its own deadline instead.
      await sleep(20);
    };
    const release = async () => {
      hung.clear();
      for (const done of waiting.splice(0)) done("present");
      await sleep(20);
    };
    return {
      env,
      fill,
      release,
      calls,
      count: (on) => {
        counting = on;
        calls.length = 0;
      },
      afterAdmission: (step) => (afterAdmission = step),
    };
  }

  const busy = { kind: "BUSY", acceptance: "not-accepted", nextAction: "none" };

  it("refuses a write as BUSY when the filesystem permits fill between its admission and its last check, and records nothing", async () => {
    const { env, fill, release, afterAdmission } = await saturable();
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c-t", "T");
    const tasksBefore = await env.rows("SELECT task_id FROM tasks ORDER BY task_id");
    const mountsBefore = await env.rows("SELECT mount_id FROM mounts ORDER BY mount_id");
    const checkout = { source: "checkout", repoId: alpha.repoId };
    afterAdmission(fill);
    expect(
      (await env.tasks.create("p", { operationId: "c", title: "New", mounts: [checkout] })).error,
    ).toMatchObject(busy);
    await release();
    afterAdmission(fill);
    expect(
      (await env.tasks.addMount("p", { operationId: "a", taskId, mount: checkout })).error,
    ).toMatchObject(busy);
    await release();
    expect(await env.rows("SELECT task_id FROM tasks ORDER BY task_id")).toEqual(tasksBefore);
    expect(await env.rows("SELECT mount_id FROM mounts ORDER BY mount_id")).toEqual(mountsBefore);
    for (const operationId of ["c", "a"])
      expect(await env.receipts.get({ serverId: "server", principalId: "p", operationId })).toBe(
        null,
      );
    // Not accepted, and nothing is known about the path: the same request succeeds later.
    expect(
      (await env.tasks.addMount("p", { operationId: "a", taskId, mount: checkout })).operation
        .state,
    ).toBe("succeeded");
  });

  it("gives every Git discovery of a write the write-step deadline", async () => {
    const left = [];
    const env = await setup({
      writeStepBudgetMs: 5000,
      git: {
        discoverRepository: (path, options) => {
          left.push(options.deadline - performance.now());
          return discoverRepository(path, options);
        },
      },
    });
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c", "T");
    left.length = 0;
    const added = await env.tasks.addMount("p", {
      operationId: "a",
      taskId,
      mount: { source: "checkout", repoId: alpha.repoId },
    });
    expect(added.operation.state).toBe("succeeded");
    // The admission and the last check before the transaction, each within 5 s of its start.
    expect(left).toHaveLength(2);
    for (const remaining of left) {
      expect(remaining).toBeLessThanOrEqual(5000);
      expect(remaining).toBeGreaterThan(4000);
    }
  });

  it("refuses a write as GIT_UNAVAILABLE when the real path of its checkout gives no answer, although the later checks would pass", async () => {
    let hang = false;
    const env = await setup({
      writeStepBudgetMs: 100,
      fs: {
        // The next resolution never settles; every later one answers.
        realpath: (path) => {
          if (!hang) return realpath(path);
          hang = false;
          return new Promise(() => undefined);
        },
      },
    });
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c-t", "T");
    const tasksBefore = await env.rows("SELECT task_id FROM tasks ORDER BY task_id");
    const mountsBefore = await env.rows("SELECT mount_id FROM mounts ORDER BY mount_id");
    const checkout = { source: "checkout", repoId: alpha.repoId };
    const unanswered = { kind: "GIT_UNAVAILABLE", acceptance: "not-accepted" };
    hang = true;
    expect(
      (await env.tasks.create("p", { operationId: "c", title: "New", mounts: [checkout] })).error,
    ).toMatchObject(unanswered);
    hang = true;
    expect(
      (await env.tasks.addMount("p", { operationId: "a", taskId, mount: checkout })).error,
    ).toMatchObject(unanswered);
    expect(await env.rows("SELECT task_id FROM tasks ORDER BY task_id")).toEqual(tasksBefore);
    expect(await env.rows("SELECT mount_id FROM mounts ORDER BY mount_id")).toEqual(mountsBefore);
    for (const operationId of ["c", "a"])
      expect(await env.receipts.get({ serverId: "server", principalId: "p", operationId })).toBe(
        null,
      );
  });

  it("starts no filesystem work for a write while every permit is held, and records nothing", async () => {
    const { env, fill, release, calls, count } = await saturable();
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c-t", "T");
    const tasksBefore = await env.rows("SELECT task_id FROM tasks ORDER BY task_id");
    const mountsBefore = await env.rows("SELECT mount_id FROM mounts ORDER BY mount_id");
    const checkout = { source: "checkout", repoId: alpha.repoId };
    await fill();
    count(true);
    expect(
      (await env.tasks.create("p", { operationId: "c", title: "New", mounts: [checkout] })).error,
    ).toMatchObject(busy);
    expect(
      (await env.tasks.addMount("p", { operationId: "a", taskId, mount: checkout })).error,
    ).toMatchObject(busy);
    // Not the workspace root, the entry path, the checkout's real path nor Git.
    expect(calls).toEqual([]);
    count(false);
    await release();
    expect(await env.rows("SELECT task_id FROM tasks ORDER BY task_id")).toEqual(tasksBefore);
    expect(await env.rows("SELECT mount_id FROM mounts ORDER BY mount_id")).toEqual(mountsBefore);
    for (const operationId of ["c", "a"])
      expect(await env.receipts.get({ serverId: "server", principalId: "p", operationId })).toBe(
        null,
      );
  });

  it("leaves no observer behind on shared work that never settles, however many reads time out against it", async () => {
    let hangCheck = false;
    let hangEntry = false;
    const env = await setup({
      readBudgetMs: 200,
      fs: {
        checkoutDirectory: (path) =>
          hangCheck ? new Promise(() => undefined) : checkoutDirectory(path),
        inspectEntry: (...args) =>
          hangEntry ? new Promise(() => undefined) : inspectEntry(...args),
      },
    });
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c", "T", [
      { source: "checkout", repoId: alpha.repoId },
    ]);
    const rounds = async (read) => {
      for (let round = 0; round < 5; round += 1) {
        let peak = 0;
        const sample = setInterval(() => (peak = Math.max(peak, env.tasks.observerCount())), 5);
        const reads = await Promise.all(Array.from({ length: 200 }, () => env.tasks.get(taskId)));
        clearInterval(sample);
        for (const { task } of reads) read(task.workspace);
        // The reads of this round observed the shared work until their deadline, and left nothing
        // on it once they had answered.
        expect(peak).toBeGreaterThan(0);
        expect(env.tasks.observerCount()).toBe(0);
      }
    };
    // A checkout check that never settles.
    hangCheck = true;
    await rounds((workspace) => expect(workspace.mounts[0].state).toBe("unavailable"));
    // An entry materialization that never settles too.
    hangEntry = true;
    await rounds((workspace) => expect(workspace.entryState).toBe("unavailable"));
  });

  it("drops a request waiting for a Git slot at its deadline without starting its discovery", async () => {
    let slow = false;
    const calls = [];
    const env = await setup({
      readBudgetMs: 200,
      gitConcurrency: 1,
      git: {
        discoverRepository: async (path, options) => {
          if (slow) {
            calls.push(path);
            await sleep(600);
          }
          return discoverRepository(path, options);
        },
      },
    });
    const alpha = await env.register("alpha");
    const beta = await env.register("beta");
    const { taskId } = await created(env.tasks, "c", "T", [
      { source: "checkout", repoId: alpha.repoId, name: "a" },
      { source: "checkout", repoId: beta.repoId, name: "b" },
    ]);
    slow = true;
    expect(await states(env, taskId)).toEqual(["unavailable", "unavailable"]);
    // The slot is free again once the first discovery ends; the second never starts.
    await sleep(800);
    expect(calls).toHaveLength(1);
  });

  it("serves the Git slots to waiting requests in turn, so a single get does not wait behind a large list", async () => {
    let slow = false;
    const env = await setup({
      gitConcurrency: 1,
      git: {
        discoverRepository: async (path, options) => {
          if (slow) await sleep(300);
          return discoverRepository(path, options);
        },
      },
    });
    const taskIds = [];
    for (const name of ["a1", "a2", "a3", "a4", "a5", "a6", "a7"]) {
      const repo = await env.register(name);
      const mounts = [{ source: "checkout", repoId: repo.repoId, name: "m" }];
      taskIds.push((await created(env.tasks, `c-${name}`, name, mounts)).taskId);
    }
    taskIds.sort();
    slow = true;
    // A page of the first six tasks; the get reads the seventh, whose checkout the list does not
    // check (a check of the same checkout would be shared with the list, not queued anew).
    const list = env.tasks.list({ limit: 6 });
    // The list has queued all six checks by now, one of them running.
    await sleep(100);
    const started = performance.now();
    expect(await states(env, taskIds[6])).toEqual(["ready"]);
    // In turn: at most the rest of the list's running check and one more before the get's own,
    // some 800 ms. Behind the whole list it would be five more checks first, over 1700 ms.
    expect(performance.now() - started).toBeLessThan(1300);
    const listed = await list;
    expect(listed.tasks.flatMap((task) => task.workspace.mounts.map((m) => m.state))).toEqual(
      Array(6).fill("ready"),
    );
  });

  it("checks a checkout shared by tasks of one page once and runs at most gitConcurrency Git queries across requests", async () => {
    let active = 0;
    let peak = 0;
    const calls = [];
    const env = await setup({
      gitConcurrency: 2,
      git: {
        discoverRepository: async (path, options) => {
          calls.push(path);
          active += 1;
          peak = Math.max(peak, active);
          try {
            await sleep(20);
            return await discoverRepository(path, options);
          } finally {
            active -= 1;
          }
        },
      },
    });
    const repos = [];
    for (const name of ["alpha", "beta", "gamma", "delta"]) repos.push(await env.register(name));
    for (const [index, repo] of repos.entries()) {
      const mounts = [{ source: "checkout", repoId: repos[0].repoId, name: "shared" }];
      if (index > 0) mounts.push({ source: "checkout", repoId: repo.repoId, name: "own" });
      await created(env.tasks, `c${index}`, `T${index}`, mounts);
    }
    calls.length = 0;
    peak = 0;
    const listed = await env.tasks.list({ limit: 10 });
    expect(listed.tasks.flatMap((task) => task.workspace.mounts.map((m) => m.state))).toEqual(
      Array(7).fill("ready"),
    );
    expect(calls.filter((path) => path === repos[0].path)).toHaveLength(1);
    expect(calls).toHaveLength(4);
    peak = 0;
    await Promise.all([
      env.tasks.list({ limit: 10 }),
      env.tasks.list({ limit: 10 }),
      ...listed.tasks.map((task) => env.tasks.get(task.taskId)),
    ]);
    expect(peak).toBe(2);
  });
});

describe("capacity handover", () => {
  // Hands the only place of `limit` from one holder to a waiter whose deadline is 50 ms away, and
  // keeps the event loop busy for 100 ms between the handover and the waiter resuming: a reaction
  // to the holder's work added after the limit's own runs after the handover, before the waiter's
  // continuation.
  async function handover(hold, wait) {
    let finish;
    const first = new Promise((done) => (finish = done));
    const held = hold(() => first);
    await sleep(10);
    let started = 0;
    const waiting = wait(performance.now() + 50, () => {
      started += 1;
      return Promise.resolve("late");
    });
    void first.then(() => {
      const until = performance.now() + 100;
      while (performance.now() < until);
    });
    finish("first");
    return { held, waiting: await waiting, started: () => started };
  }

  it("starts no filesystem work for a permit handed over before its deadline but resumed after it", async () => {
    const permits = new FsPermits(1);
    const { waiting, started } = await handover(
      (work) => permits.start({}, performance.now() + 10_000, work),
      (deadline, work) => permits.start({}, deadline, work),
    );
    expect(waiting).toBe(null);
    expect(started()).toBe(0);
    // The permit was given back: the next request gets it at once.
    const next = await permits.start({}, performance.now() + 1000, () => Promise.resolve("next"));
    expect(await next.settled).toBe("next");
  });

  it("starts no discovery for a Git slot handed over before its deadline but resumed after it", async () => {
    const slots = new Slots(1);
    const { waiting, started } = await handover(
      (work) => slots.run({}, performance.now() + 10_000, work, "busy"),
      (deadline, work) => slots.run({}, deadline, work, "busy"),
    );
    expect(waiting).toBe("busy");
    expect(started()).toBe(0);
    expect(await slots.run({}, performance.now() + 1000, async () => "next", "busy")).toBe("next");
  });
});

describe("migration 002", () => {
  it("upgrades a version 1 database: existing workspaces are not materialized yet", async () => {
    const layout = await prepareHome(join(await temporary(), "home"));
    const options = {
      databasePath: layout.databasePath,
      backupDirectory: layout.backupDirectory,
      operationModules: [testOperations],
    };
    const first = await Store.open({ ...options, migrations: [MIGRATIONS[0]] });
    await first.call("test.run", {
      sql: `INSERT INTO tasks VALUES ('t', 0, 'T', 't', 0, 1, 1)`,
    });
    await first.call("test.run", {
      sql: `INSERT INTO workspaces VALUES ('w', 't', 0, '/w/t-1', 1)`,
    });
    await first.close();
    const store = await Store.open(options);
    stores.push(store);
    expect(store.schemaVersion).toBe(2);
    expect(
      await store.call("test.all", {
        sql: "SELECT workspace_id, revision, materialized_revision FROM workspaces",
      }),
    ).toEqual([{ workspace_id: "w", revision: 0, materialized_revision: null }]);
    expect(
      await store.call("test.all", {
        sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'mounts_by_repo'",
      }),
    ).toEqual([{ name: "mounts_by_repo" }]);
  });
});

describe("workspace entry", () => {
  const manifestIn = (entryPath) => join(entryPath, "cove-workspace.json");
  const entryState = async (env, taskId) => (await env.tasks.get(taskId)).task.workspace.entryState;
  const entryOf = async (env, taskId) => (await env.tasks.get(taskId)).task.workspace.entryPath;
  const exists = (path) =>
    lstat(path).then(
      () => true,
      () => false,
    );
  const mountAdd = (env, taskId, repoId, name) =>
    env.tasks.addMount("p", {
      operationId: `add-${name}`,
      taskId,
      mount: { source: "checkout", repoId, name },
    });

  it("refuses a task whose workspace root cannot be created and records nothing", async () => {
    const env = await setup();
    await writeFile(env.workspaceRoot, "a file in the way");
    expect(
      (await env.tasks.create("p", { operationId: "c", title: "T", mounts: [] })).error,
    ).toMatchObject({ kind: "WORKSPACE_ENTRY_UNAVAILABLE", acceptance: "not-accepted" });
    expect(await env.rows("SELECT * FROM tasks")).toEqual([]);
  });

  it("refuses a task whose entry path is already taken and leaves the occupant as it is", async () => {
    const env = await setup({ newId: counter() });
    const occupant = join(env.workspaceRoot, "t-id0001");
    await mkdir(occupant, { recursive: true });
    await writeFile(join(occupant, "notes.txt"), "mine\n");
    expect(
      (await env.tasks.create("p", { operationId: "c", title: "T", mounts: [] })).error,
    ).toMatchObject({ kind: "WORKSPACE_ENTRY_UNAVAILABLE", acceptance: "not-accepted" });
    expect(await env.rows("SELECT * FROM tasks")).toEqual([]);
    expect(await readdir(occupant)).toEqual(["notes.txt"]);
  });

  it("reports an occupant that appears before the entry is published as unavailable and never writes into it", async () => {
    let intruded = false;
    const env = await setup({
      fs: {
        publishEntry: async (path, manifest, hooks) => {
          if (!intruded) {
            intruded = true;
            await mkdir(path);
            await writeFile(manifestIn(path), "theirs\n");
          }
          return publishEntry(path, manifest, hooks);
        },
      },
    });
    const { operation, taskId } = await created(env.tasks, "c", "T");
    // The task was accepted and recorded; only its entry is not Cove's.
    expect(operation.state).toBe("succeeded");
    const entryPath = await entryOf(env, taskId);
    expect(await entryState(env, taskId)).toBe("unavailable");
    expect(await readFile(manifestIn(entryPath), "utf8")).toBe("theirs\n");
    expect(await readdir(entryPath)).toEqual(["cove-workspace.json"]);
    // Nothing of the failed publication is left behind.
    expect(await readdir(env.workspaceRoot)).toEqual([basename(entryPath)]);
    // Once the operator removes it, a read publishes the entry that was never written.
    await rm(entryPath, { recursive: true });
    expect(await entryState(env, taskId)).toBe("ready");
    expect(JSON.parse(await readFile(manifestIn(entryPath), "utf8"))).toMatchObject({ taskId });
  });

  it("reports a foreign, malformed, linked or other workspace's manifest as unavailable and leaves it as it is", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const one = await created(env.tasks, "one", "One");
    const two = await created(env.tasks, "two", "Two");
    const manifestOne = manifestIn(await entryOf(env, one.taskId));
    const entryTwo = await entryOf(env, two.taskId);
    const manifestTwo = manifestIn(entryTwo);
    const textOne = await readFile(manifestOne, "utf8");
    const cases = [
      ["foreign", async () => writeFile(manifestTwo, '{ "kind": "something-else" }\n')],
      ["malformed", async () => writeFile(manifestTwo, '{ "kind": "cove-workspace", ')],
      ["another workspace", async () => writeFile(manifestTwo, textOne)],
      ["a symlink", async () => symlink(manifestOne, manifestTwo)],
      ["none", async () => undefined],
    ];
    for (const [index, [label, place]] of cases.entries()) {
      await rm(manifestTwo, { force: true });
      await place();
      const before = await readdir(entryTwo);
      const text = await readFile(manifestTwo, "utf8").catch(() => null);
      expect([label, await entryState(env, two.taskId)]).toEqual([label, "unavailable"]);
      // A change of the workspace is recorded but does not write over it either.
      const added = await mountAdd(env, two.taskId, alpha.repoId, `m${index}`);
      expect(added.operation.state).toBe("succeeded");
      expect([label, await entryState(env, two.taskId)]).toEqual([label, "unavailable"]);
      expect(await readdir(entryTwo)).toEqual(before);
      expect(await readFile(manifestTwo, "utf8").catch(() => null)).toBe(text);
    }
    expect(await readFile(manifestOne, "utf8")).toBe(textOne);
  });

  it("reports an older manifest of its own entry as pending and brings it up to date", async () => {
    let failReplace = false;
    const env = await setup({
      fs: {
        replaceManifest: async (...args) => (failReplace ? "failed" : replaceManifest(...args)),
      },
    });
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c", "T");
    const manifest = manifestIn(await entryOf(env, taskId));
    const revisionZero = await readFile(manifest, "utf8");
    failReplace = true;
    expect((await mountAdd(env, taskId, alpha.repoId, "a")).operation.state).toBe("succeeded");
    expect(await entryState(env, taskId)).toBe("pending");
    expect(await readFile(manifest, "utf8")).toBe(revisionZero);
    expect(await env.rows("SELECT revision, materialized_revision FROM workspaces")).toEqual([
      { revision: 1, materialized_revision: 0 },
    ]);
    failReplace = false;
    expect(await entryState(env, taskId)).toBe("ready");
    expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({
      workspaceRevision: 1,
      mounts: [{ name: "a" }],
    });
    // An older copy of its own manifest put back is not current either.
    await writeFile(manifest, revisionZero);
    failReplace = true;
    expect(await entryState(env, taskId)).toBe("pending");
    failReplace = false;
    expect(await entryState(env, taskId)).toBe("ready");
  });

  it("publishes a change whose manifest write failed on the next read, also once its entry was deleted, and only once", async () => {
    let failReplace = false;
    const env = await setup({
      fs: {
        replaceManifest: async (...args) => (failReplace ? "failed" : replaceManifest(...args)),
      },
    });
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c", "T");
    const entryPath = await entryOf(env, taskId);
    failReplace = true;
    await mountAdd(env, taskId, alpha.repoId, "a");
    expect(await env.rows("SELECT revision, materialized_revision FROM workspaces")).toEqual([
      { revision: 1, materialized_revision: 0 },
    ]);
    failReplace = false;
    // Revision 1 was never written, so its one publication is still to be made.
    await rm(entryPath, { recursive: true });
    expect(await entryState(env, taskId)).toBe("ready");
    expect(JSON.parse(await readFile(manifestIn(entryPath), "utf8"))).toMatchObject({
      workspaceRevision: 1,
      mounts: [{ name: "a" }],
    });
    // Deleted again: that publication was made, so reads leave it missing.
    await rm(entryPath, { recursive: true });
    expect(await entryState(env, taskId)).toBe("missing");
    expect(await entryState(env, taskId)).toBe("missing");
    expect(await exists(entryPath)).toBe(false);
    await mountAdd(env, taskId, alpha.repoId, "b");
    expect(await entryState(env, taskId)).toBe("ready");
    expect(JSON.parse(await readFile(manifestIn(entryPath), "utf8")).mounts).toHaveLength(2);
  });

  it("publishes once, after a restart, the change of a write that committed and then died or lost its answer while its entry was deleted", async () => {
    let lose = false;
    const env = await setup({
      wrapStore: (store) => ({
        call: async (name, args) => {
          const result = await store.call(name, args);
          if (name === "receipts.write" && lose) {
            lose = false;
            throw new Error("the answer to a committed write is lost");
          }
          return result;
        },
      }),
    });
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c", "T");
    const entryPath = await entryOf(env, taskId);
    await rm(entryPath, { recursive: true });
    expect(await entryState(env, taskId)).toBe("missing");
    lose = true;
    expect((await mountAdd(env, taskId, alpha.repoId, "a")).error).toBeDefined();
    expect(await exists(entryPath)).toBe(false);
    expect(
      await env.rows("SELECT revision AS r, materialized_revision AS m FROM workspaces"),
    ).toEqual([{ r: 1, m: 0 }]);
    // The committed revision's publication was never attempted; the restarted server's first
    // read makes it.
    const restarted = env.restart();
    const read = async () => (await restarted.get(taskId)).task.workspace.entryState;
    expect(await read()).toBe("ready");
    expect(JSON.parse(await readFile(manifestIn(entryPath), "utf8"))).toMatchObject({
      workspaceRevision: 1,
      mounts: [{ name: "a" }],
    });
    await rm(entryPath, { recursive: true });
    expect(await read()).toBe("missing");
    expect(await exists(entryPath)).toBe(false);
  });

  it("reports an entry that failed to be published as pending and publishes it on the next read", async () => {
    let fail = true;
    const env = await setup({
      fs: { publishEntry: async (...args) => (fail ? "failed" : publishEntry(...args)) },
    });
    const { operation, taskId } = await created(env.tasks, "c", "T");
    // The task is recorded (the operation succeeded); its entry is not written yet.
    expect(operation.state).toBe("succeeded");
    expect(await entryState(env, taskId)).toBe("pending");
    fail = false;
    expect(await entryState(env, taskId)).toBe("ready");
    expect(await env.rows("SELECT revision, materialized_revision FROM workspaces")).toEqual([
      { revision: 0, materialized_revision: 0 },
    ]);
    // Deleted from outside: reported missing, not recreated by reads; the next change writes it.
    const entryPath = await entryOf(env, taskId);
    await rm(entryPath, { recursive: true });
    expect(await entryState(env, taskId)).toBe("missing");
    expect(await entryState(env, taskId)).toBe("missing");
    const alpha = await env.register("alpha");
    await mountAdd(env, taskId, alpha.repoId, "a");
    expect(await entryState(env, taskId)).toBe("ready");
  });

  it("never writes through a symlink put in place of the entry or of the workspace root", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const one = await created(env.tasks, "one", "One");
    const entryOne = await entryOf(env, one.taskId);
    const elsewhere = await temporary();
    await rm(entryOne, { recursive: true });
    await symlink(elsewhere, entryOne);
    await mountAdd(env, one.taskId, alpha.repoId, "a");
    expect(await entryState(env, one.taskId)).toBe("unavailable");
    expect(await readdir(elsewhere)).toEqual([]);
    // The root itself replaced by a symlink to a copy: the entry is no longer where it was
    // recorded, even though a manifest is there.
    const two = await created(env.tasks, "two", "Two");
    const entryTwo = await entryOf(env, two.taskId);
    const copy = await temporary();
    await cp(env.workspaceRoot, copy, { recursive: true, verbatimSymlinks: true });
    const copied = await readdir(copy);
    await rename(env.workspaceRoot, `${env.workspaceRoot}.moved`);
    await symlink(copy, env.workspaceRoot);
    expect(await entryState(env, two.taskId)).toBe("unavailable");
    await mountAdd(env, two.taskId, alpha.repoId, "b");
    expect(await entryState(env, two.taskId)).toBe("unavailable");
    expect(await readdir(copy)).toEqual(copied);
    expect(
      JSON.parse(await readFile(manifestIn(join(copy, basename(entryTwo))), "utf8")).mounts,
    ).toEqual([]);
  });

  // A bare root with one entry path below it, outside any workspace service.
  async function entryFixture() {
    const base = await temporary();
    const root = join(base, "root");
    await mkdir(root);
    const elsewhere = join(base, "elsewhere");
    await mkdir(elsewhere);
    const swapRoot = async () => {
      await rename(root, join(base, "root.moved"));
      await symlink(elsewhere, root);
    };
    const restoreRoot = async () => {
      await rm(root);
      await rename(join(base, "root.moved"), root);
    };
    const manifest = {
      kind: "cove-workspace",
      version: 1,
      taskId: "t",
      workspaceId: "w",
      workspaceRevision: 0,
      note: "n",
      mounts: [],
    };
    return { base, root, elsewhere, swapRoot, restoreRoot, manifest, entryPath: join(root, "t-1") };
  }

  it("claims a new entry exclusively and never adopts a directory or a manifest that appears meanwhile", async () => {
    const { entryPath, manifest } = await entryFixture();
    // An empty directory made right before the claim is someone else's and stays empty.
    expect(await publishEntry(entryPath, manifest, { beforeClaim: () => mkdir(entryPath) })).toBe(
      "occupied",
    );
    expect(await readdir(entryPath)).toEqual([]);
    await rm(entryPath, { recursive: true });
    // A manifest put into the claimed entry before the link is kept, and so is the claim holding
    // it: not `occupied`, which says nothing of the attempt is left. The temporary file is gone.
    const intrude = () => writeFile(manifestIn(entryPath), "theirs\n");
    expect(await publishEntry(entryPath, manifest, { beforePublish: intrude })).toBe("unavailable");
    expect(await readdir(entryPath)).toEqual(["cove-workspace.json"]);
    expect(await readFile(manifestIn(entryPath), "utf8")).toBe("theirs\n");
    await rm(entryPath, { recursive: true });
    expect(await publishEntry(entryPath, manifest)).toBe("written");
    expect(await readdir(entryPath)).toEqual(["cove-workspace.json"]);
  });

  it("creates nothing through a root swapped right before the claim or the temporary manifest", async () => {
    const { base, elsewhere, swapRoot, restoreRoot, manifest, entryPath } = await entryFixture();
    expect(await publishEntry(entryPath, manifest, { beforeClaim: swapRoot })).toBe("unavailable");
    expect(await readdir(elsewhere)).toEqual([]);
    await restoreRoot();
    // The other side already has a directory of the entry's name, which a write through the
    // swapped root would reach.
    await mkdir(join(elsewhere, "t-1"));
    expect(await publishEntry(entryPath, manifest, { beforeCreate: swapRoot })).toBe("unavailable");
    expect(await readdir(join(elsewhere, "t-1"))).toEqual([]);
    // The claim moved with the real root, unverified, and is left as it is.
    expect(await readdir(join(base, "root.moved", "t-1"))).toEqual([]);
  });

  it("replaces a manifest only while it is still the file and the content inspected", async () => {
    const { entryPath, manifest, swapRoot, elsewhere } = await entryFixture();
    expect(await publishEntry(entryPath, manifest)).toBe("written");
    const original = await readFile(manifestIn(entryPath), "utf8");
    const next = { ...manifest, workspaceRevision: 1 };
    const attempt = async (beforeRename) =>
      replaceManifest(entryPath, await inspectEntry(entryPath, next), next, { beforeRename });
    // The same bytes in another file, renamed over it (so it is a new inode for certain).
    const recreate = async () => {
      await writeFile(join(entryPath, "theirs.tmp"), original);
      await rename(join(entryPath, "theirs.tmp"), manifestIn(entryPath));
    };
    expect(await attempt(recreate)).toBe("unavailable");
    expect(await readdir(entryPath)).toEqual(["cove-workspace.json"]);
    // Other bytes in the same file.
    const rewrite = () => writeFile(manifestIn(entryPath), "theirs\n");
    expect(await attempt(rewrite)).toBe("unavailable");
    expect(await readFile(manifestIn(entryPath), "utf8")).toBe("theirs\n");
    expect(await readdir(entryPath)).toEqual(["cove-workspace.json"]);
    // The entry swapped for another directory with a manifest.
    await writeFile(manifestIn(entryPath), original);
    const swapEntry = async () => {
      await rename(entryPath, `${entryPath}.moved`);
      await mkdir(entryPath);
      await writeFile(manifestIn(entryPath), "theirs\n");
    };
    expect(await attempt(swapEntry)).toBe("unavailable");
    expect(await readdir(entryPath)).toEqual(["cove-workspace.json"]);
    expect(await readFile(manifestIn(entryPath), "utf8")).toBe("theirs\n");
    expect(await readFile(manifestIn(`${entryPath}.moved`), "utf8")).toBe(original);
    await rm(entryPath, { recursive: true });
    await rename(`${entryPath}.moved`, entryPath);
    // The root swapped.
    expect(await attempt(swapRoot)).toBe("unavailable");
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("does not take a manifest rewritten in place while it was read as current", async () => {
    const { entryPath, manifest } = await entryFixture();
    expect(await publishEntry(entryPath, manifest)).toBe("written");
    const path = manifestIn(entryPath);
    const { ino } = await lstat(path);
    // The same file, rewritten after its bytes were read and before its handle is checked again:
    // the bytes read are the expected ones, and its change time is the rewrite's.
    const rewrite = () => writeFile(path, "theirs\n");
    expect((await inspectEntry(entryPath, manifest, { afterBytes: rewrite })).kind).toBe(
      "unavailable",
    );
    expect((await lstat(path)).ino).toBe(ino);
  });

  it("does not take a manifest as current when its name was swapped after it was read", async () => {
    const { entryPath, manifest } = await entryFixture();
    expect(await publishEntry(entryPath, manifest)).toBe("written");
    const text = await readFile(manifestIn(entryPath), "utf8");
    // The same bytes in another file, renamed over it after the old file was read.
    const swap = async () => {
      await writeFile(join(entryPath, "theirs"), text);
      await rename(join(entryPath, "theirs"), manifestIn(entryPath));
    };
    expect((await inspectEntry(entryPath, manifest, { afterRead: swap })).kind).toBe("unavailable");
  });

  it("does not replace a manifest swapped in after it was validated, and keeps the one swapped in", async () => {
    const { entryPath, manifest } = await entryFixture();
    expect(await publishEntry(entryPath, manifest)).toBe("written");
    const original = await readFile(manifestIn(entryPath), "utf8");
    const next = { ...manifest, workspaceRevision: 1 };
    // Other bytes, and the same bytes in another file, renamed over it.
    for (const text of ["theirs\n", original]) {
      await writeFile(manifestIn(entryPath), original);
      const observed = await inspectEntry(entryPath, next);
      expect(observed.kind).toBe("stale");
      const swap = async () => {
        await writeFile(join(entryPath, "theirs"), text);
        await rename(join(entryPath, "theirs"), manifestIn(entryPath));
      };
      expect(await replaceManifest(entryPath, observed, next, { afterValidation: swap })).toBe(
        "unavailable",
      );
      expect(await readFile(manifestIn(entryPath), "utf8")).toBe(text);
      expect(await readdir(entryPath)).toEqual(["cove-workspace.json"]);
    }
  });

  it("publishes only the temporary manifest it wrote, and leaves one replaced or rewritten meanwhile as it is", async () => {
    const { entryPath, manifest } = await entryFixture();
    const temporaryIn = async () =>
      (await readdir(entryPath)).find((name) => name.endsWith(".tmp"));
    const replaced = async () => {
      const name = await temporaryIn();
      await writeFile(join(entryPath, "theirs"), "theirs\n");
      await rename(join(entryPath, "theirs"), join(entryPath, name));
    };
    const rewritten = async () => writeFile(join(entryPath, await temporaryIn()), "theirs\n");
    // A new entry: nothing is linked into place.
    for (const substitute of [replaced, rewritten]) {
      expect(await publishEntry(entryPath, manifest, { beforePublish: substitute })).toBe(
        "unavailable",
      );
      const left = await readdir(entryPath);
      expect(left).toEqual([expect.stringMatching(/\.tmp$/)]);
      expect(await readFile(join(entryPath, left[0]), "utf8")).toBe("theirs\n");
      await rm(entryPath, { recursive: true });
    }
    // A replacement: the manifest stays the one inspected.
    expect(await publishEntry(entryPath, manifest)).toBe("written");
    const original = await readFile(manifestIn(entryPath), "utf8");
    const next = { ...manifest, workspaceRevision: 1 };
    for (const substitute of [replaced, rewritten]) {
      const observed = await inspectEntry(entryPath, next);
      expect(await replaceManifest(entryPath, observed, next, { beforeRename: substitute })).toBe(
        "unavailable",
      );
      expect(await readFile(manifestIn(entryPath), "utf8")).toBe(original);
      const name = await temporaryIn();
      expect(await readFile(join(entryPath, name), "utf8")).toBe("theirs\n");
      await rm(join(entryPath, name));
    }
  });

  it("neither publishes nor replaces with a temporary manifest rewritten in place while it was checked", async () => {
    const { entryPath, manifest } = await entryFixture();
    const temporaryIn = async () =>
      (await readdir(entryPath)).find((name) => name.endsWith(".tmp"));
    // The same file and length, other bytes, after the check read it and before its handle is
    // checked again.
    const rewrite = async () => {
      const path = join(entryPath, await temporaryIn());
      const text = await readFile(path, "utf8");
      await writeFile(path, text.replace("cove-workspace", "evoc-workspace"));
    };
    expect(await publishEntry(entryPath, manifest, { afterTemporaryRead: rewrite })).toBe(
      "unavailable",
    );
    // Nothing was linked into place; the rewritten file is left as it is.
    expect(await readdir(entryPath)).toEqual([expect.stringMatching(/\.tmp$/)]);
    await rm(entryPath, { recursive: true });
    expect(await publishEntry(entryPath, manifest)).toBe("written");
    const original = await readFile(manifestIn(entryPath), "utf8");
    const next = { ...manifest, workspaceRevision: 1 };
    const observed = await inspectEntry(entryPath, next);
    expect(await replaceManifest(entryPath, observed, next, { afterTemporaryRead: rewrite })).toBe(
      "unavailable",
    );
    expect(await readFile(manifestIn(entryPath), "utf8")).toBe(original);
  });

  // The final lstat of a name (see NameStat in workspace-fs/entry.ts), reporting the change time
  // the file had before `change` ran on it: a change within one tick of the filesystem clock, which
  // a test cannot produce. Applies once, to the first name `target` accepts.
  const sameTick = (target, change) => {
    let pending = true;
    return async (path) => {
      if (!pending || !target(path)) return lstat(path, { bigint: true });
      pending = false;
      const before = await lstat(path, { bigint: true });
      await change(path);
      const after = await lstat(path, { bigint: true });
      return Object.create(after, { ctimeNs: { value: before.ctimeNs } });
    };
  };

  // The same file, one byte longer, after its last descriptor check and before its name's lstat.
  const longer = async (path) => writeFile(path, (await readFile(path, "utf8")) + " ");
  const isTemporary = (path) => path.endsWith(".tmp");

  it("does not publish a temporary manifest whose length changed within one clock tick of its check", async () => {
    const { entryPath, manifest } = await entryFixture();
    expect(
      await publishEntry(entryPath, manifest, { nameStat: sameTick(isTemporary, longer) }),
    ).toBe("unavailable");
    // Nothing is linked into place; the temporary file is left as it is.
    expect(await readdir(entryPath)).toEqual([expect.stringMatching(/\.tmp$/)]);
  });

  it("does not replace a manifest when it or the temporary one changed length within one clock tick of its check", async () => {
    const { entryPath, manifest } = await entryFixture();
    const named = (path) => path === manifestIn(entryPath);
    expect(await publishEntry(entryPath, manifest)).toBe("written");
    const next = { ...manifest, workspaceRevision: 1 };
    for (const target of [isTemporary, named]) {
      const before = await readFile(manifestIn(entryPath), "utf8");
      const observed = await inspectEntry(entryPath, next);
      expect(observed.kind).toBe("stale");
      expect(
        await replaceManifest(entryPath, observed, next, { nameStat: sameTick(target, longer) }),
      ).toBe("unavailable");
      // The manifest stays as it is (grown, when it was the one that changed).
      expect(await readFile(manifestIn(entryPath), "utf8")).toBe(
        target === named ? `${before} ` : before,
      );
      for (const name of (await readdir(entryPath)).filter(isTemporary))
        await rm(join(entryPath, name));
    }
  });

  it("does not take as current a manifest whose length changed within one clock tick of its read", async () => {
    const { entryPath, manifest } = await entryFixture();
    expect(await publishEntry(entryPath, manifest)).toBe("written");
    const named = (path) => path === manifestIn(entryPath);
    expect(
      (await inspectEntry(entryPath, manifest, { nameStat: sameTick(named, longer) })).kind,
    ).toBe("unavailable");
  });

  // Bytes that are not Cove's but decode to the same text: a manifest holding U+FFFD (EF BF BD)
  // with it replaced by a lone continuation byte (another length) or by a truncated four-byte
  // sequence (the same length), each of which a lossy decoder also reads as one U+FFFD.
  const replacementChar = { note: "\uFFFD" };
  const sameTextVariants = [
    ["another length", Buffer.from([0x80])],
    ["the same length", Buffer.from([0xf1, 0x80, 0x80])],
  ];
  const withVariant = (bytes, replacement) => {
    const at = bytes.indexOf(Buffer.from("\uFFFD"));
    expect(at).toBeGreaterThan(0);
    const changed = Buffer.concat([bytes.subarray(0, at), replacement, bytes.subarray(at + 3)]);
    expect(new TextDecoder().decode(changed)).toBe(new TextDecoder().decode(bytes));
    return changed;
  };
  // Rewrites a file in place (same inode) with the variant of its bytes.
  const rewriteVariant = async (path, replacement) => {
    const changed = withVariant(await readFile(path), replacement);
    await writeFile(path, changed);
    return changed;
  };

  it("does not take as Cove's a manifest whose bytes differ from Cove's but decode to the same text", async () => {
    for (const [, replacement] of sameTextVariants) {
      const { entryPath, manifest: base } = await entryFixture();
      const manifest = { ...base, ...replacementChar };
      expect(await publishEntry(entryPath, manifest)).toBe("written");
      const changed = await rewriteVariant(manifestIn(entryPath), replacement);
      // Not valid UTF-8, so not a manifest Cove wrote: foreign, neither current nor stale.
      expect((await inspectEntry(entryPath, manifest)).kind).toBe("foreign");
      expect((await inspectEntry(entryPath, { ...manifest, workspaceRevision: 1 })).kind).toBe(
        "foreign",
      );
      expect(await readFile(manifestIn(entryPath))).toEqual(changed);
    }
  });

  it("does not replace a manifest rewritten within one clock tick to other bytes of the same text", async () => {
    for (const [, replacement] of sameTextVariants) {
      const { entryPath, manifest: base } = await entryFixture();
      const manifest = { ...base, ...replacementChar };
      expect(await publishEntry(entryPath, manifest)).toBe("written");
      const next = { ...manifest, workspaceRevision: 1 };
      const observed = await inspectEntry(entryPath, next);
      expect(observed.kind).toBe("stale");
      const changed = await rewriteVariant(manifestIn(entryPath), replacement);
      // The rewrite within one tick of the filesystem clock, which a test cannot produce: the
      // observation carries the change time the rewritten file has.
      const { ctimeNs } = await lstat(manifestIn(entryPath), { bigint: true });
      const sameTickObservation = {
        ...observed,
        manifest: { ...observed.manifest, changed: ctimeNs },
      };
      expect(await replaceManifest(entryPath, sameTickObservation, next)).toBe("unavailable");
      expect(await readFile(manifestIn(entryPath))).toEqual(changed);
      expect((await readdir(entryPath)).filter(isTemporary)).toEqual([]);
    }
  });

  it("neither publishes nor replaces with a temporary manifest rewritten to other bytes of the same text", async () => {
    for (const [, replacement] of sameTextVariants) {
      const { entryPath, manifest: base } = await entryFixture();
      const manifest = { ...base, ...replacementChar };
      const rewriteTemporary = async () => {
        const [name] = (await readdir(entryPath)).filter(isTemporary);
        await rewriteVariant(join(entryPath, name), replacement);
      };
      expect(await publishEntry(entryPath, manifest, { beforePublish: rewriteTemporary })).toBe(
        "unavailable",
      );
      expect(await readdir(entryPath)).toEqual([expect.stringMatching(/\.tmp$/)]);
      await rm(entryPath, { recursive: true });
      expect(await publishEntry(entryPath, manifest)).toBe("written");
      const before = await readFile(manifestIn(entryPath));
      const next = { ...manifest, workspaceRevision: 1 };
      const observed = await inspectEntry(entryPath, next);
      expect(observed.kind).toBe("stale");
      expect(
        await replaceManifest(entryPath, observed, next, { afterValidation: rewriteTemporary }),
      ).toBe("unavailable");
      expect(await readFile(manifestIn(entryPath))).toEqual(before);
    }
  });

  it("reads a manifest up to the largest one Cove can write and treats a larger file as foreign", async () => {
    const { entryPath, manifest } = await entryFixture();
    // The largest manifest the protocol limits allow: 16 mounts whose paths JSON escapes 6:1.
    const largest = {
      ...manifest,
      taskId: "t".repeat(40),
      workspaceId: "w".repeat(40),
      workspaceRevision: Number.MAX_SAFE_INTEGER,
      mounts: Array.from({ length: 16 }, (_, index) => ({
        name: `${index}`.padEnd(64, "n"),
        path: "\u0001".repeat(M0_LIMITS.cwdBytes),
        source: "checkout",
        readOnly: false,
        state: "unavailable",
      })),
    };
    expect(Buffer.byteLength(manifestText(largest))).toBeGreaterThan(256 * 1024);
    expect(Buffer.byteLength(manifestText(largest))).toBeLessThanOrEqual(MAX_MANIFEST_BYTES);
    expect(await publishEntry(entryPath, largest)).toBe("written");
    expect((await inspectEntry(entryPath, largest)).kind).toBe("current");
    // At the bound exactly (padded with whitespace JSON ignores) it is read; one byte more is not.
    const next = { ...largest, workspaceRevision: 1 };
    const text = manifestText(largest);
    const padded = (size) => text + " ".repeat(size - Buffer.byteLength(text));
    await writeFile(manifestIn(entryPath), padded(MAX_MANIFEST_BYTES));
    expect((await inspectEntry(entryPath, next)).kind).toBe("stale");
    await writeFile(manifestIn(entryPath), padded(MAX_MANIFEST_BYTES + 1));
    expect((await inspectEntry(entryPath, next)).kind).toBe("foreign");
  });

  it("reports the entry state of the workspace revision it returns when a mount is added during the read", async () => {
    let duringRead = null;
    const env = await setup({
      wrapStore: (store) => ({
        call: async (name, args) => {
          const result = await store.call(name, args);
          if (name === "tasks.get" && duringRead) {
            const run = duringRead;
            duringRead = null;
            await run();
          }
          return result;
        },
      }),
    });
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c", "T");
    duringRead = () => mountAdd(env, taskId, alpha.repoId, "a");
    const { task } = await env.tasks.get(taskId);
    expect(duringRead).toBe(null);
    expect(task.workspace).toMatchObject({
      revision: 1,
      entryState: "ready",
      mounts: [expect.objectContaining({ name: "a" })],
    });
  });

  it("does not recreate a deleted entry for a resent mount removal, and leaves the change an identical request committed first to the next read", async () => {
    let entryPath;
    let duplicateFirst = false;
    const env = await setup({
      wrapStore: (store) => ({
        call: async (name, args) => {
          // An identical request commits right before this one's write transaction, and the
          // entry is deleted after that commit.
          if (name === "receipts.write" && duplicateFirst) {
            duplicateFirst = false;
            await store.call(name, args);
            await rm(entryPath, { recursive: true });
          }
          return store.call(name, args);
        },
      }),
    });
    const alpha = await env.register("alpha");
    const { taskId } = await created(env.tasks, "c", "T", [
      { source: "checkout", repoId: alpha.repoId, name: "a" },
      { source: "checkout", repoId: alpha.repoId, name: "b" },
    ]);
    entryPath = await entryOf(env, taskId);
    const [a, b] = (await env.tasks.get(taskId)).task.workspace.mounts;
    const remove = (operationId, mountId) =>
      env.tasks.removeMount("p", { operationId, taskId, mountId });
    expect((await remove("rm-a", a.mountId)).operation.state).toBe("succeeded");
    await rm(entryPath, { recursive: true });
    expect((await remove("rm-a", a.mountId)).operation.state).toBe("succeeded");
    expect(await exists(entryPath)).toBe(false);
    expect(await entryState(env, taskId)).toBe("missing");
    // Recreated by a change, then the duplicate.
    await mountAdd(env, taskId, alpha.repoId, "c");
    expect(await entryState(env, taskId)).toBe("ready");
    duplicateFirst = true;
    expect((await remove("rm-b", b.mountId)).operation.state).toBe("succeeded");
    expect(duplicateFirst).toBe(false);
    // The call answered with the other's record writes nothing; the other committed a revision
    // whose publication nobody attempted, which the next read makes, once.
    expect(await exists(entryPath)).toBe(false);
    expect(await entryState(env, taskId)).toBe("ready");
    await rm(entryPath, { recursive: true });
    expect(await entryState(env, taskId)).toBe("missing");
  });

  it("keeps a publication that left its claimed directory behind from publishing the same revision again", async () => {
    let intrude = true;
    const env = await setup({
      fs: {
        // Someone else's manifest appears in the directory Cove claimed, before the link.
        publishEntry: (path, manifest, hooks) =>
          publishEntry(
            path,
            manifest,
            intrude ? { beforePublish: () => writeFile(manifestIn(path), "theirs\n") } : hooks,
          ),
      },
    });
    const { taskId } = await created(env.tasks, "c", "T");
    intrude = false;
    const entryPath = await entryOf(env, taskId);
    expect(await entryState(env, taskId)).toBe("unavailable");
    expect(await readFile(manifestIn(entryPath), "utf8")).toBe("theirs\n");
    // The claim was this revision's one publication: removed from outside, it stays missing.
    await rm(entryPath, { recursive: true });
    expect(await entryState(env, taskId)).toBe("missing");
    expect(await exists(entryPath)).toBe(false);
  });

  it("answers a committed write by its entry budget while its manifest replacement hangs, and a later read repairs the entry", async () => {
    const unhandled = [];
    const record = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      let hang = false;
      let settled = false;
      const env = await setup({
        entryWriteBudgetMs: 100,
        fs: {
          replaceManifest: (...args) => {
            if (!hang) return replaceManifest(...args);
            hang = false;
            // Fails long after the write has answered.
            return sleep(1500).then(() => {
              settled = true;
              throw new Error("late");
            });
          },
        },
      });
      const { taskId } = await created(env.tasks, "c", "T");
      const alpha = await env.register("alpha");
      hang = true;
      const begun = performance.now();
      const outcome = await env.tasks.addMount("p", {
        operationId: "a",
        taskId,
        mount: { source: "checkout", repoId: alpha.repoId },
      });
      expect(performance.now() - begun).toBeLessThan(1200);
      expect(outcome.operation.state).toBe("succeeded");
      expect(settled).toBe(false);
      await sleep(1600);
      expect(settled).toBe(true);
      expect(unhandled).toEqual([]);
      const { task } = await env.tasks.get(taskId);
      expect(task.workspace.entryState).toBe("ready");
      const written = JSON.parse(await readFile(manifestIn(task.workspace.entryPath), "utf8"));
      expect(written.workspaceRevision).toBe(task.workspace.revision);
      expect(written.mounts).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("keeps an entry that was published but not recorded missing on reads once it is deleted", async () => {
    let failRecord = true;
    const env = await setup({
      wrapStore: (store) => ({
        call: async (name, args) => {
          if (name === "workspaces.markMaterialized" && failRecord)
            throw new Error("injected store failure");
          return store.call(name, args);
        },
      }),
    });
    const { taskId } = await created(env.tasks, "c", "T");
    const entryPath = await entryOf(env, taskId);
    expect(await exists(manifestIn(entryPath))).toBe(true);
    expect(await entryState(env, taskId)).toBe("pending");
    expect(
      await env.rows(
        "SELECT materialized_revision AS m, entry_attempted_revision AS a FROM workspaces",
      ),
    ).toEqual([{ m: null, a: 0 }]);
    await rm(entryPath, { recursive: true });
    failRecord = false;
    expect(await entryState(env, taskId)).toBe("missing");
    expect(await entryState(env, taskId)).toBe("missing");
    expect(await exists(entryPath)).toBe(false);
    const alpha = await env.register("alpha");
    await mountAdd(env, taskId, alpha.repoId, "a");
    expect(await entryState(env, taskId)).toBe("ready");
  });

  it("creates the root and the entry 0700 with a 0600 manifest, and records the entry only after flushing it", async () => {
    let failSync = true;
    const seen = [];
    let env;
    env = await setup({
      fs: {
        syncEntry: async (path) => {
          seen.push(await env.rows("SELECT materialized_revision AS m FROM workspaces"));
          if (failSync) throw new Error("injected flush failure");
          return syncEntry(path);
        },
      },
    });
    const { taskId } = await created(env.tasks, "c", "T");
    const entryPath = await entryOf(env, taskId);
    // Published but not flushed: not recorded, and not reported ready.
    expect(await exists(manifestIn(entryPath))).toBe(true);
    expect(await entryState(env, taskId)).toBe("pending");
    expect(await env.rows("SELECT materialized_revision AS m FROM workspaces")).toEqual([
      { m: null },
    ]);
    failSync = false;
    expect(await entryState(env, taskId)).toBe("ready");
    expect(await env.rows("SELECT materialized_revision AS m FROM workspaces")).toEqual([{ m: 0 }]);
    // Every flush ran before the revision was recorded: the create, then each of the three reads
    // above, of which only the last one could flush and record it.
    expect(seen).toEqual(Array(4).fill([{ m: null }]));
    const mode = async (path) => (await stat(path)).mode & 0o777;
    expect(await mode(env.workspaceRoot)).toBe(0o700);
    expect(await mode(entryPath)).toBe(0o700);
    expect(await mode(manifestIn(entryPath))).toBe(0o600);
  });
});

describe("worktree mounts", () => {
  it("refuses a worktree mount before anything is recorded until T3b creates them", async () => {
    const env = await setup();
    const alpha = await env.register("alpha");
    const checkout = { source: "checkout", repoId: alpha.repoId };
    const worktree = { source: "worktree", repoId: alpha.repoId, name: "work" };
    const refused = { kind: "CAPABILITY_UNAVAILABLE", acceptance: "not-accepted" };
    // A task.create naming one is refused as a whole, its checkout included.
    expect(
      (await env.tasks.create("p", { operationId: "c", title: "T", mounts: [checkout, worktree] }))
        .error,
    ).toMatchObject(refused);
    const { taskId } = await created(env.tasks, "c2", "T");
    expect(
      (await env.tasks.addMount("p", { operationId: "a", taskId, mount: worktree })).error,
    ).toMatchObject(refused);
    // No task, mount, receipt or entry exists for the refused requests.
    expect(await env.rows("SELECT task_id FROM tasks")).toEqual([{ task_id: taskId }]);
    expect(await env.rows("SELECT mount_id FROM mounts")).toEqual([]);
    for (const operationId of ["c", "a"])
      expect(await env.receipts.get({ serverId: "server", principalId: "p", operationId })).toBe(
        null,
      );
    const { task } = await env.tasks.get(taskId);
    expect(await readdir(env.workspaceRoot)).toEqual([basename(task.workspace.entryPath)]);
    expect(task.workspace).toMatchObject({ revision: 0, mounts: [] });
    // Nothing holds the registration.
    expect(
      (await env.repos.remove("p", { operationId: "rr", repoId: alpha.repoId })).operation.state,
    ).toBe("succeeded");
  });
});
