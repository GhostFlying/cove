import { expect, test } from "vitest";
import {
  RunRefSchema,
  SequenceSchema,
  sameRunRef,
  validateTerminalMessage,
} from "@cove/protocol/provisional/terminal";
import {
  WorkerRefSchema,
  PipeMetadataSchema,
  sameWorkerRef,
  validatePipeMessage,
} from "@cove/protocol/provisional/pipe";

const run = { serverId: "s-1", relayInstanceId: "i-1", runId: "r-1" };
const worker = {
  serverId: "s-1",
  relayInstanceId: "i-1",
  workerId: "w-1",
  workerIncarnationId: "wi-1",
};
const empty = new Uint8Array();

test("opaque IDs reject missing, mistyped, empty, oversized and coerced values", () => {
  for (const invalid of [undefined, "", "a".repeat(129), " space", 42, "é"]) {
    expect(RunRefSchema.safeParse({ ...run, runId: invalid }).success).toBe(false);
    expect(WorkerRefSchema.safeParse({ ...worker, workerId: invalid }).success).toBe(false);
  }
});

test("complete references preserve instance and incarnation identity", () => {
  expect(sameRunRef(run, { ...run })).toBe(true);
  expect(sameRunRef(run, { ...run, serverId: "s-2" })).toBe(false);
  expect(sameRunRef(run, { ...run, relayInstanceId: "i-2" })).toBe(false);
  expect(sameRunRef(run, { ...run, runId: "r-2" })).toBe(false);
  expect(sameWorkerRef(worker, { ...worker, workerId: "w-2" })).toBe(false);
  expect(sameWorkerRef(worker, { ...worker, workerIncarnationId: "wi-2" })).toBe(false);
});

test("sequence accepts exact safe boundary without normalization", () => {
  expect(SequenceSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0"]) {
    expect(SequenceSchema.safeParse(invalid).success).toBe(false);
  }
});

test("known metadata tolerates extra fields but rejects unknown kinds and absent correlation", () => {
  expect(
    validateTerminalMessage({ kind: "output", run, seq: 0, future: "ignored" }, empty).ok,
  ).toBe(true);
  expect(validateTerminalMessage({ kind: "future", run, seq: 0 }, empty).ok).toBe(false);
  expect(validateTerminalMessage({ kind: "input", run }, empty).ok).toBe(false);
  expect(
    PipeMetadataSchema.safeParse({ kind: "probe-request", worker, run, requestId: "q", extra: 1 })
      .success,
  ).toBe(true);
  expect(
    PipeMetadataSchema.safeParse({ kind: "future", worker, run, requestId: "q" }).success,
  ).toBe(false);
});

test("request correlation does not default from sequence or baseline identity and failures stay fixed", () => {
  const invalid = { kind: "input", run, seq: 7, baselineId: "secret-marker" };
  const result = validateTerminalMessage(invalid, Uint8Array.of(27, 93));
  expect(result).toMatchObject({ ok: false, error: { code: "INVALID_METADATA", offset: 0 } });
  expect(JSON.stringify(result)).not.toMatch(/secret-marker|\[27/);
});

test("baseline metadata requires feasible declared totals and zero-byte shape", () => {
  const baseline = {
    kind: "baseline-chunk",
    run,
    baselineId: "b",
    atSeq: 1,
    chunkIndex: 0,
    chunkCount: 2,
    totalBytes: 3,
  };
  expect(validateTerminalMessage(baseline, Uint8Array.of(1)).ok).toBe(true);
  for (const candidate of [
    { ...baseline, chunkIndex: 2 },
    { ...baseline, chunkCount: 257 },
    { ...baseline, totalBytes: 1 },
    { ...baseline, totalBytes: 131073 },
  ])
    expect(validateTerminalMessage(candidate, Uint8Array.of(1)).ok).toBe(false);
  expect(validateTerminalMessage({ ...baseline, chunkCount: 1, totalBytes: 0 }, empty).ok).toBe(
    true,
  );
  expect(validateTerminalMessage({ ...baseline, totalBytes: 0 }, empty).ok).toBe(false);
});

test("pipe correlation rejects mismatched refs and error payloads without leaking content", () => {
  const message = {
    kind: "terminal-event",
    worker,
    run,
    requestId: "q",
    terminal: { kind: "output", run, seq: 1 },
  };
  expect(validatePipeMessage(message, Uint8Array.of(27)).ok).toBe(true);
  expect(
    validatePipeMessage({ ...message, worker: { ...worker, relayInstanceId: "stale" } }, empty),
  ).toMatchObject({ ok: false, error: { code: "IDENTITY_MISMATCH" } });
  expect(
    validatePipeMessage(
      { ...message, terminal: { ...message.terminal, run: { ...run, runId: "other" } } },
      empty,
    ),
  ).toMatchObject({ ok: false, error: { code: "IDENTITY_MISMATCH" } });
  expect(
    validatePipeMessage(
      {
        kind: "error",
        worker,
        run,
        requestId: "q",
        error: { kind: "PROBE_FAILED", message: "secret-marker" },
      },
      Uint8Array.of(1),
    ),
  ).toMatchObject({ ok: false, error: { code: "INVALID_METADATA" } });
});
