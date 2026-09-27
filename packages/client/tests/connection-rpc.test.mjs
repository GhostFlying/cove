import { TextDecoder, TextEncoder } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { M0_CAPABILITIES, PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { BASELINE_ENCODING, PROFILE } from "@cove/protocol/profile";
import { domainError } from "@cove/protocol/errors";
import { createClient } from "@cove/client";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const ids = { serverId: "server-1", relayInstanceId: "instance-1" };
const run = { ...ids, runId: "run-1" };

function budgets(overrides = {}) {
  return { ...M0_LIMITS, ...overrides };
}

function bootstrap(overrides = {}, terminal = false) {
  return {
    type: "cove-bootstrap-result",
    bootstrapVersion: 1,
    ...ids,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: "server-build",
    capabilities: [...M0_CAPABILITIES],
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    effectiveBudgets: budgets(),
    ...(terminal ? { connection: { connectionId: "connection-1", generation: 1 } } : {}),
    ...overrides,
  };
}

function headers(overrides = {}) {
  return {
    "cOvE-pRoToCoL": String(PROTOCOL_VERSION),
    "COVE-SERVER-ID": ids.serverId,
    "cove-instance-id": ids.relayInstanceId,
    ...overrides,
  };
}

class FakeScheduler {
  now = 0;
  nextId = 1;
  timers = new Map();

  nowMs = () => this.now;

  setTimer = (delayMs, callback) => {
    const id = this.nextId++;
    this.timers.set(id, { deadline: this.now + delayMs, callback });
    return { dispose: () => this.timers.delete(id) };
  };

  yieldTurn = async () => {};

  advance(ms) {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.deadline <= this.now) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

class FakeTerminal {
  opens = [];

  open = (callbacks) => {
    const record = { callbacks, disposed: false, closed: false, sent: [] };
    const connection = {
      send: (message) => {
        record.sent.push(message);
        return "handed-off";
      },
      close: () => {
        record.closed = true;
      },
      dispose: () => {
        record.disposed = true;
      },
    };
    record.connection = connection;
    this.opens.push(record);
    callbacks.onOpen(connection);
    return {
      cancel: () => {
        record.disposed = true;
        return "not-sent";
      },
    };
  };

  text(index, value) {
    this.opens[index].callbacks.onText(encoder.encode(JSON.stringify(value)));
  }

  binary(index, value = new Uint8Array([1])) {
    this.opens[index].callbacks.onBinary(value);
  }
}

class FakeHttp {
  requests = [];

  post = (request, callbacks) => {
    const record = { request, callbacks, cancelled: false, disposition: "not-sent" };
    this.requests.push(record);
    return {
      cancel: () => {
        record.cancelled = true;
        return record.disposition;
      },
    };
  };

  respond(index, value, options = {}) {
    const record = this.requests[index];
    record.disposition = "handed-off";
    record.callbacks.onDisposition("handed-off");
    record.callbacks.onResponse({
      status: options.status ?? 200,
      headers: options.headers ?? {},
      body: options.body ?? encoder.encode(JSON.stringify(value)),
    });
  }

  fail(index, disposition = "unknown", reason = "transport") {
    const record = this.requests[index];
    record.disposition = disposition;
    record.callbacks.onDisposition(disposition);
    record.callbacks.onFailure({ disposition, reason });
  }
}

function harness(overrides = {}) {
  const http = overrides.http ?? new FakeHttp();
  const terminal = overrides.terminal ?? new FakeTerminal();
  const scheduler = overrides.scheduler ?? new FakeScheduler();
  let nextId = 0;
  const client = createClient({
    ...ids,
    expectedServerId: ids.serverId,
    expectedRelayInstanceId: ids.relayInstanceId,
    buildVersion: "different-client-build",
    credentials: () => ({
      authorization: "Bearer private-http-value",
      terminalSecret: "a".repeat(43),
    }),
    codec: {
      encode: (text) => encoder.encode(text),
      decodeFatal: (bytes) => fatalDecoder.decode(bytes),
    },
    createOpaqueId: () => `request-${++nextId}`,
    scheduler,
    http,
    terminal,
    ...overrides.options,
  });
  return { client, http, terminal, scheduler };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function connectHarness(
  context,
  httpValue = bootstrap(),
  terminalValue = bootstrap({}, true),
) {
  const promise = context.client.connect();
  await flush();
  context.http.respond(0, httpValue);
  context.terminal.text(0, terminalValue);
  expect(await promise).toMatchObject({ ok: true });
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function runRecord(overrides = {}) {
  return {
    run,
    status: "live",
    geometry: { cols: 80, rows: 24 },
    controlEpoch: 0,
    controlHolder: null,
    preview: {
      version: null,
      generatedAtMs: null,
      checkedAtMs: null,
      stale: true,
      byteLength: 0,
    },
    ...overrides,
  };
}

function operation(operationId, method, overrides = {}) {
  return {
    operationId,
    method,
    revision: 0,
    state: "accepted",
    run,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("dual-channel connection", () => {
  test("commits only after semantically equal successes and accepts server build different from client", async () => {
    const context = harness();
    const states = [];
    context.client.onState((state) => states.push(state.status));
    const promise = context.client.connect();
    await flush();
    const offered = JSON.parse(context.terminal.opens[0].sent[0]);
    expect(offered.secret).toBe("a".repeat(43));
    expect(offered.buildVersion).toBe("different-client-build");
    expect(
      JSON.parse(fatalDecoder.decode(context.http.requests[0].request.body)),
    ).not.toHaveProperty("secret");
    context.http.respond(0, bootstrap({ capabilities: [...M0_CAPABILITIES].reverse() }));
    expect(context.client.snapshot().status).toBe("connecting");
    expect(context.http.requests).toHaveLength(1);
    context.terminal.text(
      0,
      bootstrap({ capabilities: [...M0_CAPABILITIES, M0_CAPABILITIES[0]] }, true),
    );
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: true, connection: { buildVersion: "server-build" } });
    expect(states).toEqual(["connecting", "connected"]);
  });

  async function rejectsChannelDisagreement(httpValue, terminalValue, field) {
    const context = harness();
    const promise = context.client.connect();
    await flush();
    context.http.respond(0, httpValue);
    context.terminal.text(0, terminalValue);
    expect(await promise).toEqual({
      ok: false,
      error: { category: "negotiation", reason: "channel-disagreement", field },
    });
    expect(context.http.requests[0].cancelled).toBe(true);
    expect(context.terminal.opens[0]).toMatchObject({ closed: true, disposed: true });
  }

  test("rejects a server build disagreement and closes both owned sides", async () => {
    expect.assertions(3);
    await rejectsChannelDisagreement(
      bootstrap(),
      bootstrap({ buildVersion: "other-build" }, true),
      "server-build",
    );
  });
  test("rejects a capability set disagreement and closes both owned sides", async () => {
    expect.assertions(3);
    await rejectsChannelDisagreement(
      bootstrap(),
      bootstrap({ capabilities: [M0_CAPABILITIES[0], M0_CAPABILITIES[1]] }, true),
      "capabilities",
    );
  });
  test("rejects a budget disagreement and closes both owned sides", async () => {
    expect.assertions(3);
    await rejectsChannelDisagreement(
      bootstrap(),
      bootstrap({ effectiveBudgets: budgets({ rpcInflight: 1 }) }, true),
      "effective-budgets",
    );
  });

  test("rejects a channel identity outside the frozen expected instance", async () => {
    const context = harness();
    const promise = context.client.connect();
    await flush();
    context.http.respond(0, bootstrap());
    context.terminal.text(0, bootstrap({ relayInstanceId: "other-instance" }, true));
    expect(await promise).toMatchObject({
      ok: false,
      error: { category: "negotiation", reason: "invalid-bootstrap", field: "instance" },
    });
  });

  test("rejects role inversion, pre-bootstrap binary, malformed UTF-8 and oversized bootstrap", async () => {
    const inverted = harness();
    const invertedPromise = inverted.client.connect();
    await flush();
    inverted.http.respond(0, bootstrap({}, true));
    expect(await invertedPromise).toMatchObject({ ok: false, error: { field: "connection" } });

    const missingRef = harness();
    const missingRefPromise = missingRef.client.connect();
    await flush();
    missingRef.terminal.text(0, bootstrap());
    expect(await missingRefPromise).toMatchObject({
      ok: false,
      error: { field: "connection" },
    });

    const binary = harness();
    const binaryPromise = binary.client.connect();
    await flush();
    binary.terminal.binary(0);
    expect(await binaryPromise).toMatchObject({ ok: false, error: { field: "connection" } });

    const invalid = harness();
    const invalidPromise = invalid.client.connect();
    await flush();
    invalid.http.respond(0, null, { body: new Uint8Array([0xff]) });
    expect(await invalidPromise).toMatchObject({ ok: false });

    const invalidJson = harness();
    const invalidJsonPromise = invalidJson.client.connect();
    await flush();
    invalidJson.http.respond(0, null, { body: encoder.encode("{") });
    expect(await invalidJsonPromise).toMatchObject({ ok: false });

    const oversized = harness();
    const oversizedPromise = oversized.client.connect();
    await flush();
    oversized.http.respond(0, null, { body: new Uint8Array(M0_LIMITS.bootstrapBytes + 1) });
    expect(await oversizedPromise).toMatchObject({
      ok: false,
      error: { category: "local", reason: "invalid-response" },
    });
  });

  test("accepts an 8 KiB bounded response and rejects missing selection, bad budgets, and late first messages", async () => {
    const decodedLengths = [];
    const exact = harness({
      options: {
        codec: {
          encode: (text) => encoder.encode(text),
          decodeFatal: (bytes) => {
            decodedLengths.push(bytes.byteLength);
            return fatalDecoder.decode(bytes).trimEnd();
          },
        },
      },
    });
    const exactPromise = exact.client.connect();
    await flush();
    const encoded = encoder.encode(JSON.stringify(bootstrap()));
    const exactBody = new Uint8Array(M0_LIMITS.bootstrapBytes);
    exactBody.set(encoded);
    exactBody.fill(0x20, encoded.byteLength);
    exact.http.respond(0, null, { body: exactBody });
    exact.terminal.text(0, bootstrap({}, true));
    expect(await exactPromise).toMatchObject({ ok: true });
    expect(decodedLengths).toContain(M0_LIMITS.bootstrapBytes);

    for (const [override, field] of [
      [{ capabilities: ["terminal-framing-v2"] }, "capabilities"],
      [{ profile: "future-profile" }, "bootstrap-version"],
      [{ protocolVersion: 1 }, "bootstrap-version"],
    ]) {
      const missing = harness();
      const missingPromise = missing.client.connect();
      await flush();
      missing.http.respond(0, bootstrap(override));
      expect(await missingPromise).toMatchObject({ ok: false, error: { field } });
    }

    const badBudget = harness();
    const badBudgetPromise = badBudget.client.connect();
    await flush();
    badBudget.http.respond(
      0,
      bootstrap({ effectiveBudgets: budgets({ parseLowBytes: 2, parseHighBytes: 2 }) }),
    );
    expect(await badBudgetPromise).toMatchObject({
      ok: false,
      error: { field: "effective-budgets" },
    });

    const late = harness();
    const latePromise = late.client.connect();
    await flush();
    late.scheduler.advance(5_001);
    expect(await latePromise).toMatchObject({ ok: false, error: { reason: "timeout" } });
    late.terminal.text(0, bootstrap({}, true));
    expect(late.client.snapshot().status).toBe("unverifiable");
  });

  test("contains synchronous credential and transport exceptions", async () => {
    const credential = harness({
      options: {
        credentials: () => {
          throw new Error("secret text");
        },
      },
    });
    expect(await credential.client.connect()).toMatchObject({
      ok: false,
      error: { reason: "credential" },
    });
    expect(JSON.stringify(credential.client.snapshot())).not.toContain("secret text");

    const terminal = harness({
      terminal: {
        open: () => {
          throw new Error("transport text");
        },
      },
    });
    expect(await terminal.client.connect()).toMatchObject({
      ok: false,
      error: { reason: "transport" },
    });

    const http = harness({
      http: {
        post: () => {
          throw new Error("transport text");
        },
      },
    });
    expect(await http.client.connect()).toMatchObject({
      ok: false,
      error: { reason: "transport" },
    });
  });

  test("freezes the offer and credentials before either transport can observe mutation", async () => {
    const capabilities = [...M0_CAPABILITIES];
    const credentials = {
      authorization: "Bearer original",
      terminalSecret: "a".repeat(43),
    };
    const context = harness({
      options: { capabilities, credentials: () => credentials },
    });
    const promise = context.client.connect();
    capabilities.splice(0, capabilities.length, "mutated");
    await flush();
    credentials.authorization = "Bearer mutated";
    credentials.terminalSecret = "b".repeat(43);
    const httpRequest = JSON.parse(fatalDecoder.decode(context.http.requests[0].request.body));
    const terminalRequest = JSON.parse(context.terminal.opens[0].sent[0]);
    expect(httpRequest.capabilities).toEqual(M0_CAPABILITIES);
    expect(terminalRequest.capabilities).toEqual(M0_CAPABILITIES);
    expect(context.http.requests[0].request.headers.Authorization).toBe("Bearer original");
    expect(terminalRequest.secret).toBe("a".repeat(43));
    context.http.respond(0, bootstrap());
    context.terminal.text(0, bootstrap({}, true));
    expect(await promise).toMatchObject({ ok: true });
  });

  test("uses one shared concurrent attempt and fences its late callbacks from reconnect", async () => {
    const context = harness();
    const first = context.client.connect();
    const shared = context.client.connect();
    expect(shared).toBe(first);
    await flush();
    const oldHttp = context.http.requests[0].callbacks;
    const oldTerminal = context.terminal.opens[0].callbacks;
    const second = context.client.reconnect();
    expect(await first).toMatchObject({ ok: false });
    await flush();
    oldHttp.onResponse({
      status: 200,
      headers: {},
      body: encoder.encode(JSON.stringify(bootstrap())),
    });
    oldTerminal.onText(encoder.encode(JSON.stringify(bootstrap({}, true))));
    oldTerminal.onClose();
    context.http.respond(1, bootstrap());
    context.terminal.text(1, bootstrap({}, true));
    expect(await second).toMatchObject({ ok: true });
    expect(context.client.snapshot().status).toBe("connected");
  });

  test("times out at the finite boundary and isolates reentrant listeners and duplicate dispose", async () => {
    const context = harness();
    let publications = 0;
    context.client.onState((state) => {
      publications += 1;
      if (state.status === "unverifiable") context.client.dispose();
      throw new Error("listener-private");
    });
    const promise = context.client.connect();
    await flush();
    context.scheduler.advance(5_001);
    expect(await promise).toMatchObject({ ok: false, error: { reason: "timeout" } });
    context.client.dispose();
    expect(context.client.snapshot()).toMatchObject({ status: "disposed", listenerCount: 0 });
    expect(publications).toBeGreaterThanOrEqual(2);
  });
});

describe("bounded typed RPC", () => {
  test("sends and validates all six method shapes through one public call surface", async () => {
    const context = harness();
    await connectHarness(context);
    const cases = [
      [
        "server.status",
        {},
        {
          ...ids,
          buildVersion: "server-build",
          protocolVersion: 2,
          profile: PROFILE,
          effectiveBudgets: budgets(),
          workerCount: 1,
          runCount: 1,
          admission: "ready",
          health: "live",
        },
      ],
      ["terminal.list", { limit: 1 }, { runs: [runRecord()] }],
      ["terminal.get", { run }, { record: runRecord() }],
      [
        "terminal.create",
        {
          operationId: "op-create",
          expectedRelayInstanceId: ids.relayInstanceId,
          executable: "/bin/sh",
          argv: ["-l"],
          cwd: "/tmp",
          geometry: { cols: 80, rows: 24 },
        },
        { operation: operation("op-create", "terminal.create") },
      ],
      [
        "terminal.stop",
        { operationId: "op-stop", expectedRelayInstanceId: ids.relayInstanceId, run },
        { operation: operation("op-stop", "terminal.stop") },
      ],
      [
        "operation.get",
        { operationId: "op-query", expectedRelayInstanceId: ids.relayInstanceId },
        { operation: operation("op-query", "terminal.create", { state: "running" }) },
      ],
    ];
    for (const [method, params, result] of cases) {
      const call = context.client.call(method, params);
      await flush();
      const index = context.http.requests.length - 1;
      const request = JSON.parse(fatalDecoder.decode(context.http.requests[index].request.body));
      expect(request.method).toBe(method);
      expect(context.http.requests[index].request.headers.Authorization).toContain("private-http");
      context.http.respond(index, rpcResult(request.id, result), { headers: headers() });
      expect(await call).toEqual({ ok: true, value: result });
    }
  });

  test("handles a synchronous RPC response and cancels its returned handle once", async () => {
    const context = harness();
    await connectHarness(context);
    let cancellations = 0;
    context.http.post = (request, callbacks) => {
      const decoded = JSON.parse(fatalDecoder.decode(request.body));
      callbacks.onDisposition("handed-off");
      callbacks.onResponse({
        status: 200,
        headers: headers(),
        body: encoder.encode(JSON.stringify(rpcResult(decoded.id, { runs: [] }))),
      });
      return {
        cancel: () => {
          cancellations += 1;
          return "handed-off";
        },
      };
    };
    expect(await context.client.call("terminal.list", { limit: 1 })).toEqual({
      ok: true,
      value: { runs: [] },
    });
    expect(cancellations).toBe(1);
    expect(context.client.snapshot().pendingRpcCount).toBe(0);
  });

  async function rejectsMismatchedResult(response, responseHeaders = headers()) {
    const context = harness();
    await connectHarness(context);
    const call = context.client.call("terminal.list", { limit: 1 });
    await flush();
    const request = JSON.parse(fatalDecoder.decode(context.http.requests[1].request.body));
    context.http.respond(1, response(request), { headers: responseHeaders });
    expect(await call).toMatchObject({
      ok: false,
      kind: "local-error",
      error: { category: "local" },
    });
  }

  test("rejects wrong request ID instead of returning false success", async () => {
    expect.assertions(2);
    await rejectsMismatchedResult((request) => rpcResult(`${request.id}-wrong`, { runs: [] }));
  });
  test("rejects foreign list run instead of returning false success", async () => {
    expect.assertions(2);
    await rejectsMismatchedResult((request) =>
      rpcResult(request.id, {
        runs: [runRecord({ run: { ...run, relayInstanceId: "foreign" } })],
      }),
    );
  });
  test("rejects foreign headers instead of returning false success", async () => {
    expect.assertions(2);
    await rejectsMismatchedResult((request) => rpcResult(request.id, { runs: [] }), {
      "Cove-Protocol": "2",
      "Cove-Server-Id": ids.serverId,
      "Cove-Instance-Id": "foreign",
    });
  });

  test("distinguishes definitely not-sent writes from unknown writes and never retries", async () => {
    const context = harness();
    await connectHarness(context);
    const params = {
      operationId: "stable-operation",
      expectedRelayInstanceId: ids.relayInstanceId,
      executable: "/bin/sh",
      argv: [],
      cwd: "/tmp",
      geometry: { cols: 80, rows: 24 },
    };
    const notSent = context.client.call("terminal.create", params);
    await flush();
    context.http.fail(1, "not-sent");
    expect(await notSent).toMatchObject({
      ok: false,
      kind: "operation-not-sent",
      operation: { operationId: "stable-operation" },
    });

    const unknown = context.client.call("terminal.create", params);
    await flush();
    context.http.fail(2, "handed-off");
    expect(await unknown).toMatchObject({
      ok: false,
      kind: "operation-unknown",
      error: { kind: "RESULT_UNKNOWN", nextAction: "query-operation" },
    });
    expect(context.http.requests).toHaveLength(3);

    const query = context.client.getOperation("stable-operation");
    await flush();
    const request = JSON.parse(fatalDecoder.decode(context.http.requests[3].request.body));
    expect(request).toMatchObject({
      method: "operation.get",
      params: { operationId: "stable-operation", expectedRelayInstanceId: ids.relayInstanceId },
    });
    context.http.respond(
      3,
      rpcResult(request.id, {
        operation: operation("stable-operation", "terminal.create", { state: "accepted" }),
      }),
      { headers: headers() },
    );
    expect(await query).toMatchObject({ ok: true, value: { operation: { state: "accepted" } } });
  });

  test("invalid bound write response is unknown, and conflicting simultaneous intent is rejected", async () => {
    const context = harness();
    await connectHarness(context);
    const firstParams = {
      operationId: "op-conflict",
      expectedRelayInstanceId: ids.relayInstanceId,
      executable: "/bin/a",
      argv: [],
      cwd: "/tmp",
      geometry: { cols: 80, rows: 24 },
    };
    const first = context.client.call("terminal.create", firstParams);
    await flush();
    const conflict = await context.client.call("terminal.create", {
      ...firstParams,
      executable: "/bin/b",
    });
    expect(conflict).toMatchObject({
      ok: false,
      kind: "local-error",
      error: { reason: "operation-conflict" },
    });
    const request = JSON.parse(fatalDecoder.decode(context.http.requests[1].request.body));
    context.http.respond(
      1,
      rpcResult(request.id, { operation: operation("wrong-operation", "terminal.create") }),
      { headers: headers() },
    );
    expect(await first).toMatchObject({
      ok: false,
      kind: "operation-unknown",
      operation: { operationId: "op-conflict" },
    });
    expect(context.http.requests).toHaveLength(2);
  });

  test("does not retain a permanent receipt ledger after returning an unknown operation", async () => {
    const context = harness();
    await connectHarness(context);
    const params = {
      operationId: "op-retained",
      expectedRelayInstanceId: ids.relayInstanceId,
      executable: "/bin/a",
      argv: [],
      cwd: "/tmp",
      geometry: { cols: 80, rows: 24 },
    };
    const first = context.client.call("terminal.create", params);
    await flush();
    context.http.fail(1, "unknown");
    expect(await first).toMatchObject({ ok: false, kind: "operation-unknown" });
    const explicitResubmit = context.client.call("terminal.create", {
      ...params,
      executable: "/bin/b",
    });
    await flush();
    const request = JSON.parse(fatalDecoder.decode(context.http.requests[2].request.body));
    expect(request).toMatchObject({
      method: "terminal.create",
      params: { operationId: "op-retained" },
    });
    context.http.respond(
      2,
      rpcResult(request.id, { operation: operation("op-retained", "terminal.create") }),
      { headers: headers() },
    );
    expect(await explicitResubmit).toMatchObject({
      ok: true,
      value: { operation: { state: "accepted" } },
    });

    const query = context.client.getOperation("op-retained");
    await flush();
    const queryRequest = JSON.parse(fatalDecoder.decode(context.http.requests[3].request.body));
    context.http.respond(
      3,
      rpcResult(queryRequest.id, {
        operation: operation("op-retained", "terminal.create", {
          state: "failed",
          error: domainError("WORKER_UNAVAILABLE"),
        }),
      }),
      { headers: headers() },
    );
    expect(await query).toMatchObject({ ok: true, value: { operation: { state: "failed" } } });
  });

  async function wrongWriteBindingIsUnknown(method, params, record) {
    const context = harness();
    await connectHarness(context);
    const call = context.client.call(method, params);
    await flush();
    const request = JSON.parse(fatalDecoder.decode(context.http.requests[1].request.body));
    context.http.respond(1, rpcResult(request.id, { operation: record }), {
      headers: headers(),
    });
    expect(await call).toMatchObject({ ok: false, kind: "operation-unknown" });
  }

  test("treats a wrong operation method binding as an unknown write", async () => {
    expect.assertions(2);
    await wrongWriteBindingIsUnknown(
      "terminal.create",
      {
        operationId: "op-method",
        expectedRelayInstanceId: ids.relayInstanceId,
        executable: "/bin/a",
        argv: [],
        cwd: "/tmp",
        geometry: { cols: 80, rows: 24 },
      },
      operation("op-method", "terminal.stop"),
    );
  });
  test("treats a wrong stop run binding as an unknown write", async () => {
    expect.assertions(2);
    await wrongWriteBindingIsUnknown(
      "terminal.stop",
      { operationId: "op-stop-run", expectedRelayInstanceId: ids.relayInstanceId, run },
      operation("op-stop-run", "terminal.stop", { run: { ...run, runId: "other-run" } }),
    );
  });

  test("enforces negotiated inflight and request limits before handing bytes to the port", async () => {
    const inflight = harness();
    await connectHarness(
      inflight,
      bootstrap({ effectiveBudgets: budgets({ rpcInflight: 1 }) }),
      bootstrap({ effectiveBudgets: budgets({ rpcInflight: 1 }) }, true),
    );
    const pending = inflight.client.call("terminal.list", { limit: 1 });
    await flush();
    expect(await inflight.client.call("terminal.list", { limit: 1 })).toMatchObject({
      ok: false,
      kind: "local-error",
      error: { reason: "capacity" },
    });
    inflight.http.fail(1, "not-sent");
    await pending;

    const requestLimited = harness();
    await connectHarness(
      requestLimited,
      bootstrap({ effectiveBudgets: budgets({ rpcRequestBytes: 32 }) }),
      bootstrap({ effectiveBudgets: budgets({ rpcRequestBytes: 32 }) }, true),
    );
    expect(await requestLimited.client.call("terminal.list", { limit: 1 })).toMatchObject({
      ok: false,
      kind: "local-error",
      error: { reason: "capacity" },
    });
    expect(requestLimited.http.requests).toHaveLength(1);
  });

  test("enforces method capability and response-byte caps before success", async () => {
    const offered = M0_CAPABILITIES.filter((value) => value !== "terminal-preview-v1");
    const context = harness({ options: { capabilities: offered } });
    await connectHarness(
      context,
      bootstrap({ capabilities: offered }),
      bootstrap({ capabilities: offered }, true),
    );
    expect(await context.client.call("terminal.list", { limit: 1 })).toMatchObject({
      ok: false,
      kind: "local-error",
      error: { reason: "invalid-request" },
    });
    expect(context.http.requests).toHaveLength(1);

    const responseLimited = harness();
    await connectHarness(
      responseLimited,
      bootstrap({ effectiveBudgets: budgets({ rpcResponseBytes: 32 }) }),
      bootstrap({ effectiveBudgets: budgets({ rpcResponseBytes: 32 }) }, true),
    );
    const read = responseLimited.client.call("terminal.list", { limit: 1 });
    await flush();
    responseLimited.http.respond(1, null, { headers: headers(), body: new Uint8Array(33) });
    expect(await read).toMatchObject({
      ok: false,
      kind: "local-error",
      error: { reason: "response-too-large" },
    });
  });

  test("keeps read failure distinct from operation uncertainty", async () => {
    const context = harness();
    await connectHarness(context);
    const read = context.client.call("terminal.get", { run });
    await flush();
    const request = JSON.parse(fatalDecoder.decode(context.http.requests[1].request.body));
    const error = domainError("RUN_NOT_FOUND");
    context.http.respond(
      1,
      {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: error.code, message: error.message, data: error },
      },
      { headers: headers() },
    );
    expect(await read).toEqual({ ok: false, kind: "rpc-error", error });
  });

  test("settles handed-off write as unknown on timeout/dispose and ignores late success", async () => {
    const context = harness({ options: { rpcTimeoutMs: 10 } });
    await connectHarness(context);
    const params = { operationId: "op-timeout", expectedRelayInstanceId: ids.relayInstanceId, run };
    const pending = context.client.call("terminal.stop", params);
    await flush();
    context.http.requests[1].disposition = "handed-off";
    context.http.requests[1].callbacks.onDisposition("handed-off");
    context.scheduler.advance(10);
    expect(await pending).toMatchObject({ ok: false, kind: "operation-unknown" });
    const request = JSON.parse(fatalDecoder.decode(context.http.requests[1].request.body));
    context.http.respond(
      1,
      rpcResult(request.id, { operation: operation("op-timeout", "terminal.stop") }),
      { headers: headers() },
    );
    expect(context.http.requests).toHaveLength(2);
    expect(context.client.snapshot().pendingRpcCount).toBe(0);

    const disposed = context.client.call("terminal.stop", { ...params, operationId: "op-dispose" });
    await flush();
    context.http.requests[2].callbacks.onDisposition("handed-off");
    context.client.dispose();
    expect(await disposed).toMatchObject({ ok: false, kind: "operation-unknown" });
  });

  test("does not leak credentials or arbitrary server text into snapshots", async () => {
    const context = harness();
    await connectHarness(context);
    const call = context.client.call("terminal.list", { limit: 1 });
    await flush();
    context.http.fail(1, "unknown");
    await call;
    const serialized = JSON.stringify(context.client.snapshot());
    expect(serialized).not.toContain("private-http-value");
    expect(serialized).not.toContain("a".repeat(43));
  });

  test("a connected terminal close settles pending reads and writes without claiming run exit", async () => {
    const context = harness();
    await connectHarness(context);
    const read = context.client.call("terminal.list", { limit: 1 });
    const write = context.client.call("terminal.stop", {
      operationId: "op-close",
      expectedRelayInstanceId: ids.relayInstanceId,
      run,
    });
    await flush();
    context.http.requests[2].callbacks.onDisposition("handed-off");
    context.terminal.opens[0].callbacks.onClose();
    expect(await read).toMatchObject({
      ok: false,
      kind: "local-error",
      error: { reason: "transport" },
    });
    expect(await write).toMatchObject({ ok: false, kind: "operation-unknown" });
    expect(context.client.snapshot()).toMatchObject({ status: "unverifiable", pendingRpcCount: 0 });
  });
});
