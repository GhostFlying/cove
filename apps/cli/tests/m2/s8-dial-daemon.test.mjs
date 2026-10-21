import { lstat, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import {
  alive,
  cliEnv,
  CURRENT_BUILD,
  daemonHello,
  endDaemon,
  modeOf,
  OTHER_BUILD,
  removeRoot,
  runCove,
  runCoveJson,
  shortRoot,
  socketOf,
  spawnDaemon,
  tsnetBuilds,
} from "./tsnet-fixtures.mjs";

// m2 S8 (D14), the dial daemon's lifecycle as the CLI drives it, with the real cove-tsnet (built
// by tsnet-fixtures.mjs). None of these needs a tailnet: a daemon without node state never
// contacts a control plane, and the CLI's start loop, takeover and version rules are the same with
// or without one (s8-tsnet-tailnet covers streams and login).
//
// Startup races use cove-tsnet's test pause points (`--debug-pause-at`, PROTOCOL.md): a daemon this
// test starts stops itself (SIGSTOP) holding the lock, either before it listens (`locked`: a race
// winner that is not ready yet) or after it unlinked its socket while exiting (`unlinked`). The test
// then continues or kills it while a CLI command waits inside its start deadline.

let builds;
let root;
let home;
let env;
const started = [];

beforeAll(async () => {
  builds = await tsnetBuilds();
}, 600_000);

beforeEach(async () => {
  root = await shortRoot("ct4d");
  home = join(root, "c");
  env = cliEnv(root, { COVE_TSNET_BINARY: builds.current });
});

afterEach(async () => {
  for (const daemon of started.splice(0)) {
    daemon.child.kill("SIGCONT");
    daemon.child.kill("SIGKILL");
    await daemon.exited;
  }
  await endDaemon(home);
  await removeRoot(root);
});

const status = () => runCove(env, home, ["remote", "tsnet", "status"]);

function paused(args) {
  const daemon = spawnDaemon(builds.current, home, null, args);
  started.push(daemon);
  return daemon;
}

async function pausedAt(point, extra = []) {
  const daemon = paused(["--debug-pause-at", point, ...extra]);
  await waitFor(
    `the daemon to pause at ${point}`,
    () => daemon.stderr().includes(`debug pause at ${point}`),
    15_000,
  );
  return daemon;
}

test("concurrent commands start one daemon, in the private layout, which exits when idle and removes its socket", async () => {
  await runCoveJson(env, home, ["remote", "tsnet", "config", "--idle-timeout", "3s"]);
  const results = await Promise.all(Array.from({ length: 5 }, () => status()));
  for (const result of results) expect(result).toMatchObject({ code: 0 });
  const pids = new Set(results.map((result) => JSON.parse(result.stdout).daemon.pid));
  expect(pids.size).toBe(1);
  const [pid] = pids;
  for (const result of results)
    expect(JSON.parse(result.stdout)).toMatchObject({
      state: "LoggedOut",
      daemon: { build: CURRENT_BUILD, protocol: 1 },
    });
  // Whichever commands lost the start race, exactly one daemon ever listened.
  const log = await readFile(join(home, "tsnet-client", "run", "dial.log"), "utf8");
  expect(log.match(/dial: listening/g)).toHaveLength(1);

  const tsnetHome = join(home, "tsnet-client");
  expect(await modeOf(tsnetHome)).toBe(0o700);
  expect(await modeOf(join(tsnetHome, "run"))).toBe(0o700);
  expect((await lstat(socketOf(home))).mode & 0o777).toBe(0o600);
  expect(await modeOf(join(tsnetHome, "run", "lock"))).toBe(0o600);
  expect(await modeOf(join(tsnetHome, "run", "dial.log"))).toBe(0o600);
  expect(await modeOf(join(home, "client", "tsnet.json"))).toBe(0o600);

  // The configured idle timeout: the daemon exits by itself and removes its socket.
  await waitFor("the idle daemon to exit", () => !alive(pid), 15_000);
  await expect(lstat(socketOf(home))).rejects.toMatchObject({ code: "ENOENT" });
}, 60_000);

test("a socket left by a killed daemon does not stop the next command, which takes over in bounded time", async () => {
  const first = JSON.parse((await status()).stdout).daemon.pid;
  process.kill(first, "SIGKILL");
  await waitFor("the daemon to die", () => !alive(first), 5_000);
  // The socket file is left behind; nothing listens on it.
  expect((await lstat(socketOf(home))).isSocket()).toBe(true);
  const next = await status();
  expect(next.code).toBe(0);
  const second = JSON.parse(next.stdout).daemon.pid;
  expect(second).not.toBe(first);
  expect(next.elapsedMs).toBeLessThan(10_000);
}, 60_000);

test("a command started while a daemon is between unlinking its socket and releasing its lock connects to the next daemon", async () => {
  const exiting = await pausedAt("unlinked", ["--idle-timeout", "1s"]);
  // Socket gone, lock still held: the CLI's daemons lose the lock (75) until the old one exits.
  await expect(lstat(socketOf(home))).rejects.toMatchObject({ code: "ENOENT" });
  const command = status();
  await new Promise((done) => setTimeout(done, 1_500));
  exiting.child.kill("SIGCONT");
  expect(await exiting.exited).toEqual({ code: 0, signal: null });
  const result = await command;
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).daemon.pid).not.toBe(exiting.pid);
  expect(result.elapsedMs).toBeLessThan(10_000);
}, 60_000);

