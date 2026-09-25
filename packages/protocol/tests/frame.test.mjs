import { expect, test } from "vitest";
import {
  createTerminalDecoder,
  encodeTerminalFrame,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_READ_BYTES,
  MAX_READ_FRAMES,
} from "@cove/protocol/provisional/terminal";
import { createPipeDecoder, encodePipeFrame } from "@cove/protocol/provisional/pipe";

const metadata = Uint8Array.of(123, 125);
const bytes = (kind = "output", payload = Uint8Array.of(0, 27, 255)) => {
  const result = encodeTerminalFrame(kind, metadata, payload);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};

function feed(decoder, input, step) {
  const frames = [];
  for (let cursor = 0; cursor < input.byteLength;) {
    const chunk = input.subarray(cursor, Math.min(cursor + step, input.byteLength));
    const result = decoder.read(chunk);
    expect(result.status).not.toBe("error");
    expect(result.consumedBytes).toBeGreaterThan(0);
    cursor += result.consumedBytes;
    frames.push(...result.frames);
  }
  return frames;
}

test("fixed golden header decodes independent of encoder and preserves offset views", () => {
  const golden = Uint8Array.of(
    0x43,
    0x50,
    1,
    1,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    3,
    123,
    125,
    0,
    27,
    255,
  );
  const wrapped = Uint8Array.of(9, ...golden, 8);
  const frame = createTerminalDecoder().read(wrapped.subarray(1, -1));
  expect(frame).toMatchObject({ consumedBytes: golden.length, status: "need-input" });
  expect(frame.frames).toHaveLength(1);
  expect(Array.from(frame.frames[0].payload)).toEqual([0, 27, 255]);
  expect(Array.from(bytes())).toEqual(Array.from(golden));
});

test("every header split, one-byte feeds and body splits preserve frame order", () => {
  const frame = bytes();
  for (let split = 1; split < frame.length; split++) {
    const decoder = createTerminalDecoder();
    expect(decoder.read(frame.subarray(0, split)).frames).toHaveLength(0);
    const result = decoder.read(frame.subarray(split));
    expect(result.frames).toHaveLength(1);
    expect(decoder.finish().ok).toBe(true);
  }
  const coalesced = Uint8Array.of(...bytes(), ...bytes("input", new Uint8Array()));
  expect(feed(createTerminalDecoder(), coalesced, 1).map((item) => item.kind)).toEqual([1, 2]);
});

test("rejects malformed headers at 16 bytes before accepting any body", () => {
  const original = bytes();
  const variants = [
    [0, 0],
    [2, 3],
    [3, 2],
    [4, 5],
    [5, 1],
    [8, 255],
    [11, 0],
    [12, 1],
  ];
  for (const [index, value] of variants) {
    const corrupt = original.slice();
    corrupt[index] = value;
    const result = createTerminalDecoder().read(corrupt);
    expect(result.status).toBe("error");
    expect(result.consumedBytes).toBe(HEADER_BYTES);
    expect(result.frames).toHaveLength(0);
  }
  const badLength = original.slice();
  badLength.set([255, 255, 255, 255], 8);
  expect(createTerminalDecoder().read(badLength)).toMatchObject({
    consumedBytes: 16,
    status: "error",
    error: { code: "CAPACITY_EXCEEDED", offset: 16 },
  });
});

test("encoder rejects over-limit views without allocating and copies only selected offsets", () => {
  expect(encodeTerminalFrame("output", new Uint8Array(), new Uint8Array()).ok).toBe(false);
  expect(encodeTerminalFrame("output", new Uint8Array(4097), new Uint8Array()).ok).toBe(false);
  expect(encodeTerminalFrame("output", metadata, new Uint8Array(65537)).ok).toBe(false);
  const source = Uint8Array.of(9, 123, 125, 8);
  const result = encodeTerminalFrame("output", source.subarray(1, 3), new Uint8Array());
  expect(result.ok).toBe(true);
  expect(result.value.byteLength).toBe(18);
  source[1] = 0;
  expect(result.value[16]).toBe(123);
  const maximum = encodeTerminalFrame("output", new Uint8Array(4096), new Uint8Array(65_536));
  expect(maximum.ok).toBe(true);
  expect(maximum.value.byteLength).toBe(MAX_FRAME_BYTES);
});

