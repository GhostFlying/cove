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
  PROTOCOL_VERSION,
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
  PIPE_REVISION,
  PIPE_VERSION,
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
  validateOperationRecord,
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
  ExternalTerminalEventSchema,
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
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_METADATA_BYTES,
  TERMINAL_REVISION,
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
  expect(journey.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(journey.terminalRevision).toBe(TERMINAL_REVISION);
  const subscription = {
    run: journey.run,
    connection: journey.connection,
    subscriptionId: journey.subscriptionId,
    viewId: journey.viewId,
  };
  expect(SubscriptionRefSchema.safeParse(subscription).success).toBe(true);
  expect(journey.reconnectSubscriptionId).not.toBe(journey.subscriptionId);
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
      { type: "run-event", subscription, event: events[0] },
      journey.connection,
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
  const uncertain = domainError("RESULT_UNKNOWN", journey.inputOutcome.acceptance, "input");
  expect(uncertain.nextAction).toBe(journey.inputOutcome.nextAction);
  expect(uncertain.subject).toBe("input");
  expect(uncertain.nextAction).not.toBe("query-operation");
  expect(DomainErrorSchema.safeParse({ ...uncertain, acceptance: "not-accepted" }).success).toBe(
    false,
  );
  expect(
    validateTerminalFrame(frame(4), {
      type: "error",
      run: journey.run,
      requestId: "input-q",
      commandType: "input",
      error: uncertain,
    }).ok,
  ).toBe(true);
  expect(
    validateTerminalFrame(frame(4), {
      type: "error",
      run: journey.run,
      requestId: "input-q",
      commandType: "input",
      error: domainError("RESULT_UNKNOWN", "unknown"),
    }).ok,
  ).toBe(false);
  expect(journey.stalePreview.currentVersion).toBeGreaterThan(journey.stalePreview.knownVersion);
});

test("fixture consumer ledger accepts monotonic gaps but rejects stale control and input", async () => {
  const journey = await fixture("terminal-journey.json");
  const { olderFocusSeq, newerFocusSeq, olderEpoch, newerEpoch } = journey.focusRace;
  const {
    skippedFocusSeq,
    skippedInputSeq,
    viewGeneration,
    lateViewGeneration,
    initialAppliedSeq,
    nextAppliedSeq,
    grantAtSeq,
  } = journey.ordering;
  const subscription = {
    run: journey.run,
    connection: journey.connection,
    subscriptionId: journey.subscriptionId,
    viewId: journey.viewId,
  };
  const base = { run: journey.run, subscription };
  const state = {
    focusSeq: 0,
    epoch: 0,
    holder: false,
    inputSeq: 0,
    appliedSeq: initialAppliedSeq,
    grantAtSeq: initialAppliedSeq,
    viewGeneration,
  };
  const seenFocus = new Map();
  const focus = (focusSeq, epoch, requestId) => {
    const command = {
      type: "focus",
      ...base,
      requestId,
      focusSeq,
      geometry: { cols: 80, rows: 24 },
    };
    const result = { type: "focus-result", ...base, requestId, epoch, atSeq: grantAtSeq };
    if (
      !TerminalCommandSchema.safeParse(command).success ||
      !TerminalResultSchema.safeParse(result).success ||
      !validateTerminalResultForCommand(command, result)
    )
      return "invalid";
    const prior = seenFocus.get(focusSeq);
    if (prior)
      return prior.requestId === requestId && prior.epoch === epoch ? "existing" : "conflict";
    if (focusSeq <= state.focusSeq) return "stale";
    if (epoch !== state.epoch + 1) return "invalid-epoch";
    seenFocus.set(focusSeq, { requestId, epoch });
    state.focusSeq = focusSeq;
    state.epoch = epoch;
    state.holder = true;
    state.grantAtSeq = focusSeq === newerFocusSeq ? grantAtSeq : initialAppliedSeq;
    return "accepted";
  };
  expect(focus(olderFocusSeq, olderEpoch, "focus-old")).toBe("accepted");
  expect(focus(newerFocusSeq, newerEpoch, "focus-new")).toBe("accepted");
  expect(focus(newerFocusSeq, newerEpoch, "focus-new")).toBe("existing");
  expect(focus(newerFocusSeq, newerEpoch, "focus-conflict")).toBe("conflict");
  expect(focus(olderFocusSeq, olderEpoch, "focus-old")).toBe("existing");
  expect(state.epoch).toBe(newerEpoch);
  const input = (inputSeq, epoch, generation) => {
    const command = { type: "input", ...base, requestId: `input-${inputSeq}`, inputSeq, epoch };
    if (!TerminalCommandSchema.safeParse(command).success) return false;
    if (
      !state.holder ||
      generation !== state.viewGeneration ||
      epoch !== state.epoch ||
      state.appliedSeq < state.grantAtSeq ||
      inputSeq <= state.inputSeq
    )
      return false;
    state.inputSeq = inputSeq;
    return true;
  };
  expect(input(journey.inputOutcome.inputSeq, olderEpoch, viewGeneration)).toBe(false);
  expect(input(journey.inputOutcome.inputSeq, newerEpoch, lateViewGeneration)).toBe(false);
  expect(input(journey.inputOutcome.inputSeq, newerEpoch + 1, viewGeneration)).toBe(false);
  expect(input(journey.inputOutcome.inputSeq, newerEpoch, viewGeneration)).toBe(false);
  state.appliedSeq = nextAppliedSeq;
  expect(input(journey.inputOutcome.inputSeq, newerEpoch, viewGeneration)).toBe(true);
  expect(input(journey.inputOutcome.inputSeq, newerEpoch, viewGeneration)).toBe(false);
  expect(input(skippedInputSeq, newerEpoch, viewGeneration)).toBe(true);
  expect(input(journey.inputOutcome.inputSeq + 1, newerEpoch, viewGeneration)).toBe(false);
  const blur = (epoch) => {
    const command = { type: "blur", ...base, requestId: `blur-${epoch}`, epoch };
    if (!TerminalCommandSchema.safeParse(command).success || !state.holder || epoch !== state.epoch)
      return false;
    state.holder = false;
    return true;
  };
  expect(blur(olderEpoch)).toBe(false);
  expect(blur(newerEpoch)).toBe(true);
  expect(input(skippedInputSeq + 1, newerEpoch, viewGeneration)).toBe(false);
  expect(focus(skippedFocusSeq, newerEpoch + 2, "focus-gap")).toBe("invalid-epoch");
  expect(focus(skippedFocusSeq, newerEpoch + 1, "focus-gap")).toBe("accepted");
  expect(focus(skippedFocusSeq - 1, newerEpoch + 2, "focus-stale")).toBe("stale");
  expect(state.epoch).toBe(newerEpoch + 1);
});

