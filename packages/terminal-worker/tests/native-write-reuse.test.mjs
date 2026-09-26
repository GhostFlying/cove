import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

test("stale native addon capability refuses bounded spawn before creating a child", () => {
  const marker = pty.native.coveBoundedWriterVersion;
  const fork = pty.native.fork;
  let forkCalls = 0;
  try {
    pty.native.coveBoundedWriterVersion = undefined;
    pty.native.fork = (...args) => {
      forkCalls++;
      return fork(...args);
    };
    expect(() =>
      pty.spawn("/bin/false", [], {
        boundedWrite: { maxAllocatedBytes: 1, maxTasks: 1 },
      }),
    ).toThrow(/native capability/);
    expect(forkCalls).toBe(0);
  } finally {
    pty.native.coveBoundedWriterVersion = marker;
    pty.native.fork = fork;
  }
});

function absent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}

async function stopOwnedProcess(pid, nonce, fixture) {
  if (pid === undefined || absent(pid)) return;
  const inspected = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (absent(pid)) return;
  if (
    inspected.error ||
    inspected.status !== 0 ||
    !inspected.stdout.includes(fixture) ||
    !inspected.stdout.includes(nonce)
  ) {
    throw new Error(`owned process ${pid} identity unverifiable`);
  }
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + 2_000;
  while (!absent(pid)) {
    if (Date.now() >= deadline) throw new Error(`owned process ${pid} remained live`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function runReuse(fault, watchdogMs = 15_000) {
  const runner = new URL("./fixtures/native-write-reuse-runner.mjs", import.meta.url);
  const nonce = randomUUID();
  const child = spawn(process.execPath, [runner.pathname, nonce], {
    cwd: import.meta.dirname,
    env: { ...process.env, UV_THREADPOOL_SIZE: "1", COVE_N1_REUSE_FAULT: fault ?? "" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  let ownedPid;
  let scratch;
  child.on("message", (value) => {
    if (value?.nonce === nonce && Number.isSafeInteger(value.pid) && value.pid > 0) {
      ownedPid = value.pid;
      if (
        typeof value.scratch === "string" &&
        value.scratch.startsWith(join(tmpdir(), "cove-n1-reuse-"))
      ) {
        scratch = value.scratch;
      }
    }
  });
  child.stdout.setEncoding("utf8").on("data", (text) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text) => {
    stderr += text;
  });
  let watchdog;
  let failure;
  let outcome;
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  try {
    outcome = await Promise.race([
      exit,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("native reuse runner timed out")), watchdogMs);
      }),
    ]);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await stopOwnedProcess(child.pid, nonce, runner.pathname);
        let exitWatchdog;
        try {
          await Promise.race([
            exit,
            new Promise((_, reject) => {
              exitWatchdog = setTimeout(() => reject(new Error("runner remained live")), 2_000);
            }),
          ]);
        } finally {
          clearTimeout(exitWatchdog);
        }
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await stopOwnedProcess(
        ownedPid,
        nonce,
        resolve(import.meta.dirname, "fixtures/native-write-child.mjs"),
      );
    } catch (error) {
      failure ??= error;
    }
    if (scratch && existsSync(scratch)) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) {
    failure.cleanup = {
      runnerAbsent: child.pid === undefined || absent(child.pid),
      childAbsent: ownedPid === undefined || absent(ownedPid),
      scratchAbsent: scratch === undefined || !existsSync(scratch),
    };
    throw failure;
  }
  return { outcome, stdout, stderr, ownedPid, scratch };
}

test("delayed bounded fs.write never reaches a reused reader descriptor", async () => {
  const { outcome, stdout, stderr, ownedPid, scratch } = await runReuse();
  assert.deepEqual(outcome, { code: 0, signal: null }, stderr || stdout);
  assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 0);
  assert.ok(scratch);
  const result = JSON.parse(stdout.trim());
  expect(result.readerFd).toBe(result.readerReused);
  expect(result.writerFd).not.toBe(result.readerFd);
  expect(result.sentinelBytes).toBe(0);
}, 35_000);

async function expectOwnedFaultCleanup(fault, message) {
  const { outcome, stderr, ownedPid, scratch } = await runReuse(fault);
  assert.deepEqual(outcome, { code: 1, signal: null });
  assert.match(stderr, message);
  assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 0);
  assert.ok(scratch);
  return { outcome, ownedPid, scratch };
}

test("native reuse runner cleans its child and scratch after post-spawn failure", async () => {
  const result = await expectOwnedFaultCleanup("after-spawn", /synthetic post-spawn failure/);
  expect(result).toMatchObject({
    outcome: { code: 1, signal: null },
    ownedPid: expect.any(Number),
  });
}, 35_000);

test("native reuse runner cleans its child and scratch after blocker rejection", async () => {
  const result = await expectOwnedFaultCleanup("blocker", /synthetic blocker failure/);
  expect(result).toMatchObject({ outcome: { code: 1, signal: null }, scratch: expect.any(String) });
}, 35_000);

test("hung reuse runner is retired before the framework deadline", async () => {
  let failure;
  try {
    await runReuse("hang", 250);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    message: "native reuse runner timed out",
    cleanup: { runnerAbsent: true, childAbsent: true, scratchAbsent: true },
  });
}, 35_000);
