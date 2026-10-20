import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { Client } from "@cove/client";
import type { DomainError } from "@cove/protocol/errors";
import type { RunRef } from "@cove/protocol/identity";
import type { OperationRecord } from "@cove/protocol/rpc";
import type { RunHistoryRecord, TabRecord, TaskRecord } from "@cove/protocol/workspace";
import type { Session } from "../session.js";
import {
  flag,
  optionalIntegerFlag,
  print,
  StatusError,
  takeFlags,
  unwrap,
  UsageError,
  withSession,
  type Arguments,
} from "./_common.js";
import { operationIdFor, submitWrite } from "./_pending.js";
import {
  argumentPath,
  getTask,
  isPathArgument,
  listTabs,
  listTasks,
  printTaskOperation,
} from "./_workspace.js";

// The binding commands of the mount group (M1 T5; RPC_METHODS routes them as `mount convert`,
// `mount delete-worktree` and `mount history`): binding.convert, binding.delete and binding.list.
// They live in this helper module so that they stay under `cove mount` rather than forming a
// `cove binding` group of their own (main.ts discovers groups from the non-`_` modules).

export const commands = `  mount convert <taskId> [mountId] [--branch BRANCH] [--base REF] [--no-fetch] [--expected-revision N] [--operation-id ID]
  mount delete-worktree (<taskId> [mountId] | <PATH>) [--yes] [--expected-revision N] [--operation-id ID]
  mount history <taskId> <mountId>`;

export const notes = `mount convert switches a checkout mount to a new managed worktree of the same repository, created
from a commit by the same base rule as mount add (D3). Changes in the checkout stay there: they
are counted in the result (sourceChanges) and never stashed, reset or carried over. It is refused
while a run of this task uses the checkout (LIVE_RUNS_PRESENT, with the runs). The mount stays the
checkout until the worktree is ready and verified; if preparing it fails the checkout stays bound.
A run of the task that started using the checkout meanwhile stops the switch (requires_attention):
end it and run \`cove operation continue\`, or abandon to remove the worktree. Without a mountId
it converts the task's only checkout mount; with none or several it lists them and exits 2.
mount delete-worktree deletes the managed worktree of a mount, including its uncommitted and
untracked changes, and removes the mount; the branch is kept. It also deletes a worktree that a
failed or abandoned preparation left in place. A checkout is never deleted. It asks for
confirmation on a terminal; --yes confirms it without asking, and without a terminal it is
required. It is refused while any run uses the worktree (LIVE_RUNS_PRESENT, with the runs).
Without a mountId it deletes the task's only managed worktree mount, listing them (exit 2) when
there are none or several. Given a PATH (starting with /, . or ~, or containing a /) it finds the
task and mount whose managed worktree is at that real path, archived tasks included; a checkout
or a worktree Cove does not manage is not deleted (\`cove mount remove\` unmounts it).
mount history lists the bindings a mount has had, oldest first.`;

function expectedWorkspaceRevision(args: Arguments): { expectedWorkspaceRevision?: number } {
  const value = optionalIntegerFlag(args, "--expected-revision");
  return value === undefined ? {} : { expectedWorkspaceRevision: value };
}

function mountIds(args: Arguments, command: string): [string, string] {
  const [, , taskId, mountId] = args.words;
  if (!taskId || !mountId || args.words.length !== 4 || args.command)
    throw new UsageError(`mount ${command} needs a task id and a mount id`);
  return [taskId, mountId];
}

type MountRecord = TaskRecord["workspace"]["mounts"][number];

// `<taskId> [mountId]`: the task and, when given, the mount.
function taskAndMaybeMount(args: Arguments, command: string): [string, string | undefined] {
  const [, , taskId, mountId] = args.words;
  if (!taskId || args.words.length > 4 || args.command)
    throw new UsageError(`mount ${command} needs a task id and optionally a mount id`);
  return [taskId, mountId];
}

