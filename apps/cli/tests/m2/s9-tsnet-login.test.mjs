import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { bootstrapRequest, createAuthFixture, payloadOf, portOf } from "./auth-fixtures.mjs";

// The server's tsnet node through the compiled server and CLI, with a stand-in helper
// (s9-fake-tsnet.mjs, selected by the workspace-only COVE_TSNET_BINARY override): the login,
// status and logout commands and their records, the invitation's tsnet entry and the port sync
// with the pairing listener, the forwarded-connection handover into the business and pairing
// listeners, and the secret boundary of the auth key and the login URL (the fixture's scan
// covers every file under the root, the store and the CLI pending records included, and server
// stderr). s9-tsnet-node.test.mjs runs the real helper against a test control plane.

const FAKE = resolve(import.meta.dirname, "s9-fake-tsnet.mjs");
const KEY = "tskey-auth-k0123456789ABCDEFGHIJ";
const LOGIN_URL = "https://login.example.test/a/interactive-0123456789";

let fixture;
beforeEach(async () => {
  fixture = await createAuthFixture();
  fixture.env.COVE_TSNET_BINARY = FAKE;
  fixture.remember(KEY);
  fixture.remember(LOGIN_URL);
});
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

// Where the server keeps its tsnet node: the directory holding the fake's request log.
async function tsnetHome(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
      else if (entry.name === "fake-ops.jsonl") return directory;
    }
  }
  return null;
}
const opsOf = async (home) =>
  (await readFile(join(home, "fake-ops.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const portSets = async (home) =>
  (await opsOf(home)).filter((op) => op.op === "setPorts").map((op) => op.ports);

function processLine(pid, withEnvironment) {
  return new Promise((done) =>
    execFile(
      "ps",
      [withEnvironment ? "eww" : "ww", "-o", "command=", "-p", String(pid)],
      (_e, out) => done(out),
    ),
  );
}

// One forwarded connection, as the helper opens it: the header line, then `bytes`; resolves with
// everything answered until the connection closes. The socket is where the server told the helper
// (`<node>/run`, or a private temporary directory when that path is too long for a socket).
async function forwarded(home, port, bytes) {
  const args = (await opsOf(home)).find((op) => op.op === "start").args;
  const path = args[args.indexOf("--forward-socket") + 1];
  return new Promise((done, fail) => {
    const socket = connect(path);
    let answer = "";
    socket.on("data", (chunk) => (answer += chunk));
    socket.once("error", fail);
    socket.once("close", () => done(answer));
    socket.write(
      `${JSON.stringify({ protocol: 1, port, remoteAddr: "100.64.0.9:4000", peer: { stableNodeID: "nPeer1CNTRL", name: "laptop.tail.example." }, whoIsError: "" })}\n${bytes}`,
    );
  });
}
const httpPost = (port, path, body, headers = {}) =>
  `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
  Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("") +
  `Connection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

test("an auth-key login from stdin enrolls the node, which serves the business port and the pairing port only while an invitation is open", async () => {
  const home = fixture.home("server");
  const server = await fixture.startAuthServer(home);
  const businessPort = portOf(server);
  // A node that never logged in: no helper runs and status says so.
  expect(await fixture.coveJson(["server", "tsnet", "status"], { home })).toMatchObject({
    state: "logged-out",
    nodeId: null,
  });
  expect(await tsnetHome(fixture.root)).toBeNull();

  let helperLines;
  const login = await fixture.coveInput(["server", "tsnet", "login"], `${KEY}\n`, {
    home,
    sample: async (pid) => [await processLine(pid, false), await processLine(pid, true)],
  });
  expect({ code: login.code, stderr: login.stderr }).toMatchObject({ code: 0 });
  const printed = JSON.parse(login.stdout);
  expect(printed.operation).toMatchObject({ method: "server.tsnet.login", state: "succeeded" });
  expect(printed.operation.result).toBeUndefined();
  expect(printed.status).toMatchObject({ state: "running", nodeId: "nFake1CNTRL", hold: null });
  expect(printed.status.ports).toEqual([businessPort]);
  const node = await tsnetHome(fixture.root);
  const helper = (await opsOf(node)).find((op) => op.op === "start");
  helperLines = [await processLine(helper.pid, false), await processLine(helper.pid, true)];
  // The key was in neither process's argv or environment.
  for (const line of [...login.sampled, ...helperLines]) expect(line).not.toContain(KEY);
  expect((await opsOf(node)).find((op) => op.op === "login").hasKey).toBe(true);

  // An invitation advertises the node, and its pairing port is open on the node while it is.
  const invited = await fixture.invite(home);
  const payload = payloadOf(invited.invitation);
  expect(payload.entries.tsnet).toEqual({ nodeId: "nFake1CNTRL", name: "cove-fake.tail.example" });
  expect(payload.entries.ssh).toBeDefined();
  expect((await portSets(node)).at(-1)).toEqual([businessPort, payload.pairingPort]);
  await fixture.coveJson(["auth", "invite", "cancel", payload.inviteId], { home });
  await waitFor(
    "the pairing port to be closed on the node",
    async () => JSON.stringify((await portSets(node)).at(-1)) === JSON.stringify([businessPort]),
    5_000,
  );
  expect((await fixture.coveJson(["server", "tsnet", "status"], { home })).ports).toEqual([
    businessPort,
  ]);
}, 60_000);

test("forwarded connections reach the business and pairing listeners, which still require their credentials", async () => {
  const home = fixture.home("server");
  const server = await fixture.startAuthServer(home);
  const businessPort = portOf(server);
  expect((await fixture.coveInput(["server", "tsnet", "login"], KEY, { home })).code).toBe(0);
  const node = await tsnetHome(fixture.root);
  const bootstrap = JSON.stringify(bootstrapRequest(server));
  const identity = await forwarded(
    node,
    businessPort,
    httpPost(businessPort, "/bootstrap", bootstrap),
  );
  expect(identity).toMatch(/^HTTP\/1\.1 200/);
  expect(identity).toContain(server.record.serverId);
  // No credential: refused exactly as on the loopback port.
  // A well-formed business request without a credential: refused as on the loopback port.
  const business = {
    "cove-protocol": String(PROTOCOL_VERSION),
    "cove-server-id": server.record.serverId,
    "cove-instance-id": server.record.relayInstanceId,
  };
  const rpcRequest = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "task.list",
    params: { limit: 10 },
  });
  const rpc = await forwarded(
    node,
    businessPort,
    httpPost(businessPort, "/rpc", rpcRequest, business),
  );
  expect(rpc).toMatch(/^HTTP\/1\.1 401/);
  expect(rpc).toContain("UNAUTHENTICATED");
  // The pairing port answers only while an invitation is open.
  const invited = await fixture.invite(home);
  const pairingPort = payloadOf(invited.invitation).pairingPort;
  const pairingIdentity = await forwarded(
    node,
    pairingPort,
    httpPost(pairingPort, "/bootstrap", bootstrap),
  );
  expect(pairingIdentity).toContain(server.record.serverId);
  await fixture.coveJson(["auth", "invite", "cancel", payloadOf(invited.invitation).inviteId], {
    home,
  });
  await waitFor(
    "the pairing listener to close",
    async () =>
      (await fixture.coveJson(["server", "tsnet", "status"], { home })).ports.length === 1,
    5_000,
  );
  expect(await forwarded(node, pairingPort, httpPost(pairingPort, "/bootstrap", bootstrap))).toBe(
    "",
  );
}, 60_000);

test("an interactive login shows its URL once, a refused login fails honestly, and logout reports the control plane's confirmation", async () => {
  const home = fixture.home("server");
  await fixture.startAuthServer(home);
  const interactive = await fixture.coveInput(["server", "tsnet", "login"], "", { home });
  expect({ code: interactive.code, stderr: interactive.stderr }).toMatchObject({ code: 0 });
  expect(interactive.stderr).toContain(LOGIN_URL);
  expect(interactive.stdout).not.toContain(LOGIN_URL);
  const printed = JSON.parse(interactive.stdout);
  expect(printed.operation.result).toEqual({ secretDelivery: "first-response-only" });
  expect(printed.status.state).toBe("running");
  // The record never holds the URL: operation get answers without it.
  const record = await fixture.coveJson(["operation", "get", printed.operation.operationId], {
    home,
  });
  expect(JSON.stringify(record)).not.toContain("login.example.test");

  // Already running: refused, the node unchanged, said so explicitly.
  const again = await fixture.coveInput(["server", "tsnet", "login"], "", { home });
  expect(again.code).toBe(1);
  expect(JSON.parse(again.stdout).operation).toMatchObject({
    state: "failed",
    error: { kind: "TSNET_LOGIN_FAILED" },
  });
  expect(again.stderr).toMatch(/already logged in; nothing was changed/);

  const logout = await fixture.coveJson(["server", "tsnet", "logout"], { home });
  expect(logout.operation).toMatchObject({
    state: "succeeded",
    result: { remoteLogoutConfirmed: true },
  });
  expect((await fixture.coveJson(["server", "tsnet", "status"], { home })).state).toBe(
    "logged-out",
  );
  // Nothing left to log out: no write is sent, and no admin-console warning is given.
  const nothing = await fixture.cove(["server", "tsnet", "logout"], { home });
  expect(nothing.code).toBe(0);
  expect(JSON.parse(nothing.stdout)).toMatchObject({ status: { state: "logged-out" } });
  expect(nothing.stderr).toMatch(/not logged in; nothing was done/);
  // No node: invitations advertise SSH alone.
  expect(payloadOf((await fixture.invite(home)).invitation).entries.tsnet).toBeUndefined();

  const refused = await fixture.coveInput(
    ["server", "tsnet", "login"],
    "tskey-fail-0123456789abcdef",
    {
      home,
    },
  );
  fixture.remember("tskey-fail-0123456789abcdef");
  expect(refused.code).toBe(1);
  expect(JSON.parse(refused.stdout).operation.error.kind).toBe("TSNET_LOGIN_FAILED");
  expect(refused.stderr).toMatch(/refused or did not finish; the node is unchanged/);
  expect(refused.stderr).not.toContain("tskey-fail");
}, 60_000);
