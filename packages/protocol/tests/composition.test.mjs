import { expect, test } from "vitest";
import {
  createTerminalDecoder,
  encodeTerminalFrame,
  validateTerminalFrame,
  validateTerminalMessage,
} from "@cove/protocol/provisional/terminal";
import {
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
  validatePipeMessage,
} from "@cove/protocol/provisional/pipe";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const run = { serverId: "s", relayInstanceId: "i", runId: "r" };
const worker = { serverId: "s", relayInstanceId: "i", workerId: "w", workerIncarnationId: "wi" };

// Host conversion remains outside the byte-only protocol package.
function send(kind, metadata, payload, validate, encode) {
  const checked = validate(metadata, payload);
  if (!checked.ok) return checked;
  return encode(kind, encoder.encode(JSON.stringify(checked.value)), payload);
}

function receive(frame, validate) {
  try {
    const metadata = JSON.parse(decoder.decode(frame.metadata));
    return validate(frame, metadata);
  } catch {
    return { ok: false, error: { code: "INVALID_METADATA", offset: 0 } };
  }
}

test("compiled host composition preserves opaque VT, NUL and partial UTF-8", () => {
  const payload = Uint8Array.of(0, 255, 0xc3, 27, 91, 48, 109, 27, 93, 52, 59, 27, 80, 49);
  const metadata = { kind: "output", run, seq: 0 };
  const sent = send("output", metadata, payload, validateTerminalMessage, encodeTerminalFrame);
  expect(sent.ok).toBe(true);
  const framed = createTerminalDecoder().read(sent.value);
  expect(framed.frames).toHaveLength(1);
  expect(receive(framed.frames[0], validateTerminalFrame)).toMatchObject({
    ok: true,
    value: metadata,
  });
  expect(Array.from(framed.frames[0].payload)).toEqual(Array.from(payload));
  const input = { kind: "input", run, requestId: "q" };
  const sentInput = send(
    "input",
    input,
    new Uint8Array(),
    validateTerminalMessage,
    encodeTerminalFrame,
  );
  expect(sentInput.ok).toBe(true);
  expect(
    receive(createTerminalDecoder().read(sentInput.value).frames[0], validateTerminalFrame),
  ).toMatchObject({ ok: true, value: input });
});

test("opaque baseline chunks can be assembled externally without codec retention", () => {
  const all = Uint8Array.from({ length: 256 }, (_, index) => index);
  const chunks = [all.subarray(0, 130), all.subarray(130)];
  const frames = [];
  for (const [chunkIndex, payload] of chunks.entries()) {
    const metadata = {
      kind: "baseline-chunk",
      run,
      baselineId: "b",
      atSeq: 9,
      chunkIndex,
      chunkCount: 2,
      totalBytes: 256,
    };
    const sent = send(
      "baseline-chunk",
      metadata,
      payload,
      validateTerminalMessage,
      encodeTerminalFrame,
    );
    expect(sent.ok).toBe(true);
    frames.push(...createTerminalDecoder().read(sent.value).frames);
  }
  const assembled = Uint8Array.of(...frames[0].payload, ...frames[1].payload);
  expect(Array.from(assembled)).toEqual(Array.from(all));
});

test("pipe event carries same run and opaque terminal bytes without nested frame", () => {
  const payload = Uint8Array.of(27, 91, 0);
  const metadata = {
    kind: "terminal-event",
    worker,
    run,
    requestId: "q",
    terminal: { kind: "output", run, seq: 2 },
  };
  const sent = send("terminal-event", metadata, payload, validatePipeMessage, encodePipeFrame);
  expect(sent.ok).toBe(true);
  const frame = createPipeDecoder().read(sent.value).frames[0];
  expect(receive(frame, validatePipeFrame)).toMatchObject({ ok: true, value: metadata });
  expect(Array.from(frame.payload)).toEqual(Array.from(payload));
});

test("host rejects invalid UTF-8, malformed JSON and header-metadata kind mismatch", () => {
  for (const malformed of [Uint8Array.of(255), encoder.encode("{")]) {
    const encoded = encodeTerminalFrame("output", malformed, new Uint8Array());
    expect(
      receive(createTerminalDecoder().read(encoded.value).frames[0], validateTerminalFrame),
    ).toMatchObject({ ok: false, error: { code: "INVALID_METADATA" } });
  }
  const metadata = encoder.encode(JSON.stringify({ kind: "input", run, requestId: "q" }));
  const wrong = encodeTerminalFrame("output", metadata, new Uint8Array());
  expect(
    receive(createTerminalDecoder().read(wrong.value).frames[0], validateTerminalFrame),
  ).toMatchObject({ ok: false, error: { code: "INVALID_METADATA" } });
});

test("metadata byte limit applies after UTF-8 encoding and combined validation precedes send", () => {
  const oversized = {
    kind: "error",
    run,
    error: { kind: "PROBE_FAILED", message: "🧪".repeat(257) },
  };
  expect(validateTerminalMessage(oversized, new Uint8Array()).ok).toBe(false);
  const pipeMismatch = {
    kind: "probe-request",
    worker: { ...worker, serverId: "other" },
    run,
    requestId: "q",
  };
  expect(
    send("probe-request", pipeMismatch, new Uint8Array(), validatePipeMessage, encodePipeFrame),
  ).toMatchObject({ ok: false, error: { code: "IDENTITY_MISMATCH" } });
  const extra = { kind: "output", run, seq: 1, future: "🧪".repeat(1100) };
  expect(validateTerminalMessage(extra, new Uint8Array()).ok).toBe(true);
  expect(
    encodeTerminalFrame("output", encoder.encode(JSON.stringify(extra)), new Uint8Array()),
  ).toMatchObject({ ok: false, error: { code: "CAPACITY_EXCEEDED" } });
});
