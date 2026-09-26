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

export class FrameDecoder {
  private pending = new Uint8Array(HEADER_BYTES);
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
      this.pending.set(input.subarray(consumedBytes, consumedBytes + count), this.filled);
      this.filled += count;
      consumedBytes += count;
      this.offset += count;
      if (this.filled !== this.expected) continue;
      if (this.expected === HEADER_BYTES) {
        // Reject the header before allocating its body; fatal failure releases pending bytes but preserves earlier frames.
        const checked = inspectHeader(this.pending, this.lane, this.revision);
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
        const body = new Uint8Array(length);
        body.set(this.pending);
        this.pending = body;
      }
      if (this.filled === this.expected) {
        frames.push({
          kind: this.kind,
          metadata: this.pending.slice(HEADER_BYTES, HEADER_BYTES + this.metadataLength),
          payload: this.pending.slice(HEADER_BYTES + this.metadataLength),
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

  private resetPending(): void {
    this.pending = new Uint8Array(HEADER_BYTES);
    this.filled = 0;
    this.expected = HEADER_BYTES;
    this.metadataLength = 0;
  }

  private close(): void {
    this.pending = new Uint8Array(0);
    this.filled = 0;
    this.closed = true;
  }
}
