import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { saveServer } from "../../dist/remote/credentials.js";
import { waitFor } from "../recording-view.mjs";
import {
  alive,
  cliEnv,
  daemonHello,
  endDaemon,
  removeRoot,
  runCove,
  shortRoot,
} from "./tsnet-fixtures.mjs";

// m2 S8 (D14), the CLI's side of the dial-socket protocol against a scripted daemon
// (tsnet-fake-dial.mjs), for the answers a real daemon on a test tailnet cannot be made to give:
// a daemon of an incompatible local protocol that carries streams, one of a compatible other
// build with streams, identity holds after a login, a logout the control plane did not confirm,
// and a server node address that answers WhoIs as another node. The real daemon's own behavior
// is covered by s8-dial-daemon and s8-tsnet-tailnet.

const fake = resolve(import.meta.dirname, "tsnet-fake-dial.mjs");
const STREAM = {
  id: "s7",
  stableNodeID: "nSERVER1",
  port: 7443,
  label: "box (cove pid 4242)",
  startedAt: "2026-10-22T09:00:00Z",
};
const KEY = "tskey-auth-fake-0123456789abcdef";

let root;
let home;
let configPath;
let eventsPath;
let env;
let wrapper;
const daemons = [];

// What the CLI's binary reports (`version`) and, for daemons the CLI starts, how they answer.
async function configure(settings) {
  await writeFile(configPath, JSON.stringify({ events: eventsPath, ...settings }));
}

