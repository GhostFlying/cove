import { failure, type ProtocolFailure, type ProtocolResult } from "./errors.js";

export const HEADER_BYTES = 16;
export const MAX_METADATA_BYTES = 4096;
export const MAX_PAYLOAD_BYTES = 65_536;
export const MAX_FRAME_BYTES = HEADER_BYTES + MAX_METADATA_BYTES + MAX_PAYLOAD_BYTES;
export const MAX_READ_BYTES = 256 * 1024;
export const MAX_READ_FRAMES = 32;

export type FrameKind = 1 | 2 | 3 | 4;
export type ByteFrame = { kind: FrameKind; metadata: Uint8Array; payload: Uint8Array };
export type ReadStatus = "need-input" | "budget" | "error";
export type ReadResult = {
  consumedBytes: number;
  frames: ByteFrame[];
  status: ReadStatus;
  error?: ProtocolFailure;
};

function uint32(input: Uint8Array, offset: number): number {
  return (
    input[offset]! * 0x1000000 +
    (input[offset + 1]! << 16) +
    (input[offset + 2]! << 8) +
    input[offset + 3]!
  );
}

function setUint32(output: Uint8Array, offset: number, value: number): void {
  output[offset] = Math.floor(value / 0x1000000);
  output[offset + 1] = (value >>> 16) & 255;
  output[offset + 2] = (value >>> 8) & 255;
  output[offset + 3] = value & 255;
}

function inspectHeader(
  header: Uint8Array,
  lane: number,
  revision: number,
): ProtocolResult<{ length: number; metadataLength: number; kind: FrameKind }> {
  if (
    header[0] !== 0x43 ||
    header[1] !== 0x50 ||
    header[5] !== 0 ||
    header[6] !== 0 ||
    header[7] !== 0
  )
    return failure("INVALID_HEADER", HEADER_BYTES);
  if (header[2] !== lane || header[3] !== revision)
    return failure("UNSUPPORTED_FORMAT", HEADER_BYTES);
  const kind = header[4];
  if (kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4)
    return failure("UNSUPPORTED_KIND", HEADER_BYTES);
  const metadataLength = uint32(header, 8);
  const payloadLength = uint32(header, 12);
  if (
    metadataLength < 1 ||
    metadataLength > MAX_METADATA_BYTES ||
    payloadLength > MAX_PAYLOAD_BYTES
  )
    return failure("CAPACITY_EXCEEDED", HEADER_BYTES);
  const length = HEADER_BYTES + metadataLength + payloadLength;
  if (length > MAX_FRAME_BYTES) return failure("CAPACITY_EXCEEDED", HEADER_BYTES);
  return { ok: true, value: { length, metadataLength, kind } };
}

export function encodeFrame(
  lane: 1 | 2 | 3 | 4,
  revision: number,
  kind: FrameKind,
  metadata: Uint8Array,
  payload: Uint8Array,
): ProtocolResult<Uint8Array> {
  if (revision < 1 || revision > 255 || !Number.isInteger(revision))
    return failure("UNSUPPORTED_FORMAT");
  if (kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4) return failure("UNSUPPORTED_KIND");
  if (
    metadata.byteLength < 1 ||
    metadata.byteLength > MAX_METADATA_BYTES ||
    payload.byteLength > MAX_PAYLOAD_BYTES
  )
    return failure("CAPACITY_EXCEEDED");
  const output = new Uint8Array(HEADER_BYTES + metadata.byteLength + payload.byteLength);
  output[0] = 0x43;
  output[1] = 0x50;
  output[2] = lane;
  output[3] = revision;
  output[4] = kind;
  setUint32(output, 8, metadata.byteLength);
  setUint32(output, 12, payload.byteLength);
  output.set(metadata, HEADER_BYTES);
  output.set(payload, HEADER_BYTES + metadata.byteLength);
  return { ok: true, value: output };
}

function copyRange(segments: readonly Uint8Array[], start: number, end: number): Uint8Array {
  const output = new Uint8Array(end - start);
  let offset = 0;
  for (const segment of segments) {
    const from = Math.max(start - offset, 0);
    const to = Math.min(end - offset, segment.byteLength);
    if (from < to) output.set(segment.subarray(from, to), offset + from - start);
    offset += segment.byteLength;
    if (offset >= end) break;
  }
  return output;
}

