import assert from "node:assert/strict";
import { readdirSync, fstatSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const candidate = process.env.COVE_N1_PACKAGE_ROOT;
const pty = candidate ? require(`${candidate}/lib/index.js`) : require("node-pty");
const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
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
  const terminal = pty.spawn("/bin/true", [], {
    cols: 80,
    rows: 24,
    encoding: null,
    ...(enabled ? { boundedWrite: { maxAllocatedBytes: 1024, maxTasks: 2 } } : {}),
  });
  const reader = terminal.fd;
  const writer = enabled ? terminal._writeStream._fd : reader;
  try {
    await new Promise((resolve, reject) => {
      const watchdog = setTimeout(
        () => reject(new Error(`PTY child ${terminal.pid} did not exit`)),
        3_000,
      );
      terminal.onExit(() => {
        clearTimeout(watchdog);
        resolve();
      });
    });
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

if (process.platform === "darwin") {
  const failSpawn = () =>
    assert.throws(
      () =>
        pty.native.fork(
          "/bin/true",
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