// The mount a command without a mount ID acts on: the task's only mount of `source`. With none or
// several nothing is sent, and the candidates are listed for the operator to choose (exit 2, as a
// command that needs one more argument).
function onlyMount(task: TaskRecord, source: MountRecord["source"], command: string): MountRecord {
  const candidates = task.workspace.mounts.filter((mount) => mount.source === source);
  if (candidates.length === 1) return candidates[0]!;
  const kind = source === "checkout" ? "checkout mount" : "managed worktree mount";
  throw new StatusError(
    candidates.length === 0
      ? `task ${task.taskId} has no ${kind}; nothing was sent`
      : `task ${task.taskId} has ${candidates.length} ${kind}s; name one: ` +
          `\`cove mount ${command} ${task.taskId} <mountId>\` (nothing was sent)\n` +
          candidates.map((mount) => `  ${mount.mountId}\t${mount.name}\t${mount.path}`).join("\n"),
    2,
  );
}

// The task and managed worktree mount whose worktree is at `path`, for `mount delete-worktree
// PATH`. Both sides are compared by real path, so the worktree may be named through a symlink or
// an alias such as macOS /tmp; a path that does not resolve is refused. Every task is
// searched, archived ones included (a deletion is allowed there). Only managed worktree mounts
// match: a checkout, or a worktree Cove does not manage, is never deleted by this command.
async function managedWorktreeAt(
  client: Client,
  path: string,
): Promise<{ taskId: string; mount: MountRecord }> {
  // The target must resolve: a lexical fallback could name another directory (`gone/../wt` is
  // not `wt` when `gone` is missing or a symlink), and this command deletes what it names.
  let target: string;
  try {
    target = await realpath(path);
  } catch (error) {
    throw new Error(
      `cannot resolve ${path} (${(error as NodeJS.ErrnoException).code ?? String(error)}); ` +
        `nothing was sent. A managed worktree whose directory is gone is still deleted by its ` +
        `IDs: \`cove mount delete-worktree <taskId> <mountId>\``,
    );
  }
  // A recorded mount path is already the real path it had; one that no longer resolves cannot
  // equal the existing target and is compared as recorded.
  const real = (value: string) => realpath(value).catch(() => value);
  const matches: { taskId: string; mount: MountRecord }[] = [];
  for (const task of await listTasks(client, "include"))
    for (const mount of task.workspace.mounts)
      if (mount.source === "worktree" && (await real(mount.path)) === target)
        matches.push({ taskId: task.taskId, mount });
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0)
    throw new Error(
      `no Cove-managed worktree mount is at ${target} (tasks were searched, archived ones ` +
        `included); nothing was sent. A checkout or a worktree Cove does not manage is never ` +
        `deleted by Cove: \`cove mount remove <taskId> <mountId>\` unmounts it without deleting ` +
        `anything, and \`git worktree remove\` deletes a worktree yourself`,
    );
  throw new StatusError(
    `${matches.length} managed worktree mounts are at ${target}; name one: ` +
      `\`cove mount delete-worktree <taskId> <mountId>\` (nothing was sent)\n` +
      matches.map(({ taskId, mount }) => `  ${taskId}\t${mount.mountId}\t${mount.name}`).join("\n"),
    2,
  );
}

