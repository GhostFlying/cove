import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Client } from "@cove/client";
import type { OperationRecord } from "@cove/protocol/rpc";
import {
  M1_LIMITS,
  type MountSpec,
  type RepoRecord,
  type TabRecord,
  type TaskRecord,
} from "@cove/protocol/workspace";
import { hostPath, print, unwrap, UsageError } from "./_common.js";

// Helpers shared by `cove task` and `cove mount` (M1 T3a).

// D4: checkout mounts are for read-only use. Cove does not enforce it, so the CLI states it in
// every output that shows a checkout mount and in the help.
export const CHECKOUT_NOTICE =
  "Checkout mounts are existing directories Cove does not own, for read-only use (reading, " +
  "building, running tests); Cove does not enforce this. Use a worktree mount to change code.";

export const MOUNT_SPEC_HELP = `A checkout mount is an existing directory for read-only use (D4); Cove never writes to it and
does not enforce read-only use:
  --checkout REPO_ID[,name=NAME][,path=PATH]
    the registered clone itself, or with path= an existing worktree of it that Cove does not
    manage; path= comes last and takes the rest of the value. A path Cove manages as a worktree
    is refused (MANAGED_WORKTREE_NOT_MOUNTABLE).
  --checkout PATH[,name=NAME]
    the same, named by its directory: the CLI finds the registered repo whose clone or worktree
    PATH is (\`cove repo list\`) and sends the request above. The value is a PATH when the part
    before its first comma starts with /, . or ~ or contains a /, which a repo ID never does
    (write ./NAME for a directory NAME).
A worktree mount is a new Git worktree Cove creates and manages at <entry>/NAME:
  --worktree REPO_ID[,name=NAME][,branch=BRANCH][,base=REF][,no-fetch]
    BRANCH is a new branch; an existing one fails the mount (BRANCH_EXISTS). Without it the
    branch is cove/<task slug>, the slug keeping the title's script and case, or when that
    exists locally or on a remote, the first free of cove/<task slug>-2 to -100. Cove first
    fetches origin; a failed fetch fails the mount and creates nothing (FETCH_FAILED), and only
    no-fetch skips it. The base is REF, otherwise the remote branch of the repo's mainBranch,
    origin/HEAD, the remote's HEAD, then origin/main, master, trunk or develop; never the local
    HEAD (MAIN_BRANCH_UNRESOLVED). The command waits while the mounts are prepared one after
    another; a failed mount leaves the others and can be retried with cove mount retry.
NAME defaults to the repo's display name. The workspace entry directory holds cove-workspace.json,
the manifest of every mount with its real path; a checkout is reached by that real path.`;

// A `--checkout PATH[,name=NAME]` value: the directory still to be resolved to its registered
// repo (resolveMountSpecs) before the request is built.
export type CheckoutPathSpec = { source: "checkout"; lookup: string; name?: string };
export type ParsedMountSpec = MountSpec | CheckoutPathSpec;

// Whether a command argument names a directory rather than a resource ID. A resource ID (repo,
// task, mount) is 1-40 of [A-Za-z0-9._-] starting with a letter or digit, so it never starts with
// `/`, `.` or `~` and never contains `/`: the two cannot be confused, and the rule does not
// depend on what exists on disk. A directory named like an ID is written `./NAME`.
export function isPathArgument(value: string): boolean {
  return /^[/.~]/.test(value) || value.includes("/");
}

// A path argument as the server should see it: `~` and `~/...` (left unexpanded when quoted) are
// the user's home directory, and a relative path is made absolute (hostPath).
export function argumentPath(value: string): string {
  if (value === "~") return homedir();
  // Only the prefix is replaced. join() would normalize the rest lexically, and `..` after a
  // symlink means something else than that (`~/link/../x` is the parent of the link's target).
  if (value.startsWith("~/")) {
    const home = homedir();
    return `${home.endsWith(sep) ? home.slice(0, -1) : home}${sep}${value.slice(2)}`;
  }
  if (value.startsWith("~")) throw new UsageError(`only ~ and ~/ are expanded in ${value}`);
  return hostPath(value);
}

