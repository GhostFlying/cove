import { createRequire } from "node:module";
import { createTerminalModel } from "@cove/terminal-engine";
import { observeLogicalGrid } from "@cove/terminal-engine/probes/recovery-boundaries";
import { validateBaselineDescriptor, validateBaselineTransfer } from "@cove/protocol/terminal";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");
export const RUN = Object.freeze({ serverId: "s", relayInstanceId: "i", runId: "r" });
export const utf8 = (input) =>
  input instanceof Uint8Array ? input : new TextEncoder().encode(input);
export const string = (input) => new TextDecoder().decode(input);
export const model = (options = {}) =>
  createTerminalModel({
    run: RUN,
    geometry: { cols: 12, rows: 4 },
    onAutomaticOutput: () => {},
    ...options,
  });
export const output = (seq, run = RUN) => ({ type: "output", run, seq });
export const resize = (seq, cols, rows = 4, run = RUN) => ({
  type: "resize",
  run,
  seq,
  geometry: { cols, rows },
  requiresBaseline: true,
});
export const appearance = (seq, value, run = RUN) => ({
  type: "appearance",
  run,
  seq,
  appearance: value,
});
export const control = (seq, holder, geometry = { cols: 12, rows: 4 }) => ({
  type: "control",
  run: RUN,
  seq,
  epoch: seq,
  holder,
  geometry,
});
export const holder = (id) => ({
  connection: { connectionId: `c${id}`, generation: 1 },
  viewId: `v${id}`,
  subscriptionId: `sub${id}`,
});
export const write = (terminal, bytes) =>
  new Promise((resolve) => terminal.write(utf8(bytes), resolve));
export function receiver(geometry = { cols: 12, rows: 4 }, scrollback = 1000) {
  return new Terminal({ ...geometry, scrollback, allowProposedApi: true });
}
export async function restore(baseline, geometry = baseline.currentGeometry, scrollback = 1000) {
  const terminal = receiver(geometry, scrollback);
  await write(terminal, baseline.vt);
  await write(terminal, baseline.tail);
  return terminal;
}
export function observation(terminal) {
  return observeLogicalGrid(terminal);
}
export function assertTransfer(baseline, run = RUN) {
  const subscription = {
    run,
    connection: { connectionId: "c", generation: 1 },
    viewId: "v",
    subscriptionId: "sub",
  };
  const all = new Uint8Array(baseline.vt.length + baseline.tail.length);
  all.set(baseline.vt);
  all.set(baseline.tail, baseline.vt.length);
  const chunks = [];
  for (let offset = 0; offset < all.length; offset += 65_536) {
    chunks.push({
      metadata: {
        type: "baseline-chunk",
        run,
        baselineId: "b",
        subscription,
        ordinal: chunks.length,
      },
      payload: all.slice(offset, offset + 65_536),
    });
  }
  const descriptor = {
    baselineId: "b",
    run,
    subscription,
    profile: baseline.profile,
    encoding: baseline.encoding,
    checkpointSeq: baseline.checkpointSeq,
    atSeq: baseline.atSeq,
    captureGeometry: baseline.captureGeometry,
    currentGeometry: baseline.currentGeometry,
    coverage: baseline.coverage,
    vtBytes: baseline.vt.length,
    tailBytes: baseline.tail.length,
    chunkCount: chunks.length,
  };
  const end = {
    type: "baseline-end",
    run,
    baselineId: "b",
    subscription,
    chunkCount: chunks.length,
    totalBytes: all.length,
    atSeq: baseline.atSeq,
  };
  return (
    Boolean(validateBaselineDescriptor(descriptor)) &&
    validateBaselineTransfer(descriptor, chunks, end)
  );
}
