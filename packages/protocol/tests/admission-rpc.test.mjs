import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import {
  ADMISSION_STATUS,
  BootstrapRequestSchema,
  RendezvousSchema,
  WsBootstrapSchema,
  evaluateAdmission,
  evaluateWsUpgrade,
  negotiateBootstrap,
  validateWsFirstMessage,
} from "@cove/protocol/bootstrap";

const request = {
  type: "cove-bootstrap",
  bootstrapVersion: 1,
  protocolVersion: 1,
  buildVersion: "client-build",
  capabilities: [
    "terminal-framing-v1",
    "logical-grid-recovery-v1",
    "terminal-preview-v1",
    "future-optional",
  ],
  profiles: ["pragmatic-logical-grid-v1"],
  encodings: ["vt-checkpoint-tail-v1"],
};
const server = {
  serverId: "s1",
  relayInstanceId: "i1",
  buildVersion: "server-build",
  effectiveBudgets: M0_LIMITS,
};
const allowedOrigins = ["http://127.0.0.1:4173"];
const admission = {
  method: "POST",
  path: "/bootstrap",
  host: "127.0.0.1:4096",
  boundAuthority: "127.0.0.1:4096",
  origin: allowedOrigins[0],
  allowedOrigins,
  browser: true,
  authenticated: true,
  bodyBytes: 100,
  serverId: "s1",
  relayInstanceId: "i1",
  capacityAvailable: true,
};

test("bootstrap separates protocol and build and intersects only known capabilities", () => {
  const result = negotiateBootstrap(request, server);
  expect(result.type).toBe("cove-bootstrap-result");
  expect(result.buildVersion).toBe("server-build");
  expect(result.capabilities).toEqual([
    "terminal-framing-v1",
    "logical-grid-recovery-v1",
    "terminal-preview-v1",
  ]);
  expect(result.capabilities).not.toContain("future-optional");
});

test("bootstrap requires both baseline capabilities, profile and encoding", () => {
  expect(
    negotiateBootstrap({ ...request, capabilities: ["terminal-framing-v1"] }, server).kind,
  ).toBe("CAPABILITY_UNAVAILABLE");
  expect(negotiateBootstrap({ ...request, profiles: [] }, server).kind).toBe("PROFILE_UNSUPPORTED");
  expect(negotiateBootstrap({ ...request, encodings: [] }, server).kind).toBe(
    "PROFILE_UNSUPPORTED",
  );
});

test("bootstrap identity and protocol mismatch never return run inventory", () => {
  for (const altered of [
    { protocolVersion: 2 },
    { expectedServerId: "s2" },
    { expectedRelayInstanceId: "i2" },
  ]) {
    const result = negotiateBootstrap({ ...request, ...altered }, server);
    expect(result.type).toBe("cove-bootstrap-error");
    expect(JSON.stringify(result)).not.toMatch(/runId|executable|cwd/);
  }
  expect(negotiateBootstrap({ ...request, bootstrapVersion: 2 }, server).kind).toBe(
    "BOOTSTRAP_UNSUPPORTED",
  );
});

test("HTTP admission binds exact numeric authority, origin and authenticated verdict", () => {
  expect(evaluateAdmission(admission)).toBe("accepted");
  expect(evaluateAdmission({ ...admission, host: "localhost:4096" })).toBe("forbidden");
  expect(evaluateAdmission({ ...admission, origin: "null" })).toBe("forbidden");
  expect(evaluateAdmission({ ...admission, origin: undefined })).toBe("forbidden");
  expect(evaluateAdmission({ ...admission, authenticated: false })).toBe("unauthenticated");
  expect(ADMISSION_STATUS.unauthenticated).toBe(401);
});

test("native CLI may omit Origin but still requires authentication", () => {
  const cli = { ...admission, browser: false, origin: undefined };
  expect(evaluateAdmission(cli)).toBe("accepted");
  expect(evaluateAdmission({ ...cli, authenticated: false })).toBe("unauthenticated");
});

test("RPC admission requires instance and protocol headers before dispatch", () => {
  const rpc = {
    ...admission,
    path: "/rpc",
    expectedProtocol: 1,
    expectedServerId: "s1",
    expectedRelayInstanceId: "i1",
  };
  expect(evaluateAdmission(rpc)).toBe("accepted");
  expect(evaluateAdmission({ ...rpc, expectedRelayInstanceId: undefined })).toBe("malformed");
  expect(evaluateAdmission({ ...rpc, expectedRelayInstanceId: "i2" })).toBe("mismatch");
  expect(evaluateAdmission({ ...rpc, bodyBytes: M0_LIMITS.rpcRequestBytes + 1 })).toBe("too-large");
});

test("preflight is exact origin, method and headers without business dispatch", () => {
  const options = {
    ...admission,
    method: "OPTIONS",
    authenticated: false,
    requestedMethod: "POST",
    requestedHeaders: ["Authorization", "Content-Type"],
  };
  expect(evaluateAdmission(options)).toBe("accepted");
  expect(evaluateAdmission({ ...options, requestedMethod: "DELETE" })).toBe("forbidden");
  expect(evaluateAdmission({ ...options, requestedHeaders: ["X-Secret"] })).toBe("forbidden");
  expect(evaluateAdmission({ ...options, origin: "null" })).toBe("forbidden");
});

test("WS upgrade authenticates only after exact-origin first-message bootstrap", () => {
  const upgrade = {
    path: "/terminal",
    host: admission.host,
    boundAuthority: admission.boundAuthority,
    origin: admission.origin,
    allowedOrigins,
    capacityAvailable: true,
  };
  expect(evaluateWsUpgrade(upgrade)).toBe("accepted");
  expect(evaluateWsUpgrade({ ...upgrade, origin: undefined })).toBe("forbidden");
  expect(evaluateWsUpgrade({ ...upgrade, host: "localhost:4096" })).toBe("forbidden");
  expect(evaluateWsUpgrade({ ...upgrade, path: "/rpc" })).toBe("forbidden");
  expect(WsBootstrapSchema.safeParse({ ...request, secret: "x".repeat(43) }).success).toBe(true);
  expect(WsBootstrapSchema.safeParse(request).success).toBe(false);
  expect(validateWsFirstMessage({ ...request, secret: "x".repeat(43) }, 200, 5000, true)).toEqual(
    request,
  );
  expect(
    validateWsFirstMessage({ ...request, secret: "x".repeat(43) }, 200, 5001, true),
  ).toBeNull();
  expect(validateWsFirstMessage({ ...request, secret: "x".repeat(43) }, 200, 1, false)).toBeNull();
});

test("rendezvous carries numeric loopback endpoint and bounded harness secret", () => {
  const rendezvous = {
    bootstrapVersion: 1,
    serverId: "s1",
    relayInstanceId: "i1",
    endpoint: "http://127.0.0.1:4096",
    secret: "x".repeat(43),
  };
  expect(RendezvousSchema.safeParse(rendezvous).success).toBe(true);
  expect(
    RendezvousSchema.safeParse({ ...rendezvous, endpoint: "http://localhost:4096" }).success,
  ).toBe(false);
  expect(BootstrapRequestSchema.safeParse(request).success).toBe(true);
});
