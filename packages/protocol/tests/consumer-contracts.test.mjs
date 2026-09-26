import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import { M0_LIMITS, EffectiveBudgetsSchema } from "@cove/protocol/budgets";
import {
  BootstrapRequestSchema,
  BootstrapSuccessSchema,
  BootstrapFailureSchema,
  WsBootstrapSchema,
  RendezvousSchema,
  M0_CAPABILITIES,
  negotiateBootstrap,
} from "@cove/protocol/bootstrap";
import { DomainErrorSchema, domainError } from "@cove/protocol/errors";
import {
  ConnectionRefSchema,
  RunRefSchema,
  SubscriptionRefSchema,
  WorkerRefSchema,
} from "@cove/protocol/identity";
import {
  PipeCommandSchema,
  PipeMetadataSchema,
  PipeResultSchema,
  PipeEventSchema,
  PipeErrorSchema,
  PipeHelloSchema,
  PipeReadySchema,
  RunStatusSchema,
  SpawnArgumentsSchema,
  composeSpawnPayload,
  validatePipeFrame,
  validatePipeReadiness,
  validatePipeResultForCommand,
} from "@cove/protocol/pipe";
import {
  PROFILE,
  BASELINE_ENCODING,
  QUERY_SUPPORT,
  RecoveryCoverageSchema,
  AppearanceSchema,
  GeometrySchema,
} from "@cove/protocol/profile";
import {
  RPC_METHODS,
  RpcRequestSchema,
  RpcResultSchema,
  RpcErrorSchema,
  OperationRecordSchema,
  RunRecordSchema,
  canonicalOperationIntent,
  classifyReceiptAdmission,
  classifyRpcItem,
  composeRpcMethodResult,
  validateRpcResultForCall,
  validateRpcResponse,
} from "@cove/protocol/rpc";
import {
  TerminalCommandSchema,
  TerminalEventSchema,
  TerminalResultSchema,
  TerminalErrorSchema,
  BaselineDescriptorSchema,
  BaselineChunkSchema,
  BaselineEndSchema,
  validateBaselineDescriptor,
  validateBaselineTransfer,
  validateContiguousEvents,
  validateTerminalFrame,
  validateTerminalResultForCommand,
  MAX_FRAME_BYTES,
} from "@cove/protocol/terminal";

const root = new URL("../../../tests/fixtures/protocol/m0/", import.meta.url);
const fixture = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
const encoder = (text) => new TextEncoder().encode(text);
const frame = (kind, payload = new Uint8Array()) => ({ kind, metadata: new Uint8Array(), payload });

test("compiled fixture manifest pins exactly four authored journey files", async () => {
  const manifest = await fixture("manifest.json");
  expect(Object.keys(manifest.files).sort()).toEqual([
    "admission-rpc.json",
    "pipe-journey.json",
    "profile.json",
    "terminal-journey.json",
  ]);
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(new URL(name, root));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
  }
});

test("profile fixture fixes supported queries and required versus diagnostic classes", async () => {
  const profile = await fixture("profile.json");
  expect(profile.profile).toBe(PROFILE);
  expect(profile.encoding).toBe(BASELINE_ENCODING);
  expect(RecoveryCoverageSchema.safeParse(profile.coverage).success).toBe(true);
  expect(profile.queryFixtureIds).toEqual(QUERY_SUPPORT.map((entry) => entry.fixture));
  expect(profile.classification.visibleLogicalGrid).toBe("required");
  expect(profile.classification.savedSgrCharset).toBe("diagnostic");
  expect(profile.classification.realAgentWorkflow).toBe("integration-obligation");
});

