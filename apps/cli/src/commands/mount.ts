import {
  flag,
  flagValues,
  optionalIntegerFlag,
  takeFlags,
  UsageError,
  withSession,
  type Arguments,
} from "./_common.js";
import { commands as bindingCommands, notes as bindingNotes, runBinding } from "./_binding.js";
import { operationIdFor, submitWrite } from "./_pending.js";
import {
  MOUNT_SPEC_HELP,
  parseMountSpec,
  printTaskOperation,
  resolveMountSpecs,
} from "./_workspace.js";

export const usage = `  mount add <taskId> (--checkout SPEC | --worktree SPEC) [--expected-revision N] [--operation-id ID]
  mount remove <taskId> <mountId> [--expected-revision N] [--operation-id ID]
  mount retry <taskId> <mountId> [--branch BRANCH] [--base REF] [--no-fetch] [--operation-id ID]
${bindingCommands}

--expected-revision is the workspace revision. mount remove only changes the workspace: it never
deletes a checkout or a worktree directory, and it is allowed on an archived task. A worktree
mount that is still being prepared cannot be removed (OPERATION_EFFECTS_ACTIVE).
mount retry prepares a failed worktree mount again as a new operation. It reuses the branch,
base and fetch choice the mount was added with; --branch and --base override them for this
attempt, and --no-fetch skips the fetch for it. --no-fetch can only turn fetch-skipping on: a
mount added with no-fetch is retried without a fetch.
${bindingNotes}
${MOUNT_SPEC_HELP}`;

function expectedWorkspaceRevision(args: Arguments): { expectedWorkspaceRevision?: number } {
  const value = optionalIntegerFlag(args, "--expected-revision");
  return value === undefined ? {} : { expectedWorkspaceRevision: value };
}

export async function run(args: Arguments): Promise<number> {
  const sub = args.words[1];
  if (sub === "add") {
    takeFlags(args, ["--checkout", "--worktree", "--expected-revision", "--operation-id"]);
    const [, , taskId] = args.words;
    if (!taskId || args.words.length !== 3 || args.command)
      throw new UsageError("mount add needs a task id");
    const checkout = flagValues(args, "--checkout");
    const worktree = flagValues(args, "--worktree");
    if (checkout.length + worktree.length !== 1)
      throw new UsageError("mount add needs exactly one --checkout or --worktree");
    const spec = checkout[0]
      ? parseMountSpec("checkout", checkout[0])
      : parseMountSpec("worktree", worktree[0]!);
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      const [mount] = await resolveMountSpecs(session.client, [spec]);
      const operation = await submitWrite(args, session, "mount.add", {
        operationId,
        taskId,
        mount,
        ...expectedWorkspaceRevision(args),
      });
      return printTaskOperation(session.client, operation, taskId);
    });
  }
  if (sub === "remove") {
    takeFlags(args, ["--expected-revision", "--operation-id"]);
    const [, , taskId, mountId] = args.words;
    if (!taskId || !mountId || args.words.length !== 4 || args.command)
      throw new UsageError("mount remove needs a task id and a mount id");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      const operation = await submitWrite(args, session, "mount.remove", {
        operationId,
        taskId,
        mountId,
        ...expectedWorkspaceRevision(args),
      });
      return printTaskOperation(session.client, operation, taskId);
    });
  }
  if (sub === "retry") {
    takeFlags(args, ["--branch", "--base", "--no-fetch", "--operation-id"]);
    const [, , taskId, mountId] = args.words;
    if (!taskId || !mountId || args.words.length !== 4 || args.command)
      throw new UsageError("mount retry needs a task id and a mount id");
    const branch = flag(args, "--branch");
    const base = flag(args, "--base");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      const operation = await submitWrite(args, session, "mount.retry", {
        operationId,
        taskId,
        mountId,
        ...(branch === undefined ? {} : { branch }),
        ...(base === undefined ? {} : { base }),
        ...(args.flags.has("--no-fetch") ? { noFetch: true } : {}),
      });
      return printTaskOperation(session.client, operation, taskId);
    });
  }
  const binding = sub === undefined ? null : await runBinding(args, sub);
  if (binding !== null) return binding;
  throw new UsageError(`Unknown mount command ${sub ?? ""}`.trim());
}
