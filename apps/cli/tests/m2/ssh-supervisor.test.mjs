import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { SUPERVISOR } from "../../dist/remote/ssh-tunnel.js";

// The compiled ssh supervisor (ssh-tunnel.ts) around a stand-in for ssh. It ends the child on a
// line on its pipe (close()'s request) or once the pipe ended and the process that started it is
// gone, and reports why on the child's stderr (`cove-ssh: ...`). An end of the pipe while that
// process still runs is not proof that it ended (#174): the child keeps running.

function supervise(child, { stdin = "pipe", feed = () => undefined } = {}) {
  const supervisor = spawn("/bin/sh", ["-c", SUPERVISOR, "cove-ssh", ...child], {
    stdio: [stdin, "ignore", "pipe"],
  });
  let stderr = "";
  supervisor.stderr.setEncoding("utf8");
  supervisor.stderr.on("data", (chunk) => (stderr += chunk));
  const started = Date.now();
  const exited = new Promise((done) =>
    supervisor.once("exit", (code) => done({ code, ms: Date.now() - started })),
  );
  if (supervisor.stdin) feed(supervisor.stdin);
  return exited.then((result) => ({ ...result, stderr }));
}

test("a line on the pipe ends the child at once and names it", async () => {
  const line = await supervise(["sleep", "30"], {
    feed: (stdin) => setTimeout(() => stdin.end("stop\n"), 200),
  });
  expect(line.code).toBe(143);
  expect(line.stderr).toBe("cove-ssh: ending ssh after a line on the supervisor pipe\n");
  expect(line.ms).toBeLessThan(10_000);
}, 30_000);

test("an end of the pipe while its process runs does not end the child (#174)", async () => {
  // The pipe ends without a line, from the start (stdin is /dev/null: the reader reads an
  // end-of-file at once, as in #174) and after a while; this test process, the supervisor's
  // parent, still runs. The child completes on its own (status 0) instead of being ended (143).
  for (const options of [
    { stdin: "ignore" },
    { feed: (stdin) => setTimeout(() => stdin.end(), 200) },
  ]) {
    const ended = await supervise(["sleep", "2"], options);
    expect(ended.code).toBe(0);
    expect(ended.ms).toBeGreaterThanOrEqual(1_900);
    expect(ended.stderr).toBe(
      "cove-ssh: the supervisor pipe ended (read status 1) while the CLI runs; " +
        "waiting for the CLI to end\n",
    );
  }
}, 30_000);

// A process (standing in for the CLI) that starts the supervisor around `sleep 30` in a group of
// its own, as ssh-tunnel.ts does, writes the supervisor's PID and waits.
const HOLDER = `
const { spawn } = require("node:child_process");
const child = spawn("/bin/sh", ["-c", process.env.SUPERVISOR, "cove-ssh", "sleep", "30"], {
  detached: true,
  stdio: ["pipe", "ignore", "ignore"],
});
process.stdout.write(child.pid + "\\n");
setInterval(() => undefined, 1000);
`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the end of the process that started it ends the child", async () => {
  const holder = spawn(process.execPath, ["-e", HOLDER], {
    env: { ...process.env, SUPERVISOR },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  holder.stdout.on("data", (chunk) => (output += chunk));
  await waitFor("the holder to start the supervisor", () => output.includes("\n"), 10_000);
  const supervisor = Number(output.trim());
  expect(alive(supervisor)).toBe(true);
  try {
    // SIGKILL: the holder cannot close anything itself; its pipe ends with it, and the supervisor
    // is no longer its child.
    holder.kill("SIGKILL");
    await waitFor("the supervisor to end its child and exit", () => !alive(supervisor), 10_000);
    expect(alive(supervisor)).toBe(false);
  } finally {
    if (alive(supervisor)) process.kill(-supervisor, "SIGKILL");
  }
}, 30_000);
