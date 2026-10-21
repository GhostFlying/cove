import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  alteredInvitation,
  connectable,
  createAuthFixture,
  payloadOf,
  waitUntilClosed,
} from "./auth-fixtures.mjs";

// m2 S12 (a lost pairing answer, and restarts), against the compiled CLI and server. A lost
// answer is not retried (D6): the invitation is used up, the device it created is listed
// never-connected and can be revoked, and a new invitation pairs. Open invitations survive a
// kill -9 (the listener reopens on their port); a redeemed one does not reopen the listener.

let fixture;

beforeEach(async () => {
  fixture = await createAuthFixture();
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

async function savedServers(home) {
  try {
    return await readdir(join(home, "client", "servers"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("a lost redemption answer uses up the invitation and leaves a revocable never-connected device", async () => {
  const serverHome = fixture.home("server");
  await fixture.startAuthServer(serverHome);
  const created = await fixture.invite(serverHome);
  const { pairingPort, secret } = payloadOf(created.invitation);
  // The client reaches the listener through a proxy that drops the redemption answer after the
  // server sent it.
  const proxy = await fixture.pairingProxy(pairingPort, "drop");
  const proxied = alteredInvitation(created.invitation, { pairingPort: proxy.port });
  const client = fixture.home("client");

  const lost = await fixture.pair(client, "box", proxied);
  expect(lost.code).toBe(1);
  expect(lost.stdout).toBe("");
  expect(lost.stderr).toContain("the pairing answer was lost");
  expect(lost.stderr).toContain("never-connected");
  expect(lost.stdout + lost.stderr).not.toContain(secret);
  expect(proxy.seen).toEqual(["/bootstrap", "/pair"]);
  expect(await savedServers(client)).toEqual([]);

  // The redemption committed: the only invitation is used up and the listener closed with it.
  await waitUntilClosed(pairingPort);
  const retry = await fixture.pair(client, "box", created.invitation);
  expect(retry.code).toBe(1);
  expect(retry.stdout).toBe("");
  expect(retry.stdout + retry.stderr).not.toContain(secret);
  const { invitations } = await fixture.coveJson(["auth", "invite", "list"], { home: serverHome });
  expect(invitations).toEqual([expect.objectContaining({ state: "redeemed" })]);

  // The device it created never connected, and revoking it removes it from the active devices.
  const { devices } = await fixture.coveJson(["auth", "device", "list"], { home: serverHome });
  expect(devices).toEqual([
    expect.objectContaining({ neverConnected: true, lastUsedAtMs: null, revokedAtMs: null }),
  ]);
  expect(devices[0].deviceId).toBe(invitations[0].redeemedDeviceId);
  await fixture.coveJson(["auth", "device", "revoke", devices[0].deviceId], { home: serverHome });
  expect(
    (await fixture.coveJson(["auth", "device", "list"], { home: serverHome })).devices,
  ).toEqual([]);

  // A new invitation pairs.
  const fresh = await fixture.invite(serverHome);
  const paired = await fixture.pairOk(client, "box", fresh.invitation);
  expect(paired.deviceId).not.toBe(devices[0].deviceId);
  expect(
    (await fixture.coveJson(["--server", "box", "auth", "device", "list"], { home: client }))
      .currentDeviceId,
  ).toBe(paired.deviceId);
});

test("after kill -9 an open invitation reopens the listener on its port and still pairs", async () => {
  const serverHome = fixture.home("server");
  const first = await fixture.startAuthServer(serverHome);
  const created = await fixture.invite(serverHome);
  const { pairingPort } = payloadOf(created.invitation);
  expect(await connectable(pairingPort)).toBe(true);
  await fixture.killServer(first);
  expect(await connectable(pairingPort)).toBe(false);

  await fixture.startAuthServer(serverHome);
  expect(await connectable(pairingPort)).toBe(true);
  const client = fixture.home("client");
  const paired = await fixture.pairOk(client, "box", created.invitation);
  await waitUntilClosed(pairingPort);
  expect(
    (await fixture.coveJson(["--server", "box", "auth", "device", "list"], { home: client }))
      .currentDeviceId,
  ).toBe(paired.deviceId);
});

test("after a redeemed invitation a restart keeps the listener closed", async () => {
  const serverHome = fixture.home("server");
  const first = await fixture.startAuthServer(serverHome);
  const created = await fixture.invite(serverHome);
  const { pairingPort } = payloadOf(created.invitation);
  await fixture.pairOk(fixture.home("client"), "box", created.invitation);
  await waitUntilClosed(pairingPort);
  await fixture.killServer(first);

  await fixture.startAuthServer(serverHome);
  expect(await connectable(pairingPort)).toBe(false);
  const { invitations } = await fixture.coveJson(["auth", "invite", "list"], { home: serverHome });
  expect(invitations).toEqual([expect.objectContaining({ state: "redeemed" })]);
  // The device survived the restart.
  const { devices } = await fixture.coveJson(["auth", "device", "list"], { home: serverHome });
  expect(devices).toEqual([expect.objectContaining({ neverConnected: true })]);
});
