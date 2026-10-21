import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import {
  ADMISSION_STATUS,
  BootstrapFailureSchema,
  BootstrapIdentitySchema,
  BuildVersionSchema,
  CredentialSchema,
  DeviceTokenSchema,
  RendezvousSchema,
  WsBootstrapSchema,
  bootstrapFailure,
  bootstrapIdentity,
  formatBuildId,
  formatDeviceToken,
  isBuildId,
  parseCredential,
  validateWsFirstMessage,
} from "@cove/protocol/bootstrap";
import {
  AUTH_LIMITS,
  AuthInviteCreateParamsSchema,
  DeviceRecordSchema,
  EntrySetParamsSchema,
  InvitationPayloadSchema,
  InvitationStringSchema,
  SshTargetSchema,
  TsnetHostnameSchema,
} from "@cove/protocol/auth";
import {
  DOMAIN_ERROR_KINDS,
  DomainErrorSchema,
  ERROR_CODES,
  WS_CLOSE_CODES,
  closeCodeForError,
  domainError,
} from "@cove/protocol/errors";
import {
  RPC_METHODS,
  WRITE_RPC_METHODS,
  canonicalWriteIntent,
  composeRpcMethodResult,
  secretFields,
  splitSecrets,
  validateOperationRecord,
  validateRpcMethodParams,
} from "@cove/protocol/rpc";

// M2 T0 contract (docs/milestones/m2.md): credentials, build identity, pre-auth identity, the M2
// methods and errors, and the secret boundary of operation records.

const encoder = (text) => new TextEncoder().encode(text);
const localSecret = "L".repeat(43);
const deviceSecret = "d".repeat(42) + "Q";
const deviceToken = `cove_d1_dev-1.${deviceSecret}`;
const request = {
  type: "cove-bootstrap",
  bootstrapVersion: 1,
  protocolVersion: 2,
  buildVersion: "0.0.0+0123456789abcdef",
  capabilities: [],
  profiles: [],
  encodings: [],
};

test("the two credential kinds are disjoint and parse to their parts", () => {
  expect(parseCredential(localSecret)).toEqual({ kind: "local-secret", secret: localSecret });
  expect(parseCredential(deviceToken)).toEqual({
    kind: "device-token",
    deviceId: "dev-1",
    secret: deviceSecret,
  });
  expect(formatDeviceToken("dev-1", deviceSecret)).toBe(deviceToken);
  for (const malformed of [
    "",
    "short",
    `cove_d1_dev.1.${deviceSecret}`,
    `cove_d1_dev-1.${deviceSecret}x`,
    `cove_d1_.${deviceSecret}`,
    `cove_d2_dev-1.${deviceSecret}`,
    `${localSecret} `,
    42,
    null,
  ])
    expect(parseCredential(malformed)).toBeNull();
  expect(() => formatDeviceToken("dev.1", deviceSecret)).toThrow("Invalid device token parts");
  expect(() => formatDeviceToken("dev-1", "short")).toThrow("Invalid device token parts");
  // Either kind authenticates the terminal WebSocket; the rendezvous holds only the local one.
  for (const secret of [localSecret, deviceToken]) {
    expect(CredentialSchema.safeParse(secret).success).toBe(true);
    expect(validateWsFirstMessage({ ...request, secret }, 200, 1, true)).toEqual(request);
  }
  expect(WsBootstrapSchema.safeParse({ ...request, secret: "x.y" }).success).toBe(false);
  const rendezvous = {
    bootstrapVersion: 1,
    serverId: "s1",
    relayInstanceId: "i1",
    endpoint: "http://127.0.0.1:4096",
  };
  expect(RendezvousSchema.safeParse({ ...rendezvous, secret: localSecret }).success).toBe(true);
  expect(RendezvousSchema.safeParse({ ...rendezvous, secret: deviceToken }).success).toBe(false);
  expect(DeviceTokenSchema.safeParse(localSecret).success).toBe(false);
});

