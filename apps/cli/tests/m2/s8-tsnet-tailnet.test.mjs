import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { ECHO_LOOP, attachedTerminal } from "./ssh-scenario.mjs";
import {
  alive,
  daemonHello,
  filesHolding,
  modeOf,
  runCove,
  startTailnet,
  tsnetBuilds,
} from "./tsnet-fixtures.mjs";
import { createTsnetScenario } from "./tsnet-scenario.mjs";

// m2 S8 (the client's tsnet node, D9, D14) on the test tailnet with the real cove-tsnet daemon and
// a serve node standing in for the server's tailnet wiring (tsnet-scenario.mjs):
// - the node is logged in with an auth key from stdin, its state is private and reused by later
//   commands without a new login, pairing and commands work over it with no tailscale or
//   tailscaled on PATH, and the key is in no file, output or log (the scenario's secret scan);
// - a node that took over the server node's name is not the paired node: the command stops before
//   the token is sent;
// - a long terminal attach and other commands share the one daemon; a logout without --yes lists
//   the attach and changes nothing; a concurrent login and logout --yes are serialized by the
//   daemon and leave a consistent node (logged out, or logged in again), and the attach ends;
// - after `kill -9` of the daemon during an attach the next command takes over without a login,
//   with the same node identity, and the attach recovers from a new baseline.
// Another tailnet node reaching any port of the client node is refused by cove-tsnet itself
// (no listener; native/tailscale internal/e2e probes every port class).

let builds;
let tailnet;
let scenario;

beforeAll(async () => {
  builds = await tsnetBuilds();
  tailnet = await startTailnet(builds);
}, 600_000);

afterAll(async () => {
  await tailnet?.stop();
});

afterEach(async () => {
  await scenario?.cleanup();
  scenario = undefined;
});

async function setUp({ via = "tsnet" } = {}) {
  scenario = await createTsnetScenario(builds, tailnet);
  const target = await scenario.startServer();
  const node = await scenario.serveNode(target);
  const client = scenario.client();
  const login = await scenario.login(client);
  if (login.code !== 0) throw new Error(`remote tsnet login failed: ${login.stderr}`);
  const record = await scenario.pair(client, "box", target.home, node, via);
  return { ...target, node, client, login, record };
}

const tsnetStatus = (client) =>
  scenario.fixture.coveJson(["remote", "tsnet", "status"], { home: client });

test("an auth key from stdin logs the node in once; pairing and commands use it without system Tailscale", async () => {
  const { client, login, record, node, businessPort } = await setUp();
  const self = JSON.parse(login.stdout).self;
  expect(JSON.parse(login.stdout)).toMatchObject({ state: "Running", streams: [] });
  expect(login.stdout + login.stderr).not.toContain(tailnet.authKey);
  const tsnetHome = join(client, "tsnet-client");
  expect(await modeOf(tsnetHome)).toBe(0o700);
  expect(await modeOf(join(tsnetHome, "state"))).toBe(0o700);

  // Paired over tsnet: only the tsnet entry, at the business port, as the default.
  expect(record.defaultEntry).toBe("tsnet");
  const saved = await scenario.fixture.credential(client, record.serverId);
  expect(saved.entries).toEqual({
    tsnet: { nodeId: node.self.stableNodeID, name: node.self.name, port: businessPort },
  });

  // Later commands, from a new daemon too, reuse the node: same identity, no login.
  const { pid } = await daemonHello(client);
  await scenario.fixture.cove(["remote", "tsnet", "stop"], { home: client });
  await waitFor("the daemon to exit", () => !alive(pid), 10_000);
  // No tailscale or tailscaled anywhere the CLI or its daemon could look: PATH is one empty
  // directory.
  const emptyPath = join(scenario.fixture.root, "empty-path");
  await mkdir(emptyPath);
  const bare = { ...scenario.fixture.env, PATH: emptyPath };
  const status = await runCove(bare, client, ["--server", "box", "status"]);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout).serverId).toBe(record.serverId);
  const again = await waitForRunning(bare, client);
  expect(again.self.stableNodeID).toBe(self.stableNodeID);
  expect(again.daemon.pid).not.toBe(pid);
  expect(await readdir(emptyPath)).toEqual([]);

  // The key is in no file of the client (the scenario's secret scan checks the whole root and
  // the server's output again at cleanup), in particular not in the node state or daemon log.
  expect(await filesHolding(client, tailnet.authKey)).toEqual([]);
  expect(await readFile(join(tsnetHome, "run", "dial.log"), "utf8")).not.toContain("tskey");
}, 180_000);

async function waitForRunning(env, client) {
  let status;
  await waitFor(
    "the restored node to run",
    async () => {
      const result = await runCove(env, client, ["remote", "tsnet", "status"]);
      status = result.code === 0 ? JSON.parse(result.stdout) : undefined;
      return status?.state === "Running";
    },
    30_000,
  );
  return status;
}

test("a node that took over the server node's name is not the paired node; the token is not sent", async () => {
  const { client, node, businessPort, pairingPort } = await setUp();
  // The server node leaves the tailnet, and another node joins with the same hostname.
  await node.logout();
  const squatter = await scenario.serveNode(
    { businessPort, pairingPort },
    { hostname: "cove-srv" },
  );
  expect(squatter.self.stableNodeID).not.toBe(node.self.stableNodeID);
  const result = await scenario.fixture.cove(["--server", "box", "status"], { home: client });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("ENTRY_UNAVAILABLE");
  // The paired node is gone (or no longer answers, while the control plane still lists it); the
  // squatter, whatever its name, is never dialed: streams go to the stable ID only.
  expect(result.stderr).toMatch(
    new RegExp(
      `no node with the stable ID of server node ${node.self.stableNodeID}|` +
        `server node ${node.self.stableNodeID} did not accept a connection`,
    ),
  );
  expect(result.stderr).toContain("nothing was sent");
  expect(squatter.recorded).toEqual([]);
}, 180_000);