// One --checkout or --worktree value. Options are comma-separated `key=value` pairs after the
// repo ID; a checkout's path= is last and may itself contain commas. A checkout value whose part
// before the first comma is a path (isPathArgument) is `PATH[,name=NAME]`: the path may contain
// commas, and only a final `,name=NAME` is an option.
export function parseMountSpec(source: "checkout" | "worktree", value: string): ParsedMountSpec {
  const flagName = `--${source}`;
  if (source === "checkout" && isPathArgument(value.split(",")[0]!)) {
    const named = /^(.+),name=([^,/]*)$/.exec(value);
    if (named && !named[2]) throw new UsageError(`${flagName} name= needs a value`);
    return {
      source,
      lookup: argumentPath(named ? named[1]! : value),
      ...(named ? { name: named[2]! } : {}),
    };
  }
  let rest = value;
  let path: string | undefined;
  if (source === "checkout") {
    const at = rest.indexOf(",path=");
    if (at >= 0) {
      path = rest.slice(at + ",path=".length);
      rest = rest.slice(0, at);
      if (!path) throw new UsageError(`${flagName} path= needs a path`);
    }
  }
  const [repoId, ...options] = rest.split(",");
  if (!repoId) throw new UsageError(`${flagName} needs a repo id`);
  const spec: Record<string, unknown> = { source, repoId };
  for (const option of options) {
    const equals = option.indexOf("=");
    const key = equals < 0 ? option : option.slice(0, equals);
    const optionValue = equals < 0 ? undefined : option.slice(equals + 1);
    const allowed = source === "checkout" ? ["name"] : ["name", "branch", "base", "no-fetch"];
    const field = key === "no-fetch" ? "noFetch" : key;
    if (!allowed.includes(key) || field in spec)
      throw new UsageError(`${flagName} has an unknown or repeated option ${key}`);
    if (key === "no-fetch") {
      if (optionValue !== undefined) throw new UsageError(`${flagName} no-fetch takes no value`);
      spec.noFetch = true;
    } else {
      if (!optionValue) throw new UsageError(`${flagName} ${key}= needs a value`);
      spec[key] = optionValue;
    }
  }
  if (path !== undefined) spec.path = hostPath(path);
  return spec as MountSpec;
}

export async function listTasks(
  client: Client,
  archived: string | undefined,
): Promise<TaskRecord[]> {
  const tasks: TaskRecord[] = [];
  let afterTaskId: string | undefined;
  do {
    const page = unwrap(
      "task.list",
      await client.call("task.list", {
        limit: M1_LIMITS.listPage,
        ...(afterTaskId ? { afterTaskId } : {}),
        ...(archived ? { archived: archived as "exclude" | "include" | "only" } : {}),
      }),
    );
    tasks.push(...page.tasks);
    afterTaskId = page.nextAfterTaskId;
  } while (afterTaskId);
  return tasks;
}

export async function listRepos(client: Client): Promise<RepoRecord[]> {
  const repos: RepoRecord[] = [];
  let afterRepoId: string | undefined;
  do {
    const page = unwrap(
      "repo.list",
      await client.call("repo.list", {
        limit: M1_LIMITS.listPage,
        ...(afterRepoId ? { afterRepoId } : {}),
      }),
    );
    repos.push(...page.repos);
    afterRepoId = page.nextAfterRepoId;
  } while (afterRepoId);
  return repos;
}

export async function listTabs(client: Client, taskId: string): Promise<TabRecord[]> {
  const tabs: TabRecord[] = [];
  let afterTabId: string | undefined;
  do {
    const page = unwrap(
      "tab.list",
      await client.call("tab.list", {
        taskId,
        limit: M1_LIMITS.listPage,
        ...(afterTabId ? { afterTabId } : {}),
      }),
    );
    tabs.push(...page.tabs);
    afterTabId = page.nextAfterTabId;
  } while (afterTabId);
  return tabs;
}

// The CLI's own Git queries (`--checkout PATH` only). Like the server's (apps/server/src/git/
// run.ts), the environment is rebuilt from an allowlist: a GIT_DIR, GIT_WORK_TREE,
// GIT_COMMON_DIR, GIT_INDEX_FILE, GIT_CEILING_DIRECTORIES or GIT_CONFIG_* inherited from a Git
// hook or another tool would redirect the query to some other repository, and the CLI would then
// name the wrong registered repo. The user's global and system configuration is still read.
const GIT_INHERITED = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
] as const;

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of GIT_INHERITED)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return {
    ...env,
    LC_ALL: "C",
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
  };
}

// `--path-format=absolute` (rev-parse) first appeared in Git 2.31.
const GIT_MINIMUM: readonly [number, number] = [2, 31];
// Registered clones inspected at once: a lookup must not start one process per registration.
const GIT_CONCURRENCY = 8;

const nothingSent = "nothing was sent";

