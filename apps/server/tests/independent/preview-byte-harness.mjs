import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createPipeDecoder, encodePipeFrame } from "@cove/protocol/pipe";
import { createTerminalDecoder } from "@cove/protocol/terminal";

export const codec = {
  encode: (text) => new TextEncoder().encode(text),
  decode: (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
};
export const utf8 = codec.encode;
export const copy = (value) => structuredClone(value);
export const joinBytes = (parts) => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};
export function pipeBytes(metadata, payload = new Uint8Array()) {
  const kind = metadata.type === "error" ? 4 : metadata.type === "terminal-event" ? 3 : 2;
  const result = encodePipeFrame(kind, utf8(JSON.stringify(metadata)), payload);
  if (!result.ok) throw new Error("Invalid QA pipe encoding");
  return result.value;
}
export function decodeBytes(bytes, lane = "pipe") {
  const decoder = lane === "pipe" ? createPipeDecoder() : createTerminalDecoder();
  const decoded = decoder.read(bytes);
  if (decoded.status === "error") throw new Error("Invalid observed QA frame bytes");
  return decoded.frames.map((frame) => ({
    metadata: JSON.parse(codec.decode(frame.metadata)),
    payload: Array.from(frame.payload),
  }));
}
export function carrier(options = {}) {
  const writes = [];
  return {
    writes,
    write(bytes, callback) {
      const entry = { bytes: new Uint8Array(bytes), callback, original: bytes };
      writes.push(entry);
      options.onWrite?.(entry);
      if (!options.hold) callback();
      return options.writable !== false;
    },
    settle(error) {
      for (const item of writes) item.callback(error);
    },
    decoded(lane = "pipe") {
      return writes.flatMap((entry) => decodeBytes(entry.bytes, lane));
    },
  };
}
export function clocks() {
  let monotonic = 0;
  let wall = 1000;
  const timers = [];
  let hook;
  return {
    now: () => {
      const invoke = hook;
      hook = undefined;
      invoke?.();
      return monotonic;
    },
    hook(callback) {
      hook = callback;
    },
    wallNow: () => wall,
    set(m, w = wall) {
      monotonic = m;
      wall = w;
    },
    nowMs: () => monotonic,
    setTimer(delay, callback) {
      const timer = { at: monotonic + delay, callback, live: true };
      timers.push(timer);
      return {
        dispose() {
          timer.live = false;
        },
      };
    },
    fire(m) {
      monotonic = m;
      for (const timer of timers)
        if (timer.live && timer.at <= m) {
          timer.live = false;
          timer.callback();
        }
    },
    yieldTurn: () => Promise.resolve(),
  };
}
export async function turns() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
export function recordRow(id, status, effect) {
  const row = { id, status, effect };
  const directory = process.env.COVE_PREVIEW_QA_TRACE_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, "semantic-rows.jsonl"), JSON.stringify(row) + "\n");
  }
  return row;
}
