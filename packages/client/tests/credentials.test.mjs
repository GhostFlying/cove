import { expect, test } from "vitest";
import { createClient, credentialHeaders, credentialSupplier } from "@cove/client";
import { createDefaultScheduler, createUtf8Codec } from "@cove/client/web-ports";

// m2 T0: the injected credential provider. The client derives the wire form of either credential
// kind, asks the provider again for every attempt, and sends nothing when it gets a malformed one.

const localSecret = "L".repeat(43);
const deviceToken = `cove_d1_dev-1.${"t".repeat(43)}`;

test("either credential kind maps to the bearer header and the terminal secret", () => {
  expect(credentialHeaders({ kind: "local-secret", secret: localSecret })).toEqual({
    authorization: `Bearer ${localSecret}`,
    terminalSecret: localSecret,
  });
  expect(credentialHeaders({ kind: "device-token", token: deviceToken })).toEqual({
    authorization: `Bearer ${deviceToken}`,
    terminalSecret: deviceToken,
  });
  // A value of the other kind, or no credential at all, is malformed.
  for (const credential of [
    { kind: "local-secret", secret: deviceToken },
    { kind: "device-token", token: localSecret },
    { kind: "device-token", token: "cove_d1_x.short" },
    { kind: "password", secret: localSecret },
    null,
  ])
    expect(credentialHeaders(credential)).toBeNull();
});

test("the supplier asks the provider each time, with the bound server", async () => {
  const requests = [];
  let token = deviceToken;
  const supplier = credentialSupplier((request) => {
    requests.push(request);
    return { kind: "device-token", token };
  }, "server-1");
  expect((await supplier()).terminalSecret).toBe(deviceToken);
  token = `cove_d1_dev-1.${"u".repeat(43)}`;
  expect((await supplier()).terminalSecret).toBe(token);
  expect(requests).toEqual([{ serverId: "server-1" }, { serverId: "server-1" }]);
  const broken = credentialSupplier(() => ({ kind: "device-token", token: "nope" }), "s");
  await expect(broken()).rejects.toThrow(/malformed credential/);
  await expect(broken()).rejects.not.toThrow(/nope/);
});

function client(provider) {
  const sent = { http: [], terminal: [] };
  const created = createClient({
    expectedServerId: "server-1",
    expectedRelayInstanceId: "instance-1",
    buildVersion: "0.0.0+0123456789abcdef",
    credentials: credentialSupplier(provider, "server-1"),
    codec: createUtf8Codec(),
    createOpaqueId: () => "id-1",
    scheduler: createDefaultScheduler(),
    connectionTimeoutMs: 200,
    http: {
      post: (request) => {
        sent.http.push(request);
        return { cancel: () => "not-sent" };
      },
    },
    terminal: {
      open: (callbacks) => {
        callbacks.onOpen({
          send: (message) => {
            sent.terminal.push(message);
            return "handed-off";
          },
          close: () => {},
          dispose: () => {},
        });
        return { cancel: () => "not-sent" };
      },
    },
  });
  return { created, sent };
}

test("a client sends a device token on both channels and nothing for a malformed one", async () => {
  const good = client(() => ({ kind: "device-token", token: deviceToken }));
  const pending = good.created.connect();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(good.sent.http[0].headers.Authorization).toBe(`Bearer ${deviceToken}`);
  expect(JSON.parse(good.sent.terminal[0]).secret).toBe(deviceToken);
  good.created.dispose();
  await pending;

  const bad = client(() => ({ kind: "device-token", token: localSecret }));
  const outcome = await bad.created.connect();
  expect(outcome).toEqual({ ok: false, error: { category: "local", reason: "credential" } });
  expect(bad.sent).toEqual({ http: [], terminal: [] });
  bad.created.dispose();
});