test("a build ID is the package version plus a 16-hex content digest", () => {
  const digest = "0123456789abcdef".repeat(4);
  expect(formatBuildId("0.0.0", digest)).toBe("0.0.0+0123456789abcdef");
  expect(isBuildId("0.0.0+0123456789abcdef")).toBe(true);
  for (const invalid of ["0.0.0", "0.0.0+0123", "0.0.0+0123456789ABCDEF", "+0123456789abcdef"])
    expect(isBuildId(invalid)).toBe(false);
  expect(() => formatBuildId("0.0.0", "not-hex")).toThrow("Invalid build identity");
  expect(() => formatBuildId("0.0.0", "abc")).toThrow("Invalid build identity");
  expect(() => formatBuildId("bad version", digest)).toThrow("Invalid build identity");
  // Other bounded build strings stay valid on the wire (test peers, the worker pipe).
  expect(BuildVersionSchema.safeParse("author").success).toBe(true);
});

test("the pre-auth identity carries only versions, build and server identity", () => {
  const identity = bootstrapIdentity(
    { ...request, expectedServerId: "other" },
    { serverId: "s1", relayInstanceId: "i1", buildVersion: "0.0.0+0123456789abcdef" },
  );
  expect(identity).toEqual({
    type: "cove-bootstrap-identity",
    bootstrapVersion: 1,
    protocolVersion: 2,
    buildVersion: "0.0.0+0123456789abcdef",
    serverId: "s1",
    relayInstanceId: "i1",
  });
  expect(BootstrapIdentitySchema.safeParse(identity).success).toBe(true);
  expect(
    bootstrapIdentity({ type: "x" }, { serverId: "s1", relayInstanceId: "i1", buildVersion: "b" }),
  ).toEqual(bootstrapFailure("BOOTSTRAP_UNSUPPORTED"));
  // Nothing beyond the declared fields is accepted from a server either.
  expect(
    BootstrapIdentitySchema.strict().safeParse({ ...identity, effectiveBudgets: M0_LIMITS })
      .success,
  ).toBe(false);
});

test("M2 error kinds are appended with their codes and next actions", () => {
  const m2 = [
    ["DEVICE_REVOKED", "reauthenticate"],
    ["INVITATION_UNAVAILABLE", "none"],
    ["INVITATION_NOT_FOUND", "refresh-resource"],
    ["DEVICE_NOT_FOUND", "refresh-resource"],
    ["SERVER_ID_MISMATCH", "none"],
    ["PEER_IDENTITY_MISMATCH", "none"],
    ["ENTRY_UNAVAILABLE", "none"],
    ["OPERATION_HISTORY_EXPIRED", "refresh-resource"],
  ];
  expect(DOMAIN_ERROR_KINDS.slice(42)).toEqual(m2.map(([kind]) => kind));
  m2.forEach(([kind, nextAction], index) => {
    const error = domainError(kind);
    expect(error).toMatchObject({ code: 1042 + index, nextAction, acceptance: "not-accepted" });
    expect(ERROR_CODES[kind]).toBe(1042 + index);
    expect(DomainErrorSchema.safeParse(error).success).toBe(true);
  });
  expect(closeCodeForError("DEVICE_REVOKED")).toBe(WS_CLOSE_CODES.policy);
  expect(BootstrapFailureSchema.safeParse(bootstrapFailure("DEVICE_REVOKED")).success).toBe(true);
  expect(ADMISSION_STATUS.revoked).toBe(401);
});

