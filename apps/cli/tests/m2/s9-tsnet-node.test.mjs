import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { cli } from "../m1/fixtures.mjs";
import { waitFor } from "../recording-view.mjs";
import {
  bootstrapRequest,
  createAuthFixture,
  filesUnder,
  payloadOf,
  portOf,
} from "./auth-fixtures.mjs";
import {
  bodyOf,
  httpPost,
  shortRoot,
  startPeer,
  startTailnet,
  tsnetBuilds,
} from "./s9-tsnet-fixture.mjs";

// m2 S9 (docs/milestones/m2.md), against the compiled server and CLI and the real `cove-tsnet`,
// on the test tailnet (s9-tsnet-fixture.mjs): the server node listens only on the business port
// and, while an invitation is open, the pairing port, and requests through it still need a device
// token; a normal restart keeps the node's identity without a new login; a `kill -9` of
// `cove-tsnet` is followed by a restart and touches neither PTYs nor the loopback entry (SSH
// forwards to it); no system tailscaled is needed (none is on the server's PATH) and nothing
// is written outside the server's own node directory; the auth key is in no argv, environment,
// log, database or operation record (the fixture's secret scan covers every file under the root
// and server stderr); and after a login whose answer was lost, `server tsnet status` answers.
// The cove-tsnet builds on both platforms are the CI build jobs. A real tailnet across two
// machines is checked outside CI.

let builds;
let tailnet;
let peerRoot;
let peer;
let fixture;

beforeAll(async () => {
  builds = await tsnetBuilds();
  tailnet = await startTailnet(builds);
  peerRoot = await shortRoot();
  peer = await startPeer(builds.current, tailnet, peerRoot);
}, 600_000);

