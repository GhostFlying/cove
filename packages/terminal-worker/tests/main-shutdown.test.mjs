import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("compiled main reports completed abnormal shutdown without a native owner", async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../dist/src/main.js", import.meta.url))],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stderr = [];
  child.stderr.on("data", (bytes) => stderr.push(Buffer.from(bytes)));
  const timeout = setTimeout(() => child.kill(), 5_000);
  try {
    child.stdin.end(Buffer.alloc(16));
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (...status) => resolve(status));
    });
    const diagnostic = Buffer.concat(stderr).toString("utf8");
    expect({ code, signal }).toEqual({ code: 1, signal: null });
    expect(diagnostic).toMatch(
      /^worker-shutdown reason=decode-[A-Za-z0-9_-]+ disposal-complete=0 disposal-uncertain=0\n$/,
    );
    expect(Buffer.byteLength(diagnostic)).toBeLessThan(1024);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