export class FrameDecoder {
  private readonly header = new Uint8Array(HEADER_BYTES);
  // Body bytes received so far, held as exact copies of each consumed slice. A validated header
  // does not allocate its declared frame length up front, so storageBytes is what the decoder
  // really owns and a caller can bound its ingress exactly (issue #96).
  private body: Uint8Array[] = [];
  private filled = 0;
  private expected = HEADER_BYTES;
  private metadataLength = 0;
  private kind: FrameKind = 1;
  private offset = 0;
  private closed = false;

  constructor(
    private readonly lane: 1 | 2 | 3 | 4,
    private readonly revision: number,
  ) {}

  get retainedBytes(): number {
    return this.filled;
  }

  // Storage owned for the partial frame: the fixed header buffer once a frame has started, then
  // exactly the copied body bytes. An idle decoder owns no ingress.
  get storageBytes(): number {
    return this.filled === 0 ? 0 : Math.max(HEADER_BYTES, this.filled);
  }

  // The caller owns ingress beyond consumedBytes and resubmits it later; only one copied partial frame is retained.
  read(input: Uint8Array): ReadResult {
    if (this.closed)
      return {
        consumedBytes: 0,
        frames: [],
        status: "error",
        error: { code: "DECODER_CLOSED", offset: this.offset },
      };
    const frames: ByteFrame[] = [];
    let consumedBytes = 0;
    let emittedBytes = 0;
    while (consumedBytes < input.byteLength && consumedBytes < MAX_READ_BYTES) {
      // A validated header can expand expected from 16 bytes to a full frame; do not exceed this call's output budget.
      if (frames.length >= MAX_READ_FRAMES || emittedBytes + this.expected > MAX_READ_BYTES) break;
      const count = Math.min(
        this.expected - this.filled,
        input.byteLength - consumedBytes,
        MAX_READ_BYTES - consumedBytes,
      );
      const slice = input.subarray(consumedBytes, consumedBytes + count);
      // expected stays HEADER_BYTES until the header completes, so one copy never spans both parts.
      if (this.filled < HEADER_BYTES) this.header.set(slice, this.filled);
      else this.appendBody(slice);
      this.filled += count;
      consumedBytes += count;
      this.offset += count;
      if (this.filled !== this.expected) continue;
      if (this.expected === HEADER_BYTES) {
        // Reject the header before accepting its body; fatal failure releases pending bytes but preserves earlier frames.
        const checked = inspectHeader(this.header, this.lane, this.revision);
        if (!checked.ok) {
          this.close();
          return {
            consumedBytes,
            frames,
            status: "error",
            error: { code: checked.error.code, offset: this.offset },
          };
        }
        const { length, metadataLength, kind } = checked.value;
        this.metadataLength = metadataLength;
        this.kind = kind;
        this.expected = length;
      }
      if (this.filled === this.expected) {
        const bodyLength = this.expected - HEADER_BYTES;
        frames.push({
          kind: this.kind,
          metadata: copyRange(this.body, 0, this.metadataLength),
          payload: copyRange(this.body, this.metadataLength, bodyLength),
        });
        emittedBytes += this.expected;
        this.resetPending();
      }
    }
    const status = consumedBytes < input.byteLength ? "budget" : "need-input";
    return { consumedBytes, frames, status };
  }

  finish(): ProtocolResult<void> {
    if (this.closed) return failure("DECODER_CLOSED", this.offset);
    const partial = this.filled !== 0;
    this.close();
    return partial ? failure("TRUNCATED_FRAME", this.offset) : { ok: true, value: undefined };
  }

  // Copies the slice (a Node Buffer slice would be a view of the caller's backing) into exactly
  // sized segments merged geometrically: the new bytes absorb each trailing segment no larger
  // than twice what has accumulated, in one copy. Afterwards every segment is more than twice the
  // next, so a frame has at most ~log2(MAX_FRAME_BYTES) segments; and a byte is recopied only when
  // its segment grows by at least half, so total copy work is O(n log n) even for one-byte reads,
  // while storage stays exactly the bytes received.
  private appendBody(slice: Uint8Array): void {
    let from = this.body.length;
    let size = slice.byteLength;
    while (from > 0 && this.body[from - 1]!.byteLength <= 2 * size) {
      from -= 1;
      size += this.body[from]!.byteLength;
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (let index = from; index < this.body.length; index++) {
      merged.set(this.body[index]!, offset);
      offset += this.body[index]!.byteLength;
    }
    merged.set(slice, offset);
    this.body.length = from;
    this.body.push(merged);
  }

  private resetPending(): void {
    this.body = [];
    this.filled = 0;
    this.expected = HEADER_BYTES;
    this.metadataLength = 0;
  }

  private close(): void {
    this.body = [];
    this.filled = 0;
    this.closed = true;
  }
}
