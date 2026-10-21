import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { ERROR_CODES, domainError } from "@cove/protocol/errors";
import { canonicalWriteIntent } from "@cove/protocol/rpc";
import { callHandler, dispatchRpc } from "../../dist/rpc/dispatch.js";
import { rpcBody } from "../../dist/transport/http-rpc.js";
import {
  executeDatabaseWriteCommitted,
  executeSecretWrite,
  recordedWrite,
} from "../../dist/operations/database-operations.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { ConfigService, sqliteConfigState } from "../../dist/store/config.js";
import { nextEntryConfig } from "../../dist/store/config-rules.js";
import { Store } from "../../dist/store/database.js";
import { prepareHome } from "../../dist/store/home.js";
import { loadOrCreateIdentity, recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";

// m2 T0: the principal and the secret boundary of the dispatch layer ("秘密与操作记录的分界"),
// the secret-returning database write and the entry configuration rules.

const encoder = new TextEncoder();
const encodeUtf8 = (text) => encoder.encode(text);
const authKey = "tskey-auth-k1234567890SECRET";
const invitation = `cove-invite:v1:${"I".repeat(80)}`;
const owner = { kind: "local-owner", principalId: "owner-1" };
const device = { kind: "device", principalId: "owner-1", deviceId: "dev-1" };
const core = {
  runtime: { composition: { serverId: "s1", budgets: { ...M0_LIMITS } } },
  operations: {},
  buildVersion: "author",
  principalId: "owner-1",
};
const record = (method, result = {}) => ({
  operationId: "o1",
  method,
  revision: 0,
  state: "succeeded",
  result,
});

describe("dispatch principal and permission", () => {
  it("refuses a local-owner method to a device before its module runs", async () => {
    let called = false;
    const handler = () => {
      called = true;
      return {};
    };
    const refused = await callHandler(handler, core, "server.tsnet.logout", {}, device);
    expect(refused).toEqual({
      error: expect.objectContaining({ kind: "FORBIDDEN", acceptance: "not-accepted" }),
    });
    expect(called).toBe(false);
    // The same through the real table: the device is refused, the local owner reaches the
    // placeholder module.
    const params = { operationId: "o1", secrets: { authKey } };
    expect(await dispatchRpc(core, "server.tsnet.login", params, device)).toMatchObject({
      error: { kind: "FORBIDDEN" },
    });
    expect(await dispatchRpc(core, "server.tsnet.login", params)).toMatchObject({
      error: { kind: "CAPABILITY_UNAVAILABLE" },
    });
  });

  it("passes the authenticated principal with the owner's principalId", async () => {
    const calls = [];
    const handler = (_core, call) => {
      calls.push(call);
      return { devices: [], currentDeviceId: null };
    };
    await callHandler(handler, core, "auth.device.list", {}, device);
    await callHandler(handler, core, "auth.device.list", {}, owner);
    expect(calls.map(({ principal, principalId }) => [principal, principalId])).toEqual([
      [device, "owner-1"],
      [owner, "owner-1"],
    ]);
    // Without a principal from the transport, the caller is the composition's local owner.
    const seen = [];
    const operations = { get: (principalId) => (seen.push(principalId), { error: {} }) };
    await dispatchRpc({ ...core, operations }, "operation.get", { operationId: "o1" });
    expect(seen).toEqual(["owner-1"]);
  });
});

describe("dispatch secret boundary", () => {
  it("hands a handler the params without secrets and the declared secrets apart", async () => {
    const calls = [];
    const handler = (_core, call) => {
      calls.push(call);
      return { operation: record("server.tsnet.login") };
    };
    await callHandler(
      handler,
      core,
      "server.tsnet.login",
      { operationId: "o1", secrets: { authKey } },
      owner,
    );
    expect(calls[0].params).toEqual({ operationId: "o1" });
    expect(calls[0].secrets).toEqual({ authKey });
    // A method that declares no input secret never passes one on.
    await callHandler(
      handler,
      core,
      "auth.invite.cancel",
      { operationId: "o1", inviteId: "inv-1", secrets: { authKey } },
      owner,
    );
    expect(calls[1].params).toEqual({ operationId: "o1", inviteId: "inv-1" });
    expect(calls[1]).not.toHaveProperty("secrets");
  });

  it("keeps output secrets only beside the record of a method that declares them", async () => {
    const created = record("auth.invite.create", { inviteId: "inv-1" });
    const answer = await callHandler(
      () => ({ operation: created, secrets: { invitation } }),
      core,
      "auth.invite.create",
      { operationId: "o1" },
      owner,
    );
    expect(answer).toEqual({ operation: created, secrets: { invitation } });
    const cancelled = record("auth.invite.cancel", { inviteId: "inv-1" });
    const dropped = await callHandler(
      () => ({ operation: cancelled, secrets: { invitation } }),
      core,
      "auth.invite.cancel",
      { operationId: "o1", inviteId: "inv-1" },
      owner,
    );
    expect(dropped).toEqual({ operation: cancelled });
  });

  it("refuses an answer that holds a secret outside its secrets member", async () => {
    // An input secret copied into the record.
    await expect(
      callHandler(
        () => ({ operation: record("server.tsnet.login", { inviteId: "x" }), note: authKey }),
        core,
        "server.tsnet.login",
        { operationId: "o1", secrets: { authKey } },
        owner,
      ),
    ).rejects.toThrow(/holds a secret/);
    // An output secret also stored in the record.
    await expect(
      callHandler(
        () => ({
          operation: {
            ...record("auth.invite.create"),
            progress: { completedSteps: [invitation] },
          },
          secrets: { invitation },
        }),
        core,
        "auth.invite.create",
        { operationId: "o1" },
        owner,
      ),
    ).rejects.toThrow(/holds a secret/);
  });

  it("never echoes a secret in the HTTP answer and carries the principal through it", async () => {
    const body = (method, params) =>
      encoder.encode(JSON.stringify({ jsonrpc: "2.0", id: "q1", method, params }));
    const params = { operationId: "o1", secrets: { authKey } };
    const asOwner = await rpcBody(core, body("server.tsnet.login", params));
    expect(asOwner.body).not.toContain(authKey);
    expect(JSON.parse(asOwner.body).error.code).toBe(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    const asDevice = await rpcBody(core, body("server.tsnet.login", params), undefined, device);
    expect(JSON.parse(asDevice.body).error.code).toBe(ERROR_CODES.FORBIDDEN);
    expect(asDevice.body).not.toContain(authKey);
  });
});

describe("HTTP answers behind the secret boundary", () => {
  // One HTTP call whose method is served by `handler` behind the real boundary (callHandler).
  async function answer(method, params, handler) {
    const bytes = encoder.encode(JSON.stringify({ jsonrpc: "2.0", id: "q1", method, params }));
    const route = (routed, name, validated, principal) =>
      callHandler(handler, routed, name, validated, principal ?? owner);
    const { body } = await rpcBody(core, bytes, undefined, undefined, route);
    return { body, parsed: JSON.parse(body) };
  }
  const login = { operationId: "o1", secrets: { authKey } };
  const loginUrl = "https://login.example/a/1234567890";

  it("refuses a refusal whose details carry an input secret", async () => {
    const run = { serverId: "s1", relayInstanceId: "i1", runId: authKey };
    const { body, parsed } = await answer("server.tsnet.login", login, () => ({
      error: domainError("LIVE_RUNS_PRESENT", "not-accepted", undefined, { runs: [run] }),
    }));
    expect(parsed.error.code).toBe(-32603);
    expect(body).not.toContain(authKey);
  });

  it("refuses a refusal that carries an output secret, with or without its details", async () => {
    const token = `cove_d1_dev-1.${"T".repeat(43)}`;
    const secret = "T".repeat(43);
    const run = { serverId: "s1", relayInstanceId: "i1", runId: secret };
    const error = domainError("LIVE_RUNS_PRESENT", "not-accepted", undefined, { runs: [run] });
    for (const outcome of [
      { error, secrets: { token: `cove_d1_dev-1.${secret}` } },
      { error: { ...error, nested: { secrets: { token } } } },
      { error: domainError("BUSY"), secrets: { token } },
    ]) {
      const { body, parsed } = await answer(
        "auth.device.rotate",
        { operationId: "o1" },
        () => outcome,
      );
      expect(parsed.error.code).toBe(-32603);
      expect(body).not.toContain(secret);
    }
  });

  it("refuses a misplaced nested secret and undeclared output secret keys", async () => {
    const operation = record("server.tsnet.login", { secretDelivery: "first-response-only" });
    const token = `cove_d1_dev-1.${"T".repeat(43)}`;
    const nested = await answer("auth.device.rotate", { operationId: "o1" }, () => ({
      operation: { ...record("auth.device.rotate"), result: { secrets: { token } } },
    }));
    expect(nested.parsed.error.code).toBe(-32603);
    expect(nested.body).not.toContain(token);
    const extra = await answer("server.tsnet.login", login, () => ({
      operation,
      secrets: { loginUrl, authKey },
    }));
    expect(extra.parsed.error.code).toBe(-32603);
    expect(extra.body).not.toContain(authKey);
    // The exact declaration passes, with its secret beside the record.
    const exact = await answer("server.tsnet.login", login, () => ({
      operation,
      secrets: { loginUrl },
    }));
    expect(exact.parsed.result).toEqual({ operation, secrets: { loginUrl } });
  });

  it("serializes the schema-parsed result, never the handler's object", async () => {
    const operation = record("auth.invite.cancel", { inviteId: "inv-1" });
    const { body, parsed } = await answer(
      "auth.invite.cancel",
      { operationId: "o1", inviteId: "inv-1" },
      () => ({ operation: { ...operation, internal: "server-only-note" }, debug: "x" }),
    );
    expect(parsed.result).toEqual({ operation });
    expect(body).not.toContain("server-only-note");
    expect(body).not.toContain("debug");
  });

  it("finds a secret that JSON escapes", async () => {
    const quoted = 'tskey-"quoted\\key-1234567890';
    const { body, parsed } = await answer(
      "server.tsnet.login",
      { operationId: "o1", secrets: { authKey: quoted } },
      () => ({ operation: record("server.tsnet.login"), note: `copied ${quoted}` }),
    );
    expect(parsed.error.code).toBe(-32603);
    expect(body).not.toContain("quoted");
  });
});

describe("executeSecretWrite", () => {
  // Receipts that commit the first request and answer later ones from the stored record.
  function receipts() {
    const stored = new Map();
    const lookups = [];
    return {
      lookups,
      stored,
      lookup: async (key, intent) => {
        lookups.push(intent);
        const found = stored.get(key.operationId);
        return found ? { kind: "existing", record: found } : { kind: "reserve" };
      },
      prepare: async () => ({ cancel: () => {} }),
      write: async ({ key }) => {
        const operation = record("auth.invite.create", {
          inviteId: "inv-1",
          secretDelivery: "first-response-only",
        });
        stored.set(key.operationId, operation);
        return { operation, committed: true };
      },
    };
  }
  const apply = { name: "auth.invite.insert", args: {} };

  it("returns the secret to the committing call only, and never fingerprints it", async () => {
    const backend = receipts();
    const context = { serverId: "s1", receipts: backend, encodeUtf8 };
    const params = { operationId: "o1" };
    const first = await executeSecretWrite(
      context,
      "owner-1",
      "auth.invite.create",
      params,
      apply,
      {
        invitation,
      },
    );
    expect(first.secrets).toEqual({ invitation });
    expect(JSON.stringify(first.operation)).not.toContain(invitation);
    const resent = await executeSecretWrite(
      context,
      "owner-1",
      "auth.invite.create",
      params,
      apply,
      { invitation: `cove-invite:v1:${"J".repeat(80)}` },
    );
    expect(resent).toEqual({ operation: first.operation });
    expect(backend.lookups.join()).not.toContain("cove-invite");
  });

  it("refuses missing or malformed output secrets before anything is looked up", async () => {
    const backend = receipts();
    const context = { serverId: "s1", receipts: backend, encodeUtf8 };
    for (const secrets of [{ invitation: "not-an-invitation" }, {}])
      await expect(
        executeSecretWrite(
          context,
          "owner-1",
          "auth.invite.create",
          { operationId: "o1" },
          apply,
          secrets,
        ),
      ).rejects.toThrow(/cannot return these secrets/);
    expect(backend.lookups).toEqual([]);
    expect(backend.stored.size).toBe(0);
  });

  it("hands the call's secret values to the receipt transaction and fails on its refusal", async () => {
    const requests = [];
    const backend = {
      ...receipts(),
      write: async (request) => (requests.push(request), { secretRefused: true }),
    };
    const context = { serverId: "s1", receipts: backend, encodeUtf8 };
    const loginUrl = "https://login.example/a/1234567890";
    await expect(
      executeSecretWrite(
        context,
        "owner-1",
        "server.tsnet.login",
        { operationId: "o1" },
        apply,
        { loginUrl },
        { authKey },
      ),
    ).rejects.toThrow(/would hold a secret/);
    expect(requests[0].secrets).toEqual([loginUrl, authKey]);
  });

  it("refuses params that still carry secrets and undeclared secrets", async () => {
    const context = { serverId: "s1", receipts: receipts(), encodeUtf8 };
    await expect(
      executeSecretWrite(
        context,
        "owner-1",
        "server.tsnet.login",
        { operationId: "o1", secrets: { authKey } },
        apply,
        { loginUrl: "https://login.example/a/1234567890" },
      ),
    ).rejects.toThrow(/cannot return these secrets/);
    await expect(
      executeSecretWrite(context, "owner-1", "auth.invite.create", { operationId: "o1" }, apply, {
        token: "x",
      }),
    ).rejects.toThrow(/cannot return these secrets/);
    await expect(
      executeSecretWrite(
        context,
        "owner-1",
        "auth.invite.cancel",
        { operationId: "o1", inviteId: "i" },
        apply,
        {},
      ),
    ).rejects.toThrow(/cannot return these secrets/);
  });
});

describe("durable secret boundary", () => {
  const directories = [];
  const stores = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("rolls back a write whose record would hold a secret, leaving nothing to read or replay", async () => {
    const path = await mkdtemp(join(tmpdir(), "cove-secret-store-"));
    directories.push(path);
    const layout = await prepareHome(join(path, "home"));
    const store = await Store.open({
      databasePath: layout.databasePath,
      backupDirectory: layout.backupDirectory,
    });
    stores.push(store);
    await loadOrCreateIdentity(store);
    const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
    const composition = new RuntimeComposition("server", "instance", { ...M0_LIMITS }, bytes);
    await recordInstanceStart(store, "instance", 1);
    const receipts = new OperationReceipts(
      composition,
      encodeUtf8,
      new SqliteReceiptBackend(store, "instance", () => 1),
    );
    const config = new ConfigService({
      home: "/home/owner/.cove",
      serverId: "server",
      receipts,
      state: sqliteConfigState(store),
      encodeUtf8,
    });
    const context = { serverId: "server", receipts, encodeUtf8 };
    // A secret that a schema-valid record field holds: here the operation ID, which every record
    // of the operation names.
    const secret = "op-secret-1234567890abcdef";
    const params = { operationId: secret, patch: { workspaceRoot: "/srv/work" } };
    const apply = { name: "config.set", args: { patch: { workspaceRoot: "/srv/work" }, at: 1 } };
    await expect(
      executeDatabaseWriteCommitted(context, "p", "config.set", params, apply, [secret]),
    ).rejects.toThrow(/would hold a secret/);
    // Neither the receipt nor the change was stored: a query and a resend find nothing to return.
    const key = { serverId: "server", principalId: "p", operationId: secret };
    expect(await receipts.get(key)).toBeNull();
    expect(await recordedWrite(context, "p", "config.set", params)).toBeNull();
    expect((await config.record()).revision).toBe(0);
    const request = {
      key,
      canonicalIntent: canonicalWriteIntent("config.set", params, encodeUtf8),
      method: "config.set",
      apply,
    };
    expect(await receipts.write({ ...request, secrets: [secret] })).toEqual({
      secretRefused: true,
    });
    expect(await receipts.get(key)).toBeNull();
    // The same write without that secret commits: the refusal was the secret check alone.
    expect(await receipts.write(request)).toMatchObject({ committed: true });
    receipts.dispose();
  });
});

describe("entry configuration rules", () => {
  const current = {
    revision: 3,
    businessPort: 7000,
    pairingPort: 7001,
    sshTarget: null,
    tsnetHostname: null,
  };

  it("applies a patch and says when it takes effect", () => {
    expect(nextEntryConfig(current, { patch: { sshTarget: "devbox" } })).toEqual({
      next: { ...current, revision: 4, sshTarget: "devbox" },
      result: { resource: { kind: "config", id: "entry", revision: 4 } },
    });
    expect(
      nextEntryConfig(current, { expectedRevision: 3, patch: { businessPort: 7100 } }),
    ).toEqual({
      next: { ...current, revision: 4, businessPort: 7100 },
      result: {
        resource: { kind: "config", id: "entry", revision: 4 },
        appliesAfterRestart: true,
      },
    });
    // Setting a field to its current value changes nothing that needs a restart.
    expect(nextEntryConfig(current, { patch: { pairingPort: 7001 } }).result).not.toHaveProperty(
      "appliesAfterRestart",
    );
  });

  it("refuses a stale revision and one port for both listeners", () => {
    expect(nextEntryConfig(current, { expectedRevision: 2, patch: { sshTarget: null } })).toEqual({
      error: expect.objectContaining({ kind: "REVISION_CONFLICT" }),
    });
    expect(nextEntryConfig(current, { patch: { pairingPort: 7000 } })).toEqual({
      error: expect.objectContaining({ kind: "INVALID_ARGUMENT" }),
    });
  });
});
