import type { Client } from "@cove/client";
import type { OperationRecord } from "@cove/protocol/rpc";
import {
  homeDirectory,
  one,
  print,
  settle,
  takeFlags,
  unwrap,
  UsageError,
  withSession,
  type Arguments,
} from "./_common.js";
import { acceptWrite, operationIdFor, readPending, syncPendingPublication } from "./_pending.js";
import { leftoverHints, leftoversOf, operationHints } from "./_workspace.js";

export const usage = `  operation get <operationId>
  operation resend <operationId>
  operation continue <operationId> [--operation-id ID]
  operation abandon <operationId> [--operation-id ID]

continue and abandon act on an operation in requires_attention. Each is a write with its own
--operation-id. The server refuses both while a Git process the operation started may still run
(OPERATION_EFFECTS_ACTIVE; nothing is accepted, so send it again later). continue goes on from
the steps the server recorded, after proving what a step whose end it did not see did; it
repeats no step that took effect, and it stops again when it cannot prove one. abandon cancels
the operation: it is accepted first, then removes what it recorded: its worktree, registered at
the recorded path on its branch, with a plain \`git worktree remove\` (Git refuses one with
changes or untracked files, and that keeps it; ignored files go with it), or, never checked out,
holding nothing but its \`.git\` file; and its branch, a plain ref still at its base, that no
worktree has checked out. Nothing is removed by force; anything else
stays, is listed in progress.remainingEffects and in leftovers, and the commands to remove it
by hand are printed on stderr. Changes made while an abandon runs are not guarded against. An
abandon that cannot finish is itself requires_attention; continue it. Both print
{operation, target, leftovers}; leftovers is [{mountId, path, branch, repoPath, effects}]
(empty when nothing was left). continue exits 0 when the target succeeded; abandon exits 0
when the target was cancelled. When the write was accepted but reading its outcome or the
target's failed, both print {operation, targetReadError} with the last record read and exit 1.`;

// operation continue/abandon (M1 T3b): the write's own record and the target as it settled.
//
// Once the server accepted the write, its receipt is printed whatever happens next (#126 item 11).
// When polling the write or reading the target fails, the output is {operation, targetReadError}:
// `operation` is the last record read (still running when its own polling failed), and neither
// `target` nor `leftovers` is printed, since the failed read says nothing about them. The command
// then exits 1 and names both operations on stderr, so they can be read with `operation get`
// instead of being sent again.
async function actOn(
  args: Arguments,
  method: "operation.continue" | "operation.abandon",
): Promise<number> {
  takeFlags(args, ["--operation-id"]);
  const targetOperationId = one(args, "operation id");
  const operationId = operationIdFor(args);
  return withSession(args, async (session) =>
    finishAction(
      session.client,
      await acceptWrite(args, session, method, { operationId, targetOperationId }),
      targetOperationId,
    ),
  );
}

// The ending of continue/abandon once the server accepted the write (`accepted`): settle it, read
// the target, print and choose the exit code.
export async function finishAction(
  client: Client,
  accepted: OperationRecord,
  targetOperationId: string,
): Promise<number> {
  const method = accepted.method;
  const operationId = accepted.operationId;
  let operation = accepted;
  let target: OperationRecord | null = null;
  try {
    operation = await settle(client, operation);
    if (operation.state === "succeeded") {
      const current = unwrap(
        "operation.get",
        await client.getOperation(targetOperationId),
      ).operation;
      target = await settle(client, current);
    }
  } catch (error) {
    const targetReadError = error instanceof Error ? error.message : String(error);
    print({ operation, targetReadError });
    process.stderr.write(
      `cove: ${method} ${operationId} was accepted (last seen ${operation.state}), but the ` +
        `outcome of ${targetOperationId} is unknown: ${targetReadError}; read them with ` +
        `\`cove operation get ${operationId}\` and \`cove operation get ${targetOperationId}\` ` +
        `rather than sending either again\n`,
    );
    return 1;
  }
  const leftovers = target ? await leftoversOf(client, target) : [];
  print({ operation, target, leftovers });
  const wanted = method === "operation.continue" ? "succeeded" : "cancelled";
  if (target?.state === wanted) {
    const left = target.progress?.remainingEffects ?? [];
    if (left.length)
      process.stderr.write(
        `cove: ${targetOperationId} was cancelled; left in place: ${left.join(", ")}\n`,
      );
    for (const hint of leftoverHints(leftovers)) process.stderr.write(`cove: ${hint}\n`);
    return 0;
  }
  const failed = target ?? operation;
  const reason = failed.error ? `: ${failed.error.kind}` : "";
  process.stderr.write(`cove: ${failed.method} ${failed.operationId} ${failed.state}${reason}\n`);
  // The hints are for whichever stopped: the target, or this write itself (an abandon that
  // could not finish is continued under its own ID).
  for (const hint of [...operationHints(failed), ...leftoverHints(leftovers)])
    process.stderr.write(`cove: ${hint}\n`);
  return 1;
}

export async function run(args: Arguments): Promise<number> {
  const sub = args.words[1];
  if (sub === "continue") return actOn(args, "operation.continue");
  if (sub === "abandon") return actOn(args, "operation.abandon");
  if (sub === "get") {
    takeFlags(args, []);
    const operationId = one(args, "operation id");
    return withSession(args, async ({ client }) => {
      print(unwrap("operation.get", await client.getOperation(operationId)).operation);
      return 0;
    });
  }
  if (sub === "resend") {
    takeFlags(args, []);
    const operationId = one(args, "operation id");
    const home = homeDirectory(args);
    const pending = await readPending(home, operationId);
    // The command that saved the record may have died before making it durable; this resend may
    // be the request's first transmission.
    await syncPendingPublication(home);
    return withSession(args, async ({ client, record }) => {
      // An operation ID is only meaningful to the server that recorded it. Another server would
      // treat the saved request as new work, so it is never sent there. A different relay
      // instance of the same server is fine: its receipt store deduplicates the request.
      if (record.serverId !== pending.serverId)
        throw new Error(
          `operation ${operationId} was saved for server ${pending.serverId}, but the connected ` +
            `server is ${record.serverId}; nothing was sent`,
        );
      const sent = unwrap(
        pending.method,
        await client.call(pending.method, pending.params as never),
      ) as { operation: OperationRecord };
      // The record is printed as the server returned it, whatever its state: a resend never
      // turns a historical failure or requires_attention into a new execution.
      print(await settle(client, sent.operation));
      return 0;
    });
  }
  throw new UsageError(`Unknown operation command ${sub ?? ""}`.trim());
}