test("the method table declares every secret member and the local-only methods", () => {
  const declared = Object.fromEntries(
    Object.keys(RPC_METHODS)
      .map((method) => [method, secretFields(method)])
      .filter(([, fields]) => fields.input.length + fields.output.length > 0),
  );
  expect(declared).toEqual({
    "auth.invite.create": { input: [], output: ["invitation"] },
    "auth.device.rotate": { input: [], output: ["token"] },
    "server.tsnet.login": { input: ["authKey"], output: ["loginUrl"] },
  });
  expect(
    Object.entries(RPC_METHODS)
      .filter(([, spec]) => spec.permission === "local-owner")
      .map(([method]) => method),
  ).toEqual(["server.tsnet.login", "server.tsnet.logout"]);
  // A method that declares no input secret has no `secrets` member: validation strips one, so a
  // secret sent to the wrong method never reaches its handler.
  expect(
    validateRpcMethodParams("auth.invite.cancel", {
      operationId: "o1",
      inviteId: "inv-1",
      secrets: { authKey: "k" },
    })?.params,
  ).toEqual({ operationId: "o1", inviteId: "inv-1" });
  expect(RPC_METHODS["server.impact"].domain).toBe("service");
  expect(RPC_METHODS["server.tsnet.status"].domain).toBe("tsnet");
  expect(RPC_METHODS["entry.set"].domain).toBe("entry");
});

test("secrets never enter the fingerprint of a write", () => {
  const login = (secrets) => ({
    operationId: "o1",
    ...(secrets ? { secrets } : {}),
  });
  const withKey = canonicalWriteIntent(
    "server.tsnet.login",
    login({ authKey: "tskey-auth-SECRET1" }),
    encoder,
  );
  expect(withKey).not.toBeNull();
  expect(withKey).not.toContain("SECRET1");
  expect(withKey).not.toContain("secrets");
  // The same operation whatever key it carried, and with the key dropped (a CLI pending record).
  expect(
    canonicalWriteIntent("server.tsnet.login", login({ authKey: "tskey-auth-OTHER" }), encoder),
  ).toBe(withKey);
  expect(canonicalWriteIntent("server.tsnet.login", login(), encoder)).toBe(withKey);
  // Ordinary params still distinguish intents.
  expect(
    canonicalWriteIntent("auth.invite.create", { operationId: "o", ttlMs: 60_000 }, encoder),
  ).not.toBe(canonicalWriteIntent("auth.invite.create", { operationId: "o" }, encoder));
  expect(splitSecrets({ a: 1, secrets: { authKey: "k" } })).toEqual({
    value: { a: 1 },
    secrets: { authKey: "k" },
  });
  expect(splitSecrets({ a: 1 })).toEqual({ value: { a: 1 }, secrets: undefined });
});

test("a record never stores a secret, and an M2 record fits its budget", () => {
  const invitation = `cove-invite:v1:${"A".repeat(64)}`;
  const record = {
    operationId: "o1",
    method: "auth.invite.create",
    revision: 0,
    state: "succeeded",
    result: { inviteId: "inv-1", expiresAtMs: 1, secretDelivery: "first-response-only" },
  };
  // A field that is not declared (here a would-be secret) is stripped, never stored.
  const leaked = validateOperationRecord(
    { ...record, secrets: { invitation }, result: { ...record.result, invitation } },
    encoder,
  );
  expect(leaked).toEqual(record);
  expect(JSON.stringify(leaked)).not.toContain(invitation);
  // The live response of the committing call may carry the secret beside the record; a method
  // that declares no output secret drops one.
  expect(
    composeRpcMethodResult("auth.invite.create", { operation: record, secrets: { invitation } }),
  ).toEqual({ operation: record, secrets: { invitation } });
  const cancel = { ...record, method: "auth.invite.cancel", result: { inviteId: "inv-1" } };
  expect(
    composeRpcMethodResult("auth.invite.cancel", { operation: cancel, secrets: { invitation } }),
  ).toEqual({ operation: cancel });
  expect(
    composeRpcMethodResult("auth.invite.create", {
      operation: record,
      secrets: { invitation: "not-an-invitation" },
    }),
  ).toBeNull();
  // M2 references never share a record with mounts or a continue/abandon target.
  expect(
    validateOperationRecord(
      { ...record, result: { ...record.result, targetOperationId: "o0" } },
      encoder,
    ),
  ).toBeNull();
  const max = Number.MAX_SAFE_INTEGER;
  const id = (length) => "x".repeat(length);
  const largest = {
    operationId: id(128),
    method: "server.tsnet.logout",
    revision: max,
    state: "requires_attention",
    run: { serverId: id(128), relayInstanceId: id(128), runId: id(128) },
    result: {
      resource: { kind: "config", id: id(40), revision: max },
      workspaceRevision: max,
      inviteId: id(40),
      deviceId: id(40),
      expiresAtMs: max,
      secretDelivery: "first-response-only",
      unclosedConnections: 65_536,
      appliesAfterRestart: true,
    },
    progress: {
      completedSteps: Array.from({ length: 8 }, () => id(32)),
      remainingEffects: Array.from({ length: 8 }, () => id(32)),
      recoveryActions: ["continue", "abandon"],
    },
    error: domainError("OPERATION_HISTORY_EXPIRED", "unknown"),
  };
  expect(validateOperationRecord(largest, encoder)).toEqual(largest);
  expect(encoder(JSON.stringify(largest)).byteLength).toBeLessThanOrEqual(
    M0_LIMITS.operationRecordBytes,
  );
  expect(WRITE_RPC_METHODS).toContain("server.tsnet.logout");
});

