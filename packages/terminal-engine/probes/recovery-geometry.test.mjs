import { createRequire } from "node:module";
import { afterAll, expect, test } from "vitest";
import {
  createFinalGlyphCheckpoint,
  createRecoveryCheckpoint,
  observeRecovery,
  readPrivateRecoveryState,
  writeParsed,
} from "@cove/terminal-engine/probes/recovery-boundaries";
import { bytes } from "../../../tests/fixtures/terminal/engine/recovery-cases.mjs";
import { writeRecoverySuiteEvidence } from "../../../tests/fixtures/terminal/engine/recovery-evidence.mjs";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");
const completed = [];
const metrics = {
  peakInstallationBytes: 0,
  peakObservedReceiverCells: 0,
  peakOwnedCopyBudgetBytes: 0,
  maxGeometryOperations: 0,
  maxTemporaryColumns: 41,
  maxTemporaryRows: 4,
  maxDisposableRows: 1,
};
afterAll(() => writeRecoverySuiteEvidence("recovery-geometry", completed, 4, metrics));

const alternateMarker = "\u001b[?47h\u001b[H";
const lastPrint = "\u001b[4;5H\u001b[1X\u001b[4;5HQ";
const mixedNormal = `${"N".repeat(65)}\r\n\u001b[2;4r\u001b)0\u000e\u001b[2;3H\u001b[31m\u001b7\u000f\u001b)B`;
const historyNormal = `${"H".repeat(200)}\r\n中é😀\r\n\u001b[2;3r\u001b)0\u000e\u001b[2;3H\u001b[31m\u001b7\u000f\u001b)B`;
const alternateContent =
  `\u001b[?47h\u001b[1;1H${"B".repeat(40)}A` +
  "\u001b[2;40H\u001b[1;3;48;5;201m中́" +
  "\u001b[3;41H\u001b[48;2;12;34;56m \u001b[0m";

function terminal(cols, rows, scrollback) {
  return new Terminal({ cols, rows, scrollback, allowProposedApi: true });
}

async function sourceFixture(kind, shortRow, finalGlyph = false) {
  const rows = kind === "history" ? 3 : 4;
  const scrollback = kind === "history" ? 3 : 10;
  const source = terminal(41, rows, scrollback);
  const addon = new SerializeAddon();
  source.loadAddon(addon);
  const replies = [];
  const listener = source.onData((reply) => replies.push(reply));
  await writeParsed(
    source,
    bytes((kind === "history" ? historyNormal : mixedNormal) + alternateContent),
  );
  source.resize(40, rows);
  await writeParsed(
    source,
    bytes(`\u001b[${shortRow + 1};1H\u001b[L\u001b[${shortRow + 1};40HZ\u001b[0m\u001b[${rows};1H`),
  );
  if (finalGlyph) await writeParsed(source, bytes("\u001b[4;5HQ"));
  return { source, addon, listener, replies, kind, shortRow, rows, scrollback };
}

function recordCells(receiver) {
  const publicState = observeRecovery(receiver);
  const cells = [...publicState.normal.lines, ...publicState.alternate.lines].reduce(
    (sum, line) => sum + line.cells.length,
    0,
  );
  metrics.peakObservedReceiverCells = Math.max(metrics.peakObservedReceiverCells, cells);
}

async function installAttempt(fixture, vt) {
  const receiver = terminal(41, fixture.rows, fixture.scrollback);
  await writeParsed(receiver, vt);
  receiver.resize(40, fixture.rows);
  await writeParsed(
    receiver,
    bytes(
      `\u001b[${fixture.shortRow + 1};1H\u001b[M\u001b[L` +
        `\u001b[${fixture.shortRow + 1};40HZ\u001b[0m\u001b[${fixture.rows};1H`,
    ),
  );
  return receiver;
}

// One authored correction of the observed missing normal cell, retained edge and off-grid tab.
async function installCorrection(fixture, vt, suffix = "") {
  const receiver = terminal(41, fixture.rows, fixture.scrollback);
  let encodedBytes = 0;
  let largestWrite = 0;
  let geometryOperations = 0;
  const write = async (value) => {
    const payload = typeof value === "string" ? bytes(value) : value;
    encodedBytes += payload.length;
    largestWrite = Math.max(largestWrite, payload.length);
    await writeParsed(receiver, payload);
    recordCells(receiver);
  };
  const text = new TextDecoder("utf-8", { fatal: true }).decode(vt);
  const marker = text.indexOf(alternateMarker);
  expect(marker).toBeGreaterThan(0);
  expect(text.indexOf(alternateMarker, marker + 1)).toBe(-1);
  if (fixture.kind === "history") await write("D".repeat(41));
  await write(text.slice(0, marker));
  if (fixture.kind === "mixed") await write("\u001b[2;24HN");
  await write("\u001b[1;41H\u001bH\u001b[2;3H");
  await write(text.slice(marker));
  if (fixture.kind === "mixed" && fixture.shortRow === 0)
    await write("\u001b[4;41H\u001b[1;3;31;48;2;12;34;56m \u001b[0m");
  await write(`\u001b[1;41H\u001bH\u001b[${fixture.rows};1H`);
  receiver.resize(40, fixture.rows);
  geometryOperations++;
  recordCells(receiver);
  await write(
    `\u001b[${fixture.shortRow + 1};1H\u001b[M\u001b[L` +
      `\u001b[${fixture.shortRow + 1};40HZ\u001b[0m\u001b[${fixture.rows};1H`,
  );
  geometryOperations += 2;
  if (suffix) await write(suffix);
  metrics.peakInstallationBytes = Math.max(metrics.peakInstallationBytes, encodedBytes);
  metrics.peakOwnedCopyBudgetBytes = Math.max(
    metrics.peakOwnedCopyBudgetBytes,
    vt.length + 2 * text.length + largestWrite,
  );
  metrics.maxGeometryOperations = Math.max(metrics.maxGeometryOperations, geometryOperations);
  return receiver;
}

