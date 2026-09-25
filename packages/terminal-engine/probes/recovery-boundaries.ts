import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import type { Terminal } from "@xterm/headless";
import { loadSerializeAddon } from "./serialize-loader.js";
import { createRecoveryCheckpoint, BoundedRecoveryTail } from "./recovery-checkpoint.js";
import { observeRecovery, writeParsed, type RecoveryObservation } from "./recovery-observation.js";
import { assertPinnedRecoveryPackages, readPrivateRecoveryState } from "./xterm-recovery-state.js";

const require = createRequire(import.meta.url);

export interface RecoveryFixture {
  readonly caseId: string;
  readonly cols: number;
  readonly rows: number;
  readonly scrollback: number;
  readonly setupBytes: Uint8Array;
  readonly tailBytes: Uint8Array;
  readonly continuationBytes: Uint8Array;
  readonly appearance?: {
    readonly foreground: string;
    readonly background: string;
    readonly palette1: string;
  };
  readonly resizeBeforeCheckpoint?: { readonly cols: number; readonly rows: number };
  readonly resizeAfterRecovery?: { readonly cols: number; readonly rows: number };
  readonly writeChunkSize?: number;
}

export interface RecoveryCaseResult {
  readonly caseId: string;
  readonly baselineBytes: number;
  readonly tailBytes: number;
  readonly generatedMs: number;
  readonly beforeEqual: boolean;
  readonly afterEqual: boolean;
  readonly sourceReplies: readonly string[];
  readonly receiverReplies: readonly string[];
  readonly sourceBells: number;
  readonly receiverBells: number;
  readonly sourceTitles: readonly string[];
  readonly receiverTitles: readonly string[];
  readonly sourceRepliesAtCheckpoint: number;
  readonly sourceRepliesAfterRecovery: number;
  readonly receiverRepliesAfterRecovery: number;
  readonly generationPure: boolean;
  readonly sourceBefore: RecoveryObservation;
  readonly receiverBefore: RecoveryObservation;
  readonly sourceAfter: RecoveryObservation;
  readonly receiverAfter: RecoveryObservation;
}

function installAppearance(
  terminal: Terminal,
  appearance: NonNullable<RecoveryFixture["appearance"]>,
  sink: string[],
): { dispose(): void }[] {
  const reply = (id: number, data: string, value: string) => {
    if (data !== "?") return false;
    sink.push(`\u001b]${id};rgb:${value}\u001b\\`);
    return true;
  };
  return [
    terminal.parser.registerOscHandler(10, (data) => reply(10, data, appearance.foreground)),
    terminal.parser.registerOscHandler(11, (data) => reply(11, data, appearance.background)),
    terminal.parser.registerOscHandler(4, (data) => {
      if (data !== "1;?") return false;
      sink.push(`\u001b]4;1;rgb:${appearance.palette1}\u001b\\`);
      return true;
    }),
  ];
}

function newTerminal(fixture: RecoveryFixture): Terminal {
  const { Terminal: Constructor } = require("@xterm/headless") as typeof import("@xterm/headless");
  return new Constructor({
    cols: fixture.cols,
    rows: fixture.rows,
    scrollback: fixture.scrollback,
    allowProposedApi: true,
  });
}

async function writeFixtureBytes(
  terminal: Terminal,
  payload: Uint8Array,
  chunkSize: number | undefined,
): Promise<void> {
  if (chunkSize === undefined) return writeParsed(terminal, payload);
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("Invalid fixture chunk size");
  for (let offset = 0; offset < payload.length; offset += chunkSize)
    await writeParsed(terminal, payload.subarray(offset, offset + chunkSize));
}

