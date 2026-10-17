import type { Client } from "@cove/client";
import type { OperationRecord } from "@cove/protocol/rpc";
import type { MountSpec, TaskRecord } from "@cove/protocol/workspace";
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

// One --checkout or --worktree value. Options are comma-separated `key=value` pairs after the
// repo ID; a checkout's path= is last and may itself contain commas.
export function parseMountSpec(source: "checkout" | "worktree", value: string): MountSpec {
  const flagName = `--${source}`;
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

// The ending of a write that changes a task's mounts: print the settled operation together with
// the task as it is now, so per-mount outcomes and the read-only notice are visible even when
// the operation failed (a partial success is never shown as complete). Exits 1 unless it
// succeeded.
export async function printTaskOperation(
  client: Client,
  operation: OperationRecord,
  taskId: string,
): Promise<number> {
  print({ operation, task: describeTask(await getTask(client, taskId)) });
  if (operation.state === "succeeded") return 0;
  const reason = operation.error ? `: ${operation.error.kind}` : "";
  process.stderr.write(
    `cove: ${operation.method} ${operation.operationId} ${operation.state}${reason}\n`,
  );
  for (const hint of operationHints(operation, taskId)) process.stderr.write(`cove: ${hint}\n`);
  return 1;
}

// What the operator can do next about an operation that did not succeed (T3b). The hints name
// commands only; the record printed on stdout is the result.
export function operationHints(operation: OperationRecord, taskId?: string): string[] {
  const hints: string[] = [];
  const id = operation.operationId;
  if (operation.state === "requires_attention")
    hints.push(
      `inspect it with \`cove operation get ${id}\`, then \`cove operation continue ${id}\` ` +
        `or \`cove operation abandon ${id}\``,
    );
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
