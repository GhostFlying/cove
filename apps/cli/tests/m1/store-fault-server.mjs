#!/usr/bin/env node
// A test-only cove-server entry (store-fault-server.test.mjs). It is the compiled server
// (runServerProcess from dist/entry/main.js) plus test seams that the production executable never
// passes (ServerTestHooks): the store loads store-fault-operations.mjs, and signals drive faults.
//
// - SIGUSR1: crash the store worker inside a transaction.
// - SIGHUP: start an orderly stop (SIGTERM to itself) while a store crash waits in the queue.
// - SIGUSR2: saturate the store (one long call in the worker, the queue filled), then write
//   {"event":"saturated"} to stderr once a further call was refused as busy.
// - COVE_TEST_STORE_LIMITS: JSON store limits ({"inFlight":1,"queued":2}).
//
// With COVE_TEST_STORE_QUERY=1 it does not start a server: it opens the store of `--home DIR`,
// prints {"lock":"opened", instances, runs} (or {"lock":"<StoreError category>"} when it cannot
// open it) and exits. Tests use it to see whether a server still holds the data directory and what
// it recorded.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const serverPackage = dirname(createRequire(import.meta.url).resolve("@cove/server/package.json"));
const dist = (path) => import(pathToFileURL(join(serverPackage, "dist", path)).href);
const operationModules = [new URL("./store-fault-operations.mjs", import.meta.url).href];

async function query(home) {
  const { Store } = await dist("store/database.js");
  const { prepareHome } = await dist("store/home.js");
  const layout = await prepareHome(home);
  let store;
  try {
    store = await Store.open({
      databasePath: layout.databasePath,
      backupDirectory: layout.backupDirectory,
      operationModules,
    });
  } catch (error) {
    return { lock: error?.category ?? "error" };
  }
  try {
    return {
      lock: "opened",
      instances: await store.call("test.all", {
        sql: "SELECT relay_instance_id AS id, stopped_at_ms AS stopped FROM relay_instances ORDER BY started_at_ms",
      }),
      runs: await store.call("test.all", {
        sql: "SELECT run_id AS id, relay_instance_id AS instance, lifecycle, verification FROM runs ORDER BY run_seq",
      }),
    };
  } finally {
    await store.close();
  }
}

if (process.env.COVE_TEST_STORE_QUERY === "1") {
  const home = process.argv[process.argv.indexOf("--home") + 1];
  process.stdout.write(`${JSON.stringify(await query(home))}\n`);
} else {
  const { runServerProcess } = await dist("entry/main.js");
  const limits = process.env.COVE_TEST_STORE_LIMITS
    ? JSON.parse(process.env.COVE_TEST_STORE_LIMITS)
    : undefined;
  const ignore = () => undefined;
  runServerProcess(process.argv.slice(2), undefined, {
    store: { operationModules, ...(limits ? { limits } : {}) },
    onStoreOpen: (store) => {
      process.on("SIGUSR1", () => store.call("test.crash", {}).catch(ignore));
      process.on("SIGHUP", () => {
        // A long call, then a crash queued behind it; the orderly stop begins at once. The stop's
        // store close drains the queue, so the worker dies after the stop began.
        store.call("test.sleep", { ms: 1500 }).catch(ignore);
        store.call("test.crash", {}).catch(ignore);
        process.kill(process.pid, "SIGTERM");
      });
      process.on("SIGUSR2", () => {
        store.call("test.sleep", { ms: 1500 }).catch(ignore);
        for (let i = 0; i < (limits?.queued ?? 0); i++)
          store.call("test.sleep", { ms: 0 }).catch(ignore);
        store.call("test.sleep", { ms: 0 }).catch((error) => {
          if (error?.reason === "busy")
            process.stderr.write(`${JSON.stringify({ event: "saturated" })}\n`);
        });
      });
    },
  });
}