// The live sink and receiver sink are deliberately separate; only the former could be wired to a PTY.
export async function runRecoveryFixture(fixture: RecoveryFixture): Promise<RecoveryCaseResult> {
  assertPinnedRecoveryPackages();
  const source = newTerminal(fixture);
  const receiver = newTerminal(fixture);
  const addon = loadSerializeAddon();
  source.loadAddon(addon as never);
  const sourceReplies: string[] = [];
  const receiverReplies: string[] = [];
  let sourceBells = 0;
  let receiverBells = 0;
  const sourceTitles: string[] = [];
  const receiverTitles: string[] = [];
  const sourceListener = source.onData((data) => sourceReplies.push(data));
  const receiverListener = receiver.onData((data) => receiverReplies.push(data));
  const sideEffectListeners = [
    source.onBell(() => sourceBells++),
    receiver.onBell(() => receiverBells++),
    source.onTitleChange((title) => sourceTitles.push(title)),
    receiver.onTitleChange((title) => receiverTitles.push(title)),
  ];
  const appearanceListeners = fixture.appearance
    ? [
        ...installAppearance(source, fixture.appearance, sourceReplies),
        ...installAppearance(receiver, fixture.appearance, receiverReplies),
      ]
    : [];
  try {
    await writeFixtureBytes(source, fixture.setupBytes, fixture.writeChunkSize);
    if (fixture.resizeBeforeCheckpoint) {
      source.resize(fixture.resizeBeforeCheckpoint.cols, fixture.resizeBeforeCheckpoint.rows);
      receiver.resize(fixture.resizeBeforeCheckpoint.cols, fixture.resizeBeforeCheckpoint.rows);
    }
    const sourceRepliesAtCheckpoint = sourceReplies.length;
    const sourceAtCheckpoint = observeRecovery(source);
    const privateAtCheckpoint = readPrivateRecoveryState(source);
    const checkpoint = createRecoveryCheckpoint(source, addon, fixture.setupBytes.length);
    const repeated = createRecoveryCheckpoint(source, addon, fixture.setupBytes.length);
    const generationPure =
      isDeepStrictEqual(sourceAtCheckpoint, observeRecovery(source)) &&
      isDeepStrictEqual(privateAtCheckpoint, readPrivateRecoveryState(source)) &&
      isDeepStrictEqual(checkpoint.vt, repeated.vt) &&
      sourceReplies.length === sourceRepliesAtCheckpoint;
    const tail = new BoundedRecoveryTail();
    tail.append(fixture.tailBytes);
    await writeFixtureBytes(source, fixture.tailBytes, fixture.writeChunkSize);
    await writeFixtureBytes(receiver, checkpoint.vt, fixture.writeChunkSize);
    await writeFixtureBytes(receiver, tail.snapshot(), fixture.writeChunkSize);
    const sourceRepliesAfterRecovery = sourceReplies.length;
    const receiverRepliesAfterRecovery = receiverReplies.length;
    const sourceBefore = observeRecovery(source);
    const receiverBefore = observeRecovery(receiver);
    const beforeEqual = isDeepStrictEqual(sourceBefore, receiverBefore);
    await writeFixtureBytes(source, fixture.continuationBytes, fixture.writeChunkSize);
    await writeFixtureBytes(receiver, fixture.continuationBytes, fixture.writeChunkSize);
    if (fixture.resizeAfterRecovery) {
      source.resize(fixture.resizeAfterRecovery.cols, fixture.resizeAfterRecovery.rows);
      receiver.resize(fixture.resizeAfterRecovery.cols, fixture.resizeAfterRecovery.rows);
    }
    const sourceAfter = observeRecovery(source);
    const receiverAfter = observeRecovery(receiver);
    return {
      caseId: fixture.caseId,
      baselineBytes: checkpoint.vt.length,
      tailBytes: tail.retainedBytes,
      generatedMs: checkpoint.generatedMs,
      beforeEqual,
      afterEqual: isDeepStrictEqual(sourceAfter, receiverAfter),
      sourceReplies,
      receiverReplies,
      sourceBells,
      receiverBells,
      sourceTitles,
      receiverTitles,
      sourceRepliesAtCheckpoint,
      sourceRepliesAfterRecovery,
      receiverRepliesAfterRecovery,
      generationPure,
      sourceBefore,
      receiverBefore,
      sourceAfter,
      receiverAfter,
    };
  } finally {
    for (const listener of sideEffectListeners) listener.dispose();
    for (const listener of appearanceListeners) listener.dispose();
    sourceListener.dispose();
    receiverListener.dispose();
    addon.dispose();
    source.dispose();
    receiver.dispose();
  }
}

export {
  BoundedRecoveryTail,
  createRecoveryCheckpoint,
  observeRecovery,
  readPrivateRecoveryState,
  writeParsed,
};
