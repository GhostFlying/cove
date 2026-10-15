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
import { readPending } from "./_pending.js";

export const usage = `  operation get <operationId>
  operation resend <operationId>`;

export async function run(args: Arguments): Promise<number> {
  const sub = args.words[1];
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
    const pending = await readPending(homeDirectory(args), operationId);
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
