#!/usr/bin/env node
// Test-only server entry for issue #103: the compiled application (HTTP RPC, terminal WebSocket,
// runtime, worker pipe session) with a shorter recoveryDeadlineMs and the slow-worker fixture as
// its terminal worker. Usage: slow-worker-server.mjs <rendezvous path> <recoveryDeadlineMs>.
// It publishes the rendezvous like `cove-server` and prints {"pid"} once ready; SIGTERM stops it
// and exits 0 only when the worker's own exit was observed.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { createLocalApplication } from "../../dist/entry/main.js";
import { LocalRendezvous } from "../../dist/entry/local-rendezvous.js";

const [rendezvousPath, deadline] = process.argv.slice(2);
const workerEntry = join(dirname(fileURLToPath(import.meta.url)), "slow-worker.mjs");
const local = createLocalApplication(
  {
    mode: "m0-local",
    host: "127.0.0.1",
    port: 0,
    rendezvousPath,
    allowedOrigins: [],
  },
  {
    budgets: { ...M0_LIMITS, recoveryDeadlineMs: Number(deadline) },
    workerSpawn: () => {
      const child = spawn(process.execPath, [workerEntry], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      // Worker diagnostics reach the test's captured server stderr.
      child.stderr.pipe(process.stderr);
      return child;
    },
  },
);
const rendezvous = new LocalRendezvous(rendezvousPath);
const worker = local.createWorker();
let stopping;
const stop = () =>
  (stopping ??= (async () => {
    let code = 0;
    try {
      await rendezvous.close();
    } catch {
      code = 1;
    }
    local.terminal.close();
    await local.app.close();
    const receipt = await worker.close();
    local.disposeCore();
    if (receipt.status !== "exited") code = 1;
    process.exit(code);
  })());
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

local.clock.start();
worker.start();
await worker.ready;
await local.app.listen({ host: "127.0.0.1", port: 0 });
const { port } = local.app.server.address();
local.admission.bind(port);
await rendezvous.publish({
  bootstrapVersion: 1,
  ...local.identity,
  endpoint: `http://127.0.0.1:${port}`,
});
process.stdout.write(`${JSON.stringify({ pid: process.pid })}\n`);