// Lists the runs a LIVE_RUNS_PRESENT error names, each with the command that stops it: they are
// what the operator has to end first. A refusal carries them in the RPC error response; a deletion
// that was accepted and then found a run keeps a few in its final record. A conversion that
// stopped before switching (requires_attention) keeps none, so the live runs of its task's tabs
// that use the checkout of `convertedMountId` are listed instead (usesPath, the server's rule).
//
// A run's tab is found through tab.list of the task: a tab's latestRun is the only run of it that
// can be live (reopen is refused while one is). A run of none of the task's tabs is a run of
// `cove terminal create`, stopped with `cove terminal stop`. These are reads after the fact, only
// for the hint; when they fail the runs are still listed with a generic hint.
async function printLiveRuns(
  client: Client,
  taskId: string,
  error: DomainError | undefined,
  convertedMountId?: string,
): Promise<void> {
  if (error?.kind !== "LIVE_RUNS_PRESENT") return;
  let tabs: TabRecord[] | null = null;
  try {
    tabs = await listTabs(client, taskId);
  } catch {
    // Reported without the tabs.
  }
  let runs: readonly RunRef[] = error.details?.runs ?? [];
  if (!error.details) {
    let checkout: string | undefined;
    try {
      const task = await getTask(client, taskId);
      checkout = task.workspace.mounts.find((mount) => mount.mountId === convertedMountId)?.path;
    } catch {
      // As below.
    }
    if (!tabs || checkout === undefined) {
      process.stderr.write(
        `cove: a live run of the task uses the checkout; \`cove tab list ${taskId}\` shows ` +
          `the task's tabs, and \`cove tab stop <tabId>\` ends a tab's run\n`,
      );
      return;
    }
    runs = await liveTabRuns(client, tabs, checkout);
  }
  for (const run of runs) {
    const tab = tabs?.find(
      (item) =>
        item.latestRun?.runId === run.runId &&
        item.latestRun.relayInstanceId === run.relayInstanceId,
    );
    const hint = tab
      ? `of tab ${tab.tabId} (${JSON.stringify(tab.name)}) uses the path; stop it with ` +
        `\`cove tab stop ${tab.tabId}\``
      : tabs
        ? `(a terminal run, in no tab of the task) uses the path; stop it with ` +
          `\`cove terminal stop ${run.runId}\``
        : `uses the path; end it first (\`cove tab list ${taskId}\` shows its tab, otherwise ` +
          `\`cove terminal stop ${run.runId}\`)`;
    process.stderr.write(`cove: live run ${run.runId} ${hint}\n`);
  }
}

// Whether a run uses `path` by the server's rule (domain/tabs.ts liveRunsUsing): its start cwd or a
// mount of the mapping recorded at its start is `path` or lies below it. Both are real paths.
function usesPath(run: RunHistoryRecord, path: string): boolean {
  const within = (candidate: string) =>
    candidate === path || candidate.startsWith(path.endsWith("/") ? path : `${path}/`);
  return within(run.cwd) || run.mounts.some((mount) => within(mount.path));
}

// The latest runs of `tabs` that have not ended (starting or running) and use `path`, read with
// tab.get. A run that started before the checkout was mounted does not map it and is left out.
async function liveTabRuns(
  client: Client,
  tabs: readonly TabRecord[],
  path: string,
): Promise<RunRef[]> {
  const runs: RunRef[] = [];
  for (const tab of tabs) {
    if (!tab.latestRun) continue;
    try {
      const { latestRun } = unwrap("tab.get", await client.call("tab.get", { tabId: tab.tabId }));
      if (
        latestRun &&
        ["starting", "running"].includes(latestRun.lifecycle) &&
        usesPath(latestRun, path)
      )
        runs.push(latestRun.run);
    } catch {
      // A tab that cannot be read is left out of the hint.
    }
  }
  return runs;
}

// submitWrite for a binding write, listing the blocking runs of a refusal before it fails.
async function submitBinding(
  args: Arguments,
  session: Session,
  method: "binding.convert" | "binding.delete",
  taskId: string,
  params: Record<string, unknown> & { operationId: string },
): Promise<OperationRecord> {
  let refusal: DomainError | undefined;
  try {
    return await submitWrite(args, session, method, params, (outcome) => {
      if (outcome.kind === "rpc-error" && "kind" in outcome.error) refusal = outcome.error;
    });
  } catch (error) {
    await printLiveRuns(session.client, taskId, refusal);
    throw error;
  }
}