// One Git command in `cwd`, an existing directory. Resolves with its exit status and output when
// Git ran to completion. Rejects when there is no answer (Git could not be started, was killed,
// timed out, or a resource limit was hit): that proves nothing about the path, so it is never read
// as "not a repository" or "not registered".
function runGit(
  args: readonly string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) =>
    execFile(
      "git",
      args,
      { cwd, env: gitEnvironment(), timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return done({ code: 0, stdout, stderr });
        if (typeof error.code === "number" && !error.killed && error.signal === null)
          return done({ code: error.code, stdout, stderr });
        if (error.code === "ENOENT")
          return fail(
            new Error(
              `git was not found on PATH; --checkout PATH needs it to find the registered ` +
                `repo (--checkout REPO_ID does not); ${nothingSent}`,
            ),
          );
        const why = error.killed ? "timed out" : (error.signal ?? error.code ?? error.message);
        fail(new Error(`git ${args[0]} in ${cwd} did not complete (${why}); ${nothingSent}`));
      },
    ),
  );
}

// Fails with a diagnostic of its own when Git is missing or older than GIT_MINIMUM, rather than
// letting the lookups below misread its output.
async function requireGit(): Promise<void> {
  const { code, stdout } = await runGit(["--version"], "/");
  const version = /^git version (\d+)\.(\d+)/.exec(stdout);
  if (code !== 0 || !version)
    throw new Error(`git --version gave no version (${stdout.trim()}); ${nothingSent}`);
  const [major, minor] = [Number(version[1]), Number(version[2])];
  if (major < GIT_MINIMUM[0] || (major === GIT_MINIMUM[0] && minor < GIT_MINIMUM[1]))
    throw new Error(
      `git ${major}.${minor} is too old for --checkout PATH, which needs Git ` +
        `${GIT_MINIMUM.join(".")} or later (--checkout REPO_ID does not); ${nothingSent}`,
    );
}

// The working tree containing `path`: its real Git common directory (which identifies a clone
// together with its worktrees) and real top level. `none` says why there is none: the path is not
// a directory, or Git, having run, says it is not in a working tree. Anything else rejects.
async function workingTree(
  path: string,
): Promise<{ commonDir: string; topLevel: string } | { none: string }> {
  try {
    if (!(await stat(path)).isDirectory()) return { none: "it is not a directory" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { none: "it does not exist" };
    throw error;
  }
  const { code, stdout, stderr } = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
    path,
  );
  if (code !== 0) {
    if (/not a git repository|must be run in a work tree/.test(stderr))
      return { none: "Git finds no working tree there" };
    throw new Error(
      `git rev-parse in ${path} failed (${code}): ${stderr.trim().split("\n")[0]}; ${nothingSent}`,
    );
  }
  const lines = stdout.split("\n");
  if (lines.length !== 3 || lines[2] !== "")
    throw new Error(`git rev-parse in ${path} gave unexpected output; ${nothingSent}`);
  const [commonDir, topLevel] = await Promise.all([realpath(lines[0]!), realpath(lines[1]!)]);
  return { commonDir, topLevel };
}

// fn over `items`, at most `limit` at a time, results in order. The first rejection rejects.
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Turns each `--checkout PATH` into the request the REPO_ID form sends: `{repoId}` for the
// registered clone itself, `{repoId, path}` for another working tree of it. The CLI only picks the
// repo, by the Git common directory the path shares with a registered clone (repo.list); the
// server still decides whether the path is admitted (D2), exactly as for `REPO_ID,path=PATH`.
// Every failure here happens before the request is saved or sent.
export async function resolveMountSpecs(
  client: Client,
  specs: readonly ParsedMountSpec[],
): Promise<MountSpec[]> {
  if (!specs.some((spec) => "lookup" in spec)) return specs as MountSpec[];
  await requireGit();
  const targets = new Map<string, { commonDir: string; topLevel: string }>();
  for (const spec of specs) {
    if (!("lookup" in spec) || targets.has(spec.lookup)) continue;
    const found = await workingTree(spec.lookup);
    if ("none" in found)
      throw new Error(
        `--checkout ${spec.lookup} is not a repository: ${found.none}; ${nothingSent}`,
      );
    targets.set(spec.lookup, found);
  }
  const repos = await listRepos(client);
  // A registered clone whose directory is gone or no longer a working tree matches nothing.
  const commonDirs = await mapLimited(repos, GIT_CONCURRENCY, async (repo) => {
    const found = await workingTree(repo.path);
    return "none" in found ? null : found.commonDir;
  });
  return specs.map((spec): MountSpec => {
    if (!("lookup" in spec)) return spec;
    const found = targets.get(spec.lookup)!;
    const index = commonDirs.indexOf(found.commonDir);
    if (index < 0)
      throw new Error(
        `--checkout ${spec.lookup} is not in a registered repo; ${nothingSent}. ` +
          "`cove repo list` shows the registered clones, and `cove repo register <clone>` adds one",
      );
    const repo = repos[index]!;
    return {
      source: "checkout",
      repoId: repo.repoId,
      ...(spec.name === undefined ? {} : { name: spec.name }),
      ...(found.topLevel === repo.path ? {} : { path: spec.lookup }),
    };
  });
}

