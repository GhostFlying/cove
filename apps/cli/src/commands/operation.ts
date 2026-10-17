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
import { operationIdFor, readPending, submitWrite, syncPendingPublication } from "./_pending.js";
import { operationHints } from "./_workspace.js";

export const usage = `  operation get <operationId>
  operation resend <operationId>
  operation continue <operationId> [--operation-id ID]
  operation abandon <operationId> [--operation-id ID]

continue and abandon act on an operation in requires_attention. Each is a write with its own
--operation-id. The server refuses both while a Git process the operation started may still run
(OPERATION_EFFECTS_ACTIVE; nothing is accepted, so send it again later). continue goes on from
what the server observes now and repeats no step that already took effect. abandon cancels the
operation. It removes only what the operation created and still matches exactly: a clean
worktree on its own branch, and a branch still at its base. Anything else stays and is listed in
progress.remainingEffects. Both print {operation, target}. continue exits 0 when the target
succeeded; abandon exits 0 when the target was cancelled.`;

// operation continue/abandon (M1 T3b): the write's own record and the target as it settled.
async function actOn(
  args: Arguments,
  method: "operation.continue" | "operation.abandon",
): Promise<number> {
  takeFlags(args, ["--operation-id"]);
  const targetOperationId = one(args, "operation id");
  const operationId = operationIdFor(args);
  return withSession(args, async (session) => {
    const operation = await submitWrite(args, session, method, { operationId, targetOperationId });
    let target: OperationRecord | null = null;
    if (operation.state === "succeeded") {
      const current = unwrap(
        "operation.get",
        await session.client.getOperation(targetOperationId),
      ).operation;
      target = await settle(session.client, current);
    }
    print({ operation, target });
    const wanted = method === "operation.continue" ? "succeeded" : "cancelled";
    if (target?.state === wanted) {
      const left = target.progress?.remainingEffects ?? [];
      if (left.length)
        process.stderr.write(
          `cove: ${targetOperationId} was cancelled; left in place: ${left.join(", ")}\n`,
        );
      return 0;
    }
    const failed = target ?? operation;
    const reason = failed.error ? `: ${failed.error.kind}` : "";
    process.stderr.write(`cove: ${failed.method} ${failed.operationId} ${failed.state}${reason}\n`);
    if (target) for (const hint of operationHints(target)) process.stderr.write(`cove: ${hint}\n`);
    return 1;
  });
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
