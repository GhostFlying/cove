import { spawnSync } from "node:child_process";

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function ownedStalledCommand(
  pid,
  fixture,
  nonce,
  inspect = spawnSync,
  probe = process.kill,
) {
  const result = inspect("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.error || result.signal || result.status !== 0 || !result.stdout?.trim()) {
    try {
      probe(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return null;
      throw new Error(`Stalled PID ${pid} existence could not be verified`, { cause: error });
    }
    throw new Error(`Stalled PID ${pid} identity could not be verified`);
  }
  const identity = new RegExp(
    `(?:^|\\s)${escapeRegex(fixture)}\\s+stall\\s+${escapeRegex(nonce)}(?:\\s|$)`,
  );
  if (!identity.test(result.stdout.trim()))
    throw new Error(`Stalled PID ${pid} no longer matches this fixture and nonce`);
  return result.stdout.trim();
}
