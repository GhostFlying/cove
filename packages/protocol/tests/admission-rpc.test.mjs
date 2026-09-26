import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import {
  ADMISSION_STATUS,
  BootstrapFailureSchema,
  BootstrapRequestSchema,
  BootstrapSuccessSchema,
  RendezvousSchema,
  WsBootstrapSchema,
  evaluateAdmission,
  evaluateWsUpgrade,
  negotiateBootstrap,
  validateWsFirstMessage,
} from "@cove/protocol/bootstrap";
import {
  RPC_METHODS,
  STANDARD_RPC_ERRORS,
  canonicalOperationIntent,
  classifyReceiptAdmission,
  classifyRpcEnvelope,
  classifyRpcItem,
  composeRpcMethodResult,
  composeRpcResponse,
  rpcHttpSuccessStatus,
  validateOperationRecord,
  validateRpcMethodResult,
  validateRpcMethodParams,
  validateRpcResultForCall,
  validateRpcResponse,
} from "@cove/protocol/rpc";

const request = {
  type: "cove-bootstrap",
  bootstrapVersion: 1,
  protocolVersion: 2,
  buildVersion: "client-build",
  capabilities: [
    "terminal-framing-v2",
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
const encoder = (text) => new TextEncoder().encode(text);
const run = { serverId: "s1", relayInstanceId: "i1", runId: "r1" };
const create = {
  operationId: "o1",
  expectedRelayInstanceId: "i1",
  executable: "/bin/sh",
  argv: ["-c", "echo ok"],
  cwd: "/tmp",
  geometry: { cols: 80, rows: 24 },
};
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
    "terminal-framing-v2",
    "logical-grid-recovery-v1",
    "terminal-preview-v1",
  ]);
  expect(result.capabilities).not.toContain("future-optional");
});

test("bootstrap requires both baseline capabilities, profile and encoding", () => {
  expect(
    negotiateBootstrap({ ...request, capabilities: ["terminal-framing-v2"] }, server).kind,
  ).toBe("CAPABILITY_UNAVAILABLE");
  expect(negotiateBootstrap({ ...request, profiles: [] }, server).kind).toBe("PROFILE_UNSUPPORTED");
  expect(negotiateBootstrap({ ...request, encodings: [] }, server).kind).toBe(
    "PROFILE_UNSUPPORTED",
  );
  expect(
    negotiateBootstrap(
      {
        ...request,
        capabilities: request.capabilities.map((capability) =>
          capability === "terminal-framing-v2" ? "terminal-framing-v1" : capability,
        ),
      },
      server,
    ).kind,
  ).toBe("CAPABILITY_UNAVAILABLE");
});

