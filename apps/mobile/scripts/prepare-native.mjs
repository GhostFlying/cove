import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const target = process.argv[2];
if (!["android", "ios", "ios-simulator"].includes(target))
  throw new Error("usage: prepare-native.mjs android|ios|ios-simulator");
const input = join(root, "native/tailscale/dist/mobile", target);
// Device and simulator builds deliberately select their own actual slice. Both
// feed the same local pod; rerun pod install after switching platform artifacts.
const output = join(
  root,
  "apps/mobile/modules/cove-tsnet/generated",
  target === "android" ? "android" : "ios",
);
mkdirSync(output, { recursive: true });
if (target === "android") {
  const result = spawnSync(
    "unzip",
    ["-o", join(input, "CoveTsnet.aar"), "classes.jar", "jni/*", "-d", output],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Cannot extract the generated Android binding");
} else {
  const framework = join(output, "CoveTsnet.xcframework");
  // A platform switch must not leave an old slice or Info.plist behind. This
  // generated framework is wholly owned by this preparation step.
  rmSync(framework, { recursive: true, force: true });
  cpSync(join(input, "CoveTsnet.xcframework"), framework, { recursive: true });
}
