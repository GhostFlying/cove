#!/usr/bin/env node
// Test-only terminal worker for issue #103: the real pipe endpoint and the real execution (real
// PTYs), slowed down while the file named by COVE_TEST_SLOW_WORKER_FLAG exists. Nothing in the
// shipped worker reads that variable; this entry exists only for tests that spawn it.
//
// While slow, the worker behaves like one saturated by parsing on a slow host:
// - its event loop is busy in bursts of 150 ms every 200 ms (or as many milliseconds as the
//   flag file holds), so every reply and every output event is late (its heartbeat timer still
//   fires between bursts, as it would on a busy worker);
// - subscribe and recover replies are held until it is no longer slow, so an attach waits past
//   its deadline. The real execution has already run them, so a concurrent unsubscribe is
//   handled by the real route state, exactly as for a capture that is merely slow.
// Separately, while the file named by the flag plus ".route" exists, applied-ack and
// baseline-progress wait before they execute, as route control queued behind a busy worker
// does; the event loop stays free, so heartbeats keep coming.
import { existsSync, readFileSync } from "node:fs";
import { createWorkerExecution } from "@cove/terminal-worker/execution";
import { runWorkerPipe } from "@cove/terminal-worker/pipe";

const flag = process.env.COVE_TEST_SLOW_WORKER_FLAG;
const slow = () => !!flag && existsSync(flag);
const holdRoute = () => !!flag && existsSync(`${flag}.route`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function burstMs() {
  try {
    const value = Number(readFileSync(flag, "utf8").trim());
    return Number.isSafeInteger(value) && value > 0 ? value : 150;
  } catch {
    return 150;
  }
}

setInterval(() => {
  if (!slow()) return;
  const end = Date.now() + burstMs();
  while (Date.now() < end);
}, 200).unref();

// The execution is a frozen object of own function members, so a copy with one replaced member
// keeps every other hook (delivery capacity, marker and settlement notifications) intact.
function slowed(execution) {
  return Object.freeze({
    ...execution,
    execute: async (command, payload) => {
      if (command.type === "applied-ack" || command.type === "baseline-progress")
        while (holdRoute()) await sleep(50);
      const reply = await execution.execute(command, payload);
      if (command.type === "subscribe" || command.type === "recover")
        while (slow()) await sleep(50);
      return reply;
    },
  });
}

const pipe = runWorkerPipe(process.stdin, process.stdout, {
  buildVersion: "0.0.0",
  createExecution: (options) => slowed(createWorkerExecution(options)),
});
const terminate = () => void pipe.shutdown("termination-signal");
process.once("SIGINT", terminate);
process.once("SIGTERM", terminate);
void pipe.closed.then(({ reason }) => {
  process.off("SIGINT", terminate);
  process.off("SIGTERM", terminate);
  if (reason !== "stdin-eof" && reason !== "termination-signal") process.exitCode = 1;
});
