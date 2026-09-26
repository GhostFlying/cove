import assert from "node:assert/strict";
import { accessSync, closeSync, constants, readdirSync, fstatSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const candidate = process.env.COVE_N1_PACKAGE_ROOT;
const pty = candidate ? require(`${candidate}/lib/index.js`) : require("node-pty");
const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
const executable = process.platform === "darwin" ? "/usr/bin/true" : "/bin/true";
accessSync(executable, constants.X_OK);
const descriptorCount = () => readdirSync(descriptorDirectory).length;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function closed(fd) {
  try {
    fstatSync(fd);
    return false;
  } catch (error) {
    if (error.code === "EBADF") return true;
    throw error;
  }
}

async function cycle(enabled) {
  const terminal = pty.spawn(executable, [], {
    cols: 80,
    rows: 24,
    encoding: null,
    ...(enabled ? { boundedWrite: { maxAllocatedBytes: 1024, maxTasks: 2 } } : {}),
  });
  const reader = terminal.fd;
  const writer = enabled ? terminal._writeStream._fd : reader;
  if (enabled) assert.notEqual(writer, reader);
  else {
    assert.equal(terminal._writeStream._fd, reader);
    assert.equal(terminal.getBoundedWriteState(), undefined);
  }
  try {
    const exit = await new Promise((resolve, reject) => {
      const watchdog = setTimeout(
        () => reject(new Error(`PTY child ${terminal.pid} did not exit`)),
        3_000,
      );
      terminal.onExit((outcome) => {
        clearTimeout(watchdog);
        resolve(outcome);
      });
    });
    assert.deepEqual(exit, { exitCode: 0, signal: 0 });
  } finally {
    terminal.destroy();
    if (enabled) assert.deepEqual(await terminal.boundedWriteCompletion, { kind: "closed" });
  }
  assert.equal(closed(reader), true);
  assert.equal(closed(writer), true);
  assert.throws(() => process.kill(terminal.pid, 0), { code: "ESRCH" });
}

async function settledCount() {
  await sleep(200);
  return descriptorCount();
}

const counts = {};
for (const [name, enabled] of [
  ["bounded", true],
  ["legacy", false],
]) {
  await cycle(enabled); // Initialize the one-time Node/PTY read watcher before measuring churn.
  const baseline = await settledCount();
  for (let index = 0; index < 8; index++) await cycle(enabled);
  const after = await settledCount();
  assert.equal(after, baseline, `${name} parent descriptors accumulated: ${baseline} -> ${after}`);
  counts[name] = { baseline, after };
}

const openBaseline = await settledCount();
const opened = pty.native.open(80, 24);
try {
  assert.equal("writeFd" in opened, false);
  assert.equal(closed(opened.master), false);
  assert.equal(closed(opened.slave), false);
} finally {
  closeSync(opened.master);
  closeSync(opened.slave);
}
assert.equal(closed(opened.master), true);
assert.equal(closed(opened.slave), true);
assert.equal(await settledCount(), openBaseline, "native open retained an extra descriptor");

if (process.platform === "darwin") {
  const failSpawn = () =>
    assert.throws(
      () =>
        pty.native.fork(
          executable,
          [],
          [],
          process.cwd(),
          80,
          24,
          -1,
          -1,
          true,
          "/no/such/cove-helper",
          () => {},
          true,
        ),
      /posix_spawnp failed/,
    );
  failSpawn();
  const baseline = await settledCount();
  for (let index = 0; index < 8; index++) failSpawn();
  const after = await settledCount();
  assert.equal(
    after,
    baseline,
    `failed native spawn retained descriptors: ${baseline} -> ${after}`,
  );
  counts.failedSpawn = { baseline, after };
}

process.stdout.write(`${JSON.stringify({ platform: process.platform, counts })}\n`);
