import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { SUPERVISOR } from "../../dist/remote/ssh-tunnel.js";

// The compiled ssh supervisor (ssh-tunnel.ts) around a stand-in for ssh. It ends the child on a
// line on its pipe (close()'s request) or once the pipe ended and the process that started it is
// gone, and reports why on the child's stderr (`cove-ssh: ...`). An end of the pipe while that
// process still runs is not proof that it ended (#174): the child keeps running.

function supervise(child, { stdin = "pipe", feed = () => undefined } = {}) {
  const supervisor = spawn(
    "/bin/sh",
    ["-c", SUPERVISOR, "cove-ssh", String(process.pid), ...child],
    {
      stdio: [stdin, "ignore", "pipe"],
    },
  );
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
// its own, as ssh-tunnel.ts does, writes the supervisor's PID and then waits, or (IMMEDIATE) kills
// itself at once, before the supervisor's shell has started.
const HOLDER = `
const { spawn } = require("node:child_process");
const { writeSync } = require("node:fs");
const child = spawn(
  "/bin/sh",
  ["-c", process.env.SUPERVISOR, "cove-ssh", String(process.pid), "sleep", "30"],
  { detached: true, stdio: ["pipe", "ignore", "ignore"] },
);
writeSync(1, child.pid + "\\n");
if (process.env.IMMEDIATE) process.kill(process.pid, "SIGKILL");
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

// Starts a holder, SIGKILLs it (unless it killed itself at once) and reports whether the
// supervisor ran before and whether it exited within 10 s after.
async function holderDies(immediate) {
  const holder = spawn(process.execPath, ["-e", HOLDER], {
    // Neither the holder nor the supervisor runs Cove; they need only PATH (for `sleep`).
    env: { PATH: process.env.PATH, SUPERVISOR, IMMEDIATE: immediate ? "1" : "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  holder.stdout.on("data", (chunk) => (output += chunk));
  await waitFor("the holder to start the supervisor", () => output.includes("\n"), 10_000);
  const supervisor = Number(output.trim());
  const ranBefore = immediate || alive(supervisor);
  try {
    // SIGKILL: the holder cannot close anything itself; its pipe ends with it, and the supervisor
    // is no longer its child.
    if (!immediate) holder.kill("SIGKILL");
    const deadline = Date.now() + 10_000;
    while (alive(supervisor) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 50));
    return { ranBefore, ended: !alive(supervisor) };
  } finally {
    if (alive(supervisor)) process.kill(-supervisor, "SIGKILL");
  }
}

test("the end of the process that started it ends the child", async () => {
  expect(await holderDies(false)).toEqual({ ranBefore: true, ended: true });
}, 30_000);

test("a process that dies before the supervisor's shell starts still ends the child", async () => {
  // The shell's own $PPID would already name the new parent here; the PID it is given does not.
  expect(await holderDies(true)).toEqual({ ranBefore: true, ended: true });
}, 30_000);