async function events() {
  const text = await readFile(eventsPath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// A fake daemon this test starts itself, answering as `settings` say, while the CLI's binary
// reports the settings `configure` wrote: a daemon of another build than the CLI would start.
async function runningDaemon(settings) {
  const daemonConfig = join(root, "daemon.json");
  await writeFile(daemonConfig, JSON.stringify({ events: eventsPath, ...settings }));
  const child = spawn(wrapper, ["dial", "--home", join(home, "tsnet-client")], {
    env: { ...env, COVE_TEST_FAKE_DIAL: daemonConfig },
    stdio: "ignore",
  });
  daemons.push(child);
  await waitFor("the fake daemon", async () => (await daemonHello(home)) !== null, 10_000);
  return (await daemonHello(home)).pid;
}

beforeEach(async () => {
  root = await shortRoot("ct4p");
  home = join(root, "c");
  configPath = join(root, "fake.json");
  eventsPath = join(root, "events.jsonl");
  // The CLI starts the fake as it starts cove-tsnet: an executable at COVE_TSNET_BINARY.
  wrapper = join(root, "cove-tsnet");
  await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`);
  await chmod(wrapper, 0o755);
  env = cliEnv(root, { COVE_TSNET_BINARY: wrapper, COVE_TEST_FAKE_DIAL: configPath });
});

afterEach(async () => {
  await endDaemon(home);
  for (const child of daemons.splice(0)) child.kill("SIGKILL");
  await removeRoot(root);
});

const tsnet = (...args) => runCove(env, home, ["remote", "tsnet", ...args]);
const login = (input) => runCove(env, home, ["remote", "tsnet", "login"], { input });

test("a daemon of another local protocol with active streams is kept and the command fails listing them", async () => {
  await configure({ build: "0.0.0-new", protocol: 1 });
  const pid = await runningDaemon({ build: "0.0.0-old", protocol: 2, streams: [STREAM] });
  const result = await tsnet("status");
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("local protocol 2, which this CLI (protocol 1) cannot use");
  expect(result.stderr).toContain("s7 to nSERVER1:7443 (box (cove pid 4242))");
  expect(result.stderr).toContain("cove remote tsnet stop --yes");
  expect(result.stderr).toContain("ENTRY_UNAVAILABLE");
  // Not replaced, not asked to stop: the failed command requested nothing of it.
  expect(alive(pid)).toBe(true);
  expect((await daemonHello(home)).pid).toBe(pid);
  expect(await events()).toEqual([]);
}, 60_000);

test("a compatible daemon of another build with active streams is used with a warning, never replaced", async () => {
  await configure({ build: "0.0.0-new", protocol: 1 });
  const pid = await runningDaemon({ build: "0.0.0-old", protocol: 1, streams: [STREAM] });
  const result = await tsnet("status");
  expect(result.code).toBe(0);
  expect(result.stderr).toContain(
    `warning: the tsnet dial daemon (pid ${pid}) runs build 0.0.0-old, not 0.0.0-new`,
  );
  expect(result.stderr).toContain("1 active stream(s)");
  expect(JSON.parse(result.stdout).daemon).toEqual({ pid, build: "0.0.0-old", protocol: 1 });
  expect(alive(pid)).toBe(true);
  expect((await events()).map((event) => event.op)).toEqual(["status"]);
}, 60_000);

test("identity holds after a login are reported, not success", async () => {
  await configure({
    build: "b1",
    protocol: 1,
    answers: {
      login: {
        ok: false,
        error: {
          code: "IDENTITY_CHANGED",
          message: "enrolled as nOLD, logged in as nNEW; paired clients must pair again",
        },
      },
    },
  });
  const changed = await login(`${KEY}\n`);
  expect(changed.code).toBe(1);
  expect(changed.stderr).toContain("IDENTITY_CHANGED");
  expect(changed.stderr).toContain("enrolled as nOLD, logged in as nNEW");
  expect(changed.stderr).toContain("cove remote tsnet logout");

  await configure({
    build: "b1",
    protocol: 1,
    answers: {
      login: {
        ok: false,
        error: { code: "LOGIN_UNCERTAIN", message: "login timed out; it may still complete" },
      },
    },
  });
  const uncertain = await login(`${KEY}\n`);
  expect(uncertain.code).toBe(1);
  expect(uncertain.stderr).toContain("may still have completed (LOGIN_UNCERTAIN)");

  // A status under a hold says so on stderr and in the JSON.
  await configure({
    build: "b1",
    protocol: 1,
    answers: {
      status: {
        ok: true,
        result: {
          state: "Stopped",
          hold: "IDENTITY_CHANGED",
          self: { stableNodeID: "nNEW" },
          warnings: ["this node was enrolled as nOLD and is now nNEW"],
        },
      },
    },
  });
  const held = await tsnet("status");
  expect(held.code).toBe(0);
  expect(JSON.parse(held.stdout)).toMatchObject({ hold: "IDENTITY_CHANGED", state: "Stopped" });
  expect(held.stderr).toContain("held (IDENTITY_CHANGED)");

  // The key went to the daemon only inside the login request: never in output or its records.
  const logins = (await events()).filter((event) => event.op === "login");
  expect(logins).toHaveLength(2);
  expect(logins.every((event) => event.authKey)).toBe(true);
  for (const text of [changed.stdout, changed.stderr, uncertain.stdout, uncertain.stderr])
    expect(text).not.toContain(KEY);
  expect(await readFile(eventsPath, "utf8")).not.toContain(KEY);
}, 60_000);

test("a logout the control plane did not confirm is reported as such", async () => {
  await configure({
    build: "b1",
    protocol: 1,
    answers: {
      logout: {
        ok: true,
        result: {
          state: "LoggedOut",
          remoteLogoutConfirmed: false,
          warnings: [
            "the control plane could not be reached; remove the node in the admin console",
          ],
        },
      },
    },
  });
  const result = await tsnet("logout");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    state: "LoggedOut",
    remoteLogoutConfirmed: false,
  });
  expect(result.stderr).toContain("did not confirm the logout");

  await configure({
    build: "b1",
    protocol: 1,
    answers: {
      logout: {
        ok: false,
        error: { code: "ACTIVE_STREAMS", message: "1 stream open", streams: [STREAM] },
      },
    },
  });
  const refused = await tsnet("logout");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("ACTIVE_STREAMS");
  expect(refused.stderr).toContain("s7 to nSERVER1:7443");
  expect(refused.stderr).toContain("cove remote tsnet logout --yes");
  expect((await events()).map((event) => [event.op, event.force])).toEqual([
    ["logout", false],
    ["logout", false],
  ]);
}, 60_000);

test("a server node address that answers as another node is refused before anything is sent", async () => {
  // A paired record with a tsnet entry; its token must never leave this host in this case.
  await saveServer(home, {
    version: 1,
    alias: "box",
    serverId: "srv-fake-1",
    deviceId: "dev1",
    token: `cove_d1_dev1.${"A".repeat(43)}`,
    defaultEntry: "tsnet",
    entries: { tsnet: { nodeId: "nSERVER1", name: "cove-srv.tail-scale.ts.net", port: 7443 } },
    pairedAtMs: Date.now(),
  });
  const received = [];
  const target = createServer((socket) => socket.on("data", (chunk) => received.push(chunk)));
  await new Promise((done) => target.listen(0, "127.0.0.1", done));
  try {
    await configure({
      build: "b1",
      protocol: 1,
      delayMs: 300,
      dialForward: target.address().port,
      answers: {
        dial: {
          ok: false,
          error: { code: "PEER_MISMATCH", message: "100.64.0.9 answered WhoIs as nOTHER" },
        },
      },
    });
    const result = await runCove(env, home, ["--server", "box", "status"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("answered as another node (PEER_MISMATCH");
    expect(result.stderr).toContain("nothing was sent");
    expect(result.stderr).toContain("Entries of box: tsnet");
    const dials = (await events()).filter((event) => event.op === "dial");
    expect(dials).toHaveLength(1);
    // The CLI waited for the dial answer before it sent any stream byte.
    expect(dials[0].bytesBeforeAnswer).toBe(0);

    // A daemon reporting another peer than the one requested is refused by the CLI as well.
    await configure({
      build: "b1",
      protocol: 1,
      dialForward: target.address().port,
      dialPeer: "nOTHER",
    });
    const wrongPeer = await runCove(env, home, ["--server", "box", "status"]);
    expect(wrongPeer.code).toBe(1);
    expect(wrongPeer.stderr).toContain("reported peer nOTHER for server node nSERVER1");
    expect(received).toHaveLength(0);
  } finally {
    await new Promise((done) => target.close(done));
  }
}, 60_000);
