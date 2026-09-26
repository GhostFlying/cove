import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "vitest";

function matchingProcesses(fixture, nonce) {
  const inspected = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(inspected.status, 0, String(inspected.error ?? inspected.stderr));
  return inspected.stdout
    .split("\n")
    .filter((line) => line.includes(fixture) && line.includes(nonce))
    .map((line) => Number.parseInt(line.trim(), 10));
}

function stopVerified(pid, fixture, nonce) {
  const inspected = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (inspected.status !== 0) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    throw new Error(`owned process ${pid} identity unverifiable`);
  }
  if (!inspected.stdout.includes(fixture) || !inspected.stdout.includes(nonce)) {
    throw new Error(`owned process ${pid} identity changed`);
  }
  process.kill(pid, "SIGKILL");
}

function cleanupOwnedProcesses(
  fixtures,
  nonce,
  recordFailure,
  discover = matchingProcesses,
  stop = stopVerified,
) {
  for (const fixture of fixtures) {
    let pids = [];
    try {
      pids = discover(fixture, nonce);
    } catch (error) {
      recordFailure(error);
    }
    for (const pid of pids) {
      try {
        stop(pid, fixture, nonce);
      } catch (error) {
        recordFailure(error);
      }
    }
  }
}

test("owned cleanup keeps the first failure and attempts the other fixture after inspection fails", () => {
  const primary = new Error("primary rollback failure");
  const inspected = [];
  const stopped = [];
  let failure = primary;
  cleanupOwnedProcesses(
    ["runner", "child"],
    "owned-nonce",
    (error) => {
      failure ??= error;
    },
    (fixture) => {
      inspected.push(fixture);
      if (fixture === "runner") throw new Error("ps unavailable");
      return [123];
    },
    (pid, fixture) => stopped.push([pid, fixture]),
  );
  assert.equal(failure, primary);
  assert.deepEqual(inspected, ["runner", "child"]);
  assert.deepEqual(stopped, [[123, "child"]]);

  const attempted = [];
  cleanupOwnedProcesses(
    ["runner", "child"],
    "owned-nonce",
    (error) => {
      failure ??= error;
    },
    (fixture) => (fixture === "runner" ? [111, 112] : [123]),
    (pid) => {
      attempted.push(pid);
      if (pid === 111) throw new Error("identity unverifiable");
    },
  );
  assert.equal(failure, primary);
  assert.deepEqual(attempted, [111, 112, 123]);
});

test("native duplicate and watcher failure phases leave no owned descriptors or child", async () => {
  const runner = resolve(import.meta.dirname, "fixtures/native-write-fault-runner.mjs");
  const childFixture = resolve(import.meta.dirname, "fixtures/native-write-child.mjs");
  const nonce = randomUUID();
  const child = spawn(process.execPath, [runner, nonce], {
    cwd: import.meta.dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let watchdog;
  let failure;
  try {
    const result = await Promise.race([
      exit,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("native rollback runner timed out")), 15_000);
      }),
    ]);
    assert.deepEqual(result, { code: 0, signal: null }, stderr || stdout);
    expect(JSON.parse(stdout.trim())).toMatchObject({ platform: process.platform, phases: 3 });
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(watchdog);
    const recordFailure = (error) => {
      failure ??= error;
    };
    cleanupOwnedProcesses([runner, childFixture], nonce, recordFailure);
    let exitWatchdog;
    try {
      await Promise.race([
        exit,
        new Promise((_, reject) => {
          exitWatchdog = setTimeout(
            () => reject(new Error("native rollback runner remained live")),
            2_000,
          );
        }),
      ]);
    } catch (error) {
      recordFailure(error);
    } finally {
      clearTimeout(exitWatchdog);
    }
    try {
      assert.deepEqual(matchingProcesses(runner, nonce), []);
    } catch (error) {
      recordFailure(error);
    }
    try {
      assert.deepEqual(matchingProcesses(childFixture, nonce), []);
    } catch (error) {
      recordFailure(error);
    }
  }
  if (failure) throw failure;
}, 35_000);
