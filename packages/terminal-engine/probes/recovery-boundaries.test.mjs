import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { afterAll, expect, test } from "vitest";
import {
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
  validatePipeMessage,
} from "@cove/protocol/provisional/pipe";
import {
  BoundedRecoveryTail,
  createRecoveryCheckpoint,
  observeRecovery,
  readPrivateRecoveryState,
  runRecoveryFixture,
  writeParsed,
} from "@cove/terminal-engine/probes/recovery-boundaries";
import { bytes, hex } from "../../../tests/fixtures/terminal/engine/recovery-cases.mjs";
import { writeRecoverySuiteEvidence } from "../../../tests/fixtures/terminal/engine/recovery-evidence.mjs";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");
const completed = [];
afterAll(() => writeRecoverySuiteEvidence("recovery-boundaries", completed, 8));

function terminal(cols, rows = 3, scrollback = 3) {
  return new Terminal({ cols, rows, scrollback, allowProposedApi: true });
}

function row(terminal, index) {
  return terminal.buffer.alternate.getLine(index);
}

test("R6 diagnostic: 41 to 40 alternate resize loses off-grid A and same-grid DCH exposes it", async () => {
  const result = await runRecoveryFixture({
    caseId: "R6-off-grid-dch-counterexample",
    cols: 41,
    rows: 2,
    scrollback: 0,
    setupBytes: bytes(`\u001b[?47h${"B".repeat(40)}A\u001b[0m`),
    tailBytes: bytes(""),
    continuationBytes: bytes("\u001b[1;1H\u001b[P"),
    resizeBeforeCheckpoint: { cols: 40, rows: 2 },
  });
  expect(result.beforeEqual).toBe(false);
  expect(result.sourceBefore.alternate.lines[0].cells[40].chars).toBe("A");
  expect(result.receiverBefore.alternate.lines[0].cells[40]).toBeUndefined();
  expect(result.afterEqual).toBe(false);
  expect(result.sourceAfter.alternate.lines[0].cells[39].chars).toBe("A");
  expect(result.receiverAfter.alternate.lines[0].cells[39].chars).toBe("");
  completed.push(result.caseId);
});

test("R6 geometry diagnostic: row-local DL and IL can rebuild mixed alt capacities in both orders", async () => {
  for (const shortRow of [0, 2]) {
    const source = terminal(41);
    const scratch = terminal(41);
    try {
      await writeParsed(source, bytes(`\u001b[?47h${"A".repeat(41)}\u001b[0m`));
      source.resize(40, 3);
      await writeParsed(
        source,
        bytes(`\u001b[${shortRow + 1};1H\u001b[L\u001b[${shortRow + 1};40HZ\u001b[0m`),
      );
      const longRow = shortRow === 0 ? 1 : 0;
      await writeParsed(
        scratch,
        bytes(
          `\u001b[?47h\u001b[${longRow + 1};1H${"A".repeat(41)}\u001b[${shortRow + 1};40HZ\u001b[0m`,
        ),
      );
      scratch.resize(40, 3);
      await writeParsed(
        scratch,
        bytes(`\u001b[${shortRow + 1};1H\u001b[M\u001b[L\u001b[${shortRow + 1};40HZ\u001b[0m`),
      );
      expect([0, 1, 2].map((index) => row(scratch, index).length)).toEqual(
        [0, 1, 2].map((index) => row(source, index).length),
      );
      expect(observeRecovery(scratch).alternate.lines).toEqual(
        observeRecovery(source).alternate.lines,
      );
      await writeParsed(
        source,
        bytes(`\u001b[${shortRow + 1};40H\u001b[@\u001b[${shortRow + 1};40H\u001b[P`),
      );
      await writeParsed(
        scratch,
        bytes(`\u001b[${shortRow + 1};40H\u001b[@\u001b[${shortRow + 1};40H\u001b[P`),
      );
      expect(row(scratch, shortRow).getCell(39).getChars()).toBe(
        row(source, shortRow).getCell(39).getChars(),
      );
    } finally {
      source.dispose();
      scratch.dispose();
    }
  }
  completed.push("R6-mixed-row-capacities");
});

test("R6 bounded history diagnostic: a disposable row restores the leading wrapped flag", async () => {
  const source = terminal(41);
  const bare = terminal(40);
  const padded = terminal(40);
  const addon = new SerializeAddon();
  source.loadAddon(addon);
  try {
    await writeParsed(
      source,
      bytes(`${"H".repeat(200)}\r\n中é😀\r\n\u001b[2;3H\u001b[31m\u001b7\u001b[?47hALT\u001b[0m`),
    );
    source.resize(40, 3);
    const before = observeRecovery(source);
    const checkpoint = createRecoveryCheckpoint(source, addon, 0);
    expect(observeRecovery(source)).toEqual(before);
    await writeParsed(bare, checkpoint.vt);
    await writeParsed(padded, bytes("D".repeat(40)));
    await writeParsed(padded, checkpoint.vt);
    expect(bare.buffer.normal.getLine(0).isWrapped).toBe(false);
    expect(source.buffer.normal.getLine(0).isWrapped).toBe(true);
    expect(padded.buffer.normal.getLine(0).isWrapped).toBe(true);
    expect(padded.buffer.normal.length).toBe(source.buffer.normal.length);
    expect(observeRecovery(padded).normal).toEqual(before.normal);
    // The alternate extent still differs; compare the complete state after returning to normal.
    expect(isDeepStrictEqual(observeRecovery(padded), before)).toBe(false);
    for (const target of [source, padded]) await writeParsed(target, bytes("\u001b[?47l\u001b8X"));
    expect(observeRecovery(padded)).toEqual(observeRecovery(source));
  } finally {
    addon.dispose();
    source.dispose();
    bare.dispose();
    padded.dispose();
  }
  completed.push("R6-leading-wrapped-history");
});

