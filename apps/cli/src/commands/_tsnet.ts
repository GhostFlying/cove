import type { Arguments } from "./_common.js";

// `cove server tsnet ...` (m2 D9, D10): the server's own tsnet node. Delegated from server.ts so
// that its owner, T5b, replaces only this module. Until then nothing is started or sent.
export const usage = `  server tsnet login|status|logout   (not available in this build)`;

export async function run(_args: Arguments): Promise<number> {
  process.stderr.write(
    "cove: server tsnet is not available in this build (CAPABILITY_UNAVAILABLE); nothing was done\n",
  );
  return 1;
}
