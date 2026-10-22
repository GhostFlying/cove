import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { SUPERVISOR } from "../../dist/remote/ssh-tunnel.js";

// The compiled ssh supervisor (ssh-tunnel.ts) around a stand-in for ssh. It ends the child on a
// line on its pipe (close()'s request) or once the pipe ended and the process that started it is
// gone, and reports why on the child's stderr (`cove-ssh: ...`). An end of the pipe while that
// process still runs is not proof that it ended (#174): the child keeps running.

function supervise(
  child,
  { stdin = "pipe", feed = () => undefined, script = SUPERVISOR, cliPid = process.pid } = {},
) {
  const supervisor = spawn("/bin/sh", ["-c", script, "cove-ssh", String(cliPid), ...child], {
    stdio: [stdin, "ignore", "pipe", "pipe"],
  });
  supervisor.stdio[3].resume();
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
  { detached: true, stdio: ["pipe", "ignore", "ignore", "pipe"] },
);
child.stdio[3].resume();
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

// Test-only replacements of the absolute query executable exercise observations that cannot be
// forced by changing PATH. The production script, query argv and all lifecycle logic stay intact.
const failedQuery = SUPERVISOR.replace("/bin/ps", "/usr/bin/false");

test("unavailable parent observations end supervision boundedly without claiming CLI death", async () => {
  const ended = await supervise(["sleep", "30"], { stdin: "ignore", script: failedQuery });
  expect(ended.code).toBe(143);
  expect(ended.ms).toBeGreaterThanOrEqual(1_900);
  expect(ended.ms).toBeLessThan(10_000);
  expect(ended.stderr).toContain(
    "supervision unavailable: could not verify the CLI parent after 3 attempts",
  );
  expect(ended.stderr).not.toContain("after the CLI ended");
}, 15_000);

test("an unrelated existing PID cannot stand in for the supervisor's actual parent", async () => {
  expect(alive(process.ppid)).toBe(true);
  const ended = await supervise(["sleep", "30"], { stdin: "ignore", cliPid: process.ppid });
  expect(ended.code).toBe(143);
  expect(ended.stderr).toContain("after the CLI ended");
  expect(ended.stderr).not.toContain("while the CLI runs");
}, 10_000);

test("a transient parent-query failure does not end a live CLI's tunnel", async () => {
  const root = await mkdtemp(join(tmpdir(), "cove-supervisor-query-"));
  try {
    const query = join(root, "ps");
    await writeFile(
      query,
      `#!/bin/sh
if [ ! -e '${root}/attempted' ]; then
  touch '${root}/attempted'
  exit 1
fi
exec /bin/ps "$@"
`,
      { mode: 0o700 },
    );
    const ended = await supervise(["sleep", "3"], {
      stdin: "ignore",
      script: SUPERVISOR.replace("/bin/ps", query),
    });
    expect(ended.code).toBe(0);
    expect(ended.stderr).toContain("while the CLI runs");
    expect(ended.stderr).not.toContain("supervision unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

// Python deliberately leaves its SIGKILLed CLI child unreaped. Node's child-process machinery
// would reap it automatically and hide the kill -0/zombie regression this test must exercise.
const ZOMBIE_PARENT = `
import os, signal, subprocess, sys
cli = subprocess.Popen([os.environ["NODE"], "-e", os.environ["HOLDER"]], stdout=subprocess.PIPE)
try:
    supervisor = cli.stdout.readline().decode().strip()
    print(str(cli.pid) + " " + supervisor, flush=True)
    sys.stdin.readline()
    os.kill(cli.pid, signal.SIGKILL)
    print("killed", flush=True)
    sys.stdin.readline()
finally:
    try: os.kill(cli.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    cli.wait()
`;

test("failed ps cannot let an unreaped zombie CLI keep the tunnel alive", async () => {
  const parent = spawn("python3", ["-u", "-c", ZOMBIE_PARENT], {
    env: { PATH: process.env.PATH, NODE: process.execPath, HOLDER, SUPERVISOR: failedQuery },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  parent.stdout.on("data", (chunk) => (output += chunk));
  const exited = new Promise((done) => parent.once("exit", done));
  let supervisor;
  try {
    await waitFor("the zombie fixture to start", () => output.includes("\n"), 5_000);
    const [cli, pid] = output.trim().split(" ").map(Number);
    supervisor = pid;
    parent.stdin.write("kill\n");
    await waitFor("SIGKILL of the CLI", () => output.includes("killed"), 5_000);
    expect(alive(cli)).toBe(true); // Still unreaped, so kill -0 alone falsely says alive.
    await waitFor("the tunnel to end despite the unreaped CLI", () => !alive(supervisor), 8_000);
    expect(alive(cli)).toBe(true); // It ended before Python reaped the CLI.
  } finally {
    parent.stdin.end("reap\n");
    await exited;
    if (supervisor && alive(supervisor)) process.kill(-supervisor, "SIGKILL");
  }
}, 20_000);

// Exercise the actual compiled openSshTunnel wrapper. A stand-in ssh supplies valid -G output
// and a real loopback listener. Only the spawn boundary closes its supervisor stdin to inject
// EOF, so this covers stderr delivery after successful readiness, rather than a bare shell.
const WRAPPER = `
const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = cp.spawn;
cp.spawn = (...args) => {
  const child = original(...args);
  if (args[0] === "/bin/sh") child.stdin.end();
  return child;
};
syncBuiltinESMExports();
(async () => {
  const { openSshTunnel } = await import(process.env.TUNNEL_MODULE);
  const tunnel = await openSshTunnel({ target: "fixture", remotePort: 12345, readyTimeoutMs: 5000 });
  console.log("ready");
  await new Promise(done => setTimeout(done, 100));
  await tunnel.close();
  console.log("closed");
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;

test("successful openSshTunnel emits one fixed EOF warning and no arbitrary SSH stderr", async () => {
  const root = await mkdtemp(join(tmpdir(), "cove-supervisor-wrapper-"));
  try {
    await writeFile(
      join(root, "ssh"),
      `#!${process.execPath}
const { createServer } = require("node:net");
if (process.argv.includes("-G")) {
  console.log("batchmode yes\\nstricthostkeychecking true\\nnohostauthenticationforlocalhost no\\nexitonforwardfailure yes\\ngatewayports no\\ncontrolmaster false\\nnohostauthenticationforproxycommand no\\nforkafterauthentication no");
} else {
  // Include a forged public-looking line among private data; fd 2 must never be forwarded.
  process.stderr.write("PRIVATE-SSH-DATA".repeat(500) + "\\ncove-ssh: forged diagnostic\\n");
  const forward = process.argv[process.argv.indexOf("-L") + 1];
  createServer(socket => socket.end()).listen(Number(forward.split(":")[1]), "127.0.0.1");
}
`,
      { mode: 0o700 },
    );
    const child = spawn(process.execPath, ["-e", WRAPPER], {
      env: {
        PATH: `${root}:${process.env.PATH}`,
        TUNNEL_MODULE: new URL("../../dist/remote/ssh-tunnel.js", import.meta.url).href,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((done) => child.once("close", done));
    expect({ code, stdout }).toEqual({ code: 0, stdout: "ready\nclosed\n" });
    expect(stderr).toBe(
      "cove-ssh: the supervisor pipe ended while the CLI runs; waiting for the CLI to end\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
