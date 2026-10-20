import { createInterface } from "node:readline/promises";
import type { Client } from "@cove/client";
import type { DomainError } from "@cove/protocol/errors";
import type { RunRef } from "@cove/protocol/identity";
import type { OperationRecord } from "@cove/protocol/rpc";
import type { TabRecord } from "@cove/protocol/workspace";
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
import { getTask, listTabs, printTaskOperation } from "./_workspace.js";

// The binding commands of the mount group (M1 T5; RPC_METHODS routes them as `mount convert`,
// `mount delete-worktree` and `mount history`): binding.convert, binding.delete and binding.list.
// They live in this helper module so that they stay under `cove mount` rather than forming a
// `cove binding` group of their own (main.ts discovers groups from the non-`_` modules).

export const commands = `  mount convert <taskId> <mountId> [--branch BRANCH] [--base REF] [--no-fetch] [--expected-revision N] [--operation-id ID]
  mount delete-worktree <taskId> <mountId> [--yes] [--expected-revision N] [--operation-id ID]
  mount history <taskId> <mountId>`;

export const notes = `mount convert switches a checkout mount to a new managed worktree of the same repository, created
from a commit by the same base rule as mount add (D3). Changes in the checkout stay there: they
are counted in the result (sourceChanges) and never stashed, reset or carried over. It is refused
while a run of this task uses the checkout (LIVE_RUNS_PRESENT, with the runs). The mount stays the
checkout until the worktree is ready and verified; if preparing it fails the checkout stays bound.
A run of the task that started using the checkout meanwhile stops the switch (requires_attention):
end it and run \`cove operation continue\`, or abandon to remove the worktree.
mount delete-worktree deletes the managed worktree of a mount, including its uncommitted and
untracked changes, and removes the mount; the branch is kept. It also deletes a worktree that a
failed or abandoned preparation left in place. A checkout is never deleted. It asks for
confirmation on a terminal; --yes confirms it without asking, and without a terminal it is
required. It is refused while any run uses the worktree (LIVE_RUNS_PRESENT, with the runs).
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

// Lists the runs a LIVE_RUNS_PRESENT error names, each with the command that stops it: they are
// what the operator has to end first. A refusal carries them in the RPC error response; a deletion
// that was accepted and then found a run keeps a few in its final record. A conversion that
// stopped before switching (requires_attention) keeps none, so its task's live tab runs are listed
// instead: those are the runs that can hold the checkout (m1 T5).
//
// A run's tab is found through tab.list of the task: a tab's latestRun is the only run of it that
// can be live (reopen is refused while one is). A run of none of the task's tabs is a run of
// `cove terminal create`, stopped with `cove terminal stop`. These are reads after the fact, only
// for the hint; when they fail the runs are still listed with a generic hint.
async function printLiveRuns(
  client: Client,
  taskId: string,
  error: DomainError | undefined,
): Promise<void> {
  if (error?.kind !== "LIVE_RUNS_PRESENT") return;
  let tabs: TabRecord[] | null = null;
  try {
    tabs = await listTabs(client, taskId);
  } catch {
    // Reported without the tabs.
  }
  let runs: readonly RunRef[] = error.details?.runs ?? [];
  if (!error.details && tabs) runs = await liveTabRuns(client, tabs);
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

// The latest runs of `tabs` that have not ended (starting or running), read with tab.get.
async function liveTabRuns(client: Client, tabs: readonly TabRecord[]): Promise<RunRef[]> {
  const runs: RunRef[] = [];
  for (const tab of tabs) {
    if (!tab.latestRun) continue;
    try {
      const { latestRun } = unwrap("tab.get", await client.call("tab.get", { tabId: tab.tabId }));
      if (latestRun && ["starting", "running"].includes(latestRun.lifecycle))
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
    const [taskId, mountId] = mountIds(args, "convert");
    const branch = flag(args, "--branch");
    const base = flag(args, "--base");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
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
      await printLiveRuns(session.client, taskId, operation.error);
      return printTaskOperation(session.client, operation, taskId);
    });
  }
  if (sub === "delete-worktree") {
    takeFlags(args, ["--yes", "--expected-revision", "--operation-id"]);
    const [taskId, mountId] = mountIds(args, "delete-worktree");
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
      if (!args.flags.has("--yes")) {
        const task = await getTask(session.client, taskId);
        const mount = task.workspace.mounts.find((item) => item.mountId === mountId);
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
