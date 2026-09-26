import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { ownedStalledCommand } from "./stalled-input-identity.mjs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const fixture = resolve(import.meta.dirname, "fixtures/raw-child.mjs");
const source = resolve(dirname(require.resolve("node-pty/package.json")), "src/unixTerminal.ts");
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

async function waitUntil(check, label) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`Timed out awaiting ${label}`);
}

const output = [];
const nonce = `w1-stall-${randomUUID()}`;
let settleExit;
const exited = new Promise((done) => {
  settleExit = done;
});
const terminal = pty.spawn(process.execPath, [fixture, "stall", nonce], {
  cwd: resolve(import.meta.dirname, "../../.."),
  env: process.env,
  cols: 80,
  rows: 24,
  encoding: null,
  handleFlowControl: false,
});
let data;
let exit;
let dataFailure;
let primaryError;
const cleanupErrors = [];
try {
  data = terminal.onData((value) => {
    if (dataFailure) return;
    if (!Buffer.isBuffer(value)) {
      dataFailure = new Error("Native stalled diagnostic emitted non-Buffer output");
      return;
    }
    output.push(Buffer.from(value));
  });
  exit = terminal.onExit(settleExit);
  await waitUntil(() => {
    if (dataFailure) throw dataFailure;
    return Buffer.concat(output).includes(Buffer.from("STALLED"));
  }, "stall marker");
  const before = process.memoryUsage();
  const returns = new Set();
  for (let index = 0; index < 128; index++) returns.add(terminal.write(Buffer.alloc(8_192, 0x41)));
  await sleep(120);
  if (dataFailure) throw dataFailure;
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
      childStillOwned: ownedStalledCommand(terminal.pid, fixture, nonce) !== null,
    }),
  );
} catch (error) {
  primaryError = error;
} finally {
  try {
    data?.dispose();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (ownedStalledCommand(terminal.pid, fixture, nonce) !== null) {
      terminal.kill("SIGTERM");
      await waitUntil(
        () => ownedStalledCommand(terminal.pid, fixture, nonce) === null,
        "stalled child removal",
      );
      if (exit)
        await Promise.race([
          exited,
          sleep(3_000).then(() => {
            throw new Error("Stalled child did not settle after owned termination");
          }),
        ]);
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    exit?.dispose();
  } catch (error) {
    cleanupErrors.push(error);
  }
}
if (cleanupErrors.length)
  throw new AggregateError(
    primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
    "Stalled diagnostic cleanup failed",
  );
if (primaryError) throw primaryError;
