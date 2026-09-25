import { createRequire } from "node:module";
import { afterAll, expect, test } from "vitest";
import {
  BoundedRecoveryTail,
  createFinalGlyphCheckpoint,
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
  peakTailBytes: 0,
  peakBaselineBytes: 0,
  checkpointReplacements: 0,
  witnessCapBytes: 64,
};
afterAll(() => writeRecoverySuiteEvidence("recovery-join", completed, 39, metrics));

function terminal(cols = 12, rows = 4) {
  return new Terminal({ cols, rows, scrollback: 10, allowProposedApi: true });
}

function finalA(source) {
  const cursor = source.buffer.active;
  return {
    bytes: bytes("A"),
    startX: cursor.cursorX === source.cols ? source.cols - 1 : cursor.cursorX - 1,
    startY: cursor.cursorY,
    cellWidth: 1,
    preimage: "erase",
  };
}

async function assertRestore(source, addon, witness, suffix = bytes(""), byteOffset = 0) {
  const before = observeRecovery(source);
  const privateBefore = readPrivateRecoveryState(source);
  const checkpoint = createFinalGlyphCheckpoint(source, addon, byteOffset, witness);
  const repeated = createFinalGlyphCheckpoint(source, addon, byteOffset, witness);
  expect(checkpoint.byteOffset).toBe(byteOffset);
  expect(checkpoint.vt).toEqual(repeated.vt);
  expect(observeRecovery(source)).toEqual(before);
  expect(readPrivateRecoveryState(source)).toEqual(privateBefore);
  const receiver = terminal(source.cols, source.rows);
  try {
    await writeParsed(receiver, checkpoint.vt);
    expect(observeRecovery(receiver)).toEqual(before);
    expect(readPrivateRecoveryState(receiver).precedingJoinState).toBe(
      privateBefore.precedingJoinState,
    );
    await writeParsed(source, suffix);
    await writeParsed(receiver, suffix);
    expect(observeRecovery(receiver)).toEqual(observeRecovery(source));
  } finally {
    receiver.dispose();
  }
  return checkpoint.vt.length;
}

test("J replaces ordinary printable checkpoints before a 64 KiB tail fills in both buffers and grids", async () => {
  const targets = [32_768, 65_520, 98_304, 131_072, 131_073];
  for (const cols of [12, 40])
    for (const alternate of [false, true]) {
      const source = terminal(cols);
      const addon = new SerializeAddon();
      source.loadAddon(addon);
      const tail = new BoundedRecoveryTail();
      let total = 0;
      let peakTail = 0;
      let peakBaseline = 0;
      try {
        if (alternate) await writeParsed(source, bytes("\u001b[?47h"));
        for (const target of targets) {
          while (total < target) {
            const chunk = bytes("A".repeat(Math.min(2048, target - total)));
            tail.append(chunk);
            await writeParsed(source, chunk);
            total += chunk.length;
            peakTail = Math.max(peakTail, tail.retainedBytes);
            expect(tail.available).toBe(true);
          }
          peakBaseline = Math.max(
            peakBaseline,
            await assertRestore(source, addon, finalA(source), bytes(""), total),
          );
          metrics.checkpointReplacements++;
          tail.resetAfterProvedCheckpoint();
        }
        expect(targets).toHaveLength(5);
        expect(total).toBe(131_073);
        expect(peakTail).toBeLessThan(65_536);
        expect(peakBaseline).toBeLessThan(8 * 1024 * 1024);
        metrics.peakTailBytes = Math.max(metrics.peakTailBytes, peakTail);
        metrics.peakBaselineBytes = Math.max(metrics.peakBaselineBytes, peakBaseline);
        expect(source.buffer.active.cursorX).toBe(131_073 % cols);
        completed.push(`J-stream-${cols}-${alternate ? "alternate" : "normal"}`);
      } finally {
        addon.dispose();
        source.dispose();
      }
    }
  expect(metrics.checkpointReplacements).toBe(20);
});

test("J final print preserves immediate suffixes across width, charset, insert, wrap and margin cases", async () => {
  const cases = [
    ["ascii-interior", "\u001b[2;3H\u001b7\u001b[1;38;5;201mA", "A", 2, 1, 1, "erase"],
    ["ascii-pending", "\u001b[2;12H\u001b7A", "A", 11, 1, 1, "erase"],
    ["wide", "\u001b[2;4H中", "中", 3, 1, 2, "erase"],
    ["combined", "\u001b[2;4Hé", "é", 3, 1, 1, "erase"],
    ["dec-charset", "\u001b(0\u001b[2;4Hq", "q", 3, 1, 1, "erase"],
    ["insert", "ABCDE\u001b[1;3H\u001b[4hZ", "Z", 2, 0, 1, "delete"],
    ["nowrap-wide-overflow", "\u001b[?7l\u001b[1;12H中", "中", 11, 0, 2, "none"],
    ["bottom-margin", "\u001b[2;4r\u001b[4;12HA", "A", 11, 3, 1, "erase"],
  ];
  const suffixes = ["B", "́", "\u001b[3b", "\u001b8Q"];
  expect(cases).toHaveLength(8);
  for (const [id, setup, glyph, startX, startY, cellWidth, preimage] of cases) {
    for (const [index, suffix] of suffixes.entries()) {
      const source = terminal();
      const addon = new SerializeAddon();
      source.loadAddon(addon);
      try {
        await writeParsed(source, bytes(setup));
        await assertRestore(
          source,
          addon,
          {
            bytes: bytes(glyph),
            startX,
            startY,
            cellWidth,
            preimage,
          },
          bytes(suffix),
        );
        completed.push(`J-${id}-suffix-${index}`);
      } finally {
        addon.dispose();
        source.dispose();
      }
    }
  }
});

test("J refresh waits for complete multibyte boundaries and bounds its final witness", async () => {
  for (const [id, prefix, first, last, witness, x, width] of [
    ["wide-split", "\u001b[2;4H", bytes("中").subarray(0, 2), bytes("中").subarray(2), "中", 3, 2],
    ["combined-split", "\u001b[2;4He", bytes("́").subarray(0, 1), bytes("́").subarray(1), "é", 3, 1],
  ]) {
    const source = terminal();
    const addon = new SerializeAddon();
    source.loadAddon(addon);
    try {
      await writeParsed(source, bytes(prefix));
      await writeParsed(source, first);
      expect(() =>
        createFinalGlyphCheckpoint(source, addon, 0, {
          bytes: bytes(witness),
          startX: x,
          startY: 1,
          cellWidth: width,
          preimage: "erase",
        }),
      ).toThrow(/checkpoint boundary/);
      await writeParsed(source, last);
      await assertRestore(
        source,
        addon,
        {
          bytes: bytes(witness),
          startX: x,
          startY: 1,
          cellWidth: width,
          preimage: "erase",
        },
        bytes("\u001b[3b"),
      );
      completed.push(`J-${id}`);
    } finally {
      addon.dispose();
      source.dispose();
    }
  }
  const source = terminal();
  const addon = new SerializeAddon();
  source.loadAddon(addon);
  try {
    const cluster = `e${"́".repeat(33)}`;
    await writeParsed(source, bytes(cluster));
    expect(bytes(cluster).length).toBeGreaterThan(64);
    expect(() =>
      createFinalGlyphCheckpoint(source, addon, 0, {
        bytes: bytes(cluster),
        startX: 0,
        startY: 0,
        cellWidth: 1,
        preimage: "erase",
      }),
    ).toThrow(/witness exceeds bounded size/);
    completed.push("J-cluster-budget-diagnostic");
  } finally {
    addon.dispose();
    source.dispose();
  }
});
