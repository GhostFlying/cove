import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const browsersPath = fileURLToPath(new URL("../.cache/playwright/", import.meta.url));
await mkdir(browsersPath, { recursive: true });
const manifest = require("playwright/package.json");
if (manifest.version !== "1.63.0" || manifest.bin?.playwright !== "cli.js") {
  throw new Error("Unexpected Playwright CLI package layout");
}
const args = [
  join(dirname(require.resolve("playwright/package.json")), manifest.bin.playwright),
  "install",
];
if (process.platform === "linux" && process.env.CI === "true") args.push("--with-deps");
args.push("chromium");
const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