test("fixture consumer ACK ledger allows cumulative jumps and credits each event once", async () => {
  const journey = await fixture("terminal-journey.json");
  const { initialAppliedSeq, nextAppliedSeq, sentSeq, futureAppliedSeq } = journey.ordering;
  const subscription = {
    run: journey.run,
    connection: journey.connection,
    subscriptionId: journey.subscriptionId,
    viewId: journey.viewId,
  };
  let applied = initialAppliedSeq;
  const recordedBytes = new Map(
    journey.orderedPostBaseline.map(({ payload = [], ...metadata }) => [
      metadata.seq,
      HEADER_BYTES +
        encoder(JSON.stringify({ ...metadata, run: journey.run })).byteLength +
        payload.length,
    ]),
  );
  const ack = (appliedSeq) => {
    const command = {
      type: "applied-ack",
      run: journey.run,
      subscription,
      requestId: `ack-${appliedSeq}`,
      appliedSeq,
    };
    const result = {
      type: "applied-ack-result",
      run: journey.run,
      subscription,
      requestId: command.requestId,
      appliedSeq,
    };
    if (
      !TerminalCommandSchema.safeParse(command).success ||
      !TerminalResultSchema.safeParse(result).success ||
      !validateTerminalResultForCommand(command, result) ||
      appliedSeq > sentSeq
    )
      return { status: "invalid", creditedBytes: 0 };
    if (appliedSeq <= applied)
      return { status: appliedSeq === applied ? "duplicate" : "stale", creditedBytes: 0 };
    const creditedBytes = [...recordedBytes]
      .filter(([seq]) => seq > applied && seq <= appliedSeq)
      .reduce((total, [, bytes]) => total + bytes, 0);
    applied = appliedSeq;
    return { status: "advanced", creditedBytes };
  };
  expect(ack(futureAppliedSeq)).toEqual({ status: "invalid", creditedBytes: 0 });
  const cumulative = ack(sentSeq);
  expect(cumulative).toEqual({
    status: "advanced",
    creditedBytes: recordedBytes.get(nextAppliedSeq) + recordedBytes.get(sentSeq),
  });
  expect(ack(sentSeq)).toEqual({ status: "duplicate", creditedBytes: 0 });
  expect(ack(nextAppliedSeq)).toEqual({ status: "stale", creditedBytes: 0 });
  expect(ack(initialAppliedSeq)).toEqual({ status: "stale", creditedBytes: 0 });
  expect(applied).toBe(sentSeq);
});

