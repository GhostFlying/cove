import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

test("stale native addon capability refuses bounded spawn before creating a child", () => {
  const marker = pty.native.coveBoundedWriterVersion;
  try {
    pty.native.coveBoundedWriterVersion = undefined;
    expect(() =>
      pty.spawn("/bin/false", [], {
        boundedWrite: { maxAllocatedBytes: 1, maxTasks: 1 },
      }),
    ).toThrow(/native capability/);
  } finally {
    pty.native.coveBoundedWriterVersion = marker;
  }
});

test("delayed bounded fs.write never reaches a reused reader descriptor", async () => {
  const runner = new URL("./fixtures/native-write-reuse-runner.mjs", import.meta.url);
  const child = spawn(process.execPath, [runner.pathname], {
    cwd: import.meta.dirname,
    env: { ...process.env, UV_THREADPOOL_SIZE: "1" },
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
  const result = JSON.parse(stdout.trim());
  expect(result.readerFd).toBe(result.readerReused);
  expect(result.writerFd).not.toBe(result.readerFd);
  expect(result.sentinelBytes).toBe(0);
});