// A task as the CLI prints it: the server's record, with each mount marked for its intended use
// and the D4 notice when the task has a checkout mount.
export function describeTask(task: TaskRecord): unknown {
  const checkout = task.workspace.mounts.some((mount) => mount.source === "checkout");
  return {
    ...task,
    workspace: {
      ...task.workspace,
      mounts: task.workspace.mounts.map((mount) => ({
        ...mount,
        readOnlyUse: mount.source === "checkout",
      })),
    },
    ...(checkout ? { notice: CHECKOUT_NOTICE } : {}),
  };
}

export async function getTask(client: Client, taskId: string): Promise<TaskRecord> {
  return unwrap("task.get", await client.call("task.get", { taskId })).task;
}

// What a failed or abandoned preparation left in place (the mount outcomes' `left`, m1 T3b),
// joined with the mount and repo records so the operator can find it: Cove removes only what it
// can delete without losing work, and leaves the rest for a person to look at. A field the
// records no longer give is null.
export type Leftover = {
  mountId: string;
  path: string | null;
  branch: string | null;
  repoPath: string | null;
  effects: ("worktree" | "branch")[];
};

export async function leftoversOf(
  client: Client,
  operation: OperationRecord,
  task?: TaskRecord,
): Promise<Leftover[]> {
  const left = (operation.result?.mounts ?? []).filter((mount) => mount.left !== undefined);
  if (!left.length) return [];
  const mounts = new Map<string, TaskRecord["workspace"]["mounts"][number]>();
  const entries = new Map<string, string>();
  const add = (found: TaskRecord) => {
    for (const mount of found.workspace.mounts) {
      mounts.set(mount.mountId, mount);
      entries.set(mount.mountId, found.workspace.entryPath);
    }
  };
  try {
    const resource = operation.result?.resource;
    if (task) add(task);
    else if (resource?.kind === "task") add(await getTask(client, resource.id));
    else {
      // mount.add and mount.retry name the mount, not its task: look through the tasks.
      let after: string | undefined;
      do {
        const page = unwrap(
          "task.list",
          await client.call("task.list", {
            limit: 100,
            archived: "include",
            ...(after ? { afterTaskId: after } : {}),
          }),
        );
        for (const found of page.tasks) add(found);
        after = page.nextAfterTaskId;
      } while (after && left.some((mount) => !mounts.has(mount.mountId)));
    }
  } catch {
    // Reported with what is known.
  }
  const repos = new Map<string, string | null>();
  const leftovers: Leftover[] = [];
  for (const outcome of left) {
    const mount = mounts.get(outcome.mountId);
    let repoPath: string | null = null;
    if (mount) {
      if (!repos.has(mount.repoId)) {
        let path: string | null = null;
        try {
          path = unwrap("repo.get", await client.call("repo.get", { repoId: mount.repoId })).repo
            .path;
        } catch {
          // As above.
        }
        repos.set(mount.repoId, path);
      }
      repoPath = repos.get(mount.repoId) ?? null;
    }
    // A conversion whose target was left in place did not switch: the mount is still the checkout,
    // and the target is `<entry>/<name>` (m1 T5). Its branch is not in any record.
    const target =
      operation.method === "binding.convert" && mount?.source === "checkout"
        ? { path: join(entries.get(mount.mountId)!, mount.name), branch: null }
        : { path: mount?.path ?? null, branch: mount?.branch ?? null };
    leftovers.push({
      mountId: outcome.mountId,
      ...target,
      repoPath,
      effects: outcome.left === "both" ? ["worktree", "branch"] : [outcome.left!],
    });
  }
  return leftovers;
}