test("R6 retained-edge diagnostic: wider receiver restores wide, combined, and styled blank cells", async () => {
  const source = terminal(41, 3, 0);
  const addon = new SerializeAddon();
  source.loadAddon(addon);
  const setup = bytes(
    "\u001b[?47h\u001b[1;40H\u001b[1;3;48;5;201m中́\u001b[2;41H\u001b[48;2;12;34;56m \u001b[0m",
  );
  try {
    await writeParsed(source, setup);
    source.resize(40, 3);
    const before = observeRecovery(source);
    const checkpoint = createRecoveryCheckpoint(source, addon, setup.length);
    expect(observeRecovery(source)).toEqual(before);
    const narrow = terminal(40, 3, 0);
    const wide = terminal(41, 3, 0);
    try {
      for (const receiver of [narrow, wide]) {
        await writeParsed(receiver, checkpoint.vt);
        receiver.resize(40, 3);
      }
      expect(observeRecovery(narrow)).not.toEqual(before);
      expect(observeRecovery(wide)).toEqual(before);
      expect(wide.buffer.alternate.getLine(0).getCell(39).getChars()).toBe("中́");
      expect(wide.buffer.alternate.getLine(1).getCell(40).getChars()).toBe(" ");
      expect(wide.buffer.alternate.getLine(1).getCell(40).getBgColor()).toBe(0x0c2238);
      for (const suffix of ["\u001b[1;1H\u001b[P", "\u001b[2;1H\u001b[P"]) {
        await writeParsed(source, bytes(suffix));
        await writeParsed(wide, bytes(suffix));
        expect(observeRecovery(wide)).toEqual(observeRecovery(source));
      }
    } finally {
      narrow.dispose();
      wide.dispose();
    }
    expect(observeRecovery(source)).not.toEqual(before);
  } finally {
    addon.dispose();
    source.dispose();
  }
  completed.push("R6-retained-edge-styles");
});

test("R8 cap boundaries release invalid retention while live parsing and a later checkpoint continue", async () => {
  for (const length of [65_535, 65_536, 65_537]) {
    const tail = new BoundedRecoveryTail();
    tail.append(new Uint8Array(length));
    expect(tail.available).toBe(length <= 65_536);
    expect(tail.retainedBytes).toBe(length <= 65_536 ? length : 0);
  }
  const source = terminal(12, 4);
  const receiver = terminal(12, 4);
  const addon = new SerializeAddon();
  source.loadAddon(addon);
  const replies = [];
  const listener = source.onData((reply) => replies.push(reply));
  const tail = new BoundedRecoveryTail();
  try {
    await writeParsed(source, bytes("\u001b]2;"));
    for (let index = 0; index < 128; index++) {
      const chunk = bytes("x".repeat(1024));
      tail.append(chunk);
      await writeParsed(source, chunk);
    }
    expect(tail.available).toBe(false);
    expect(tail.retainedBytes).toBe(0);
    expect(() => tail.snapshot()).toThrow(/Recovery unavailable/);
    await writeParsed(source, bytes("\u0007\u001b[5n"));
    expect(replies.map(hex)).toEqual([hex(bytes("\u001b[0n"))]);
    const checkpoint = createRecoveryCheckpoint(source, addon, 128 * 1024 + 8);
    tail.resetAfterProvedCheckpoint();
    tail.append(bytes("Z"));
    await writeParsed(source, bytes("Z"));
    await writeParsed(receiver, checkpoint.vt);
    await writeParsed(receiver, tail.snapshot());
    expect(observeRecovery(receiver)).toEqual(observeRecovery(source));
  } finally {
    listener.dispose();
    addon.dispose();
    source.dispose();
    receiver.dispose();
  }
  completed.push("R8-tail-cap-overflow-recovery");
});

