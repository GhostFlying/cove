import { MAX_PAYLOAD_BYTES } from "@cove/protocol/terminal";

// A legal 64 KiB VT/input chunk expands to 87,384 base64 characters. The remainder
// covers escaped terminal metadata and the complete 256-entry appearance palette.
// Baselines stream their existing chunks; this bridge never assembles an 8 MiB baseline.
export const VIEW_BRIDGE_MAX_FRAME_CHARS = 2 * MAX_PAYLOAD_BYTES + 32 * 1024;
export const VIEW_BRIDGE_MAX_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;

export interface ViewBridgeFrame {
  version: 1;
  bridgeGeneration: number;
  kind: string;
  commandId?: number;
  noticeId?: number;
  operation?: string;
  value?: unknown;
  bytes?: string;
}

export function positiveCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function readBridgeFrame(text: string): ViewBridgeFrame | null {
  if (typeof text !== "string" || text.length > VIEW_BRIDGE_MAX_FRAME_CHARS) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const frame = value as Record<string, unknown>;
    if (
      frame.version !== 1 ||
      !positiveCounter(frame.bridgeGeneration) ||
      typeof frame.kind !== "string"
    )
      return null;
    return frame as unknown as ViewBridgeFrame;
  } catch {
    return null;
  }
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Keep the wire codec independent of Node Buffer and browser btoa/atob: the same
// host code runs in Electron main and RN, whose global codecs differ.
export function encodeBridgeBytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PAYLOAD_BYTES)
    throw new RangeError("Terminal bridge payload exceeds the terminal chunk limit");
  const encoded = new Uint8Array(4 * Math.ceil(bytes.byteLength / 3));
  let cursor = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const a = bytes[offset]!;
    const b = bytes[offset + 1];
    const c = bytes[offset + 2];
    encoded[cursor++] = alphabet.charCodeAt(a >> 2);
    encoded[cursor++] = alphabet.charCodeAt(((a & 3) << 4) | ((b ?? 0) >> 4));
    encoded[cursor++] =
      b === undefined ? 61 : alphabet.charCodeAt(((b & 15) << 2) | ((c ?? 0) >> 6));
    encoded[cursor++] = c === undefined ? 61 : alphabet.charCodeAt(c & 63);
  }
  // A bounded byte buffer avoids retaining one JS string/allocation per three
  // payload bytes. Small conversion batches also fit RN's native call stack.
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += 4096)
    chunks.push(String.fromCharCode(...encoded.subarray(offset, offset + 4096)));
  return chunks.join("");
}

export function decodeBridgeBytes(text: unknown): Uint8Array | null {
  if (
    typeof text !== "string" ||
    text.length > 4 * Math.ceil(MAX_PAYLOAD_BYTES / 3) ||
    text.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(text)
  )
    return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const length = (text.length / 4) * 3 - padding;
  if (length > MAX_PAYLOAD_BYTES) return null;
  const bytes = new Uint8Array(length);
  let cursor = 0;
  for (let offset = 0; offset < text.length; offset += 4) {
    const a = alphabet.indexOf(text[offset]!);
    const b = alphabet.indexOf(text[offset + 1]!);
    const c = alphabet.indexOf(text[offset + 2]!);
    const d = alphabet.indexOf(text[offset + 3]!);
    bytes[cursor++] = (a << 2) | (b >> 4);
    if (cursor < length) bytes[cursor++] = (b << 4) | (c >> 2);
    if (cursor < length) bytes[cursor++] = (c << 6) | d;
  }
  // Reject non-canonical trailing bits instead of accepting different encodings
  // for the same bytes. This also catches padding with an impossible final sextet.
  if (padding === 2 && (alphabet.indexOf(text.at(-3)!) & 15) !== 0) return null;
  if (padding === 1 && (alphabet.indexOf(text.at(-2)!) & 3) !== 0) return null;
  return bytes;
}

export function frameCharge(text: string, payloadBytes: number): number {
  // Conservative admission accounting, not an RSS claim: four UTF-16 wire/JSON
  // copies and three binary copies cover serialization, native IPC and parsing.
  // Credit stays reserved until parse completion, including the in-flight command.
  return 8 * text.length + 3 * payloadBytes;
}
