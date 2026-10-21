import type { Arguments } from "./_common.js";

// `cove remote tsnet ...` (m2 D9, D14): the client's own tsnet node, run by the resident
// `cove-tsnet dial` process. Delegated from remote.ts (as mount.ts delegates to _binding.ts) so
// that its owner, T4, replaces only this module. Until then nothing is started or sent.
export const usage = `  remote tsnet login|status|logout|stop   (not available in this build)`;

export async function run(_args: Arguments): Promise<number> {
  process.stderr.write(
    "cove: remote tsnet is not available in this build (CAPABILITY_UNAVAILABLE); nothing was done\n",
  );
  return 1;
}
