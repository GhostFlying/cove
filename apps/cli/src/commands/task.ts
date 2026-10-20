import {
  flag,
  flagValues,
  one,
  optionalIntegerFlag,
  print,
  takeFlags,
  UsageError,
  withSession,
  type Arguments,
} from "./_common.js";
import { operationIdFor, printSucceeded, submitWrite } from "./_pending.js";
import {
  describeTask,
  getTask,
  listTasks,
  MOUNT_SPEC_HELP,
  parseMountSpec,
  printTaskOperation,
  resolveMountSpecs,
  type ParsedMountSpec,
} from "./_workspace.js";

export const usage = `  task create <TITLE> [--checkout SPEC]... [--worktree SPEC]... [--operation-id ID]
  task list [--archived exclude|include|only]
  task get <taskId>
  task rename <taskId> <TITLE> [--expected-revision N] [--operation-id ID]
  task archive <taskId> [--expected-revision N] [--operation-id ID]
  task unarchive <taskId> [--expected-revision N] [--operation-id ID]

A task has one workspace: an entry directory under workspaceRoot holding the mount manifest
(cove-workspace.json) and the managed worktrees. task create may add mounts right away (checkouts
first, then worktrees, each in the order given); see \`cove mount\` for later changes.
${MOUNT_SPEC_HELP}
Archiving changes visibility only: nothing is stopped, unmounted or deleted.`;

function expectedRevision(args: Arguments): { expectedRevision?: number } {
  const value = optionalIntegerFlag(args, "--expected-revision");
  return value === undefined ? {} : { expectedRevision: value };
}

export async function run(args: Arguments): Promise<number> {
  const sub = args.words[1];
  if (sub === "create") {
    takeFlags(args, ["--checkout", "--worktree", "--operation-id"], ["--checkout", "--worktree"]);
    const title = one(args, "task title");
    const specs: ParsedMountSpec[] = [
      ...flagValues(args, "--checkout").map((value) => parseMountSpec("checkout", value)),
      ...flagValues(args, "--worktree").map((value) => parseMountSpec("worktree", value)),
    ];
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      const mounts = await resolveMountSpecs(session.client, specs);
      const operation = await submitWrite(args, session, "task.create", {
        operationId,
        title,
        mounts,
      });
      const taskId = operation.result?.resource?.id;
      // A create that was not carried out has no task to show.
      if (!taskId) {
        printSucceeded(operation);
        return 0;
      }
      return printTaskOperation(session.client, operation, taskId);
    });
  }
  if (sub === "list") {
    takeFlags(args, ["--archived"]);
    if (args.words.length !== 2 || args.command)
      throw new UsageError("task list takes no arguments");
    const archived = flag(args, "--archived");
    if (archived !== undefined && !["exclude", "include", "only"].includes(archived))
      throw new UsageError("--archived is exclude, include or only");
    return withSession(args, async ({ client }) => {
      print({ tasks: (await listTasks(client, archived)).map(describeTask) });
      return 0;
    });
  }
  if (sub === "get") {
    takeFlags(args, []);
    const taskId = one(args, "task id");
    return withSession(args, async ({ client }) => {
      print(describeTask(await getTask(client, taskId)));
      return 0;
    });
  }
  if (sub === "rename") {
    takeFlags(args, ["--expected-revision", "--operation-id"]);
    const [, , taskId, title] = args.words;
    if (!taskId || !title || args.words.length !== 4 || args.command)
      throw new UsageError("task rename needs a task id and a title");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      printSucceeded(
        await submitWrite(args, session, "task.update", {
          operationId,
          taskId,
          title,
          ...expectedRevision(args),
        }),
      );
      return 0;
    });
  }
  if (sub === "archive" || sub === "unarchive") {
    takeFlags(args, ["--expected-revision", "--operation-id"]);
    const taskId = one(args, "task id");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      printSucceeded(
        await submitWrite(args, session, sub === "archive" ? "task.archive" : "task.unarchive", {
          operationId,
          taskId,
          ...expectedRevision(args),
        }),
      );
      return 0;
    });
  }
  throw new UsageError(`Unknown task command ${sub ?? ""}`.trim());
}