test("an attach and other commands share the daemon; logout needs --yes; login and logout are serialized", async () => {
  const { client, login } = await setUp();
  const over = (args) => scenario.fixture.coveJson(["--server", "box", ...args], { home: client });
  const run = await over([
    "terminal",
    "create",
    "--cwd",
    scenario.fixture.root,
    "--",
    "/bin/sh",
    "-c",
    ECHO_LOOP,
  ]);
  const session = await scenario.session(client, "box", undefined);
  const attach = await attachedTerminal(session.client, run, "long");
  await attach.type("first\r");
  await attach.sees("echo:first");
  const { pid } = await daemonHello(client);

  // A second command over the same daemon, while the attach stays.
  expect((await over(["task", "list"])).tasks).toEqual([]);
  await attach.type("second\r");
  await attach.sees("echo:second");
  const busy = await tsnetStatus(client);
  expect(busy.daemon.pid).toBe(pid);
  expect(busy.streams.length).toBeGreaterThanOrEqual(1);
  expect(busy.streams.map((stream) => stream.label)).toContain(`box (cove pid ${process.pid})`);

  // Without --yes: refused, the streams listed, nothing changed.
  const refused = await scenario.fixture.cove(["remote", "tsnet", "logout"], { home: client });
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("ACTIVE_STREAMS");
  expect(refused.stderr).toContain(`box (cove pid ${process.pid})`);
  await attach.type("third\r");
  await attach.sees("echo:third");
  expect((await tsnetStatus(client)).state).toBe("Running");

  // A login and a forced logout at once: the daemon runs them one after the other.
  const [loginAgain, logout] = await Promise.all([
    scenario.fixture.coveInput(["remote", "tsnet", "login"], `${tailnet.authKey}\n`, {
      home: client,
    }),
    scenario.fixture.cove(["remote", "tsnet", "logout", "--yes"], { home: client }),
  ]);
  expect(logout.code).toBe(0);
  expect(JSON.parse(logout.stdout).state).toBe("LoggedOut");
  // The attach's stream was closed by the logout.
  await waitFor(
    "the attach to lose its connection",
    () => attach.controller.snapshot().phase === "unavailable",
    15_000,
  );
  const final = await tsnetStatus(client);
  const stateDirectory = join(client, "tsnet-client", "state");
  const outcome = {
    login:
      loginAgain.code === 0
        ? "succeeded"
        : loginAgain.stderr.includes("ALREADY_LOGGED_IN")
          ? "already logged in"
          : loginAgain.stderr,
    state: final.state,
    stateDirectory: await modeOf(stateDirectory).catch((error) => error.code),
    newNode: final.self
      ? final.self.stableNodeID !== JSON.parse(login.stdout).self.stableNodeID
      : null,
  };
  // Either order is a whole outcome, never a half-logged-in node: the login ran after the
  // logout (a new node, fully logged in, private state), or before it (it found the node logged
  // in, and the logout then removed the node and its state).
  expect([
    { login: "succeeded", state: "Running", stateDirectory: 0o700, newNode: true },
    { login: "already logged in", state: "LoggedOut", stateDirectory: "ENOENT", newNode: null },
  ]).toContainEqual(outcome);
  expect(final.daemon.pid).toBe(pid);
  expect(final.streams).toEqual([]);
}, 180_000);

test("after kill -9 of the daemon during an attach the next command takes over with the same node, and the attach recovers", async () => {
  const { client } = await setUp();
  const run = await scenario.fixture.coveJson(
    [
      "--server",
      "box",
      "terminal",
      "create",
      "--cwd",
      scenario.fixture.root,
      "--",
      "/bin/sh",
      "-c",
      ECHO_LOOP,
    ],
    { home: client },
  );
  const before = await tsnetStatus(client);
  const session = await scenario.session(client, "box", undefined);
  const attach = await attachedTerminal(session.client, run, "killed");
  await attach.type("before-kill\r");
  await attach.sees("echo:before-kill");

  process.kill(before.daemon.pid, "SIGKILL");
  await waitFor("the daemon to die", () => !alive(before.daemon.pid), 5_000);
  await waitFor(
    "the attach to lose its connection",
    () => attach.controller.snapshot().phase === "unavailable",
    15_000,
  );
  // The next command starts a new daemon over the stale socket, restores the node without a
  // login and with the same identity.
  const after = await waitForRunning(scenario.fixture.env, client);
  expect(after.daemon.pid).not.toBe(before.daemon.pid);
  expect(after.self.stableNodeID).toBe(before.self.stableNodeID);

  // The interrupted attach recovers: a reconnect and a new baseline that holds the earlier output.
  expect((await session.client.reconnect()).ok).toBe(true);
  expect(await attach.controller.attach()).toMatchObject({ ok: true });
  await attach.type("after-kill\r");
  await attach.sees("echo:after-kill");
  expect(attach.text()).toContain("echo:before-kill");
}, 180_000);