test("terminal fixture installs both-buffer checkpoint with exact tail and N plus one", async () => {
  const profile = await fixture("profile.json");
  const journey = await fixture("terminal-journey.json");
  const subscription = {
    run: journey.run,
    connection: journey.connection,
    subscriptionId: journey.subscriptionId,
    viewId: journey.viewId,
  };
  expect(SubscriptionRefSchema.safeParse(subscription).success).toBe(true);
  const descriptor = {
    baselineId: journey.baseline.baselineId,
    run: journey.run,
    subscription,
    profile: profile.profile,
    encoding: profile.encoding,
    checkpointSeq: journey.baseline.checkpointSeq,
    atSeq: journey.baseline.atSeq,
    captureGeometry: profile.geometry,
    currentGeometry: profile.geometry,
    coverage: profile.coverage,
    vtBytes: journey.baseline.vt.length,
    tailBytes: journey.baseline.tail.length,
    chunkCount: journey.baseline.chunkLengths.length,
  };
  expect(validateBaselineDescriptor(descriptor)).not.toBeNull();
  const bytes = [...journey.baseline.vt, ...journey.baseline.tail];
  let offset = 0;
  const chunks = journey.baseline.chunkLengths.map((length, ordinal) => {
    const payload = Uint8Array.from(bytes.slice(offset, offset + length));
    offset += length;
    return {
      metadata: {
        type: "baseline-chunk",
        run: journey.run,
        subscription,
        baselineId: descriptor.baselineId,
        ordinal,
      },
      payload,
    };
  });
  const end = {
    type: "baseline-end",
    run: journey.run,
    subscription,
    baselineId: descriptor.baselineId,
    chunkCount: chunks.length,
    totalBytes: bytes.length,
    atSeq: descriptor.atSeq,
  };
  expect(validateBaselineTransfer(descriptor, chunks, end)).toBe(true);
  const events = journey.orderedPostBaseline.map(({ payload: _payload, ...event }) => ({
    ...event,
    run: journey.run,
  }));
  expect(validateContiguousEvents(events, descriptor.atSeq)).toBe(true);
  expect(
    validateTerminalFrame(
      frame(3, Uint8Array.from(journey.orderedPostBaseline[0].payload)),
      events[0],
    ).ok,
  ).toBe(true);
  expect(events[1]).toMatchObject({ type: "resize", requiresBaseline: true });
  expect(events[1].geometry).not.toEqual(profile.geometry);
});

test("terminal fixture fences stale focus and uncertain input without extra writes", async () => {
  const journey = await fixture("terminal-journey.json");
  const subscription = {
    run: journey.run,
    connection: journey.connection,
    subscriptionId: journey.subscriptionId,
    viewId: journey.viewId,
  };
  const command = {
    type: "focus",
    requestId: "focus-new",
    run: journey.run,
    subscription,
    focusSeq: journey.focusRace.newerFocusSeq,
    geometry: { cols: 80, rows: 24 },
  };
  expect(TerminalCommandSchema.safeParse(command).success).toBe(true);
  const old = {
    type: "focus-result",
    requestId: "focus-old",
    run: journey.run,
    subscription,
    epoch: journey.focusRace.olderEpoch,
    atSeq: 3,
  };
  expect(validateTerminalResultForCommand(command, old)).toBe(false);
  const uncertain = domainError("RESULT_UNKNOWN", journey.inputOutcome.acceptance);
  expect(uncertain.nextAction).toBe(journey.inputOutcome.nextAction);
  expect(
    validateTerminalFrame(frame(4), {
      type: "error",
      run: journey.run,
      requestId: "input-q",
      commandType: "input",
      error: uncertain,
    }).ok,
  ).toBe(true);
  expect(journey.stalePreview.currentVersion).toBeGreaterThan(journey.stalePreview.knownVersion);
});

