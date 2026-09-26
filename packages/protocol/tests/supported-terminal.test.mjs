import { expect, test } from "vitest";
import {
  ConnectionRefSchema,
  SubscriptionRefSchema,
  nextCounter,
  sameSubscriptionRef,
} from "@cove/protocol/identity";
import {
  DOMAIN_ERROR_KINDS,
  DomainErrorSchema,
  ERROR_CODES,
  domainError,
} from "@cove/protocol/errors";
import { M0_LIMITS, validateEffectiveBudgets } from "@cove/protocol/budgets";
import { DEFAULT_APPEARANCE, QUERY_SUPPORT, validateAppearance } from "@cove/protocol/profile";
import {
  TERMINAL_LANE,
  TERMINAL_REVISION,
  ExternalTerminalEventSchema,
  RunEventSchema,
  TerminalEventSchema,
  TerminalResultSchema,
  createTerminalDecoder,
  encodeTerminalFrame,
  validateTerminalFrame,
  validateTerminalResultForCommand,
  boundedJsonStructure,
  validateBaselineDescriptor,
  validateBaselineTransfer,
  validateContiguousEvents,
} from "@cove/protocol/terminal";
import { createTerminalDecoder as createProbeDecoder } from "@cove/protocol/provisional/terminal";

const run = { serverId: "s1", relayInstanceId: "i1", runId: "r1" };
const connection = { connectionId: "c1", generation: 1 };
const subscription = { run, connection, subscriptionId: "sub1", viewId: "v1" };
const empty = new Uint8Array();
const frame = (kind, payload = empty) => ({ kind, metadata: empty, payload });
const descriptor = {
  baselineId: "b1",
  run,
  subscription,
  profile: "pragmatic-logical-grid-v1",
  encoding: "vt-checkpoint-tail-v1",
  checkpointSeq: 2,
  atSeq: 3,
  captureGeometry: { cols: 12, rows: 4 },
  currentGeometry: { cols: 12, rows: 4 },
  coverage: {
    normal: {
      historyLines: 3,
      includedHistoryLines: 3,
      trimmedBefore: false,
      resizeContext: "complete",
    },
    alternate: { included: true, resizeContext: "complete" },
  },
  vtBytes: 3,
  tailBytes: 2,
  chunkCount: 1,
};

