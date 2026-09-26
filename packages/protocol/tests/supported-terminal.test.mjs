import { expect, test } from "vitest";
import {
  ConnectionRefSchema,
  SubscriptionRefSchema,
  nextCounter,
  sameSubscriptionRef,
} from "@cove/protocol/identity";
import { DOMAIN_ERROR_KINDS, ERROR_CODES, domainError } from "@cove/protocol/errors";
import { M0_LIMITS, validateEffectiveBudgets } from "@cove/protocol/budgets";
import { DEFAULT_APPEARANCE, QUERY_SUPPORT, validateAppearance } from "@cove/protocol/profile";
import {
  TERMINAL_LANE,
  TERMINAL_REVISION,
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

test("frozen lane and class header cannot enter provisional decoder", () => {
  const encoded = encodeTerminalFrame(1, Uint8Array.of(123, 125), empty);
  expect(encoded.ok).toBe(true);
  expect(Array.from(encoded.value.subarray(0, 5))).toEqual([0x43, 0x50, 3, 1, 1]);
  expect(TERMINAL_LANE).toBe(3);
  expect(TERMINAL_REVISION).toBe(1);
  expect(createProbeDecoder().read(encoded.value).status).toBe("error");
  expect(createTerminalDecoder().read(encoded.value).frames).toHaveLength(1);
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

test("run output and resize have contiguous positive seq and exact payload class", () => {
  const first = { type: "output", run, seq: 1 };
  const second = {
    type: "resize",
    run,
    seq: 2,
    geometry: { cols: 12, rows: 4 },
    requiresBaseline: true,
  };
  expect(validateTerminalFrame(frame(3, Uint8Array.of(0)), first).ok).toBe(true);
  expect(validateTerminalFrame(frame(3), first).ok).toBe(false);
  expect(validateTerminalFrame(frame(3), second).ok).toBe(true);
  expect(validateContiguousEvents([first, second], 0)).toBe(true);
  expect(validateContiguousEvents([first, { ...second, seq: 3 }], 0)).toBe(false);
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

test("baseline start rejects mismatched run and never carries opaque cells", () => {
  const start = { type: "baseline-start", run, descriptor };
  expect(validateTerminalFrame(frame(3), start).ok).toBe(true);
  expect(
    validateTerminalFrame(frame(3), {
      ...start,
      run: { ...run, runId: "other" },
    }).ok,
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
});
