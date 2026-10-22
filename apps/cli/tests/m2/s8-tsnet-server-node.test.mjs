import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { SSH_TARGET, payloadOf } from "./auth-fixtures.mjs";
import { startTailnet, tsnetBuilds } from "./tsnet-fixtures.mjs";
import { createTsnetScenario } from "./tsnet-scenario.mjs";

// m2 S8 end to end with the server's own tailnet node (T5b) instead of the stand-in serve node
// of the other S8 scenarios: on the test tailnet, the compiled server logs its node in
// (`cove server tsnet login`), its invitation names that node (`entries.tsnet`), and a client
// whose own node is logged in (`cove remote tsnet login`) pairs `--via tsnet` through the
// server node's pairing port and then runs commands through its business port. This checks the
// interface the client relies on: the invitation's stable ID is the node the client's dial
// reaches and verifies, and the server node serves the business and pairing ports at their
// loopback numbers. The scenario's secret scan checks that the auth key is in no file or output.

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

test("a client pairs over tsnet with the server's own node and runs commands through it", async () => {
  scenario = await createTsnetScenario(builds, tailnet);
  const { fixture } = scenario;
  const { home: serverHome, server, businessPort } = await scenario.startServer();

  const serverLogin = await fixture.coveInput(
    ["server", "tsnet", "login"],
    `${tailnet.authKey}\n`,
    { home: serverHome },
  );
  expect({ code: serverLogin.code, stderr: serverLogin.stderr }).toMatchObject({ code: 0 });
  const { status: node } = JSON.parse(serverLogin.stdout);
  expect(node).toMatchObject({ state: "running", hold: null, ports: [businessPort] });

  const { invitation } = await fixture.invite(serverHome);
  const payload = payloadOf(invitation);
  expect(payload.entries.tsnet).toEqual({ nodeId: node.nodeId, name: node.nodeName });

  const client = scenario.client();
  const clientLogin = await scenario.login(client);
  expect({ code: clientLogin.code, stderr: clientLogin.stderr }).toMatchObject({ code: 0 });
  expect(JSON.parse(clientLogin.stdout).self.stableNodeID).not.toBe(node.nodeId);

  const record = await fixture.pairOk(client, "box", invitation, ["--via", "tsnet"]);
  expect(record.defaultEntry).toBe("tsnet");
  const saved = await fixture.credential(client, record.serverId);
  // Every entry of the invitation: its SSH target too, never loopback (another host).
  expect(saved.entries).toEqual({
    ssh: { target: SSH_TARGET, port: businessPort },
    tsnet: { nodeId: node.nodeId, name: node.nodeName, port: businessPort },
  });

  const status = await fixture.coveJson(["--server", "box", "status"], { home: client });
  expect(status.serverId).toBe(server.record.serverId);
  const { task } = await fixture.coveJson(["--server", "box", "task", "create", "Over tsnet"], {
    home: client,
  });
  const listed = await fixture.coveJson(["--server", "box", "task", "list"], { home: client });
  expect(JSON.stringify(listed)).toContain(task.taskId);

  // The server saw this device arrive through its tailnet node.
  const devices = await fixture.coveJson(["auth", "device", "list"], { home: serverHome });
  const device = devices.devices.find((entry) => entry.deviceId === record.deviceId);
  expect(device?.lastEntry).toBe("tsnet");
}, 240_000);