test("pipe fixture binds ready, spawn payload, status and preview to one incarnation", async () => {
  const journey = await fixture("pipe-journey.json");
  const hello = {
    type: "hello",
    worker: journey.worker,
    pipeVersion: 1,
    buildVersion: journey.helloBuild,
    effectiveBudgets: M0_LIMITS,
  };
  const ready = { ...hello, type: "ready", buildVersion: journey.readyBuild };
  expect(validatePipeReadiness(hello, ready)).toBe(true);
  expect(validatePipeFrame(frame(1), hello).ok).toBe(true);
  expect(validatePipeFrame(frame(2), ready).ok).toBe(true);
  const composed = composeSpawnPayload(journey.spawnArguments, encoder);
  const spawn = {
    type: "spawn",
    worker: journey.worker,
    run: journey.run,
    requestId: "spawn-q",
    operationId: journey.spawnOperationId,
    geometry: { cols: 80, rows: 24 },
    profile: PROFILE,
    appearance: { palette: [] },
    effectiveBudgets: M0_LIMITS,
    spawnPayloadBytes: composed.bytes.length,
  };
  expect(validatePipeFrame(frame(1, composed.bytes), spawn).ok).toBe(true);
  const result = {
    type: "result",
    worker: journey.worker,
    run: journey.run,
    requestId: "spawn-q",
    commandType: "spawn",
    outcome: "accepted",
    operationId: journey.spawnOperationId,
  };
  expect(validatePipeResultForCommand(spawn, result)).toBe(true);
  expect(
    validatePipeResultForCommand(spawn, {
      ...result,
      worker: {
        ...journey.worker,
        workerIncarnationId: journey.lateWrongIncarnation,
      },
    }),
  ).toBe(false);
  const preview = journey.preview;
  const previewBase = { worker: journey.worker, run: journey.run };
  const start = {
    type: "terminal-event",
    ...previewBase,
    terminal: {
      type: "preview-start",
      run: journey.run,
      previewId: "preview-1",
      version: preview.version,
      atSeq: preview.atSeq,
      geometry: { cols: 80, rows: 24 },
      generatedAtMs: preview.generatedAtMs,
      vtBytes: preview.vt.length,
      chunkCount: 1,
    },
  };
  const chunk = {
    type: "terminal-event",
    ...previewBase,
    terminal: {
      type: "preview-chunk",
      run: journey.run,
      previewId: "preview-1",
      version: preview.version,
      ordinal: 0,
    },
  };
  const end = {
    type: "terminal-event",
    ...previewBase,
    terminal: {
      type: "preview-end",
      run: journey.run,
      previewId: "preview-1",
      version: preview.version,
      totalBytes: preview.vt.length,
      atSeq: preview.atSeq,
    },
  };
  expect(validatePipeFrame(frame(3), start).ok).toBe(true);
  expect(validatePipeFrame(frame(3, Uint8Array.from(preview.vt)), chunk).ok).toBe(true);
  expect(validatePipeFrame(frame(3), end).ok).toBe(true);
  expect(journey.preview.vt.length).toBeLessThanOrEqual(M0_LIMITS.previewBytesPerRun);
});

test("admission fixture compiles six method params and sanitized result shapes", async () => {
  const journey = await fixture("admission-rpc.json");
  const methods = journey.methodCalls.map((call) => call.method);
  expect(methods).toEqual(Object.keys(RPC_METHODS));
  const run = journey.methodCalls[2].params.run;
  const record = {
    run,
    status: "live",
    geometry: { cols: 80, rows: 24 },
    controlEpoch: 0,
    controlHolder: null,
    preview: { version: 4, generatedAtMs: 1000, checkedAtMs: 1001, stale: false, byteLength: 4 },
  };
  const resultFor = (method) => {
    const fields = journey.resultFixtures[method];
    if (method === "server.status")
      return {
        ...journey.server,
        protocolVersion: 1,
        profile: PROFILE,
        effectiveBudgets: M0_LIMITS,
        ...fields,
      };
    if (method === "terminal.list") return { runs: [record], ...fields };
    if (method === "terminal.get")
      return {
        record: {
          ...record,
          preview: { ...record.preview, version: fields.previewVersion, stale: fields.stale },
        },
      };
    return { operation: { ...fields, run } };
  };
  for (const [index, call] of journey.methodCalls.entries()) {
    const disposition = classifyRpcItem({
      jsonrpc: "2.0",
      id: `q${index}`,
      method: call.method,
      params: call.params,
    });
    expect(disposition.kind).toBe("call");
    expect(disposition.method).toBe(call.method);
    expect(validateRpcResultForCall(call.method, call.params, resultFor(call.method))).toBe(true);
    const error = domainError(journey.errorKinds[call.method]);
    expect(
      validateRpcResponse({
        jsonrpc: "2.0",
        id: `q${index}`,
        error: {
          code: error.code,
          message: error.message,
          data: error,
        },
      }),
    ).not.toBeNull();
  }
  expect(composeRpcMethodResult("terminal.get", { record, vt: "not-part-of-RPC" })).toEqual({
    record,
  });
});