// Asks on the terminal; anything but y or yes declines.
async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(question);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export async function runBinding(args: Arguments, sub: string): Promise<number | null> {
  if (sub === "convert") {
    takeFlags(args, ["--branch", "--base", "--no-fetch", "--expected-revision", "--operation-id"]);
    const [taskId, givenMountId] = taskAndMaybeMount(args, "convert");
    const branch = flag(args, "--branch");
    const base = flag(args, "--base");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      const mountId =
        givenMountId ??
        onlyMount(await getTask(session.client, taskId), "checkout", "convert").mountId;
      const operation = await submitBinding(args, session, "binding.convert", taskId, {
        operationId,
        taskId,
        mountId,
        ...(branch === undefined ? {} : { branch }),
        ...(base === undefined ? {} : { base }),
        ...(args.flags.has("--no-fetch") ? { noFetch: true } : {}),
        ...expectedWorkspaceRevision(args),
      });
      reportSourceChanges(operation);
      await printLiveRuns(session.client, taskId, operation.error, mountId);
      return printTaskOperation(session.client, operation, taskId);
    });
  }
  if (sub === "delete-worktree") {
    takeFlags(args, ["--yes", "--expected-revision", "--operation-id"]);
    // `<PATH>` or `<taskId> [mountId]` (a task ID never looks like a path, see isPathArgument).
    const first = args.words[2];
    const byPath = first !== undefined && isPathArgument(first);
    if (byPath && (args.words.length !== 3 || args.command))
      throw new UsageError("mount delete-worktree PATH takes no mount id");
    const [givenTaskId, givenMountId] = byPath
      ? [undefined, undefined]
      : taskAndMaybeMount(args, "delete-worktree");
    const path = byPath ? argumentPath(first) : undefined;
    const operationId = operationIdFor(args);
    const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
    // Without a terminal nobody can answer the question: --yes is the confirmation, and without
    // it nothing is sent.
    if (!args.flags.has("--yes") && !interactive)
      throw new StatusError(
        "mount delete-worktree deletes the worktree with its uncommitted and untracked changes; " +
          "confirm with --yes (nothing was sent)",
        2,
      );
    return withSession(args, async (session) => {
      // The mount record when the command had to look it up; with both IDs given nothing is read
      // unless the question needs the path and branch.
      let found: { taskId: string; mount: MountRecord } | undefined;
      if (path !== undefined) found = await managedWorktreeAt(session.client, path);
      else if (givenMountId === undefined) {
        const task = await getTask(session.client, givenTaskId!);
        found = { taskId: task.taskId, mount: onlyMount(task, "worktree", "delete-worktree") };
      }
      const taskId = found?.taskId ?? givenTaskId!;
      const mountId = found?.mount.mountId ?? givenMountId!;
      if (!args.flags.has("--yes")) {
        const mount =
          found?.mount ??
          (await getTask(session.client, taskId)).workspace.mounts.find(
            (item) => item.mountId === mountId,
          );
        if (!mount) throw new Error(`task ${taskId} has no mount ${mountId}`);
        const confirmed = await confirm(
          `Delete the worktree at ${mount.path}, including its uncommitted and untracked ` +
            `changes? This cannot be undone. The branch ${mount.branch ?? "(none)"} is kept ` +
            `and the mount is removed. [y/N] `,
        );
        if (!confirmed) {
          process.stderr.write("cove: not confirmed; nothing was sent\n");
          return 1;
        }
      }
      const operation = await submitBinding(args, session, "binding.delete", taskId, {
        operationId,
        taskId,
        mountId,
        confirmed: true,
        ...expectedWorkspaceRevision(args),
      });
      await printLiveRuns(session.client, taskId, operation.error);
      return printTaskOperation(session.client, operation, taskId);
    });
  }
  if (sub === "history") {
    takeFlags(args, []);
    const [taskId, mountId] = mountIds(args, "history");
    return withSession(args, async (session) => {
      print(unwrap("binding.list", await session.client.call("binding.list", { taskId, mountId })));
      return 0;
    });
  }
  return null;
}

// What a conversion left in the source checkout (it is never carried over).
function reportSourceChanges(operation: OperationRecord): void {
  const changes = operation.result?.sourceChanges;
  if (!changes || changes.staged + changes.unstaged + changes.untracked === 0) return;
  process.stderr.write(
    `cove: the checkout keeps its changes (${changes.staged} staged, ${changes.unstaged} ` +
      `unstaged, ${changes.untracked} untracked); they are not in the new worktree\n`,
  );
}
