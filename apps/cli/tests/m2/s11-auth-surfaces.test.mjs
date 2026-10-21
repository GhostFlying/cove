import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  BOOTSTRAP_VERSION,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from "@cove/protocol/bootstrap";
import { BASELINE_ENCODING, PROFILE } from "@cove/protocol/profile";
import { waitFor } from "../recording-view.mjs";
import {
  alteredInvitation,
  connectable,
  createAuthFixture,
  filesUnder,
  payloadOf,
  post,
  waitUntilClosed,
  wrongSecret,
} from "./auth-fixtures.mjs";

// m2 S11 (the surfaces reachable before authentication, and the secret boundary) over the
// loopback entry, against the compiled CLI and server: missing, wrong and revoked credentials are
// refused on HTTP and on the terminal WebSocket without revealing anything; the pairing listener
// exists only with an open invitation and is bounded; directories and the credential file are
// owner-only; a lost invitation or rotation answer is recovered as "秘密与操作记录的分界" item 4
// says; and no issued token or invitation secret appears in argv, environments, failure output,
// the database (WAL included), operation records, logs or CLI pending records. A token appears in
// the client's credential file only.

let fixture;

beforeEach(async () => {
  fixture = await createAuthFixture();
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

const portOf = (server) => Number(new URL(server.record.endpoint).port);

function bootstrapRequest(server) {
  return {
    type: "cove-bootstrap",
    bootstrapVersion: BOOTSTRAP_VERSION,
    expectedServerId: server.record.serverId,
    expectedRelayInstanceId: server.record.relayInstanceId,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: "0.0.0+0000000000000000",
    capabilities: [...REQUIRED_CAPABILITIES],
    profiles: [PROFILE],
    encodings: [BASELINE_ENCODING],
  };
}

// A terminal WebSocket whose first frame carries `secret`: every text message and the close code.
async function terminalAttempt(server, secret) {
  const socket = new WebSocket(`ws://127.0.0.1:${portOf(server)}/terminal`);
  const messages = [];
  socket.addEventListener("message", (event) => messages.push(String(event.data)));
  const closed = new Promise((done) =>
    socket.addEventListener("close", (event) => done(event.code)),
  );
  await new Promise((done, fail) => {
    socket.addEventListener("open", done);
    socket.addEventListener("error", fail);
  });
  socket.send(JSON.stringify({ ...bootstrapRequest(server), secret }));
  return { code: await closed, messages };
}

function run(file, args) {
  return new Promise((done) =>
    execFile(file, args, { env: fixture.env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      done(error ? "" : stdout),
    ),
  );
}

// What other processes could read of a CLI: every process's argv, and this one's environment.
async function sampleProcess(pid) {
  const argv = await run(
    "ps",
    process.platform === "linux" ? ["-eww", "-o", "args="] : ["-axww", "-o", "args="],
  );
  // The sample must have seen this CLI, or it proves nothing.
  if (!argv.includes("remote add")) throw new Error("the process sample did not include the CLI");
  const environment =
    process.platform === "linux"
      ? await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "")
      : await run("ps", ["eww", "-o", "command=", "-p", String(pid)]);
  return `${argv}\n${environment}`;
}

const mode = async (path) => (await stat(path)).mode & 0o777;

test("credentials that do not authenticate are refused on HTTP and WebSocket without revealing anything", async () => {
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome);
  // Server state a refusal must not reveal.
  const clone = await fixture.gitRepo("private-clone");
  await fixture.coveJson(["repo", "register", clone.path], { home: serverHome });
  await fixture.coveJson(["task", "create", "secret-task-title"], { home: serverHome });
  const homeA = fixture.home("device-a");
  const a = await fixture.pairOk(homeA, "box", (await fixture.invite(serverHome)).invitation);
  const tokenA = (await fixture.credential(homeA, a.serverId)).token;
  const homeR = fixture.home("device-r");
  const r = await fixture.pairOk(homeR, "box", (await fixture.invite(serverHome)).invitation);
  const tokenR = (await fixture.credential(homeR, r.serverId)).token;
  await fixture.coveJson(["auth", "device", "revoke", r.deviceId], { home: serverHome });

  const [, secretA] = tokenA.split(".");
  const credentials = {
    missing: undefined,
    malformed: "not-a-credential",
    "unknown device": `cove_d1_unknown-device.${secretA}`,
    "wrong secret": `cove_d1_${a.deviceId}.${wrongSecret(secretA)}`,
    "wrong local secret": wrongSecret(server.record.secret),
    revoked: tokenR,
  };
  const forbidden = [
    a.deviceId,
    r.deviceId,
    "secret-task-title",
    clone.path,
    fixture.root,
    tokenA,
    tokenR,
  ];
  const port = portOf(server);
  // A well-formed business request, so that only the credential decides the answer.
  const business = {
    "cove-protocol": String(PROTOCOL_VERSION),
    "cove-server-id": server.record.serverId,
    "cove-instance-id": server.record.relayInstanceId,
  };
  const rpcRequest = { jsonrpc: "2.0", id: 1, method: "task.list", params: { limit: 10 } };
  for (const [name, credential] of Object.entries(credentials)) {
    const headers = credential === undefined ? {} : { authorization: `Bearer ${credential}` };
    const rpc = await post(port, "/rpc", rpcRequest, { ...business, ...headers });
    expect({ name, status: rpc.status }).toEqual({ name, status: 401 });
    expect(rpc.json?.error?.kind ?? rpc.json?.kind).toBe(
      name === "revoked" ? "DEVICE_REVOKED" : "UNAUTHENTICATED",
    );
    const bootstrap = await post(port, "/bootstrap", bootstrapRequest(server), headers);
    // Without credentials the bootstrap is the pre-auth identity (checked below).
    expect({ name, status: bootstrap.status }).toEqual({
      name,
      status: credential === undefined ? 200 : 401,
    });
    const ws = await terminalAttempt(server, credential ?? "");
    expect({ name, code: ws.code }).toEqual({ name, code: 1008 });
    for (const text of [rpc.raw, bootstrap.raw, ...ws.messages])
      for (const value of forbidden) expect(text).not.toContain(value);
    expect(ws.messages.join("").includes("DEVICE_REVOKED")).toBe(name === "revoked");
  }
  // A browser (it sends an Origin) gets no identity without credentials.
  const browser = await post(port, "/bootstrap", bootstrapRequest(server), {
    origin: `http://127.0.0.1:${port}`,
  });
  expect(browser.status).not.toBe(200);
  expect(browser.raw).not.toContain(server.record.serverId);
  // The pre-auth identity holds these fields and nothing more.
  const anonymous = await post(port, "/bootstrap", bootstrapRequest(server));
  expect(Object.keys(anonymous.json).sort()).toEqual(
    [
      "bootstrapVersion",
      "buildVersion",
      "protocolVersion",
      "relayInstanceId",
      "serverId",
      "type",
    ].sort(),
  );
  // The real token still works on both channels.
  const accepted = await post(port, "/rpc", rpcRequest, {
    ...business,
    authorization: `Bearer ${tokenA}`,
  });
  expect(accepted.status).toBe(200);
  expect(accepted.raw).toContain("secret-task-title");
  const { client } = await fixture.deviceClient(server, tokenA);
  expect((await client.connect()).ok).toBe(true);
  client.dispose();

  // Owner-only directories and the credential file.
  expect(await mode(serverHome)).toBe(0o700);
  for (const home of [homeA, homeR]) {
    expect(await mode(join(home, "client"))).toBe(0o700);
    expect(await mode(join(home, "client", "servers"))).toBe(0o700);
    expect(await mode(join(home, "client", "servers", `${a.serverId}.json`))).toBe(0o600);
  }
});

test("the pairing listener exists only with an open invitation and is bounded", async () => {
  const serverHome = fixture.home("server");
  await fixture.startAuthServer(serverHome);
  const first = await fixture.invite(serverHome);
  const { pairingPort: firstPort, serverId, inviteId, secret } = payloadOf(first.invitation);
  await fixture.coveJson(["auth", "invite", "cancel", inviteId], { home: serverHome });
  await waitUntilClosed(firstPort);
  expect(await connectable(firstPort)).toBe(false);

  const open = await fixture.invite(serverHome);
  const port = payloadOf(open.invitation).pairingPort;
  expect(await connectable(port)).toBe(true);
  const redeem = (overrides = {}) => ({
    type: "cove-pairing-redeem",
    inviteId: payloadOf(open.invitation).inviteId,
    secret: wrongSecret(payloadOf(open.invitation).secret),
    deviceName: "probe",
    ...overrides,
  });

  // Only the two POST paths, with the listener's own Host and no browser headers.
  for (const [path, headers] of [
    ["/rpc", {}],
    ["/pair", { host: `localhost:${port}` }],
    ["/pair", { origin: "http://example.test" }],
    ["/pair", { "sec-fetch-site": "cross-site" }],
  ]) {
    const answer = await post(port, path, redeem(), headers);
    expect(answer.status).toBe(403);
    expect(answer.raw).not.toContain(serverId);
  }
  expect((await post(port, "/pair", "x".repeat(5000))).status).toBe(413);
  expect((await post(port, "/pair", "{not json")).status).toBe(400);
  expect((await post(port, "/pair", { ...redeem(), extra: 1 })).status).toBe(400);
  // The identity answer is the pre-auth identity only.
  const identity = await post(port, "/bootstrap", {
    type: "cove-bootstrap",
    bootstrapVersion: BOOTSTRAP_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: "0.0.0+0000000000000000",
    capabilities: [...REQUIRED_CAPABILITIES],
    profiles: [PROFILE],
    encodings: [BASELINE_ENCODING],
  });
  expect(identity.json).toMatchObject({ type: "cove-bootstrap-identity", serverId });

  // A connection cap: idle connections beyond it are not served.
  const sockets = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise((done, fail) => {
          const socket = connect({ host: "127.0.0.1", port });
          socket.once("connect", () => done(socket));
          socket.once("error", fail);
        }),
    ),
  );
  await expect(post(port, "/pair", redeem())).rejects.toThrow(/socket hang up|ECONNRESET|EPIPE/);
  for (const socket of sockets) socket.destroy();
  await waitFor("the listener to serve again", async () => {
    try {
      return (await post(port, "/pair", redeem({ inviteId: "no-such-invite" }))).status === 403;
    } catch {
      return false;
    }
  });

  // A global limit on redemption attempts: refusals until it is reached, then BUSY. Each answer
  // is fixed and never echoes the request.
  const statuses = [];
  for (let attempt = 0; attempt < 25; attempt++) {
    const answer = await post(
      port,
      "/pair",
      redeem({ inviteId: `no-such-invite-${attempt}`, secret }),
    );
    expect(answer.raw).not.toContain(secret);
    statuses.push(answer.status);
  }
  expect(statuses.slice(-3)).toEqual([429, 429, 429]);
  expect(new Set(statuses)).toEqual(new Set([403, 429]));
  expect(statuses.filter((status) => status === 403).length).toBeLessThanOrEqual(20);
});