test("receipt fixture replays same intent and rejects conflict or exhausted new work", async () => {
  const journey = await fixture("admission-rpc.json");
  const create = journey.methodCalls.find((call) => call.method === "terminal.create");
  const intent = canonicalOperationIntent("terminal.create", create.params, encoder);
  expect(intent).not.toBeNull();
  const key = {
    serverId: journey.server.serverId,
    relayInstanceId: journey.server.relayInstanceId,
    principalId: "fixture-principal",
    operationId: create.params.operationId,
  };
  const record = {
    operationId: create.params.operationId,
    method: "terminal.create",
    revision: 1,
    state: "accepted",
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
      existing: { key, canonicalIntent: intent + "changed", record },
    }),
  ).toBe("conflict");
  expect(classifyReceiptAdmission(common)).toBe("busy");
});

test("literal base-v1 compatibility drops optional capability and refuses protocol drift", async () => {
  const journey = await fixture("admission-rpc.json");
  expect(journey.literalBaseV1).toEqual({
    bootstrapVersion: 1,
    protocolVersion: 1,
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    requiredCapabilities: ["terminal-framing-v1", "logical-grid-recovery-v1"],
  });
  const request = {
    type: "cove-bootstrap",
    bootstrapVersion: journey.literalBaseV1.bootstrapVersion,
    protocolVersion: journey.literalBaseV1.protocolVersion,
    buildVersion: journey.clientBuild,
    capabilities: [...journey.oldPeerCapabilities, journey.optionalExtension],
    profiles: [PROFILE],
    encodings: [BASELINE_ENCODING],
  };
  const result = negotiateBootstrap(request, { ...journey.server, effectiveBudgets: M0_LIMITS });
  expect(result.type).toBe("cove-bootstrap-result");
  expect(result.capabilities).toEqual(journey.oldPeerCapabilities);
  expect(result.capabilities).not.toContain(journey.optionalExtension);
  expect(
    negotiateBootstrap(
      { ...request, protocolVersion: journey.incompatibleProtocolVersion },
      { ...journey.server, effectiveBudgets: M0_LIMITS },
    ).kind,
  ).toBe("PROTOCOL_MISMATCH");
});

test("maximum baseline makes progress with chunk credit and reserved control", () => {
  const chunks = M0_LIMITS.baselineChunks;
  const credit = M0_LIMITS.subscriptionCreditBytes;
  expect(chunks).toBe(129);
  expect(MAX_FRAME_BYTES).toBeLessThan(credit);
  let remaining = chunks;
  let cycles = 0;
  while (remaining > 0) {
    const sent = Math.min(remaining, Math.floor(credit / MAX_FRAME_BYTES));
    expect(sent).toBeGreaterThan(0);
    remaining -= sent;
    cycles++;
  }
  expect(cycles).toBeLessThan(chunks);
  expect(M0_LIMITS.reservedControlBytes).toBeGreaterThan(0);
});

test("all public wire schemas produce finite JSON Schema projections", () => {
  for (const schema of [
    BootstrapRequestSchema,
    BootstrapSuccessSchema,
    BootstrapFailureSchema,
    WsBootstrapSchema,
    RendezvousSchema,
    EffectiveBudgetsSchema,
    DomainErrorSchema,
    ConnectionRefSchema,
    RunRefSchema,
    SubscriptionRefSchema,
    WorkerRefSchema,
    PipeCommandSchema,
    PipeMetadataSchema,
    PipeHelloSchema,
    PipeReadySchema,
    PipeResultSchema,
    PipeEventSchema,
    PipeErrorSchema,
    RunStatusSchema,
    SpawnArgumentsSchema,
    RecoveryCoverageSchema,
    AppearanceSchema,
    GeometrySchema,
    RpcRequestSchema,
    RpcResultSchema,
    RpcErrorSchema,
    OperationRecordSchema,
    RunRecordSchema,
    TerminalCommandSchema,
    TerminalResultSchema,
    TerminalErrorSchema,
    TerminalEventSchema,
    BaselineDescriptorSchema,
    BaselineChunkSchema,
    BaselineEndSchema,
    ...Object.values(RPC_METHODS).flatMap((method) => [method.params, method.result]),
  ]) {
    const json = z.toJSONSchema(schema);
    expect(json).toBeTruthy();
    expect(JSON.stringify(json).length).toBeLessThan(100_000);
  }
  expect(M0_CAPABILITIES).toContain("logical-grid-recovery-v1");
});