test("scripted recovery trace rejects late delivery and old-ledger ACK credit", async () => {
  const journey = await fixture("terminal-journey.json");
  const checkTrace = (trace) => {
    let currentAttempt = 1;
    let markerSeen = false;
    let creditedBytes = 0;
    const retained = new Map();
    for (const item of trace) {
      if (item.kind === "recover") {
        currentAttempt = item.attempt;
        markerSeen = false;
        retained.clear();
      } else if (item.kind === "recover-result") {
        if (item.attempt !== currentAttempt) return null;
        markerSeen = true;
      } else if (item.kind === "run-event") {
        if (!markerSeen || item.attempt !== currentAttempt) return null;
        retained.set(item.seq, item.retainedBytes);
      } else if (item.kind === "applied-ack") {
        if (item.attempt !== currentAttempt) return null;
        for (const [seq, bytes] of retained) {
          if (seq <= item.seq) {
            creditedBytes += bytes;
            retained.delete(seq);
          }
        }
      }
    }
    return creditedBytes;
  };
  expect(checkTrace(journey.recovery.validTrace)).toBe(24);
  expect(checkTrace(journey.recovery.lateOldDeliveryTrace)).toBeNull();
  expect(checkTrace(journey.recovery.reusedAckTrace)).toBeNull();
});

