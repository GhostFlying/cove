import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { ECHO_LOOP, attachedTerminal } from "./ssh-scenario.mjs";
import { startTailnet, tsnetBuilds } from "./tsnet-fixtures.mjs";
import { createTsnetScenario } from "./tsnet-scenario.mjs";

// m2 S7 (switching entries keeps the identity), tsnet part, against the compiled CLI and server, a
// real cove-tsnet dial daemon and a serve node on the test tailnet (tsnet-scenario.mjs). One
// client paired over loopback also records the invitation's tsnet entry:
// - over loopback and over tsnet it sees the same serverId, tasks and runs, and a terminal attached
//   over loopback and then over tsnet (--via) recovers the same run, with no duplicate;
// - the tsnet node of the server the client reached is the one the invitation named, and the
//   server saw the client's own node;
// - when the tsnet entry is unreachable the command fails naming the entries and --via, and the
//   loopback entry is never tried;
// - a tsnet entry that now reaches another data directory's server is refused with
//   SERVER_ID_MISMATCH before the token is sent.
// The server's own tailnet wiring is T5b's; until it lands the serve node is run by the scenario.

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

async function paired() {
  scenario = await createTsnetScenario(builds, tailnet);
  const target = await scenario.startServer();
  const node = await scenario.serveNode(target);
  const client = scenario.client();
  const login = await scenario.login(client);
  if (login.code !== 0) throw new Error(`remote tsnet login failed: ${login.stderr}`);
  const record = await scenario.pair(client, "box", target.home, node);
  return { ...target, node, client, clientNode: JSON.parse(login.stdout).self, record };
}

test("loopback and tsnet reach the same server, tasks and runs; --via tsnet attaches the same run", async () => {
  const { client, record, node, businessPort, clientNode, home: serverHome } = await paired();
  expect(record.defaultEntry).toBe("loopback");
  expect(record.entries.tsnet).toEqual({
    nodeId: node.self.stableNodeID,
    name: node.self.name,
    port: businessPort,
  });
  const over = (via, args) =>
    scenario.fixture.coveJson(["--server", "box", ...(via ? ["--via", via] : []), ...args], {
      home: client,
    });

  await over(undefined, ["task", "create", "Shared task"]);
  const run = await over("tsnet", [
    "terminal",
    "create",
    "--cwd",
    scenario.fixture.root,
    "--",
    "/bin/sh",
    "-c",
    ECHO_LOOP,
  ]);
  const read = async (via) => ({
    status: await over(via, ["status"]),
    tasks: await over(via, ["task", "list"]),
    runs: await over(via, ["terminal", "list"]),
  });
  const viaLoopback = await read(undefined);
  const viaTsnet = await read("tsnet");
  expect(viaTsnet.status.serverId).toBe(record.serverId);
  expect(viaLoopback.status.serverId).toBe(record.serverId);
  expect(viaTsnet.tasks).toEqual(viaLoopback.tasks);
  const refs = (listed) => listed.runs.map((entry) => entry.run);
  expect(refs(viaTsnet.runs)).toEqual(refs(viaLoopback.runs));
  expect(refs(viaTsnet.runs)).toEqual([run]);
  // The requests arrived through the serve node from the client's own node.
  const peers = new Set(node.recorded.map((entry) => entry.peer?.stableNodeID));
  expect(peers).toEqual(new Set([clientNode.stableNodeID]));

  // A terminal over loopback, then the same run over tsnet: the second attach recovers the
  // first's output and continues the same run.
  const local = await scenario.session(client, "box", undefined);
  const first = await attachedTerminal(local.client, run, "loopback");
  await first.type("over-loopback\r");
  await first.sees("echo:over-loopback");
  await scenario.closeSession(local);
  const remote = await scenario.session(client, "box", "tsnet");
  expect(remote.record.endpoint).not.toBe(`http://127.0.0.1:${businessPort}`);
  const second = await attachedTerminal(remote.client, run, "tsnet");
  await second.sees("echo:over-loopback");
  await second.type("over-tsnet\r");
  await second.sees("echo:over-tsnet");
  await scenario.closeSession(remote);

  // No duplicate task, run, paired server or server.
  expect((await over("tsnet", ["task", "list"])).tasks).toHaveLength(1);
  expect((await over(undefined, ["terminal", "list"])).runs).toHaveLength(1);
  expect(
    (await scenario.fixture.coveJson(["remote", "list"], { home: client })).servers.map(
      (server) => server.alias,
    ),
  ).toEqual(["box"]);
  expect((await scenario.fixture.coveJson(["status"], { home: serverHome })).serverId).toBe(
    record.serverId,
  );
}, 180_000);

test("an unreachable tsnet entry fails naming the entries; a tsnet entry reaching another server is refused before the token", async () => {
  const { client, record, node, businessPort } = await paired();
  const recordPath = join(client, "client", "servers", `${record.serverId}.json`);
  // The loopback entry now leads to a counter: it must never be tried while tsnet fails.
  let loopbackConnections = 0;
  const counter = createServer((socket) => {
    loopbackConnections += 1;
    socket.destroy();
  });
  await new Promise((done) => counter.listen(0, "127.0.0.1", done));
  try {
    const current = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(
      recordPath,
      JSON.stringify({
        ...current,
        entries: { ...current.entries, loopback: { port: counter.address().port } },
      }),
      { mode: 0o600 },
    );

    // The server node no longer serves the business port: the stream opens nowhere.
    await node.serve(new Map([[businessPort, () => undefined]]));
    const unreachable = await scenario.fixture.cove(
      ["--server", "box", "--via", "tsnet", "status"],
      {
        home: client,
      },
    );
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toContain("ENTRY_UNAVAILABLE");
    expect(unreachable.stderr).toContain("Entries of box: loopback, ssh, tsnet");
    expect(unreachable.stderr).toContain("--via ssh|tsnet");
    expect(loopbackConnections).toBe(0);

    // The same node and port now lead to another data directory's server.
    const other = await scenario.startServer(scenario.fixture.home("other"));
    await node.serve(new Map([[businessPort, () => other.businessPort]]));
    const before = node.sent(businessPort).length;
    const mismatch = await scenario.fixture.cove(["--server", "box", "--via", "tsnet", "status"], {
      home: client,
    });
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain("SERVER_ID_MISMATCH");
    expect(mismatch.stderr).toContain("no token was sent");
    const sent = node.sent(businessPort).slice(before);
    expect(sent).toContain("cove-bootstrap");
    expect(sent).not.toContain("cove_d1_");
    expect(sent).not.toContain(record.deviceId + ".");
    expect(loopbackConnections).toBe(0);
  } finally {
    await new Promise((done) => counter.close(done));
  }
}, 180_000);
