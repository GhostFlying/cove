import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { expect, test } from "vitest";

test("finite real PTY churn closes bounded and legacy parent descriptors", async () => {
  const runner = new URL("./fixtures/native-write-churn-runner.mjs", import.meta.url);
  const child = spawn(process.execPath, [runner.pathname], {
    cwd: import.meta.dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text) => {
    stderr += text;
  });
  const exit = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  assert.deepEqual(exit, { code: 0, signal: null }, stderr || stdout);
  const { counts } = JSON.parse(stdout.trim());
  expect(counts.bounded.after).toBe(counts.bounded.baseline);
  expect(counts.legacy.after).toBe(counts.legacy.baseline);
  if (process.platform === "darwin") {
    expect(counts.failedSpawn.after).toBe(counts.failedSpawn.baseline);
  }
});