test("M2 schemas bound third-party and operator input", () => {
  // An SSH target is passed to ssh as an argument: never an option, never whitespace.
  for (const valid of ["devbox", "me@devbox.example.com", "_alias", "a.b-c"])
    expect(SshTargetSchema.safeParse(valid).success).toBe(true);
  for (const invalid of ["-oProxyCommand=x", "me@-host", "a b", "a;b", "", "a\nb"])
    expect(SshTargetSchema.safeParse(invalid).success).toBe(false);
  expect(TsnetHostnameSchema.safeParse("cove-devbox").success).toBe(true);
  for (const invalid of ["-cove", "cove-", "Cove", "a.b", "x".repeat(64)])
    expect(TsnetHostnameSchema.safeParse(invalid).success).toBe(false);
  const payload = {
    serverId: "s1",
    inviteId: "inv-1",
    secret: deviceSecret,
    expiresAtMs: 1,
    pairingPort: 7001,
    entries: { ssh: { target: "devbox" } },
  };
  expect(InvitationPayloadSchema.safeParse(payload).success).toBe(true);
  expect(InvitationPayloadSchema.safeParse({ ...payload, entries: {} }).success).toBe(false);
  expect(InvitationPayloadSchema.safeParse({ ...payload, pairingPort: 80 }).success).toBe(false);
  expect(InvitationStringSchema.safeParse("cove-invite:v1:abc").success).toBe(true);
  expect(InvitationStringSchema.safeParse("cove-invite:v2:abc").success).toBe(false);
  expect(
    InvitationStringSchema.safeParse(`cove-invite:v1:${"a".repeat(AUTH_LIMITS.invitationChars)}`)
      .success,
  ).toBe(false);
  for (const ttlMs of [AUTH_LIMITS.invitationMinTtlMs - 1, AUTH_LIMITS.invitationMaxTtlMs + 1])
    expect(AuthInviteCreateParamsSchema.safeParse({ operationId: "o", ttlMs }).success).toBe(false);
  const device = {
    deviceId: "dev-1",
    revision: 0,
    name: "laptop",
    createdAtMs: 1,
    inviteId: "inv-1",
    lastUsedAtMs: null,
    lastEntry: null,
    neverConnected: true,
    revokedAtMs: null,
  };
  expect(DeviceRecordSchema.safeParse(device).success).toBe(true);
  expect(DeviceRecordSchema.safeParse({ ...device, neverConnected: false }).success).toBe(false);
  expect(DeviceRecordSchema.safeParse({ ...device, name: "a\u0007" }).success).toBe(false);
  expect(EntrySetParamsSchema.safeParse({ operationId: "o", patch: {} }).success).toBe(false);
  expect(
    EntrySetParamsSchema.safeParse({ operationId: "o", patch: { businessPort: null } }).success,
  ).toBe(true);
  expect(
    EntrySetParamsSchema.safeParse({ operationId: "o", patch: { businessPort: 80 } }).success,
  ).toBe(false);
});