function assertSame(source, receiver) {
  expect(observeRecovery(receiver)).toEqual(observeRecovery(source));
  expect(readPrivateRecoveryState(receiver)).toEqual(readPrivateRecoveryState(source));
}

async function pureCheckpoint(fixture, finalGlyph = false) {
  const before = observeRecovery(fixture.source);
  const privateBefore = readPrivateRecoveryState(fixture.source);
  const create = () =>
    finalGlyph
      ? createFinalGlyphCheckpoint(fixture.source, fixture.addon, 0, {
          bytes: bytes("Q"),
          startX: 4,
          startY: 3,
          cellWidth: 1,
          preimage: "erase",
        })
      : createRecoveryCheckpoint(fixture.source, fixture.addon, 0);
  const first = create();
  expect(create().vt).toEqual(first.vt);
  expect(observeRecovery(fixture.source)).toEqual(before);
  expect(readPrivateRecoveryState(fixture.source)).toEqual(privateBefore);
  expect(fixture.replies).toEqual([]);
  return first.vt;
}

test("G mixed 40/41 rows in both orders: initial mismatch and one corrected both-buffer schedule", async () => {
  for (const shortRow of [0, 3]) {
    const fixture = await sourceFixture("mixed", shortRow);
    let attempt;
    let corrected;
    try {
      const vt = await pureCheckpoint(fixture);
      attempt = await installAttempt(fixture, vt);
      expect(observeRecovery(attempt)).not.toEqual(observeRecovery(fixture.source));
      expect(fixture.source.buffer.normal.getLine(1).getCell(23).getChars()).toBe("N");
      expect(attempt.buffer.normal.getLine(1).getCell(23).getChars()).toBe("");
      const retainedEdge =
        shortRow === 0
          ? [
              fixture.source.buffer.alternate.getLine(3).getCell(40).getChars(),
              attempt.buffer.alternate.getLine(3).getCell(40).getChars(),
            ]
          : null;
      expect(retainedEdge).toEqual(shortRow === 0 ? [" ", ""] : null);
      corrected = await installCorrection(fixture, vt);
      assertSame(fixture.source, corrected);
      const longRow = shortRow === 0 ? 1 : 0;
      for (const suffix of [
        `\u001b[${shortRow + 1};40H\u001b[@\u001b[${shortRow + 1};40H\u001b[P`,
        `\u001b[${longRow + 1};1H\u001b[P`,
        "\u001b[?47l\u001b8q",
      ]) {
        await writeParsed(fixture.source, bytes(suffix));
        await writeParsed(corrected, bytes(suffix));
        assertSame(fixture.source, corrected);
      }
      completed.push(`G-mixed-short-${shortRow}`);
    } finally {
      attempt?.dispose();
      corrected?.dispose();
      fixture.listener.dispose();
      fixture.addon.dispose();
      fixture.source.dispose();
    }
  }
});

test("G retained three-line history, disposable row, later resizes and same-size resize", async () => {
  const fixture = await sourceFixture("history", 0);
  let attempt;
  let corrected;
  try {
    const vt = await pureCheckpoint(fixture);
    attempt = await installAttempt(fixture, vt);
    expect(fixture.source.buffer.normal.getLine(0).isWrapped).toBe(true);
    expect(attempt.buffer.normal.getLine(0).isWrapped).toBe(false);
    corrected = await installCorrection(fixture, vt);
    assertSame(fixture.source, corrected);
    expect(corrected.buffer.normal.length).toBe(6);
    expect(corrected.buffer.normal.getLine(0).translateToString(true).startsWith("H")).toBe(true);
    for (const cols of [41, 40, 40]) {
      fixture.source.resize(cols, 3);
      corrected.resize(cols, 3);
      assertSame(fixture.source, corrected);
    }
    for (const suffix of [
      "\u001b[1;40H\u001b[@\u001b[1;40H\u001b[P",
      "\u001b[2;1H\u001b[P",
      "\u001b[?47l\u001b8q",
    ]) {
      await writeParsed(fixture.source, bytes(suffix));
      await writeParsed(corrected, bytes(suffix));
      assertSame(fixture.source, corrected);
    }
    completed.push("G-history-three-line-resize");
  } finally {
    attempt?.dispose();
    corrected?.dispose();
    fixture.listener.dispose();
    fixture.addon.dispose();
    fixture.source.dispose();
  }
});

test("G corrected geometry composes with J final print and immediate combining and REP", async () => {
  const fixture = await sourceFixture("mixed", 0, true);
  let corrected;
  try {
    const vt = await pureCheckpoint(fixture, true);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(vt);
    expect(text.endsWith(lastPrint)).toBe(true);
    corrected = await installCorrection(
      fixture,
      bytes(text.slice(0, -lastPrint.length)),
      lastPrint,
    );
    assertSame(fixture.source, corrected);
    expect(readPrivateRecoveryState(corrected).precedingJoinState).toBe(2);
    for (const suffix of ["́", "\u001b[3b"]) {
      await writeParsed(fixture.source, bytes(suffix));
      await writeParsed(corrected, bytes(suffix));
      assertSame(fixture.source, corrected);
    }
    completed.push("G-J-composed-final-print");
  } finally {
    corrected?.dispose();
    fixture.listener.dispose();
    fixture.addon.dispose();
    fixture.source.dispose();
  }
});