// The commands an operator would run to remove the leftovers once they have looked at them; never
// run by Cove. Without --force: Git itself refuses a worktree with changes and an unmerged branch.
export function leftoverHints(leftovers: readonly Leftover[]): string[] {
  const hints: string[] = [];
  for (const leftover of leftovers) {
    const repo = leftover.repoPath === null ? "<repo>" : shellQuote(leftover.repoPath);
    const commands: string[] = [];
    if (leftover.effects.includes("worktree"))
      commands.push(
        `git -C ${repo} worktree remove ${leftover.path === null ? "<path>" : shellQuote(leftover.path)}`,
      );
    if (leftover.effects.includes("branch"))
      commands.push(
        `git -C ${repo} branch -d ${leftover.branch === null ? "<branch>" : shellQuote(leftover.branch)}`,
      );
    hints.push(
      `mount ${leftover.mountId}: left in place (${leftover.effects.join(", ")}), not removed ` +
        `because deleting it could lose work; check it, then remove it yourself if it is not needed: ` +
        commands.map((command) => `\`${command}\``).join(", then "),
    );
  }
  return hints;
}

function shellQuote(text: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

// The ending of a write that changes a task's mounts: print the settled operation together with
// the task as it is now, so per-mount outcomes and the read-only notice are visible even when
// the operation failed (a partial success is never shown as complete). Exits 1 unless it
// succeeded.
export async function printTaskOperation(
  client: Client,
  operation: OperationRecord,
  taskId: string,
): Promise<number> {
  const task = await getTask(client, taskId);
  const leftovers = await leftoversOf(client, operation, task);
  print({ operation, task: describeTask(task), ...(leftovers.length ? { leftovers } : {}) });
  if (operation.state === "succeeded") return 0;
  const reason = operation.error ? `: ${operation.error.kind}` : "";
  process.stderr.write(
    `cove: ${operation.method} ${operation.operationId} ${operation.state}${reason}\n`,
  );
  for (const hint of [...operationHints(operation, taskId), ...leftoverHints(leftovers)])
    process.stderr.write(`cove: ${hint}\n`);
  return 1;
}

// What the operator can do next about an operation that did not succeed (T3b). The hints name
// commands only; the record printed on stdout is the result. For requires_attention they offer
// exactly the actions the server advertises in progress.recoveryActions: an abandon that stopped
// can only be continued, never abandoned.
export function operationHints(operation: OperationRecord, taskId?: string): string[] {
  const hints: string[] = [];
  const id = operation.operationId;
  if (operation.state === "requires_attention") {
    const actions = (operation.progress?.recoveryActions ?? []).map(
      (action) => `\`cove operation ${action} ${id}\``,
    );
    hints.push(
      actions.length
        ? `inspect it with \`cove operation get ${id}\`, then ${actions.join(" or ")}`
        : `inspect it with \`cove operation get ${id}\``,
    );
  }
  const failedMounts = (operation.result?.mounts ?? []).filter((mount) => mount.state === "failed");
  for (const mount of failedMounts) {
    // A failed conversion never changed the mount: it is still the ready checkout, which
    // `mount retry` (only for a failed worktree mount) refuses with INVALID_ARGUMENT. It is tried
    // again by converting again, a new request that reuses nothing of the failed one, so any
    // other flag given then is repeated. operation.continue prints these without the task ID,
    // which a conversion's record (resource: the mount) does not give.
    const task = taskId ?? "<taskId>";
    const convert = operation.method === "binding.convert";
    const retry = convert
      ? `cove mount convert ${task} ${mount.mountId}`
      : `cove mount retry ${task} ${mount.mountId}`;
    const repeat = convert ? " (the checkout stays mounted; repeat any other flag you gave)" : "";
    if (mount.errorKind === "FETCH_FAILED")
      hints.push(
        `mount ${mount.mountId}: fetching origin failed and nothing was created; fix the remote ` +
          `and run \`${retry}\`, or create it from the commits already fetched with ` +
          `\`${retry} --no-fetch\`${repeat}`,
      );
    else if (mount.errorKind === "MAIN_BRANCH_UNRESOLVED")
      hints.push(
        `mount ${mount.mountId}: no main branch was found on origin; run \`${retry} --base REF\`, ` +
          `or set it with \`cove repo set <repoId> mainBranch BRANCH\` and run \`${retry}\`${repeat}`,
      );
    else if (mount.errorKind === "BRANCH_EXISTS")
      hints.push(
        `mount ${mount.mountId}: the branch already exists; run \`${retry} --branch NEW\`${repeat}`,
      );
  }
  return hints;
}
