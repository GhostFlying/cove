import { resolve } from "node:path";
import type { Client } from "@cove/client";
import { M0_LIMITS } from "@cove/protocol/budgets";
import type { RunRecord } from "@cove/protocol/rpc";
import type { Session } from "../session.js";
import {
  flag,
  integerFlag,
  one,
  print,
  requireSucceeded,
  takeFlags,
  unwrap,
  UsageError,
  withSession,
  type Arguments,
} from "./_common.js";
import { operationIdFor, submitWrite } from "./_pending.js";

export const usage = `  terminal create [--cwd DIR] [--cols N] [--rows N] [--operation-id ID] -- <executable> [args...]
  terminal list
  terminal get <runId>
  terminal stop [--operation-id ID] <runId>`;

function runRef(session: Session, runId: string) {
  return {
    serverId: session.record.serverId,
    relayInstanceId: session.record.relayInstanceId,
    runId,
  };
}

async function listRuns(client: Client): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  let afterRunId: string | undefined;
  do {
    const page = unwrap(
      "terminal.list",
      await client.call("terminal.list", {
        limit: M0_LIMITS.listPage,
        ...(afterRunId ? { afterRunId } : {}),
      }),
    );
    runs.push(...page.runs);
    afterRunId = page.nextAfterRunId;
  } while (afterRunId);
  return runs;
}

export async function run(args: Arguments): Promise<number> {
  const sub = args.words[1];
  if (sub === "create") {
    takeFlags(args, ["--cwd", "--cols", "--rows", "--operation-id"]);
    const [executable, ...argv] = args.command ?? [];
    if (args.words.length !== 2 || !executable)
      throw new UsageError("terminal create needs `-- <executable> [args...]`");
    const geometry = {
      cols: integerFlag(args, "--cols", 80),
      rows: integerFlag(args, "--rows", 24),
    };
    const cwd = resolve(flag(args, "--cwd") ?? process.cwd());
    const operationId = operationIdFor(args);
    // The execution precondition names the instance this command was built against; a resend
    // after a restart keeps it (`cove operation resend`), while rebuilding the command against the
    // new instance is a different intent (OPERATION_ID_CONFLICT for a reused operation ID).
    return withSession(args, async (session) => {
      const operation = requireSucceeded(
        await submitWrite(args, session, "terminal.create", {
          executable,
          argv,
          cwd,
          geometry,
          operationId,
          expectedRelayInstanceId: session.record.relayInstanceId,
        }),
      );
      print(operation.result?.run ?? operation.run);
      return 0;
    });
  }
  if (sub === "list") {
    takeFlags(args, []);
    if (args.words.length !== 2 || args.command)
      throw new UsageError("terminal list takes no arguments");
    return withSession(args, async ({ client }) => {
      print({ runs: await listRuns(client) });
      return 0;
    });
  }
  if (sub === "get") {
    takeFlags(args, []);
    const runId = one(args, "run id");
    return withSession(args, async (session) => {
      const run = runRef(session, runId);
      print(unwrap("terminal.get", await session.client.call("terminal.get", { run })).record);
      return 0;
    });
  }
  if (sub === "stop") {
    takeFlags(args, ["--operation-id"]);
    const runId = one(args, "run id");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      print(
        requireSucceeded(
          await submitWrite(args, session, "terminal.stop", {
            run: runRef(session, runId),
            operationId,
            expectedRelayInstanceId: session.record.relayInstanceId,
          }),
        ),
      );
      return 0;
    });
  }
  throw new UsageError(`Unknown terminal command ${sub ?? ""}`.trim());
}