test("frozen identities bind connection, view, subscription, instance and safe counters", () => {
  expect(ConnectionRefSchema.safeParse(connection).success).toBe(true);
  expect(SubscriptionRefSchema.safeParse(subscription).success).toBe(true);
  expect(sameSubscriptionRef(subscription, { ...subscription })).toBe(true);
  for (const changed of [
    { ...subscription, run: { ...run, relayInstanceId: "i2" } },
    { ...subscription, connection: { ...connection, generation: 2 } },
    { ...subscription, viewId: "v2" },
    { ...subscription, subscriptionId: "sub2" },
  ])
    expect(sameSubscriptionRef(subscription, changed)).toBe(false);
  expect(nextCounter(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
  expect(nextCounter(Number.MAX_SAFE_INTEGER)).toBeNull();
  expect(nextCounter(Infinity)).toBeNull();
});

test("profile advertises only nine tested query families and known palette one", () => {
  expect(QUERY_SUPPORT.map((query) => query.fixture)).toEqual([
    "dsr-status",
    "cpr",
    "dec-cpr",
    "da-primary",
    "da-secondary",
    "mode-report",
    "color-fg",
    "color-bg",
    "color-palette",
  ]);
  expect(DEFAULT_APPEARANCE.palette).toEqual([{ index: 1, rgb: "cccc/0000/0000" }]);
  expect(validateAppearance(DEFAULT_APPEARANCE)).not.toBeNull();
  expect(
    validateAppearance({
      ...DEFAULT_APPEARANCE,
      palette: [
        { index: 1, rgb: "cccc/0000/0000" },
        { index: 1, rgb: "ffff/ffff/ffff" },
      ],
    }),
  ).toBeNull();
});

test("effective limits reject nonfinite, oversized and contradictory budgets", () => {
  expect(validateEffectiveBudgets(M0_LIMITS)).not.toBeNull();
  expect(validateEffectiveBudgets({ ...M0_LIMITS, maxRuns: NaN })).toBeNull();
  expect(validateEffectiveBudgets({ ...M0_LIMITS, maxRuns: 129 })).toBeNull();
  expect(
    validateEffectiveBudgets({ ...M0_LIMITS, parseLowBytes: M0_LIMITS.parseHighBytes }),
  ).toBeNull();
  expect(validateEffectiveBudgets({ ...M0_LIMITS, baselineChunks: 128 })).toBeNull();
  expect(validateEffectiveBudgets({ ...M0_LIMITS, subscriptionCreditBytes: 65_536 })).toBeNull();
  expect(validateEffectiveBudgets({ ...M0_LIMITS, outboundConnectionBytes: 1 })).toBeNull();
  expect(validateEffectiveBudgets({ ...M0_LIMITS, reservedControlBytes: 1 })).toBeNull();
  expect(validateEffectiveBudgets({ ...M0_LIMITS, pipeQueuedBytes: 1 })).toBeNull();
  expect(validateEffectiveBudgets({ ...M0_LIMITS, previewGlobalBytes: 65_536 })).toBeNull();
});

test("domain codes are complete and sequential without interpolating user bytes", () => {
  expect(DOMAIN_ERROR_KINDS).toHaveLength(21);
  expect(DOMAIN_ERROR_KINDS.map((kind) => ERROR_CODES[kind])).toEqual(
    Array.from({ length: 21 }, (_, index) => 1000 + index),
  );
  expect(domainError("RESULT_UNKNOWN", "unknown")).toMatchObject({
    code: 1018,
    acceptance: "unknown",
    nextAction: "query-operation",
  });
  expect(JSON.stringify(domainError("INPUT_REJECTED"))).not.toContain("secret-marker");
});

test("error fields reject injected detail and mismatched next action", () => {
  const valid = domainError("UNAUTHENTICATED");
  expect(DomainErrorSchema.safeParse(valid).success).toBe(true);
  expect(DomainErrorSchema.safeParse({ ...valid, message: "credential secret" }).success).toBe(
    false,
  );
  expect(DomainErrorSchema.safeParse({ ...valid, nextAction: "none" }).success).toBe(false);
});

test("frozen lane and class header cannot enter provisional decoder", () => {
  const encoded = encodeTerminalFrame(1, Uint8Array.of(123, 125), empty);
  expect(encoded.ok).toBe(true);
  expect(Array.from(encoded.value.subarray(0, 5))).toEqual([0x43, 0x50, 3, 2, 1]);
  expect(TERMINAL_LANE).toBe(3);
  expect(TERMINAL_REVISION).toBe(2);
  expect(createProbeDecoder().read(encoded.value).status).toBe("error");
  expect(createTerminalDecoder().read(encoded.value).frames).toHaveLength(1);
  const oldRevision = encoded.value.slice();
  oldRevision[3] = 1;
  expect(createTerminalDecoder().read(oldRevision)).toMatchObject({
    status: "error",
    error: { code: "UNSUPPORTED_FORMAT" },
  });
});

test("frozen decoder owns split payload and rejects malformed header and EOF", () => {
  const encoded = encodeTerminalFrame(3, Uint8Array.of(123, 125), Uint8Array.of(0, 27, 255));
  expect(encoded.ok).toBe(true);
  const decoder = createTerminalDecoder();
  for (let index = 0; index < encoded.value.length - 1; index++)
    expect(decoder.read(encoded.value.subarray(index, index + 1)).frames).toHaveLength(0);
  const last = decoder.read(encoded.value.subarray(-1));
  expect(Array.from(last.frames[0].payload)).toEqual([0, 27, 255]);
  encoded.value.fill(0);
  expect(Array.from(last.frames[0].payload)).toEqual([0, 27, 255]);
  const partial = createTerminalDecoder();
  partial.read(Uint8Array.of(0x43, 0x50, 3));
  expect(partial.finish().ok).toBe(false);
});

test("terminal command payload is confined to input and metadata class is closed", () => {
  const command = { type: "input", requestId: "q1", run, subscription, epoch: 1, inputSeq: 1 };
  expect(validateTerminalFrame(frame(1, Uint8Array.of(0, 255)), command).ok).toBe(true);
  expect(validateTerminalFrame(frame(1), command).ok).toBe(false);
  expect(validateTerminalFrame(frame(3, Uint8Array.of(1)), command).ok).toBe(false);
  expect(validateTerminalFrame(frame(1, Uint8Array.of(1)), { ...command, type: "future" }).ok).toBe(
    false,
  );
  expect(
    validateTerminalFrame(frame(1, Uint8Array.of(1)), {
      ...command,
      subscription: { ...subscription, run: { ...run, runId: "r2" } },
    }).ok,
  ).toBe(false);
});

test("routed run output preserves inner events and binds full subscription identity", () => {
  const first = { type: "output", run, seq: 1 };
  const second = {
    type: "resize",
    run,
    seq: 2,
    geometry: { cols: 12, rows: 4 },
    requiresBaseline: true,
  };
  const delivered = { type: "run-event", subscription, event: first };
  expect(RunEventSchema.safeParse(first).success).toBe(true);
  expect(TerminalEventSchema.safeParse(first).success).toBe(true);
  expect(ExternalTerminalEventSchema.safeParse(delivered).success).toBe(true);
  expect(validateTerminalFrame(frame(3, Uint8Array.of(0)), delivered, connection).ok).toBe(true);
  expect(validateTerminalFrame(frame(3), delivered, connection).ok).toBe(false);
  expect(validateTerminalFrame(frame(3), { ...delivered, event: second }, connection).ok).toBe(
    true,
  );
  expect(
    validateTerminalFrame(frame(3, Uint8Array.of(1)), { ...delivered, event: second }, connection)
      .ok,
  ).toBe(false);
  expect(validateTerminalFrame(frame(3, Uint8Array.of(0)), first, connection).ok).toBe(false);
  for (const changed of [
    { ...delivered, event: { ...first, run: { ...run, runId: "r2" } } },
    { ...delivered, subscription: { ...subscription, run: { ...run, runId: "r2" } } },
  ])
    expect(validateTerminalFrame(frame(3, Uint8Array.of(0)), changed, connection).ok).toBe(false);
  expect(
    validateTerminalFrame(frame(3, Uint8Array.of(0)), delivered, { ...connection, generation: 2 })
      .ok,
  ).toBe(false);
  expect(validateContiguousEvents([first, second], 0)).toBe(true);
  expect(validateContiguousEvents([first, { ...second, seq: 3 }], 0)).toBe(false);
});

test("two subscriptions on one run remain independently routed", () => {
  const other = { ...subscription, subscriptionId: "sub2", viewId: "v2" };
  const first = {
    type: "run-event",
    subscription,
    event: { type: "output", run, seq: 4 },
  };
  const second = {
    type: "run-event",
    subscription: other,
    event: { type: "output", run, seq: 9 },
  };
  expect(validateTerminalFrame(frame(3, Uint8Array.of(1)), first, connection).ok).toBe(true);
  expect(validateTerminalFrame(frame(3, Uint8Array.of(1)), second, connection).ok).toBe(true);
  expect(first.subscription).not.toEqual(second.subscription);
  expect(first.event.seq).not.toBe(second.event.seq);
});

test("new attach gets a fresh ID while recovery keeps the complete existing ref", () => {
  const reconnectConnection = { ...connection, generation: 2 };
  const attach = {
    type: "attach",
    requestId: "attach-2",
    run,
    connection: reconnectConnection,
    viewId: subscription.viewId,
    profile: "pragmatic-logical-grid-v1",
    encoding: "vt-checkpoint-tail-v1",
  };
  const reattached = {
    type: "attach-result",
    requestId: attach.requestId,
    run,
    subscription: {
      ...subscription,
      connection: reconnectConnection,
      subscriptionId: "sub-new",
    },
    mode: "replay",
    atSeq: 4,
  };
  expect(validateTerminalResultForCommand(attach, reattached)).toBe(false);
  expect(validateTerminalResultForCommand(attach, { ...reattached, mode: "baseline" })).toBe(true);
  const retained = {
    appliedSeq: 4,
    profile: attach.profile,
    encoding: attach.encoding,
    geometry: { cols: 12, rows: 4 },
  };
  expect(validateTerminalResultForCommand({ ...attach, resume: retained }, reattached)).toBe(true);
  expect(reattached.subscription.subscriptionId).not.toBe(subscription.subscriptionId);

  const command = {
    type: "recover",
    requestId: "recover-1",
    run,
    subscription,
    reason: "gap",
    resume: {
      appliedSeq: 4,
      profile: "pragmatic-logical-grid-v1",
      encoding: "vt-checkpoint-tail-v1",
      geometry: { cols: 12, rows: 4 },
    },
  };
  const result = {
    type: "recover-result",
    requestId: command.requestId,
    run,
    subscription,
    mode: "replay",
    atSeq: 4,
  };
  expect(validateTerminalResultForCommand(command, result)).toBe(true);
  expect(validateTerminalResultForCommand({ ...command, resume: undefined }, result)).toBe(false);
  expect(
    validateTerminalResultForCommand(
      { ...command, resume: undefined },
      { ...result, mode: "baseline" },
    ),
  ).toBe(true);
  expect(validateTerminalResultForCommand(command, { ...result, atSeq: 3 })).toBe(false);
  expect(
    validateTerminalResultForCommand(command, {
      ...result,
      subscription: { ...subscription, subscriptionId: "sub2" },
    }),
  ).toBe(false);
  const projected = TerminalResultSchema.parse({ ...result, replacement: reattached.subscription });
  expect(Object.hasOwn(projected, "replacement")).toBe(false);
});

test("result correlation rejects stale request, run, subscription and input sequence", () => {
  const command = { type: "input", requestId: "q1", run, subscription, epoch: 2, inputSeq: 3 };
  const result = {
    type: "input-result",
    requestId: "q1",
    run,
    subscription,
    epoch: 2,
    inputSeq: 3,
    status: "written",
    writtenBytes: 2,
  };
  expect(validateTerminalFrame(frame(2), result).ok).toBe(true);
  expect(validateTerminalResultForCommand(command, result)).toBe(true);
  for (const changed of [
    { ...result, requestId: "q2" },
    { ...result, inputSeq: 4 },
    { ...result, run: { ...run, relayInstanceId: "i2" } },
    { ...result, subscription: { ...subscription, viewId: "v2" } },
  ])
    expect(validateTerminalResultForCommand(command, changed)).toBe(false);
});

test("control and cumulative acknowledgment results bind original epoch or sequence", () => {
  const fields = { requestId: "q1", run, subscription };
  for (const type of ["blur", "resize", "appearance"]) {
    const command = {
      type,
      ...fields,
      epoch: 2,
      geometry: { cols: 12, rows: 4 },
      appearance: DEFAULT_APPEARANCE,
    };
    const result = { type: `${type}-result`, ...fields, epoch: 3, atSeq: 4 };
    expect(validateTerminalResultForCommand(command, result)).toBe(false);
  }
  expect(
    validateTerminalResultForCommand(
      { type: "applied-ack", ...fields, appliedSeq: 4 },
      { type: "applied-ack-result", ...fields, appliedSeq: 5 },
    ),
  ).toBe(false);
});

test("baseline descriptor binds N, geometry, both buffers and budgeted normal history", () => {
  expect(validateBaselineDescriptor(descriptor)).not.toBeNull();
  expect(validateBaselineDescriptor({ ...descriptor, checkpointSeq: 4 })).toBeNull();
  expect(
    validateBaselineDescriptor({ ...descriptor, currentGeometry: { cols: 11, rows: 4 } }),
  ).toBeNull();
  expect(
    validateBaselineDescriptor({
      ...descriptor,
      coverage: {
        ...descriptor.coverage,
        normal: { ...descriptor.coverage.normal, includedHistoryLines: 4 },
      },
    }),
  ).toBeNull();
  expect(
    validateBaselineDescriptor({
      ...descriptor,
      coverage: {
        ...descriptor.coverage,
        alternate: { included: false, resizeContext: "complete" },
      },
    }),
  ).toBeNull();
});

test("baseline transfer rejects reordered, duplicate, missing and overfull chunks", () => {
  const chunk = {
    metadata: { type: "baseline-chunk", run, baselineId: "b1", subscription, ordinal: 0 },
    payload: Uint8Array.of(1, 2, 3, 4, 5),
  };
  const end = {
    type: "baseline-end",
    run,
    baselineId: "b1",
    subscription,
    chunkCount: 1,
    totalBytes: 5,
    atSeq: 3,
  };
  expect(validateBaselineTransfer(descriptor, [chunk], end)).toBe(true);
  expect(
    validateBaselineTransfer(
      descriptor,
      [
        {
          ...chunk,
          metadata: {
            ...chunk.metadata,
            run: { ...run, runId: "r2" },
          },
        },
      ],
      end,
    ),
  ).toBe(false);
  expect(
    validateBaselineTransfer(descriptor, [chunk], {
      ...end,
      run: { ...run, relayInstanceId: "i2" },
    }),
  ).toBe(false);
  expect(validateBaselineTransfer(descriptor, [chunk, chunk], end)).toBe(false);
  expect(validateBaselineTransfer(descriptor, [], end)).toBe(false);
  expect(
    validateBaselineTransfer(
      descriptor,
      [{ ...chunk, metadata: { ...chunk.metadata, ordinal: 1 } }],
      end,
    ),
  ).toBe(false);
  expect(
    validateBaselineTransfer(
      descriptor,
      [{ ...chunk, payload: Uint8Array.of(1, 2, 3, 4, 5, 6) }],
      end,
    ),
  ).toBe(false);
});

test("baseline accepts any exact ordered bounded nonempty chunk partition", () => {
  const three = { ...descriptor, vtBytes: 3, tailBytes: 3, chunkCount: 3 };
  const chunks = [2, 3, 1].map((length, ordinal) => ({
    metadata: { type: "baseline-chunk", run, subscription, baselineId: "b1", ordinal },
    payload: new Uint8Array(length),
  }));
  const end = {
    type: "baseline-end",
    run,
    subscription,
    baselineId: "b1",
    atSeq: 3,
    totalBytes: 6,
    chunkCount: 3,
  };
  expect(validateBaselineDescriptor(three)).not.toBeNull();
  expect(validateBaselineTransfer(three, chunks, end)).toBe(true);
  expect(validateBaselineDescriptor({ ...three, chunkCount: 7 })).toBeNull();
});

test("baseline start rejects mismatched run and never carries opaque cells", () => {
  const start = { type: "baseline-start", run, descriptor };
  expect(validateTerminalFrame(frame(3), start, connection).ok).toBe(true);
  expect(
    validateTerminalFrame(
      frame(3),
      {
        ...start,
        run: { ...run, runId: "other" },
      },
      connection,
    ).ok,
  ).toBe(false);
  expect(
    validateTerminalFrame(
      frame(3),
      {
        ...start,
        descriptor: {
          ...descriptor,
          subscription: {
            ...subscription,
            connection: { ...connection, generation: 2 },
          },
        },
      },
      connection,
    ).ok,
  ).toBe(false);
  expect(JSON.stringify(descriptor)).not.toMatch(/cells|privateState/);
});

test("full JSON structure is bounded before unknown optional fields are stripped", () => {
  const command = { type: "preview", requestId: "q1", run, future: "ignored" };
  expect(validateTerminalFrame(frame(1), command).ok).toBe(true);
  let nested = {};
  for (let index = 0; index < 17; index++) nested = { child: nested };
  expect(boundedJsonStructure(nested)).toBe(false);
  expect(validateTerminalFrame(frame(1), { ...command, future: nested }).ok).toBe(false);
});

test("frame cap and cross-lane refusal preserve provisional framing limits", () => {
  expect(encodeTerminalFrame(1, new Uint8Array(4097), empty).ok).toBe(false);
  expect(encodeTerminalFrame(3, Uint8Array.of(123, 125), new Uint8Array(65_537)).ok).toBe(false);
  const encoded = encodeTerminalFrame(1, Uint8Array.of(123, 125), empty);
  expect(encoded.ok).toBe(true);
  const wrong = encoded.value.slice();
  wrong[2] = 4;
  expect(createTerminalDecoder().read(wrong).status).toBe("error");
  const event = {
    type: "run-event",
    subscription,
    event: { type: "output", run, seq: 1 },
  };
  expect(
    validateTerminalFrame(
      { ...frame(3, Uint8Array.of(1)), metadata: new Uint8Array(4097) },
      event,
      connection,
    ).ok,
  ).toBe(false);
  const oversizedMetadata = new TextEncoder().encode(
    JSON.stringify({ ...event, ignored: "x".repeat(4096) }),
  );
  expect(encodeTerminalFrame(3, oversizedMetadata, Uint8Array.of(1)).ok).toBe(false);
});
