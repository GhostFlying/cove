import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import { SUPERVISOR } from "../../dist/remote/ssh-tunnel.js";

// The compiled ssh supervisor (ssh-tunnel.ts) around a stand-in for ssh: when its reader ends the
// child it reports why on the child's stderr (`cove-ssh: ...`), so an SSH entry that fails because
// the supervisor pipe ended or carried a line names that cause instead of a bare status 143.

function supervise(feed) {
  const child = spawn("/bin/sh", ["-c", SUPERVISOR, "cove-ssh", "sleep", "30"], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((done) => child.once("exit", (code) => done(code)));
  feed(child.stdin);
  return exited.then((code) => ({ code, stderr }));
}

test("the supervisor names the end of its pipe or a line on it before it ends the child", async () => {
  const ended = await supervise((stdin) => setTimeout(() => stdin.end(), 200));
  expect(ended.code).toBe(143);
  expect(ended.stderr).toMatch(
    /^cove-ssh: ending ssh after the end of the supervisor pipe or a read error \(read status [1-9][0-9]*\)\n$/,
  );

  const line = await supervise((stdin) => setTimeout(() => stdin.write("x\n"), 200));
  expect(line.code).toBe(143);
  expect(line.stderr).toBe("cove-ssh: ending ssh after a line on the supervisor pipe\n");
}, 30_000);