test("R5 diagnostic: ordinary printable output cannot refresh the current checkpoint at the tail cap", async () => {
  const source = terminal(12, 4, 10);
  const addon = new SerializeAddon();
  source.loadAddon(addon);
  const tail = new BoundedRecoveryTail();
  const printable = bytes("A".repeat(65_537));
  try {
    tail.append(printable);
    await writeParsed(source, printable);
    expect(tail.available).toBe(false);
    expect(readPrivateRecoveryState(source).precedingJoinState).toBe(2);
    expect(() => createRecoveryCheckpoint(source, addon, printable.length)).toThrow(
      /checkpoint boundary/,
    );
    await writeParsed(source, bytes("\u001b[5n"));
    expect(readPrivateRecoveryState(source).parserState).toBe(
      readPrivateRecoveryState(source).initialParserState,
    );
  } finally {
    addon.dispose();
    source.dispose();
  }
  completed.push("R5-printable-refresh-counterexample");
});

test("R8 pinned private shape fails closed and a stock saved-cursor omission is observable", async () => {
  const source = terminal(12, 4);
  const receiver = terminal(12, 4);
  const addon = new SerializeAddon();
  source.loadAddon(addon);
  try {
    await writeParsed(source, bytes("\u001b[2;3H\u001b[31m\u001b7\u001b[4;9H\u001b[34m"));
    await writeParsed(receiver, bytes(addon.serialize()));
    await writeParsed(source, bytes("\u001b8X"));
    await writeParsed(receiver, bytes("\u001b8X"));
    expect(observeRecovery(receiver)).not.toEqual(observeRecovery(source));
    const parser = source._core._inputHandler._parser;
    const state = parser.currentState;
    parser.currentState = undefined;
    expect(() => readPrivateRecoveryState(source)).toThrow(/Invalid parser state/);
    parser.currentState = state;
  } finally {
    addon.dispose();
    source.dispose();
    receiver.dispose();
  }
  completed.push("R8-stock-serializer-private-shape");
});

test("R8 provisional pipe preserves split VT and rejects missing, duplicate or wrong correlation", () => {
  const run = { serverId: "s", relayInstanceId: "i", runId: "r" };
  const worker = { serverId: "s", relayInstanceId: "i", workerId: "w", workerIncarnationId: "wi" };
  const payload = Uint8Array.of(0xe4, 0xb8, 0xad, 0, 0x1b, 0x5b, 0x31, 0x6d);
  const parts = [payload.subarray(0, 2), payload.subarray(2)];
  const metadata = parts.map((_, chunkIndex) => ({
    kind: "terminal-event",
    worker,
    run,
    requestId: "request-1",
    terminal: {
      kind: "baseline-chunk",
      run,
      baselineId: "baseline-1",
      atSeq: 9,
      chunkIndex,
      chunkCount: 2,
      totalBytes: payload.length,
    },
  }));
  const decoder = createPipeDecoder();
  const received = [];
  for (const [index, part] of parts.entries()) {
    expect(validatePipeMessage(metadata[index], part).ok).toBe(true);
    const sent = encodePipeFrame("terminal-event", bytes(JSON.stringify(metadata[index])), part);
    expect(sent.ok).toBe(true);
    for (const byte of sent.value) {
      const read = decoder.read(Uint8Array.of(byte));
      expect(read.status).not.toBe("error");
      received.push(...read.frames);
    }
  }
  expect(decoder.finish().ok).toBe(true);
  expect(received).toHaveLength(2);
  const fatal = new TextDecoder("utf-8", { fatal: true });
  const validated = received.map((frame) => {
    const checked = validatePipeFrame(frame, JSON.parse(fatal.decode(frame.metadata)));
    expect(checked.ok).toBe(true);
    return { metadata: checked.value, payload: frame.payload };
  });
  const assemble = (chunks) => {
    if (chunks.length !== 2) throw new Error("Missing baseline chunk");
    const seen = new Set();
    for (const chunk of chunks) {
      const { metadata: item } = chunk;
      if (
        item.requestId !== "request-1" ||
        item.terminal.baselineId !== "baseline-1" ||
        item.terminal.atSeq !== 9 ||
        JSON.stringify(item.run) !== JSON.stringify(run)
      )
        throw new Error("Wrong recovery correlation");
      if (seen.has(item.terminal.chunkIndex)) throw new Error("Duplicate baseline chunk");
      seen.add(item.terminal.chunkIndex);
    }
    if (!seen.has(0) || !seen.has(1)) throw new Error("Missing baseline index");
    const joined = Uint8Array.from(
      chunks
        .sort((a, b) => a.metadata.terminal.chunkIndex - b.metadata.terminal.chunkIndex)
        .flatMap((chunk) => [...chunk.payload]),
    );
    if (joined.length !== payload.length) throw new Error("Baseline total mismatch");
    return joined;
  };
  expect(assemble([...validated])).toEqual(payload);
  expect(() => assemble(validated.slice(0, 1))).toThrow(/Missing baseline chunk/);
  expect(() => assemble([validated[0], validated[0]])).toThrow(/Duplicate baseline chunk/);
  expect(() =>
    assemble([
      { ...validated[0], metadata: { ...validated[0].metadata, requestId: "wrong" } },
      validated[1],
    ]),
  ).toThrow(/Wrong recovery correlation/);
  completed.push("R8-pipe-correlation");
});
