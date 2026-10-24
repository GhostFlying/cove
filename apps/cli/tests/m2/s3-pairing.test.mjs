import { createServer } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import {
  alteredInvitation,
  connectable,
  createAuthFixture,
  payloadOf,
  SSH_TARGET,
  waitUntilClosed,
  wrongSecret,
} from "./auth-fixtures.mjs";

// m2 S3 (pairing) over the loopback entry, against the compiled CLI and server: the pairing
// listener exists only while an invitation is open, a second client pairs and calls business
// methods, every refusal is the same answer, five wrong secrets void an invitation, and a paired
// device can invite another one.

let fixture;

beforeEach(async () => {
  fixture = await createAuthFixture();
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

// The one refusal of an unusable invitation, whatever the reason (D6).
const REFUSAL = "the server refused the invitation";

async function refused(home, alias, invitation) {
  const result = await fixture.pair(home, alias, invitation);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(REFUSAL);
  expect(result.stderr).toContain("INVITATION_UNAVAILABLE");
  const { secret } = payloadOf(invitation);
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(result.stdout + result.stderr).not.toContain(invitation);
  return result.stderr;
}

async function inviteStates(home) {
  const { invitations } = await fixture.coveJson(["auth", "invite", "list"], { home });
  return Object.fromEntries(invitations.map((row) => [row.inviteId, row.state]));
}

test("a local-only invitation pairs an independent device without remote entry configuration", async () => {
  const home = fixture.home("local-server");
  await fixture.startAuthServer(home, [], { sshTarget: null });
  const { invitation } = await fixture.invite(home);
  const payload = payloadOf(invitation);
  expect(payload.entries).toEqual({});
  expect(await connectable(payload.pairingPort)).toBe(true);

  // Missing explicit entries and a wrong server identity are all refused before redemption.
  // The same one-use invitation remains open afterwards, proving none consumed its secret.
  for (const via of ["ssh", "tsnet"]) {
    const result = await fixture.pair(fixture.home(`missing-${via}`), "local", invitation, [
      "--via",
      via,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ENTRY_UNAVAILABLE");
    expect(result.stdout + result.stderr).not.toContain(payload.secret);
  }
  const mismatch = await fixture.pair(
    fixture.home("wrong-local-identity"),
    "local",
    alteredInvitation(invitation, { serverId: "another-server" }),
  );
  expect(mismatch.code).toBe(1);
  expect(mismatch.stderr).toContain("SERVER_ID_MISMATCH");
  expect(mismatch.stdout + mismatch.stderr).not.toContain(payload.secret);
  expect((await inviteStates(home))[payload.inviteId]).toBe("open");

  const client = fixture.home("local-desktop-client");
  const paired = await fixture.pairOk(client, "local", invitation, ["--name", "Desktop"]);
  expect(paired).toMatchObject({ serverId: payload.serverId, defaultEntry: "loopback" });
  await waitUntilClosed(payload.pairingPort);
  const devices = await fixture.coveJson(["--server", "local", "auth", "device", "list"], {
    home: client,
  });
  expect(devices.currentDeviceId).toBe(paired.deviceId);
  expect(devices.devices).toEqual([
    expect.objectContaining({ deviceId: paired.deviceId, name: "Desktop", neverConnected: false }),
  ]);
  expect(await fixture.coveJson(["--server", "local", "status"], { home: client })).toBeTruthy();
});

test("a client pairs, calls business methods, and every unusable invitation gets the same refusal", async () => {
  const serverHome = fixture.home("server");
  const pairingPort = await freePort();
  await fixture.startAuthServer(serverHome, ["--pairing-port", String(pairingPort)]);
  // No open invitation: no pairing listener.
  expect(await connectable(pairingPort)).toBe(false);

  // E expires first (the shortest lifetime); L outlives it so the listener stays open to answer
  // the expired redemption, then expires itself and closes the listener.
  // Taken before the invitation exists: the server stamps its expiry after this, so the lifetime
  // measured below can only be longer than the server's, never shorter by the CLI's exit time.
  const created = Date.now();
  const expiring = await fixture.invite(serverHome, ["--ttl-minutes", "1"]);
  expect(expiring.operation.state).toBe("succeeded");
  expect(expiring.operation.result).toMatchObject({ secretDelivery: "first-response-only" });
  const payload = payloadOf(expiring.invitation);
  expect(payload).toMatchObject({ pairingPort, entries: { ssh: { target: SSH_TARGET } } });
  expect(await connectable(pairingPort)).toBe(true);

  // Pairing, and a business call with the new device's token.
  const used = await fixture.invite(serverHome);
  const client = fixture.home("client");
  const paired = await fixture.pairOk(client, "box", used.invitation, ["--name", "laptop"]);
  expect(paired).toMatchObject({
    alias: "box",
    serverId: payload.serverId,
    defaultEntry: "loopback",
  });
  expect(paired).not.toHaveProperty("token");
  const listed = await fixture.coveJson(["--server", "box", "auth", "device", "list"], {
    home: client,
  });
  expect(listed.currentDeviceId).toBe(paired.deviceId);
  expect(listed.devices).toEqual([
    expect.objectContaining({ deviceId: paired.deviceId, name: "laptop", neverConnected: false }),
  ]);
  const status = await fixture.coveJson(["--server", "box", "status"], { home: client });
  expect(status).toBeTruthy();
  // The owner sees the same device.
  const owner = await fixture.coveJson(["auth", "device", "list"], { home: serverHome });
  expect(owner.currentDeviceId).toBeNull();
  expect(owner.devices.map((device) => device.deviceId)).toEqual([paired.deviceId]);
  // Other invitations are still open, so the listener stays.
  expect(await connectable(pairingPort)).toBe(true);

  // Reuse, cancellation and expiry all get the same refusal.
  const reuse = await refused(fixture.home("c2"), "box", used.invitation);
  const cancelled = await fixture.invite(serverHome);
  await fixture.coveJson(["auth", "invite", "cancel", payloadOf(cancelled.invitation).inviteId], {
    home: serverHome,
  });
  const afterCancel = await refused(fixture.home("c3"), "box", cancelled.invitation);
  const later = await fixture.invite(serverHome, ["--ttl-minutes", "1"]);
  const laterId = payloadOf(later.invitation).inviteId;
  await waitFor(
    "the first invitation to expire",
    async () => (await inviteStates(serverHome))[payload.inviteId] === "expired",
    90_000,
  );
  expect(Date.now() - created).toBeGreaterThanOrEqual(60_000);
  expect((await inviteStates(serverHome))[laterId]).toBe("open");
  const afterExpiry = await refused(fixture.home("c4"), "box", expiring.invitation);
  expect(afterCancel).toBe(reuse);
  expect(afterExpiry).toBe(reuse);

  // The last open invitation expiring closes the listener; the paired device is unaffected.
  await waitUntilClosed(pairingPort);
  expect((await inviteStates(serverHome))[laterId]).toBe("expired");
  expect(
    (await fixture.coveJson(["--server", "box", "auth", "device", "list"], { home: client }))
      .currentDeviceId,
  ).toBe(paired.deviceId);
}, 180_000);

test("the listener closes when the last invitation is redeemed or cancelled, without touching runs or connections", async () => {
  const serverHome = fixture.home("server");
  await fixture.startAuthServer(serverHome);
  const run = await fixture.coveJson(
    ["terminal", "create", "--cwd", fixture.root, "--", "/bin/sh", "-c", "exec sleep 600"],
    { home: serverHome },
  );

  const first = await fixture.invite(serverHome);
  const port = payloadOf(first.invitation).pairingPort;
  expect(await connectable(port)).toBe(true);
  const client = fixture.home("client");
  await fixture.pairOk(client, "box", first.invitation);
  // Redeeming the only open invitation closed the listener.
  await waitUntilClosed(port);
  const runs = await fixture.coveJson(["--server", "box", "terminal", "list"], { home: client });
  expect(JSON.stringify(runs)).toContain(run.runId);

  // The listener opens and closes again (cancellation) without touching the device or the run.
  const second = await fixture.invite(serverHome);
  const secondPort = payloadOf(second.invitation).pairingPort;
  expect(await connectable(secondPort)).toBe(true);
  await fixture.coveJson(["auth", "invite", "cancel", payloadOf(second.invitation).inviteId], {
    home: serverHome,
  });
  await waitUntilClosed(secondPort);
  const got = await fixture.coveJson(["--server", "box", "terminal", "get", run.runId], {
    home: client,
  });
  expect(got).toMatchObject({ run: { runId: run.runId }, status: "live" });
});

test("five wrong secrets void an invitation, and its right secret is refused afterwards", async () => {
  const serverHome = fixture.home("server");
  await fixture.startAuthServer(serverHome);
  const target = await fixture.invite(serverHome);
  // Keeps the listener open after the target is voided.
  await fixture.invite(serverHome);
  const { secret, inviteId } = payloadOf(target.invitation);
  const wrong = alteredInvitation(target.invitation, { secret: wrongSecret(secret) });
  const answers = [];
  const states = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    states.push((await inviteStates(serverHome))[inviteId]);
    answers.push(await refused(fixture.home(`wrong-${attempt}`), "box", wrong));
  }
  // Open through the fourth wrong secret; the fifth voids it.
  expect(states).toEqual(["open", "open", "open", "open", "open"]);
  expect(new Set(answers).size).toBe(1);
  expect((await inviteStates(serverHome))[inviteId]).toBe("cancelled");
  expect(await refused(fixture.home("right"), "box", target.invitation)).toBe(answers[0]);
  expect(
    (await fixture.coveJson(["auth", "device", "list"], { home: serverHome })).devices,
  ).toEqual([]);
});

test("an invitation a paired device creates over RPC pairs another client", async () => {
  const serverHome = fixture.home("server");
  await fixture.startAuthServer(serverHome);
  const first = fixture.home("first");
  const paired = await fixture.pairOk(first, "box", (await fixture.invite(serverHome)).invitation);
  const remote = await fixture.coveJson(["--server", "box", "auth", "invite", "create"], {
    home: first,
  });
  expect(typeof remote.invitation).toBe("string");
  const second = fixture.home("second");
  const other = await fixture.pairOk(second, "box", remote.invitation, ["--name", "tablet"]);
  expect(other.deviceId).not.toBe(paired.deviceId);
  const { invitations } = await fixture.coveJson(["auth", "invite", "list"], { home: serverHome });
  expect(invitations).toContainEqual(
    expect.objectContaining({
      inviteId: payloadOf(remote.invitation).inviteId,
      state: "redeemed",
      createdByDeviceId: paired.deviceId,
      redeemedDeviceId: other.deviceId,
    }),
  );
  expect(
    (await fixture.coveJson(["--server", "box", "auth", "device", "list"], { home: second }))
      .currentDeviceId,
  ).toBe(other.deviceId);
});

test("duplicate aliases and server IDs give re-pair guidance without using the invitation", async () => {
  const serverHome = fixture.home("server");
  await fixture.startAuthServer(serverHome);
  const client = fixture.home("client");
  const paired = await fixture.pairOk(client, "box", (await fixture.invite(serverHome)).invitation);
  const saved = await fixture.credential(client, paired.serverId);
  const invitation = (await fixture.invite(serverHome)).invitation;
  const { inviteId } = payloadOf(invitation);

  // The existing alias is rejected before reading stdin: even absent invitation input gives the
  // useful guidance. A different alias reads a valid invitation, but never redeems it.
  for (const [alias, input, reason] of [
    ["box", "", "a server is already named box"],
    ["other", invitation, "this client is already paired with that server as box"],
  ]) {
    const result = await fixture.pair(client, alias, input);
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain(reason);
    expect(result.stderr).toContain(`entries: ${Object.keys(saved.entries).join(", ")}`);
    expect(result.stderr).toContain("cove remote remove box");
    expect(result.stderr).toContain(`revoke its device (${paired.deviceId}) on the server`);
    expect(result.stderr).toContain("The invitation was not used");
    expect((await inviteStates(serverHome))[inviteId]).toBe("open");
    expect(await fixture.credential(client, paired.serverId)).toEqual(saved);
  }
  expect(
    (await fixture.coveJson(["auth", "device", "list"], { home: serverHome })).devices.map(
      (device) => device.deviceId,
    ),
  ).toEqual([paired.deviceId]);
  // The same invitation is still redeemable by a different client.
  expect((await fixture.pairOk(fixture.home("other-client"), "box", invitation)).deviceId).not.toBe(
    paired.deviceId,
  );
});
