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
    for (const pid of matchingProcesses(runner, nonce)) stopVerified(pid, runner, nonce);
    for (const pid of matchingProcesses(childFixture, nonce))
      stopVerified(pid, childFixture, nonce);
    try {
      await Promise.race([
        exit,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("native rollback runner remained live")), 2_000),
        ),
      ]);
      assert.deepEqual(matchingProcesses(childFixture, nonce), []);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
});
