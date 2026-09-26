import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const runner = fileURLToPath(new URL("./fixtures/native-write-churn-runner.mjs", import.meta.url));

function absent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}

function stopVerified(pid, expected, nonce) {
  if (!pid || absent(pid)) return;
  const inspected = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (absent(pid)) return;
  if (
    inspected.error ||
    inspected.status !== 0 ||
    !inspected.stdout.includes(expected) ||
    !inspected.stdout.includes(nonce)
  )
    throw new Error(`churn process ${pid} identity unverifiable`);
  process.kill(pid, "SIGKILL");
}

async function runChurn(fault, watchdogMs) {
  const nonce = randomUUID();
  const child = spawn(process.execPath, [runner, nonce], {
    cwd: import.meta.dirname,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, COVE_N1_CHURN_FAULT: fault ?? "" },
  });
  const owned = new Map();
  child.on("message", (value) => {
    if (value?.nonce === nonce && Number.isSafeInteger(value.pid) && value.pid > 0)
      owned.set(value.pid, value.executable);
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text) => {
    stderr += text;
  });
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let watchdog;
  let failure;
  let outcome;
  try {
    outcome = await Promise.race([
      exit,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("churn runner timed out")), watchdogMs);
      }),
    ]);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(watchdog);
    try {
      stopVerified(child.pid, runner, nonce);
    } catch (error) {
      failure ??= error;
    }
    for (const [pid, executable] of owned) {
      try {
        stopVerified(pid, executable, nonce);
      } catch (error) {
        failure ??= error;
      }
    }
    let cleanupWatchdog;
    try {
      await Promise.race([
        exit,
        new Promise((_, reject) => {
          cleanupWatchdog = setTimeout(
            () => reject(new Error("churn runner remained live")),
            2_000,
          );
        }),
      ]);
      const deadline = Date.now() + 2_000;
      while ([...owned.keys()].some((pid) => !absent(pid))) {
        if (Date.now() >= deadline) {
          failure ??= new Error("churn child remained live");
          break;
        }
        await new Promise((done) => setTimeout(done, 10));
      }
    } catch (error) {
      failure ??= error;
    } finally {
      clearTimeout(cleanupWatchdog);
    }
  }
  if (failure) {
    failure.cleanup = {
      runnerAbsent: child.pid === undefined || absent(child.pid),
      childrenAbsent: [...owned.keys()].every(absent),
    };
    throw failure;
  }
  return { outcome, stdout, stderr };
}

test("finite real PTY churn closes bounded and legacy parent descriptors", async () => {
  const { outcome, stdout, stderr } = await runChurn("", 10_000);
  assert.deepEqual(outcome, { code: 0, signal: null }, stderr || stdout);
  const { counts } = JSON.parse(stdout.trim());
  expect(counts.bounded.after).toBe(counts.bounded.baseline);
  expect(counts.legacy.after).toBe(counts.legacy.baseline);
  if (process.platform === "darwin")
    assert.equal(counts.failedSpawn.after, counts.failedSpawn.baseline);
}, 45_000);

test("hung churn completion retires the owned runner before the framework deadline", async () => {
  let failure;
  try {
    await runChurn("hang-completion", 250);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    message: "churn runner timed out",
    cleanup: { runnerAbsent: true, childrenAbsent: true },
  });
}, 45_000);