test("bootstrap identity and protocol mismatch never return run inventory", () => {
  for (const altered of [
    { protocolVersion: 1 },
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
  const failure = negotiateBootstrap({ ...request, protocolVersion: 1 }, server);
  expect(BootstrapFailureSchema.safeParse(failure).success).toBe(true);
  expect(failure.supportedVersions).toEqual({ bootstrap: [1], protocol: [2] });
  expect(BootstrapFailureSchema.safeParse({ ...failure, message: "secret path" }).success).toBe(
    false,
  );
});

test("bootstrap failures decode bounded peer protocol-version sets", () => {
  const failure = negotiateBootstrap({ ...request, protocolVersion: 1 }, server);
  for (const protocol of [[1], [1, 2], [1, 2, 3, 255]])
    expect(
      BootstrapFailureSchema.safeParse({
        ...failure,
        supportedVersions: { bootstrap: [1], protocol },
      }).success,
    ).toBe(true);

  for (const protocol of [[], [0], [256], [1.5], ["2"], [1, 1], [1, 2, 3, 4, 5]])
    expect(
      BootstrapFailureSchema.safeParse({
        ...failure,
        supportedVersions: { bootstrap: [1], protocol },
      }).success,
    ).toBe(false);

  expect(
    BootstrapFailureSchema.safeParse({
      ...failure,
      supportedVersions: { bootstrap: [2], protocol: [1] },
    }).success,
  ).toBe(false);
  expect(
    BootstrapFailureSchema.safeParse({
      ...failure,
      supportedVersions: { bootstrap: [1, 2], protocol: [1] },
    }).success,
  ).toBe(false);
});

test("bootstrap success decoding remains strict at the local protocol version", () => {
  const success = negotiateBootstrap(request, server);
  expect(BootstrapSuccessSchema.safeParse(success).success).toBe(true);
  expect(BootstrapSuccessSchema.safeParse({ ...success, protocolVersion: 1 }).success).toBe(false);
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
    expectedProtocol: 2,
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

test("WS upgrade checks present Origin and authenticates every first message", () => {
  const upgrade = {
    path: "/terminal",
    host: admission.host,
    boundAuthority: admission.boundAuthority,
    origin: admission.origin,
    allowedOrigins,
    capacityAvailable: true,
  };
  expect(evaluateWsUpgrade(upgrade)).toBe("accepted");
  expect(evaluateWsUpgrade({ ...upgrade, origin: undefined })).toBe("accepted");
  expect(evaluateWsUpgrade({ ...upgrade, origin: "http://127.0.0.1:9999" })).toBe("forbidden");
  expect(evaluateWsUpgrade({ ...upgrade, origin: "null" })).toBe("forbidden");
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

test("six closed RPC methods publish params, results, permissions and CLI routes", () => {
  expect(Object.keys(RPC_METHODS)).toEqual([
    "server.status",
    "terminal.list",
    "terminal.get",
    "terminal.create",
    "terminal.stop",
    "operation.get",
  ]);
  expect(
    Object.values(RPC_METHODS).every(
      (spec) =>
        spec.permission === "local-principal" &&
        spec.params &&
        spec.result &&
        spec.capability &&
        spec.cli,
    ),
  ).toBe(true);
  expect(RPC_METHODS["terminal.create"].class).toBe("write");
  expect(RPC_METHODS["terminal.get"].class).toBe("read");
});

test("JSON-RPC classifies standard parse, invalid request, method and params failures", () => {
  expect(classifyRpcEnvelope(null, true)[0].response.error.code).toBe(STANDARD_RPC_ERRORS.parse);
  expect(
    classifyRpcItem({ jsonrpc: "1.0", method: "server.status", id: 1 }).response.error.code,
  ).toBe(STANDARD_RPC_ERRORS.invalidRequest);
  expect(classifyRpcItem({ jsonrpc: "2.0", method: "future", id: 1 }).response.error.code).toBe(
    STANDARD_RPC_ERRORS.methodNotFound,
  );
  expect(
    classifyRpcItem({ jsonrpc: "2.0", method: "terminal.list", params: [], id: 1 }).response.error
      .code,
  ).toBe(STANDARD_RPC_ERRORS.invalidParams);
  expect(
    classifyRpcItem({ jsonrpc: "2.0", method: "terminal.list", params: { limit: 129 }, id: 1 })
      .response.error.code,
  ).toBe(STANDARD_RPC_ERRORS.invalidParams);
});

test("mixed batch preserves IDs and suppresses every valid notification response", () => {
  const items = classifyRpcEnvelope([
    { jsonrpc: "2.0", method: "server.status", id: "q1", params: {} },
    { jsonrpc: "2.0", method: "terminal.create", params: create },
    { jsonrpc: "2.0", method: "future", params: {} },
    42,
  ]);
  expect(items.map((item) => item.kind)).toEqual(["call", "notification", "notification", "error"]);
  expect(items[0].id).toBe("q1");
  expect(items[3].response.id).toBeNull();
  expect(classifyRpcEnvelope([])[0].response.error.code).toBe(STANDARD_RPC_ERRORS.invalidRequest);
  expect(
    classifyRpcEnvelope(Array(17).fill({ jsonrpc: "2.0", method: "server.status" })),
  ).toHaveLength(1);
  expect(rpcHttpSuccessStatus(items)).toBe(200);
  expect(rpcHttpSuccessStatus([classifyRpcItem({ jsonrpc: "2.0", method: "server.status" })])).toBe(
    204,
  );
});

test("RPC response enforces result/error exclusivity and fixed public error text", () => {
  expect(validateRpcResponse({ jsonrpc: "2.0", id: 0, result: {} })).not.toBeNull();
  expect(
    validateRpcResponse({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32602,
        message: "Invalid params",
      },
    }),
  ).not.toBeNull();
  expect(
    composeRpcResponse({ jsonrpc: "2.0", id: "q", result: "x".repeat(300_000) }, encoder),
  ).toBeNull();
  expect(
    validateRpcResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: {
        code: -32602,
        message: "Invalid params",
      },
    }),
  ).toBeNull();
  expect(
    validateRpcResponse({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32602,
        message: "secret path",
      },
    }),
  ).toBeNull();
  const domain = domainError("RESULT_UNKNOWN", "unknown");
  expect(
    validateRpcResponse({
      jsonrpc: "2.0",
      id: "q",
      error: {
        code: domain.code,
        message: domain.message,
        data: domain,
      },
    }),
  ).not.toBeNull();
});

test("canonical operation intent ignores network ID and unknown fields but binds target and argv", () => {
  const one = canonicalOperationIntent(
    "terminal.create",
    { ...create, future: "ignored" },
    encoder,
  );
  const reordered = canonicalOperationIntent(
    "terminal.create",
    {
      geometry: { rows: 24, cols: 80 },
      cwd: "/tmp",
      executable: "/bin/sh",
      argv: ["-c", "echo ok"],
      expectedRelayInstanceId: "i1",
      operationId: "o2",
    },
    encoder,
  );
  expect(one).toBe(reordered);
  expect(one).not.toContain("operationId");
  expect(
    canonicalOperationIntent("terminal.create", { ...create, argv: ["echo ok", "-c"] }, encoder),
  ).not.toBe(one);
  expect(
    canonicalOperationIntent(
      "terminal.create",
      { ...create, expectedRelayInstanceId: "i2" },
      encoder,
    ),
  ).not.toBe(one);
  expect(
    canonicalOperationIntent(
      "terminal.stop",
      { operationId: "o1", expectedRelayInstanceId: "i1", run },
      encoder,
    ),
  ).not.toBe(one);
});

test("unframable create cannot acquire a canonical write intent", () => {
  expect(
    canonicalOperationIntent("terminal.create", { ...create, argv: ["é".repeat(4096)] }, encoder),
  ).toBeNull();
  expect(
    canonicalOperationIntent(
      "terminal.create",
      { ...create, geometry: { cols: 121, rows: 24 } },
      encoder,
    ),
  ).toBeNull();
});

test("receipt replay precedes capacity while conflicting intent and new work fail safely", () => {
  const key = { serverId: "s1", relayInstanceId: "i1", principalId: "local", operationId: "o1" };
  const intent = canonicalOperationIntent("terminal.create", create, encoder);
  const record = {
    operationId: "o1",
    method: "terminal.create",
    revision: 0,
    state: "accepted",
    run,
  };
  const common = {
    key,
    canonicalIntent: intent,
    receiptCount: 1,
    receiptLimit: 1,
    encodeUtf8: encoder,
  };
  expect(
    classifyReceiptAdmission({ ...common, existing: { key, canonicalIntent: intent, record } }),
  ).toBe("existing");
  expect(
    classifyReceiptAdmission({
      ...common,
      existing: { key, canonicalIntent: intent + "x", record },
    }),
  ).toBe("conflict");
  expect(classifyReceiptAdmission(common)).toBe("busy");
  expect(classifyReceiptAdmission({ ...common, receiptCount: 0 })).toBe("reserve");
  expect(
    classifyReceiptAdmission({
      ...common,
      existing: { key: { ...key, relayInstanceId: "i2" }, canonicalIntent: intent, record },
    }),
  ).toBe("invalid");
});

test("operation records remain bounded and read results carry no preview VT", () => {
  const record = {
    operationId: "o1",
    method: "terminal.create",
    revision: 1,
    state: "succeeded",
    run,
    result: { run },
  };
  expect(validateOperationRecord(record, encoder)).toEqual(record);
  expect(
    validateOperationRecord(
      { ...record, error: { ...domainError("BUSY"), message: "private cwd" } },
      encoder,
    ),
  ).toBeNull();
  expect(validateRpcMethodResult("terminal.create", { operation: record })).toBe(true);
  expect(validateRpcMethodResult("terminal.create", { run })).toBe(false);
  const visible = {
    run,
    status: "live",
    geometry: create.geometry,
    controlEpoch: 0,
    controlHolder: null,
    preview: { version: null, generatedAtMs: null, checkedAtMs: null, stale: true, byteLength: 0 },
  };
  expect(composeRpcMethodResult("terminal.get", { record: { ...visible, vt: "secret" } })).toEqual({
    record: visible,
  });
});

test("RPC params and result identities bind target instance, method and run", () => {
  const stop = { operationId: "stop-1", expectedRelayInstanceId: "i1", run };
  expect(
    validateRpcMethodParams("terminal.stop", { ...stop, run: { ...run, relayInstanceId: "i2" } }),
  ).toBeNull();
  expect(
    canonicalOperationIntent(
      "terminal.stop",
      { ...stop, run: { ...run, relayInstanceId: "i2" } },
      encoder,
    ),
  ).toBeNull();
  expect(
    validateRpcMethodParams("terminal.create", {
      ...create,
      appearance: {
        palette: [
          { index: 1, rgb: "ffff/ffff/ffff" },
          { index: 1, rgb: "0000/0000/0000" },
        ],
      },
    }),
  ).toBeNull();
  const createOperation = {
    operationId: "o1",
    method: "terminal.create",
    revision: 1,
    state: "succeeded",
    run,
    result: { run },
  };
  expect(
    composeRpcMethodResult("terminal.create", {
      operation: {
        ...createOperation,
        state: "accepted",
        run: undefined,
      },
    }),
  ).toBeNull();
  expect(
    validateOperationRecord(
      { ...createOperation, result: { run: { ...run, runId: "r2" } } },
      encoder,
    ),
  ).toBeNull();
  expect(validateRpcMethodResult("terminal.stop", { operation: createOperation })).toBe(false);
  expect(composeRpcMethodResult("terminal.stop", { operation: createOperation })).toBeNull();
  expect(validateRpcResultForCall("terminal.create", create, { operation: createOperation })).toBe(
    true,
  );
  expect(
    validateRpcResultForCall(
      "terminal.create",
      { ...create, operationId: "o2" },
      { operation: createOperation },
    ),
  ).toBe(false);
  const stopOperation = {
    operationId: "stop-1",
    method: "terminal.stop",
    revision: 1,
    state: "accepted",
    run,
  };
  expect(validateRpcResultForCall("terminal.stop", stop, { operation: stopOperation })).toBe(true);
  expect(
    validateRpcResultForCall("terminal.stop", stop, {
      operation: { ...stopOperation, run: { ...run, runId: "r2" } },
    }),
  ).toBe(false);
});

test("status result cannot advertise budgets rejected by the shared policy", () => {
  const status = {
    serverId: "s1",
    relayInstanceId: "i1",
    buildVersion: "b1",
    protocolVersion: 2,
    profile: "pragmatic-logical-grid-v1",
    effectiveBudgets: M0_LIMITS,
    workerCount: 1,
    runCount: 1,
    admission: "ready",
    health: "live",
  };
  expect(validateRpcMethodResult("server.status", status)).toBe(true);
  expect(
    validateRpcMethodResult("server.status", {
      ...status,
      effectiveBudgets: { ...M0_LIMITS, subscriptionCreditBytes: 1 },
    }),
  ).toBe(false);
});
