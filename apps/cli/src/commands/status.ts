import { print, takeFlags, unwrap, UsageError, withSession, type Arguments } from "./_common.js";

export const usage = `  status`;

export async function run(args: Arguments): Promise<number> {
  takeFlags(args, []);
  if (args.words.length !== 1 || args.command) throw new UsageError("status takes no arguments");
  return withSession(args, async ({ client }) => {
    print(unwrap("server.status", await client.call("server.status", {})));
    return 0;
  });
}
