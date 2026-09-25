import { createRequire } from "node:module";
import { afterAll, expect, test } from "vitest";
import {
  createRecoveryCheckpoint,
  runRecoveryFixture,
  writeParsed,
} from "@cove/terminal-engine/probes/recovery-boundaries";
import {
  bytes,
  dimensions,
  parserSequences,
} from "../../../tests/fixtures/terminal/engine/recovery-cases.mjs";
import { writeRecoverySuiteEvidence } from "../../../tests/fixtures/terminal/engine/recovery-evidence.mjs";

const completed = [];
afterAll(() => writeRecoverySuiteEvidence("recovery-parser", completed, 147));

test("R4 every interior byte cut of UTF-8, CSI, OSC, DCS and abort sequences continues", async () => {
  expect(parserSequences.map(([id]) => id)).toEqual([
    "utf8-2",
    "utf8-3",
    "utf8-4",
    "csi-parameters",
    "csi-intermediates",
    "osc-bel",
    "osc-st",
    "dcs-status",
    "esc-esc",
    "esc-can",
    "esc-sub",
    "osc-can",
    "osc-sub",
    "dcs-can",
    "dcs-sub",
  ]);
  let cuts = 0;
  for (const [id, sequence] of parserSequences) {
    for (let cut = 1; cut < sequence.length; cut++) {
      for (const writeChunkSize of [undefined, 1]) {
        const result = await runRecoveryFixture({
          caseId: `R4-${id}-${cut}-${writeChunkSize ?? "coalesced"}`,
          ...dimensions,
          setupBytes: bytes(""),
          tailBytes: sequence.subarray(0, cut),
          continuationBytes: Uint8Array.from([...sequence.subarray(cut), 0x21]),
          writeChunkSize,
        });
        if (!result.generationPure || !result.beforeEqual || !result.afterEqual)
          throw new Error(`${result.caseId} restore diverged`);
        if (JSON.stringify(result.receiverReplies) !== JSON.stringify(result.sourceReplies))
          throw new Error(`${result.caseId} reply observation diverged`);
        if (
          result.receiverBells !== result.sourceBells ||
          JSON.stringify(result.receiverTitles) !== JSON.stringify(result.sourceTitles)
        )
          throw new Error(`${result.caseId} external side effect diverged`);
        completed.push(result.caseId);
        cuts++;
      }
    }
  }
  expect(cuts).toBe(138);
});

test("R5 LF, CR, BS, HT, SI, SO and BEL inside CSI execute once across a raw tail", async () => {
  const c0Cases = [
    ["lf", "\n", 2, 2, 0],
    ["cr", "\r", 0, 1, 0],
    ["bs", "\b", 1, 1, 0],
    ["ht", "\t", 8, 1, 0],
    ["si", "\u000f", 2, 1, 0],
    ["so", "\u000e", 2, 1, 0],
    ["bel", "\u0007", 2, 1, 1],
  ];
  expect(c0Cases).toHaveLength(7);
  for (const [id, control, cursorX, cursorY, bells] of c0Cases) {
    const result = await runRecoveryFixture({
      caseId: `R5-csi-${id}-once`,
      ...dimensions,
      setupBytes: bytes("\u001b[2;3H"),
      tailBytes: bytes(`\u001b[1${control}`),
      continuationBytes: bytes(";2H!"),
    });
    expect(result.beforeEqual).toBe(true);
    expect(result.afterEqual).toBe(true);
    expect(result.sourceBefore.normal.cursorX).toBe(cursorX);
    expect(result.sourceBefore.normal.cursorY).toBe(cursorY);
    expect(result.receiverBefore.normal.cursorX).toBe(cursorX);
    expect(result.receiverBefore.normal.cursorY).toBe(cursorY);
    expect(result.sourceBells).toBe(bells);
    expect(result.receiverBells).toBe(bells);
    completed.push(result.caseId);
  }
});

test("R5 REP and combining continue from a tail that includes the preceding glyph", async () => {
  for (const [id, continuation, expected] of [
    ["rep", "\u001b[3b", ["A", "A", "A", "A"]],
    ["combining", "\u0301", ["Á"]],
  ]) {
    const result = await runRecoveryFixture({
      caseId: `R5-${id}`,
      ...dimensions,
      setupBytes: bytes(""),
      tailBytes: bytes("A"),
      continuationBytes: bytes(continuation),
    });
    expect(result.beforeEqual).toBe(true);
    expect(result.afterEqual).toBe(true);
    expect(
      result.receiverAfter.normal.lines[0].cells
        .slice(0, expected.length)
        .map((cell) => cell.chars),
    ).toEqual(expected);
    completed.push(result.caseId);
  }

  const require = createRequire(import.meta.url);
  const { Terminal } = require("@xterm/headless");
  const { SerializeAddon } = require("@xterm/addon-serialize");
  const terminal = new Terminal({ ...dimensions, allowProposedApi: true });
  const addon = new SerializeAddon();
  terminal.loadAddon(addon);
  try {
    await writeParsed(terminal, bytes("A"));
    expect(() => createRecoveryCheckpoint(terminal, addon, 1)).toThrow(/checkpoint boundary/);
  } finally {
    addon.dispose();
    terminal.dispose();
  }
});
