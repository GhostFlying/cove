import { resolve } from "node:path";
import {
  optionalIntegerFlag,
  print,
  takeFlags,
  unwrap,
  UsageError,
  withSession,
  type Arguments,
} from "./_common.js";
import { operationIdFor, printSucceeded, submitWrite } from "./_pending.js";

export const usage = `  config get
  config set workspaceRoot <DIR> [--expected-revision N] [--operation-id ID]
  config reset workspaceRoot [--expected-revision N] [--operation-id ID]

workspaceRoot applies to workspaces created afterwards; existing workspaces never move.`;

// Settings the CLI can change, by their config record name.
const SETTINGS = new Set(["workspaceRoot"]);

export async function run(args: Arguments): Promise<number> {
  const sub = args.words[1];
  if (sub === "get") {
    takeFlags(args, []);
    if (args.words.length !== 2 || args.command)
      throw new UsageError("config get takes no arguments");
    return withSession(args, async ({ client }) => {
      print(unwrap("config.get", await client.call("config.get", {})).config);
      return 0;
    });
  }
  if (sub === "set" || sub === "reset") {
    takeFlags(args, ["--expected-revision", "--operation-id"]);
    const key = args.words[2];
    if (!key || !SETTINGS.has(key) || args.command)
      throw new UsageError(`config ${sub} needs a setting name (workspaceRoot)`);
    if (args.words.length !== (sub === "set" ? 4 : 3))
      throw new UsageError(
        sub === "set" ? "config set needs one value" : "config reset takes no value",
      );
    // A path is resolved here so that the request names one absolute directory; rebuilding the
    // same command from the same directory produces the same intent for a reused operation ID.
    const value = sub === "set" ? resolve(args.words[3]!) : null;
    const expectedRevision = optionalIntegerFlag(args, "--expected-revision");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      printSucceeded(
        await submitWrite(args, session, "config.set", {
          operationId,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          patch: { workspaceRoot: value },
        }),
      );
      return 0;
    });
  }
  throw new UsageError(`Unknown config command ${sub ?? ""}`.trim());
}
