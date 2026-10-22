import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { portOf } from "./auth-fixtures.mjs";
import { sshClients, startSshd } from "./sshd-fixture.mjs";
import { startTailnet, tsnetBuilds } from "./tsnet-fixtures.mjs";
import { createTsnetScenario } from "./tsnet-scenario.mjs";

// m2 S7 for a client on another host (#173): a remote pairing records every entry the invitation
// carries, so one client reaches the server over SSH and over tsnet and switches with --via. The
// compiled CLI and server, a task-owned sshd (sshd-fixture.mjs) as the invitation's SSH target,
// and a serve node on the test tailnet standing in for the server's node (tsnet-scenario.mjs):
// - paired over SSH, the record holds the ssh entry (the default) and the invitation's tsnet
//   node; paired over tsnet, the tsnet entry (the default) and the SSH target; never loopback;
// - over either entry a client sees the same serverId and tasks; each command goes through only
//   the entry it selected (--via, else the default), which the sshd's and the serve node's own
//   records show;
// - when the selected entry fails the command fails naming the entries and --via, and the other
//   entry is never tried; `remote entry default` moves the default.

let builds;
let tailnet;
let scenario;
let sshd;

beforeAll(async () => {
  builds = await tsnetBuilds();
  tailnet = await startTailnet(builds);
}, 600_000);

afterAll(async () => {
  await tailnet?.stop();
});

afterEach(async () => {
  try {
    if (sshd)
      await waitFor(
        "every ssh client of the scenario to exit",
        async () => (await sshClients(sshd.clientConfig)).length === 0,
        10_000,
      );
  } finally {
    await sshd?.stop();
    sshd = undefined;
    await scenario?.cleanup();
    scenario = undefined;
  }
});

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

// A server whose invitations name the fixture sshd as their SSH target and the serve node as
// their tsnet node, and `count()`: how many times each entry was used so far (the sshd's
// forwarded channels to the business port; the serve node's connections to it).
async function setUp() {
  scenario = await createTsnetScenario(builds, tailnet);
  const { fixture } = scenario;
  sshd = await startSshd(join(fixture.root, "ssh"));
  fixture.env.PATH = sshd.env(fixture.env).PATH;
  const home = fixture.home("server");
  const pairingPort = await freePort();
  const server = await fixture.startAuthServer(home, ["--pairing-port", String(pairingPort)], {
    sshTarget: sshd.target,
  });
  const businessPort = portOf(server);
  const node = await scenario.serveNode({ businessPort, pairingPort });
  const forwards = new RegExp(
    `server_request_direct_tcpip: originator .* target 127\\.0\\.0\\.1 port ${businessPort}\\b`,
    "g",
  );
  const count = () => ({
    ssh: (sshd.log().match(forwards) ?? []).length,
    sshConnections: (sshd.log().match(/Connection from /g) ?? []).length,
    tsnet: node.recorded.filter((entry) => entry.port === businessPort).length,
  });
  const client = async (name, via) => {
    const clientHome = scenario.client(name);
    const login = await scenario.login(clientHome);
    if (login.code !== 0) throw new Error(`remote tsnet login failed: ${login.stderr}`);
    const record = await scenario.pair(clientHome, "box", home, node, via);
    return { home: clientHome, record };
  };
  return { home, server, businessPort, node, count, client };
}

const over = (home, via, args) =>
  scenario.fixture.coveJson(["--server", "box", ...(via ? ["--via", via] : []), ...args], {
    home,
  });

