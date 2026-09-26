import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const fixture = resolve(import.meta.dirname, "fixtures/raw-child.mjs");
const source = resolve(dirname(require.resolve("node-pty/package.json")), "src/unixTerminal.ts");
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function owned(pid, mode) {
  const found = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (found.status !== 0) return false;
  if (!found.stdout.includes(fixture) || !found.stdout.includes(mode))
    throw new Error(`PID ${pid} is no longer the owned ${mode} fixture`);
  return true;
}

async function waitUntil(check, label) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`Timed out awaiting ${label}`);
}

const output = [];
let settleExit;
const exited = new Promise((done) => {
  settleExit = done;
});
const terminal = pty.spawn(process.execPath, [fixture, "stall"], {
  cwd: resolve(import.meta.dirname, "../../.."),
  env: process.env,
  cols: 80,
  rows: 24,
  encoding: null,
  handleFlowControl: false,
});
const data = terminal.onData((value) => output.push(Buffer.from(value)));
const exit = terminal.onExit(settleExit);
try {
  await waitUntil(() => Buffer.concat(output).includes(Buffer.from("STALLED")), "stall marker");
  const before = process.memoryUsage();
  const returns = new Set();
  for (let index = 0; index < 128; index++) returns.add(terminal.write(Buffer.alloc(8_192, 0x41)));
  await sleep(120);
  // Read-only diagnostic of the exact pinned implementation, never an adapter dependency.
  const tasks = terminal._writeStream?._writeQueue;
  if (!Array.isArray(tasks)) throw new Error("Pinned private diagnostic shape changed");
  const queuedBytes = tasks.reduce((sum, task) => sum + task.buffer.length - task.offset, 0);
  const after = process.memoryUsage();
  console.log(
    JSON.stringify({
      nodePtyVersion: require("node-pty/package.json").version,
      sourceSha256: createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
      childPid: terminal.pid,
      attemptedBytes: 128 * 8_192,
      callCount: 128,
      returnTypes: [...returns].map((value) => typeof value),
      privateQueuedTasks: tasks.length,
      privateQueuedBytes: queuedBytes,
      arrayBuffersDelta: after.arrayBuffers - before.arrayBuffers,
      childStillOwned: owned(terminal.pid, "stall"),
    }),
  );
} finally {
  data.dispose();
  if (owned(terminal.pid, "stall")) terminal.kill("SIGTERM");
  await Promise.race([
    exited,
    sleep(3_000).then(() => {
      throw new Error("Stalled child did not settle after owned termination");
    }),
  ]);
  exit.dispose();
  await waitUntil(() => !owned(terminal.pid, "stall"), "stalled child removal");
}