test("bounded pull consumes multi-megabyte ingress across calls with owned frames", () => {
  const unit = bytes("input", new Uint8Array());
  const ingress = new Uint8Array(unit.length * 100_000);
  for (let offset = 0; offset < ingress.length; offset += unit.length) ingress.set(unit, offset);
  const decoder = createTerminalDecoder();
  let cursor = 0;
  let delivered = 0;
  while (cursor < ingress.length) {
    const result = decoder.read(ingress.subarray(cursor));
    expect(result.consumedBytes).toBeGreaterThan(0);
    expect(result.consumedBytes).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(result.frames.length).toBeLessThanOrEqual(MAX_READ_FRAMES);
    expect(
      result.frames.reduce(
        (sum, frame) => sum + HEADER_BYTES + frame.metadata.length + frame.payload.length,
        0,
      ),
    ).toBeLessThanOrEqual(MAX_READ_BYTES);
    cursor += result.consumedBytes;
    delivered += result.frames.length;
  }
  expect(delivered).toBe(100_000);
  expect(decoder.retainedBytes).toBe(0);
  expect(MAX_FRAME_BYTES).toBe(69_648);
});

test("partial state owns bytes and fatal error closes without trailing delivery", () => {
  const frame = bytes();
  const decoder = createTerminalDecoder();
  const first = frame.slice(0, 18);
  decoder.read(first);
  first.fill(0);
  expect(decoder.retainedBytes).toBe(18);
  const result = decoder.read(frame.subarray(18));
  expect(Array.from(result.frames[0].metadata)).toEqual([123, 125]);
  result.frames[0].payload.fill(0);
  expect(Array.from(frame.subarray(-3))).toEqual([0, 27, 255]);
  const bad = frame.slice();
  bad[5] = 1;
  const mixed = Uint8Array.of(...frame, ...bad, ...frame);
  const fatal = createTerminalDecoder();
  const outcome = fatal.read(mixed);
  expect(outcome.frames).toHaveLength(1);
  expect(outcome.consumedBytes).toBe(frame.length + HEADER_BYTES);
  expect(fatal.retainedBytes).toBe(0);
  expect(fatal.read(frame).error.code).toBe("DECODER_CLOSED");
});

test("large frames stop before the output budget and empty reads cannot drain ingress", () => {
  const encoded = encodeTerminalFrame("output", metadata, new Uint8Array(65_536));
  expect(encoded.ok).toBe(true);
  const four = new Uint8Array(encoded.value.length * 4);
  for (let index = 0; index < 4; index++) four.set(encoded.value, index * encoded.value.length);
  const decoder = createTerminalDecoder();
  const first = decoder.read(four);
  expect(first.frames).toHaveLength(3);
  expect(first.consumedBytes).toBeLessThan(four.length);
  expect(first.status).toBe("budget");
  expect(decoder.read(new Uint8Array())).toMatchObject({
    consumedBytes: 0,
    frames: [],
    status: "need-input",
  });
  const second = decoder.read(four.subarray(first.consumedBytes));
  expect(second.frames).toHaveLength(1);
  first.frames[0].payload[0] = 123;
  expect(first.frames[1].payload[0]).toBe(0);
  expect(second.frames[0].payload[0]).toBe(0);
});

test("finish rejects partial EOF and closes both lane decoders", () => {
  const terminal = createTerminalDecoder();
  terminal.read(bytes().subarray(0, 4));
  expect(terminal.finish()).toMatchObject({
    ok: false,
    error: { code: "TRUNCATED_FRAME", offset: 4 },
  });
  expect(terminal.read(new Uint8Array()).error.code).toBe("DECODER_CLOSED");
  const body = createTerminalDecoder();
  body.read(bytes().subarray(0, HEADER_BYTES + 1));
  expect(body.finish()).toMatchObject({
    ok: false,
    error: { code: "TRUNCATED_FRAME", offset: HEADER_BYTES + 1 },
  });
  const pipe = createPipeDecoder();
  const encoded = encodePipeFrame("probe-request", metadata, new Uint8Array());
  expect(encoded.ok).toBe(true);
  expect(pipe.read(encoded.value).frames[0].kind).toBe(1);
  expect(pipe.finish().ok).toBe(true);
  expect(pipe.finish().error.code).toBe("DECODER_CLOSED");
});
