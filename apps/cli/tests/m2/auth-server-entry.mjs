import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The compiled server entry with the M2 auth flags the scenarios need: the arguments m1's
// startServerEntry passes, plus the JSON array in COVE_TEST_SERVER_ARGS (for example
// `--ssh-target user@example.test`). `cove server start` cannot pass server flags yet (T3), so
// the T1 scenarios start the server through this wrapper; it runs the same runServerProcess as
// the `cove-server` executable.
//
// With COVE_TEST_STORE_FAULTS set to JSON store limits (e.g. {"inFlight":1,"queued":1}) it adds
// the test seams of m1's store-fault-server.mjs that the production executable never passes: the
// store loads m1/store-fault-operations.mjs, and SIGUSR2 saturates the store (one call occupying
// the worker for COVE_TEST_SATURATE_MS, the queue filled), writing {"event":"saturated"} to stderr
// once a further call was refused as busy and {"event":"drained"} when the occupying call ended.
const serverPackage = dirname(createRequire(import.meta.url).resolve("@cove/server/package.json"));
const { runServerProcess } = await import(
  pathToFileURL(join(serverPackage, "dist/entry/main.js")).href
);
const extra = JSON.parse(process.env.COVE_TEST_SERVER_ARGS ?? "[]");
const faults = process.env.COVE_TEST_STORE_FAULTS
  ? JSON.parse(process.env.COVE_TEST_STORE_FAULTS)
  : undefined;
const event = (name, fields = {}) =>
  process.stderr.write(`${JSON.stringify({ event: name, ...fields })}\n`);
// The secret scan's sentinel (auth-fixtures.mjs), so that server stderr is a carrier it must find.
if (process.env.COVE_TEST_SENTINEL)
  event("test-sentinel", { value: process.env.COVE_TEST_SENTINEL });
const ignore = () => undefined;
runServerProcess(
  [...process.argv.slice(2), ...extra],
  undefined,
  faults && {
    store: {
      operationModules: [new URL("../m1/store-fault-operations.mjs", import.meta.url).href],
      limits: faults,
    },
    onStoreOpen: (store) => {
      process.on("SIGUSR2", () => {
        const ms = Number(process.env.COVE_TEST_SATURATE_MS ?? 4000);
        store.call("test.sleep", { ms }).then(() => event("drained"), ignore);
        for (let i = 0; i < faults.queued; i++) store.call("test.sleep", { ms: 0 }).catch(ignore);
        store.call("test.sleep", { ms: 0 }).catch((error) => {
          if (error?.reason === "busy") event("saturated");
        });
      });
    },
  },
);