afterAll(async () => {
  await peer?.stop();
  await tailnet?.stop();
  if (peerRoot) await rm(peerRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  fixture = await createAuthFixture();
  Object.assign(fixture.env, tailnet.nodeEnv, {
    COVE_TSNET_BINARY: builds.current,
    COVE_TSNET_CONTROL_URL: tailnet.controlURL,
  });
  fixture.remember(tailnet.authKey);
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

// The server can discover only the fixture's Git and Node. This proves that its
// absolute-path helper works without a system Tailscale on PATH, independently of
// any Tailscale tools the operator has installed elsewhere. CLI/fixture PATH stays intact.
async function startServer(home) {
  const tools = join(fixture.root, "server-tools");
  if (!existsSync(tools)) {
    await mkdir(tools);
    const git = execFileSync("/bin/sh", ["-c", "command -v git"], { env: fixture.env })
      .toString()
      .trim();
    await symlink(git, join(tools, "git"));
    await symlink(process.execPath, join(tools, "node"));
  }
  for (const name of ["tailscale", "tailscaled"]) expect(existsSync(join(tools, name))).toBe(false);
  const path = fixture.env.PATH;
  fixture.env.PATH = tools;
  try {
    return await fixture.startAuthServer(home);
  } finally {
    fixture.env.PATH = path;
  }
}

const ps = (pid, environment) =>
  new Promise((done) =>
    execFile(
      "/bin/ps",
      [environment ? "eww" : "ww", "-o", "command=", "-p", String(pid)],
      (_error, stdout) => done(stdout),
    ),
  );

// The server's `cove-tsnet serve` child, or undefined.
async function helperOf(server) {
  for (const pid of await fixture.childrenOf(server.pid))
    if (/ serve .*--forward-socket/.test(await ps(pid, false))) return pid;
  return undefined;
}

// `server tsnet status`, asked again while a login or logout holds the node (BUSY).
async function status(home) {
  for (let attempt = 0; ; attempt++) {
    const result = await fixture.cove(["server", "tsnet", "status"], { home });
    if (result.code === 0) return JSON.parse(result.stdout);
    if (!/busy/.test(result.stderr) || attempt > 40) throw new Error(result.stderr);
    await new Promise((done) => setTimeout(done, 500));
  }
}

async function login(home) {
  const result = await fixture.coveInput(["server", "tsnet", "login"], `${tailnet.authKey}\n`, {
    home,
    sample: async (pid) => [await ps(pid, false), await ps(pid, true)],
  });
  expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
  for (const line of result.sampled) expect(line).not.toContain(tailnet.authKey);
  return JSON.parse(result.stdout);
}

test("the server node serves only the business port and an open invitation's pairing port, and every request still needs a device token", async () => {
  const home = fixture.home("server");
  const server = await startServer(home);
  const businessPort = portOf(server);
  const { status: node } = await login(home);
  expect(node).toMatchObject({ state: "running", hold: null, ports: [businessPort] });
  const nodeId = node.nodeId;
  const helper = await helperOf(server);
  expect(helper).toBeGreaterThan(0);
  for (const line of [await ps(helper, false), await ps(helper, true)])
    expect(line).not.toContain(tailnet.authKey);

  const identity = await peer.exchange(
    nodeId,
    businessPort,
    httpPost(businessPort, "/bootstrap", bootstrapRequest(server)),
  );
  expect(identity.answer).toMatch(/^HTTP\/1\.1 200/);
  expect(bodyOf(identity.answer).serverId).toBe(server.record.serverId);
  const business = {
    "cove-protocol": String(PROTOCOL_VERSION),
    "cove-server-id": server.record.serverId,
    "cove-instance-id": server.record.relayInstanceId,
  };
  const rpc = { jsonrpc: "2.0", id: 1, method: "task.list", params: { limit: 10 } };
  const anonymous = await peer.exchange(
    nodeId,
    businessPort,
    httpPost(businessPort, "/rpc", rpc, business),
  );
  expect(anonymous.answer).toMatch(/^HTTP\/1\.1 401/);
  expect(anonymous.answer).toContain("UNAUTHENTICATED");
  // No other port: not the loopback pairing port before an invitation, not any other.
  expect(await peer.exchange(nodeId, businessPort + 1, "x")).toMatchObject({ ok: false });

  // An open invitation advertises the node and opens its pairing port on the tailnet.
  const invited = await fixture.invite(home);
  const payload = payloadOf(invited.invitation);
  expect(payload.entries.tsnet).toEqual({ nodeId, name: node.nodeName });
  const pairingIdentity = await peer.exchange(
    nodeId,
    payload.pairingPort,
    httpPost(payload.pairingPort, "/bootstrap", bootstrapRequest(server)),
  );
  expect(bodyOf(pairingIdentity.answer).serverId).toBe(server.record.serverId);
  const redeemed = await peer.exchange(
    nodeId,
    payload.pairingPort,
    httpPost(payload.pairingPort, "/pair", {
      type: "cove-pairing-redeem",
      inviteId: payload.inviteId,
      secret: payload.secret,
      deviceName: "s9-peer",
    }),
  );
  const pairing = bodyOf(redeemed.answer);
  fixture.remember(pairing.token);
  expect(pairing).toMatchObject({ type: "cove-pairing-result", businessPort });
  // With the device token the same request is answered, through the node.
  const authorized = await peer.exchange(
    nodeId,
    businessPort,
    httpPost(businessPort, "/rpc", rpc, { ...business, authorization: `Bearer ${pairing.token}` }),
  );
  expect(authorized.answer).toMatch(/^HTTP\/1\.1 200/);
  const devices = await fixture.coveJson(["auth", "device", "list"], { home });
  expect(JSON.stringify(devices)).toContain('"lastEntry":"tsnet"');
  // The redemption ended the only invitation: the pairing port is closed on the tailnet too.
  await waitFor(
    "the pairing port to close on the node",
    async () => (await status(home)).ports.length === 1,
    10_000,
  );
  expect(await peer.exchange(nodeId, payload.pairingPort, "x")).toMatchObject({ ok: false });
}, 180_000);

test("the node survives restarts of the server and of cove-tsnet, and status answers after a lost login answer", async () => {
  const home = fixture.home("server");
  let server = await startServer(home);
  const businessPort = portOf(server);

  // A login whose CLI is gone before the answer: the server completes it, and status answers.
  const lost = spawn(
    process.execPath,
    [cli, "--home", home, "server", "tsnet", "login", "--operation-id", "s9-lost-login"],
    { env: fixture.env, stdio: ["pipe", "ignore", "ignore"] },
  );
  lost.stdin.end(`${tailnet.authKey}\n`);
  await waitFor("the login to be sent", async () => (await helperOf(server)) !== undefined, 20_000);
  lost.kill("SIGKILL");
  await new Promise((done) => lost.once("exit", done));
  await waitFor(
    "the node to be running",
    async () => (await status(home)).state === "running",
    60_000,
  );
  const record = await fixture.coveJson(["operation", "get", "s9-lost-login"], { home });
  expect(JSON.stringify(record)).toMatch(/"state":"(succeeded|running)"/);
  const node = await status(home);
  expect(node).toMatchObject({ state: "running", hold: null, ports: [businessPort] });

  // A PTY, and the loopback entry, while cove-tsnet is killed and restarted.
  const run = await fixture.coveJson(
    ["terminal", "create", "--cwd", fixture.root, "--", "/bin/sh", "-c", "exec /bin/sleep 600"],
    { home },
  );
  const first = await helperOf(server);
  process.kill(first, "SIGKILL");
  expect(await fixture.coveJson(["task", "list"], { home })).toBeDefined();
  await waitFor(
    "a restarted cove-tsnet",
    async () => {
      const next = await helperOf(server);
      return next !== undefined && next !== first;
    },
    20_000,
  );
  await waitFor(
    "the node to run again with its ports",
    async () => {
      const current = await status(home);
      return current.state === "running" && current.ports.includes(businessPort);
    },
    60_000,
  );
  expect((await status(home)).nodeId).toBe(node.nodeId);
  const after = await peer.exchange(
    node.nodeId,
    businessPort,
    httpPost(businessPort, "/bootstrap", bootstrapRequest(server)),
  );
  expect(bodyOf(after.answer).serverId).toBe(server.record.serverId);
  const got = await fixture.coveJson(["terminal", "get", run.runId], { home });
  expect(JSON.stringify(got)).toContain('"status":"live"');

  // An orderly restart: the node comes back as itself, with no login.
  await fixture.stopServer(server);
  server = await startServer(home);
  await waitFor(
    "the node to run after the restart",
    async () => (await status(home)).state === "running",
    60_000,
  );
  const restarted = await status(home);
  expect(restarted.nodeId).toBe(node.nodeId);
  expect(server.stderr()).not.toContain('"event":"tsnet-unavailable"');

  // Nothing tailscale-like was written outside the server's node directory.
  const nodeDirectory = join(home, "tsnet");
  const stray = (await filesUnder(fixture.root))
    .map(({ path }) => path)
    .filter((path) => /tailscale/i.test(path) && !path.startsWith(nodeDirectory));
  expect(stray).toEqual([]);
}, 240_000);