test("pipe fixture binds ready, spawn payload, status and preview to one incarnation", async () => {
  const journey = await fixture("pipe-journey.json");
  expect(journey.pipeVersion).toBe(PIPE_VERSION);
  expect(journey.pipeRevision).toBe(PIPE_REVISION);
  const hello = {
    type: "hello",
    worker: journey.worker,
    pipeVersion: journey.pipeVersion,
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
  const routed = {
    type: "terminal-event",
    worker: journey.worker,
    run: journey.run,
    subscription: journey.subscription,
    terminal: { type: "output", run: journey.run, seq: journey.recovery.atSeq + 1 },
  };
  expect(validatePipeFrame(frame(3, Uint8Array.of(88)), routed).ok).toBe(true);
  expect(
    validatePipeFrame(frame(3, Uint8Array.of(88)), {
      ...routed,
      subscription: journey.secondSubscription,
    }).ok,
  ).toBe(true);
  expect(
    validatePipeFrame(frame(3, Uint8Array.of(88)), { ...routed, subscription: undefined }).ok,
  ).toBe(false);
  const recover = {
    type: "recover",
    worker: journey.worker,
    run: journey.run,
    requestId: journey.recovery.requestId,
    subscription: journey.subscription,
    appliedSeq: journey.recovery.appliedSeq,
  };
  const recovered = {
    type: "result",
    worker: journey.worker,
    run: journey.run,
    requestId: journey.recovery.requestId,
    commandType: "recover",
    outcome: "accepted",
    recoveryMode: journey.recovery.recoveryMode,
    atSeq: journey.recovery.atSeq,
  };
  expect(validatePipeResultForCommand(recover, recovered)).toBe(true);
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
  const inputError = {
    type: "error",
    worker: journey.worker,
    run: journey.run,
    requestId: journey.uncertainInput.requestId,
    commandType: "input",
    error: domainError("RESULT_UNKNOWN", journey.uncertainInput.acceptance, "input"),
  };
  expect(validatePipeFrame(frame(4), inputError).ok).toBe(true);
  expect(inputError.error.nextAction).toBe("inspect-run");
  expect(
    validatePipeFrame(frame(4), {
      ...inputError,
      error: domainError("RESULT_UNKNOWN", "unknown"),
    }).ok,
  ).toBe(false);
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
        protocolVersion: PROTOCOL_VERSION,
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
    const error = domainError(
      journey.errorKinds[call.method],
      journey.errorAcceptance?.[call.method] ?? "not-accepted",
    );
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
  expect(
    domainError(journey.errorKinds["terminal.create"], journey.errorAcceptance["terminal.create"]),
  ).toMatchObject({ acceptance: "unknown", nextAction: "query-operation" });
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
    run: journey.methodCalls[2].params.run,
    revision: 1,
    state: "accepted",
  };
  expect(validateOperationRecord(record, encoder)).toEqual(record);
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

test("current v2 drops optional capability and explicitly refuses protocol v1", async () => {
  const journey = await fixture("admission-rpc.json");
  expect(journey.currentV2).toEqual({
    bootstrapVersion: 1,
    protocolVersion: 2,
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    requiredCapabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
  });
  const request = {
    type: "cove-bootstrap",
    bootstrapVersion: journey.currentV2.bootstrapVersion,
    protocolVersion: journey.currentV2.protocolVersion,
    buildVersion: journey.clientBuild,
    capabilities: [...journey.currentPeerCapabilities, journey.optionalExtension],
    profiles: [PROFILE],
    encodings: [BASELINE_ENCODING],
  };
  const result = negotiateBootstrap(request, { ...journey.server, effectiveBudgets: M0_LIMITS });
  expect(result.type).toBe("cove-bootstrap-result");
  expect(result.capabilities).toEqual(journey.currentPeerCapabilities);
  expect(result.capabilities).not.toContain(journey.optionalExtension);
  const deliverExtension = (capability) => result.capabilities.includes(capability);
  expect(deliverExtension(journey.optionalExtension)).toBe(false);
  expect(deliverExtension("terminal-framing-v2")).toBe(true);
  const sendOptionalField = (capability, metadata) =>
    deliverExtension(capability) ? metadata : null;
  expect(sendOptionalField(journey.optionalExtension, journey.optionalField)).toBeNull();
  const withOptionalField = BootstrapRequestSchema.parse({ ...request, ...journey.optionalField });
  expect(withOptionalField).toEqual(BootstrapRequestSchema.parse(request));
  expect(Object.hasOwn(withOptionalField, "futureOptionalV1")).toBe(false);
  expect(
    negotiateBootstrap(
      { ...request, protocolVersion: journey.incompatibleProtocolVersion },
      { ...journey.server, effectiveBudgets: M0_LIMITS },
    ).kind,
  ).toBe("PROTOCOL_MISMATCH");
});

test("current bootstrap reader decodes a historical experimental failure", async () => {
  const journey = await fixture("admission-rpc.json");
  const historical = journey.historicalExperimentalV1;
  expect(historical.sourceRevision).toBe("6ccd5641bdc74eb4ada6b4a429b57a1cf2c1eaca");
  expect(BootstrapRequestSchema.safeParse(historical.clientRequest).success).toBe(true);
  expect(BootstrapFailureSchema.safeParse(historical.serverFailure).success).toBe(true);

  const currentReply = negotiateBootstrap(historical.clientRequest, {
    ...journey.server,
    effectiveBudgets: M0_LIMITS,
  });
  expect(currentReply).toMatchObject({
    type: "cove-bootstrap-error",
    kind: "PROTOCOL_MISMATCH",
    supportedVersions: { bootstrap: [1], protocol: [2] },
  });
  expect(BootstrapFailureSchema.safeParse(currentReply).success).toBe(true);
  expect(historical.serverFailure.supportedVersions.protocol).toEqual([1]);
});

test("maximum baseline returns recorded chunk credit through progress and reserves control", async () => {
  const journey = await fixture("terminal-journey.json");
  const subscription = {
    run: journey.run,
    connection: journey.connection,
    subscriptionId: journey.subscriptionId,
    viewId: journey.viewId,
  };
  const chunks = M0_LIMITS.baselineChunks;
  const credit = M0_LIMITS.subscriptionCreditBytes;
  expect(chunks).toBe(129);
  expect(MAX_FRAME_BYTES).toBeLessThan(credit);
  let available = credit;
  let lastSent = -1;
  let lastCredited = -1;
  let outstanding = 0;
  let progressCount = 0;
  let controlBytes = 0;
  const progressChecks = [];
  for (let ordinal = 0; ordinal < chunks; ordinal++) {
    if (available < MAX_FRAME_BYTES) {
      const progress = {
        type: "baseline-progress",
        run: journey.run,
        subscription,
        requestId: `progress-${lastSent}`,
        baselineId: journey.baseline.baselineId,
        lastParsedOrdinal: lastSent,
      };
      const result = { ...progress, type: "baseline-progress-result" };
      progressChecks.push(
        TerminalCommandSchema.safeParse(progress).success,
        TerminalResultSchema.safeParse(result).success,
        validateTerminalResultForCommand(progress, result),
        lastSent > lastCredited,
      );
      const returned = outstanding;
      available += returned;
      outstanding = 0;
      lastCredited = lastSent;
      progressCount++;
      controlBytes = 2 * (HEADER_BYTES + MAX_METADATA_BYTES);
      progressChecks.push(controlBytes <= M0_LIMITS.reservedControlBytes, available === credit);
    }
    available -= MAX_FRAME_BYTES;
    outstanding += MAX_FRAME_BYTES;
    lastSent = ordinal;
  }
  expect(progressChecks.every(Boolean)).toBe(true);
  expect(progressCount).toBeGreaterThan(0);
  expect(progressCount).toBeLessThan(chunks);
  expect(outstanding).toBeGreaterThan(0);
  expect(lastSent).toBe(chunks - 1);
  expect(lastCredited).toBeLessThan(lastSent);
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
    ExternalTerminalEventSchema,
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
