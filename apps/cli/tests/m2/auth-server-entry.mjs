import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The compiled server entry with the M2 auth flags the scenarios need: the arguments m1's
// startServerEntry passes, plus the JSON array in COVE_TEST_SERVER_ARGS (for example
// `--ssh-target user@example.test`). `cove server start` cannot pass server flags yet (T3), so
// the T1 scenarios start the server through this wrapper; it runs the same runServerProcess as
// the `cove-server` executable.
const serverPackage = dirname(createRequire(import.meta.url).resolve("@cove/server/package.json"));
const { runServerProcess } = await import(
  pathToFileURL(join(serverPackage, "dist/entry/main.js")).href
);
const extra = JSON.parse(process.env.COVE_TEST_SERVER_ARGS ?? "[]");
runServerProcess([...process.argv.slice(2), ...extra]);