test("when the start race winner dies before it is ready, a waiting command starts another within its deadline", async () => {
  const winner = await pausedAt("locked");
  const command = status();
  await new Promise((done) => setTimeout(done, 1_500));
  winner.child.kill("SIGKILL");
  expect((await winner.exited).signal).toBe("SIGKILL");
  const result = await command;
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).daemon.pid).not.toBe(winner.pid);
  expect(result.elapsedMs).toBeLessThan(10_000);
}, 60_000);

test("when no daemon becomes ready within the deadline the command fails with ENTRY_UNAVAILABLE", async () => {
  // A daemon holding the lock forever without listening.
  const stuck = await pausedAt("locked");
  const result = await status();
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("did not become ready within 10 s");
  expect(result.stderr).toContain("ENTRY_UNAVAILABLE");
  expect(result.stderr).toContain("nothing was done");
  // The diagnostic output names why the CLI's own daemons could not start.
  expect(result.stderr).toContain("another dial daemon owns this directory");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(10_000);
  expect(result.elapsedMs).toBeLessThan(20_000);
  expect(alive(stuck.pid)).toBe(true);
}, 60_000);

test("an idle daemon of another build is replaced by the current build; stop never starts one", async () => {
  const old = spawnDaemon(builds.other, home, null);
  started.push(old);
  await waitFor("the old daemon", async () => (await daemonHello(home))?.pid === old.pid, 10_000);
  expect((await daemonHello(home)).build).toBe(OTHER_BUILD);
  const result = await status();
  expect(result.code).toBe(0);
  expect(result.stderr).not.toContain("warning");
  const daemon = JSON.parse(result.stdout).daemon;
  expect(daemon.build).toBe(CURRENT_BUILD);
  expect(daemon.pid).not.toBe(old.pid);
  // The old daemon was asked to stop and exited normally, keeping nothing running.
  expect(await old.exited).toEqual({ code: 0, signal: null });

  const stopped = await runCoveJson(env, home, ["remote", "tsnet", "stop"]);
  expect(stopped).toMatchObject({ running: false, stopped: { pid: daemon.pid } });
  await waitFor("the daemon to exit", () => !alive(daemon.pid), 10_000);
  expect(await runCoveJson(env, home, ["remote", "tsnet", "stop"])).toEqual({ running: false });
  // Nothing was started by the second stop.
  expect(await daemonHello(home)).toBeNull();
  await expect(stat(socketOf(home))).rejects.toMatchObject({ code: "ENOENT" });
}, 60_000);