test("lost secrets are recovered by new explicit operations, and no secret leaks anywhere", async () => {
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome);
  const secrets = new Set();
  const remember = (value) => {
    secrets.add(value);
    if (value.startsWith("cove-invite:")) secrets.add(payloadOf(value).secret);
    if (value.startsWith("cove_d1_")) secrets.add(value.split(".")[1]);
  };

  // Pairing, with argv and the environment sampled while the redemption is in flight.
  const first = await fixture.invite(serverHome);
  remember(first.invitation);
  let resume;
  const held = new Promise((done) => (resume = done));
  let reached;
  const atPair = new Promise((done) => (reached = done));
  const proxy = await fixture.pairingProxy(payloadOf(first.invitation).pairingPort, async () => {
    reached();
    await held;
  });
  const client = fixture.home("client");
  const paired = await fixture.pair(
    client,
    "box",
    alteredInvitation(first.invitation, { pairingPort: proxy.port }),
    [],
    {
      sample: async (pid) => {
        await atPair;
        const seen = await sampleProcess(pid);
        resume();
        return seen;
      },
    },
  );
  expect(paired.code).toBe(0);
  for (const value of secrets) expect(paired.sampled).not.toContain(value);
  const device = JSON.parse(paired.stdout);
  remember((await fixture.credential(client, device.serverId)).token);

  // Failed redemptions print no secret (a wrong secret, an expired-or-used invitation).
  const keeper = await fixture.invite(serverHome);
  remember(keeper.invitation);
  const wrong = alteredInvitation(keeper.invitation, {
    secret: wrongSecret(payloadOf(keeper.invitation).secret),
  });
  remember(wrong);
  for (const invitation of [wrong, first.invitation]) {
    const failed = await fixture.pair(fixture.home("failed"), "box", invitation);
    expect(failed.code).toBe(1);
    for (const value of secrets) expect(failed.stdout + failed.stderr).not.toContain(value);
  }

  // A lost invite-create answer: the resent request shows the record without the secret, and
  // the recovery is to cancel it and create a new one.
  const owner = await fixture.deviceClient(server, null);
  expect((await owner.client.connect()).ok).toBe(true);
  const lostInvite = await owner.client.call("auth.invite.create", { operationId: "s11-invite" });
  expect(lostInvite.ok).toBe(true);
  remember(lostInvite.value.secrets.invitation);
  const resent = await fixture.cove(["auth", "invite", "create", "--operation-id", "s11-invite"], {
    home: serverHome,
  });
  expect(resent.code).toBe(1);
  expect(JSON.parse(resent.stdout)).not.toHaveProperty("invitation");
  expect(resent.stderr).toContain("cancel it");
  const lostId = payloadOf(lostInvite.value.secrets.invitation).inviteId;
  expect(JSON.parse(resent.stdout).operation.result.inviteId).toBe(lostId);
  await fixture.coveJson(["auth", "invite", "cancel", lostId], { home: serverHome });
  const refusedLost = await fixture.pair(
    fixture.home("lost"),
    "box",
    lostInvite.value.secrets.invitation,
  );
  expect(refusedLost.code).toBe(1);
  const replacement = await fixture.invite(serverHome);
  remember(replacement.invitation);
  owner.client.dispose();

  // A lost rotation answer: the old token keeps working, the resent request shows no token, and
  // rotating again replaces the never-used token, which is then refused.
  const oldToken = (await fixture.credential(client, device.serverId)).token;
  const rotating = await fixture.deviceClient(server, oldToken);
  expect((await rotating.client.connect()).ok).toBe(true);
  const lostRotation = await rotating.client.call("auth.device.rotate", {
    operationId: "s11-rotate",
  });
  expect(lostRotation.ok).toBe(true);
  const lostToken = lostRotation.value.secrets.token;
  remember(lostToken);
  rotating.client.dispose();
  const resentRotation = await fixture.cove(
    ["--server", "box", "auth", "device", "rotate", "--operation-id", "s11-rotate"],
    { home: client },
  );
  expect(resentRotation.code).toBe(1);
  expect(resentRotation.stderr).toContain("the current token still works");
  expect((await fixture.credential(client, device.serverId)).token).toBe(oldToken);
  await fixture.coveJson(["--server", "box", "status"], { home: client });
  const rotated = await fixture.cove(["--server", "box", "auth", "device", "rotate"], {
    home: client,
  });
  expect(rotated.code).toBe(0);
  const newToken = (await fixture.credential(client, device.serverId)).token;
  remember(newToken);
  expect(newToken).not.toBe(oldToken);
  expect(newToken).not.toBe(lostToken);
  for (const value of secrets) expect(rotated.stdout + rotated.stderr).not.toContain(value);
  await fixture.coveJson(["--server", "box", "status"], { home: client });
  for (const stale of [oldToken, lostToken]) {
    const refusedClient = await fixture.deviceClient(server, stale);
    expect((await refusedClient.client.connect()).ok).toBe(false);
    refusedClient.client.dispose();
  }

  // The scan. Operation records first: every operation of the run, as `operation get` shows it.
  const operationIds = new Set(["s11-invite", "s11-rotate"]);
  for (const home of [serverHome, client])
    for (const { path } of await filesUnder(join(home, "cli", "operations")))
      operationIds.add(
        path
          .split("/")
          .pop()
          .replace(/\.json$/, ""),
      );
  const records = [];
  for (const id of operationIds)
    records.push((await fixture.cove(["operation", "get", id], { home: serverHome })).stdout);
  expect(records.join("")).toContain("s11-rotate");
  const credentialFile = join(client, "client", "servers", `${device.serverId}.json`);
  const scanned = [
    ...(await filesUnder(fixture.root)).filter(({ path }) => path !== credentialFile),
    { path: "server stderr", bytes: Buffer.from(server.stderr()) },
    { path: "operation records", bytes: Buffer.from(records.join("\n")) },
  ];
  // The database and its WAL are among the scanned files.
  expect(scanned.some(({ path }) => /\.(db|sqlite)(-wal)?$/.test(path))).toBe(true);
  const leaks = [];
  for (const { path, bytes } of scanned)
    for (const value of secrets) if (bytes.includes(Buffer.from(value))) leaks.push(path);
  expect(leaks).toEqual([]);
  // The token is kept on purpose in the credential file only.
  expect(await readFile(credentialFile, "utf8")).toContain(newToken);
}, 120_000);
