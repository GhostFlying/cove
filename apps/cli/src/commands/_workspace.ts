import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
    BRANCH (default cove/<task slug>) is a new branch; an existing one fails the mount
    (BRANCH_EXISTS). Cove first fetches origin; a failed fetch fails the mount and creates
    nothing (FETCH_FAILED), and only no-fetch skips it. The base is REF, otherwise the remote
    branch of the repo's mainBranch, origin/HEAD, the remote's HEAD, then origin/main, master,
    trunk or develop; never the local HEAD (MAIN_BRANCH_UNRESOLVED). The command waits while the
    mounts are prepared one after another; a failed mount leaves the others and can be retried
    with cove mount retry.
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
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
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

// The real Git common directory and top level of the working tree containing `path`, or null when
// Git finds none there. The common directory identifies a clone together with its worktrees.
function workingTree(path: string): Promise<{ commonDir: string; topLevel: string } | null> {
  return new Promise((done) =>
    execFile(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
      { cwd: path, timeout: 10_000 },
      (error, stdout) => {
        const lines = stdout.split("\n");
        if (error || lines.length !== 3 || lines[2] !== "") return done(null);
        Promise.all([realpath(lines[0]!), realpath(lines[1]!)]).then(
          ([commonDir, topLevel]) => done({ commonDir, topLevel }),
          () => done(null),
        );
      },
    ),
  );
}

// Turns each `--checkout PATH` into the request the REPO_ID form sends: `{repoId}` for the
// registered clone itself, `{repoId, path}` for another working tree of it. The CLI only picks the
// repo, by the Git common directory the path shares with a registered clone (repo.list); the
// server still decides whether the path is admitted (D2), exactly as for `REPO_ID,path=PATH`.
export async function resolveMountSpecs(
  client: Client,
  specs: readonly ParsedMountSpec[],
): Promise<MountSpec[]> {
  if (!specs.some((spec) => "lookup" in spec)) return specs as MountSpec[];
  const repos = await listRepos(client);
  const commonDirs = await Promise.all(
    repos.map(async (repo) => (await workingTree(repo.path))?.commonDir ?? null),
  );
  return Promise.all(
    specs.map(async (spec): Promise<MountSpec> => {
      if (!("lookup" in spec)) return spec;
      const found = await workingTree(spec.lookup);
      const index = found ? commonDirs.indexOf(found.commonDir) : -1;
      if (!found || index < 0)
        throw new Error(
          `--checkout ${spec.lookup} is not in a registered repo` +
            (found ? "" : " (Git finds no working tree there)") +
            "; nothing was sent. `cove repo list` shows the registered clones, and " +
            "`cove repo register <clone>` adds one",
        );
      const repo = repos[index]!;
      return {
        source: "checkout",
        repoId: repo.repoId,
        ...(spec.name === undefined ? {} : { name: spec.name }),
        ...(found.topLevel === repo.path ? {} : { path: spec.lookup }),
      };
    }),
  );
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
    const retry = taskId ? `cove mount retry ${taskId} ${mount.mountId}` : "cove mount retry";
    if (mount.errorKind === "FETCH_FAILED")
      hints.push(
        `mount ${mount.mountId}: fetching origin failed and nothing was created; fix the remote ` +
          `and run \`${retry}\`, or create it from the commits already fetched with ` +
          `\`${retry} --no-fetch\``,
      );
    else if (mount.errorKind === "MAIN_BRANCH_UNRESOLVED")
      hints.push(
        `mount ${mount.mountId}: no main branch was found on origin; run \`${retry} --base REF\`, ` +
          `or set it with \`cove repo set <repoId> mainBranch BRANCH\` and run \`${retry}\``,
      );
    else if (mount.errorKind === "BRANCH_EXISTS")
      hints.push(
        `mount ${mount.mountId}: the branch already exists; run \`${retry} --branch NEW\``,
      );
  }
  return hints;
}