test("a client paired over SSH or over tsnet records both entries and switches with --via", async () => {
  const { server, businessPort, node, count, client } = await setUp();
  const entries = {
    ssh: { target: sshd.target, port: businessPort },
    tsnet: { nodeId: node.self.stableNodeID, name: node.self.name, port: businessPort },
  };

  // Paired over SSH: both entries, ssh the default, no loopback.
  const a = await client("a", "ssh");
  expect(a.record).toMatchObject({ defaultEntry: "ssh", entries });
  expect((await scenario.fixture.credential(a.home, a.record.serverId)).entries).toEqual(entries);

  // The default goes over SSH only.
  let before = count();
  const { task } = await over(a.home, undefined, ["task", "create", "Two entries"]);
  let after = count();
  expect(after.ssh).toBeGreaterThan(before.ssh);
  expect(after.tsnet).toBe(before.tsnet);

  // --via tsnet goes over tsnet only and reaches the same server and task.
  before = after;
  const viaTsnet = {
    status: await over(a.home, "tsnet", ["status"]),
    tasks: await over(a.home, "tsnet", ["task", "list"]),
  };
  after = count();
  expect(after.tsnet).toBeGreaterThan(before.tsnet);
  expect(after.sshConnections).toBe(before.sshConnections);
  expect(viaTsnet.status.serverId).toBe(server.record.serverId);
  expect(viaTsnet.tasks.tasks.map((entry) => entry.taskId)).toEqual([task.taskId]);
  expect(await over(a.home, "ssh", ["task", "list"])).toEqual(viaTsnet.tasks);

  // Paired over tsnet: both entries, tsnet the default; --via ssh reaches the same server.
  const b = await client("b", "tsnet");
  expect(b.record).toMatchObject({ defaultEntry: "tsnet", entries });
  expect(b.record.serverId).toBe(a.record.serverId);
  before = count();
  const viaDefault = await over(b.home, undefined, ["task", "list"]);
  after = count();
  expect(after.tsnet).toBeGreaterThan(before.tsnet);
  expect(after.sshConnections).toBe(before.sshConnections);
  before = after;
  const viaSsh = await over(b.home, "ssh", ["status"]);
  after = count();
  expect(after.ssh).toBeGreaterThan(before.ssh);
  expect(after.tsnet).toBe(before.tsnet);
  expect(viaSsh.serverId).toBe(server.record.serverId);
  expect(await over(b.home, "ssh", ["task", "list"])).toEqual(viaDefault);
  expect(viaDefault).toEqual(viaTsnet.tasks);

  // One record per server on each client.
  for (const { home } of [a, b])
    expect(
      (await scenario.fixture.coveJson(["remote", "list"], { home })).servers.map(
        (entry) => entry.alias,
      ),
    ).toEqual(["box"]);
}, 300_000);

test("a failing selected entry is never replaced by the other; entry default moves the default", async () => {
  const { businessPort, count, client, node } = await setUp();
  const a = await client("a", "ssh");

  // The default (ssh) fails at the host-key check: the command fails, names the entries and
  // --via, and does not go over tsnet.
  await sshd.pin("unknown");
  let before = count();
  const failed = await scenario.fixture.cove(["--server", "box", "status"], { home: a.home });
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain("cannot open the ssh entry of box");
  expect(failed.stderr).toContain("ENTRY_UNAVAILABLE");
  expect(failed.stderr).toContain("Entries of box: ssh, tsnet");
  expect(failed.stderr).toContain("--via ssh|tsnet");
  expect(count().tsnet).toBe(before.tsnet);
  // --via tsnet still works while ssh fails.
  expect((await over(a.home, "tsnet", ["status"])).serverId).toBe(a.record.serverId);
  await sshd.pin("correct");

  // The default moves to tsnet; the record keeps both entries.
  const moved = await scenario.fixture.coveJson(["remote", "entry", "default", "box", "tsnet"], {
    home: a.home,
  });
  expect(moved).toMatchObject({ defaultEntry: "tsnet", entries: a.record.entries });
  before = count();
  await over(a.home, undefined, ["status"]);
  let after = count();
  expect(after.tsnet).toBeGreaterThan(before.tsnet);
  expect(after.sshConnections).toBe(before.sshConnections);

  // The default (now tsnet) fails: the stream opens nowhere, and ssh is not tried.
  await node.serve(new Map([[businessPort, () => undefined]]));
  before = count();
  const unreachable = await scenario.fixture.cove(["--server", "box", "status"], {
    home: a.home,
  });
  expect(unreachable.code).toBe(1);
  expect(unreachable.stderr).toContain("ENTRY_UNAVAILABLE");
  expect(unreachable.stderr).toContain("Entries of box: ssh, tsnet");
  after = count();
  expect(after.sshConnections).toBe(before.sshConnections);
  // --via ssh still reaches the server.
  expect((await over(a.home, "ssh", ["status"])).serverId).toBe(a.record.serverId);
}, 300_000);
