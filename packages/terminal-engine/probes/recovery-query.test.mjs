import { afterAll, expect, test } from "vitest";
import { runRecoveryFixture } from "@cove/terminal-engine/probes/recovery-boundaries";
import {
  appearance,
  bytes,
  dimensions,
  expectedLiveReplies,
  hex,
  queryBytes,
} from "../../../tests/fixtures/terminal/engine/recovery-cases.mjs";
import { writeRecoverySuiteEvidence } from "../../../tests/fixtures/terminal/engine/recovery-evidence.mjs";

const completed = [];
afterAll(() => writeRecoverySuiteEvidence("recovery-query", completed, 12));

const caseIds = [
  "dsr-status",
  "cpr",
  "dec-cpr",
  "da-primary",
  "da-secondary",
  "mode-report",
  "color-fg",
  "color-bg",
  "color-palette",
];

function join(parts) {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

test("R7 source answers every agreed query exactly once before, during, and after recovery", async () => {
  expect(Object.keys(queryBytes)).toEqual(caseIds);
  expect(Object.keys(expectedLiveReplies)).toEqual(caseIds);
  const queries = join(caseIds.map((id) => queryBytes[id]));
  const expected = caseIds.map((id) => hex(expectedLiveReplies[id]));
  const result = await runRecoveryFixture({
    caseId: "R7-live-query-families",
    ...dimensions,
    setupBytes: queries,
    tailBytes: queries,
    continuationBytes: queries,
    appearance,
  });
  expect(result.generationPure).toBe(true);
  expect(result.beforeEqual).toBe(true);
  expect(result.afterEqual).toBe(true);
  expect(result.sourceRepliesAtCheckpoint).toBe(caseIds.length);
  expect(result.sourceRepliesAfterRecovery).toBe(caseIds.length * 2);
  expect(result.receiverRepliesAfterRecovery).toBe(caseIds.length);
  expect(result.sourceReplies.map((reply) => hex(bytes(reply)))).toEqual([
    ...expected,
    ...expected,
    ...expected,
  ]);
  expect(result.receiverReplies.map((reply) => hex(bytes(reply)))).toEqual([
    ...expected,
    ...expected,
  ]);
  completed.push(...caseIds);
});

test("R7 controlled appearance responds to color queries; unknown appearance invents none", async () => {
  const colors = join([
    queryBytes["color-fg"],
    queryBytes["color-bg"],
    queryBytes["color-palette"],
  ]);
  const known = await runRecoveryFixture({
    caseId: "R7-controlled-appearance",
    ...dimensions,
    setupBytes: bytes(""),
    tailBytes: colors,
    continuationBytes: bytes(""),
    appearance,
  });
  expect(known.sourceReplies.map((reply) => hex(bytes(reply)))).toEqual([
    hex(expectedLiveReplies["color-fg"]),
    hex(expectedLiveReplies["color-bg"]),
    hex(expectedLiveReplies["color-palette"]),
  ]);
  expect(known.receiverReplies).toEqual(known.sourceReplies);
  const unknown = await runRecoveryFixture({
    caseId: "R7-unknown-appearance",
    ...dimensions,
    setupBytes: bytes(""),
    tailBytes: colors,
    continuationBytes: bytes(""),
  });
  expect(unknown.sourceReplies).toEqual([]);
  expect(unknown.receiverReplies).toEqual([]);
  completed.push(known.caseId, unknown.caseId);
});

test("R7 baseline generation is pure and replay remains disconnected from the source sink", async () => {
  const result = await runRecoveryFixture({
    caseId: "R7-purity",
    ...dimensions,
    setupBytes: queryBytes["dsr-status"],
    tailBytes: queryBytes.cpr,
    continuationBytes: queryBytes["da-primary"],
  });
  expect(result.generationPure).toBe(true);
  expect(result.sourceRepliesAtCheckpoint).toBe(1);
  expect(result.sourceRepliesAfterRecovery).toBe(2);
  expect(result.receiverRepliesAfterRecovery).toBe(1);
  expect(result.sourceReplies.map((reply) => hex(bytes(reply)))).toEqual([
    hex(expectedLiveReplies["dsr-status"]),
    hex(expectedLiveReplies.cpr),
    hex(expectedLiveReplies["da-primary"]),
  ]);
  completed.push(result.caseId);
});
