import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const target = process.argv[2];
if (!["android", "ios"].includes(target)) throw new Error("usage: prepare-native.mjs android|ios");
const input = join(root, "native/tailscale/dist/mobile", target);
const output = join(root, "apps/mobile/modules/cove-tsnet/generated", target);
mkdirSync(output, { recursive: true });
if (target === "android") {
  const result = spawnSync(
    "unzip",
    ["-o", join(input, "CoveTsnet.aar"), "classes.jar", "jni/*", "-d", output],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Cannot extract the generated Android binding");
} else
  cpSync(join(input, "CoveTsnet.xcframework"), join(output, "CoveTsnet.xcframework"), {
    recursive: true,
  });
