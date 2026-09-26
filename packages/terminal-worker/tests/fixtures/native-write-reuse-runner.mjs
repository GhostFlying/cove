import assert from "node:assert/strict";
import { pbkdf2 } from "node:crypto";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

if (process.env.UV_THREADPOOL_SIZE !== "1") throw new Error("single libuv worker required");
const require = createRequire(import.meta.url);
const candidate = process.env.COVE_N1_PACKAGE_ROOT;
const pty = candidate ? require(resolve(candidate, "lib/index.js")) : require("node-pty");
const nonce = `n1-${process.pid}-${Date.now()}`;
const fixture = resolve(import.meta.dirname, "native-write-child.mjs");
const scratch = mkdtempSync(join(tmpdir(), "cove-n1-reuse-"));
const payload = Buffer.from(`REUSED-FD-${nonce}`);
const terminal = pty.spawn(process.execPath, [fixture, nonce], {
  cols: 80,
  rows: 24,
  encoding: null,
  boundedWrite: { maxAllocatedBytes: payload.byteLength, maxTasks: 1 },
});
let exited = false;
let output = Buffer.alloc(0);
let settlement;
let blocker;
let destroyed = false;
let readerReused = -1;
let sentinelPath;
const extraFds = [];
terminal.onExit(() => {
  exited = true;
});
terminal.onData((chunk) => {
  output = Buffer.concat([output, Buffer.from(chunk)]);
});

async function until(predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out awaiting ${label}`);
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 5));
  }
}
function descriptorIsClosed(fd) {
  try {
    fstatSync(fd);
    return false;
  } catch (error) {
    if (error.code === "EBADF") return true;
    throw error;
  }
}
function occupyWorker() {
  return new Promise((resolveWork, rejectWork) => {
    pbkdf2("n1", "fd-lifetime", 4_000_000, 32, "sha256", (error) =>
      error ? rejectWork(error) : resolveWork(),
    );
  });
}
function destroyOnce() {
  if (!destroyed) {
    destroyed = true;
    terminal.destroy();
  }
}

try {
  assert.equal(pty.native.coveBoundedWriterVersion, 1);
  await until(() => output.includes(Buffer.from(`READY ${nonce}`)), "child ready");
  const readerFd = terminal.fd;
  const writerFd = terminal._writeStream._fd;
  assert.notEqual(writerFd, readerFd);
  assert.equal(descriptorIsClosed(writerFd), false);
  blocker = occupyWorker();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  assert.equal(
    terminal.writeBounded(payload, (value) => {
      settlement = value;
    }).accepted,
    true,
  );
  await until(() => terminal.getBoundedWriteState().writeInFlight, "issued native write");
  destroyOnce();
  await until(() => descriptorIsClosed(readerFd), "reader close");
  assert.equal(descriptorIsClosed(writerFd), false, "writer owner closed before callback");

  for (let index = 0; index < 64; index++) {
    const path = join(scratch, `sentinel-${index}`);
    const fd = openSync(path, "w+");
    if (fd === readerFd) {
      readerReused = fd;
      sentinelPath = path;
      break;
    }
    extraFds.push(fd);
  }
  assert.equal(readerReused, readerFd, "fixture did not force reader fd reuse");
  await blocker;
  await until(() => settlement !== undefined, "write settlement");
  let ownerResult;
  terminal.boundedWriteCompletion.then((value) => {
    ownerResult = value;
  });
  await until(() => ownerResult !== undefined, "writer owner completion");
  assert.deepEqual(ownerResult, { kind: "closed" });
  await until(() => exited, "owned child exit");
  assert.equal(descriptorIsClosed(writerFd), true);
  assert.equal(readFileSync(sentinelPath).byteLength, 0, "delayed write reached reused reader fd");
  process.stdout.write(
    JSON.stringify({
      platform: process.platform,
      node: process.version,
      readerFd,
      writerFd,
      readerReused,
      sentinelBytes: 0,
      settlement,
    }) + "\n",
  );
} finally {
  terminal.disposeBoundedWrite();
  destroyOnce();
  if (blocker) await blocker;
  if (!exited) {
    terminal._boundedOwnedStop(9);
    await until(() => exited, "owned child cleanup", 3_000);
  }
  for (const fd of extraFds) closeSync(fd);
  if (readerReused >= 0) closeSync(readerReused);
  rmSync(scratch, { recursive: true, force: true });
}
