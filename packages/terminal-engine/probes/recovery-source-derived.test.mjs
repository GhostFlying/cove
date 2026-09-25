import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { afterAll, expect, test } from "vitest";
import {
  BoundedRecoveryTail,
  createSourceDerivedRecovery,
  observeRecovery,
  readPrivateRecoveryState,
  writeParsed,
} from "@cove/terminal-engine/probes/recovery-boundaries";
import { bytes } from "../../../tests/fixtures/terminal/engine/recovery-cases.mjs";
import { writeRecoverySuiteEvidence } from "../../../tests/fixtures/terminal/engine/recovery-evidence.mjs";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");
const completed = [];
const outcomes = [];
const peaks = {
  baselineBytes: 0,
  scannedCells: 0,
  capturedTextUnits: 0,
  geometryOperations: 0,
  accountedPayloadBytes: 0,
  tailBytes: 0,
};
afterAll(() =>
  writeRecoverySuiteEvidence("recovery-source-derived", completed, 5, { outcomes, peaks }),
);

function terminal(cols, rows = 4, scrollback = 10) {
  return new Terminal({ cols, rows, scrollback, allowProposedApi: true });
}

function same(source, receiver) {
  return (
    isDeepStrictEqual(observeRecovery(source), observeRecovery(receiver)) &&
    isDeepStrictEqual(readPrivateRecoveryState(source), readPrivateRecoveryState(receiver))
  );
}

function firstDifference(expected, actual, path = "") {
  if (isDeepStrictEqual(expected, actual)) return "";
  if (
    typeof expected !== "object" ||
    expected === null ||
    typeof actual !== "object" ||
    actual === null
  )
    return path || "root";
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const nested = firstDifference(expected[key], actual[key], `${path}.${key}`);
    if (nested) return nested;
  }
  return path || "root";
}

async function install(source, scrollback) {
  const publicBefore = observeRecovery(source);
  const privateBefore = readPrivateRecoveryState(source);
  const generated = createSourceDerivedRecovery(source);
  const repeated = createSourceDerivedRecovery(source);
  expect(repeated).toEqual(generated);
  expect(observeRecovery(source)).toEqual(publicBefore);
  expect(readPrivateRecoveryState(source)).toEqual(privateBefore);
  peaks.baselineBytes = Math.max(peaks.baselineBytes, generated.metrics.encodedBytes);
  peaks.scannedCells = Math.max(peaks.scannedCells, generated.metrics.scannedCells);
  peaks.geometryOperations = Math.max(
    peaks.geometryOperations,
    generated.metrics.geometryOperations,
  );
  peaks.capturedTextUnits = Math.max(peaks.capturedTextUnits, generated.metrics.capturedTextUnits);
  peaks.accountedPayloadBytes = Math.max(
    peaks.accountedPayloadBytes,
    generated.metrics.accountedPayloadBytes,
  );
  const receiver = terminal(generated.initialCols, generated.rows, scrollback);
  try {
    for (const operation of generated.operations) {
      if (operation.kind === "write") await writeParsed(receiver, operation.bytes);
      else receiver.resize(operation.cols, operation.rows);
    }
    const publicAfter = observeRecovery(receiver);
    const privateAfter = readPrivateRecoveryState(receiver);
    return {
      receiver,
      beforeEqual:
        isDeepStrictEqual(publicBefore, publicAfter) &&
        isDeepStrictEqual(privateBefore, privateAfter),
      firstDifference:
        firstDifference(publicBefore, publicAfter, "public") ||
        firstDifference(privateBefore, privateAfter, "private"),
    };
  } catch (error) {
    receiver.dispose();
    throw error;
  }
}

async function trial(id, setup, options = {}) {
  const {
    initialCols = 12,
    cols = initialCols,
    rows = 4,
    scrollback = 10,
    finish = "",
    suffix = "",
  } = options;
  const source = terminal(initialCols, rows, scrollback);
  let result;
  try {
    await writeParsed(source, bytes(setup));
    if (cols !== initialCols) source.resize(cols, rows);
    if (finish) await writeParsed(source, bytes(finish));
    result = await install(source, scrollback);
    if (suffix) {
      await writeParsed(source, bytes(suffix));
      await writeParsed(result.receiver, bytes(suffix));
    }
    const afterEqual = same(source, result.receiver);
    outcomes.push({
      id,
      beforeEqual: result.beforeEqual,
      afterEqual,
      firstDifference: result.firstDifference,
    });
    return { ...result, afterEqual };
  } finally {
    result?.receiver.dispose();
    source.dispose();
  }
}

test("source-only J families, whole 67-byte cluster and print-resize diagnostic", async () => {
  const cases = [
    ["interior", "\u001b[2;3H\u001b7\u001b[1;38;5;201mA", "\u001b[3b", {}],
    ["pending", "\u001b[2;12H\u001b7A", "́", {}],
    ["wide", "\u001b[2;4H中", "\u001b[3b", {}],
    ["combined", "\u001b[2;4Hé", "́", {}],
    ["dec", "\u001b(0\u001b[2;4Hq", "\u001b[3b", {}],
    ["insert", "ABCDE\u001b[1;3H\u001b[4hZ", "Q", {}],
    ["rejected-wide", "\u001b[?7l\u001b[1;12H中", "\u001b[3b", {}],
    ["bottom-margin", "\u001b[2;4r\u001b[4;12HA", "\u001b8Q", {}],
    ["cluster-67", `e${"́".repeat(33)}`, "́", {}],
    ["print-resize", "\u001b[2;4Hé", "\u001b[3b", { initialCols: 12, cols: 11 }],
  ];
  for (const [id, setup, suffix, options] of cases) {
    const result = await trial(`S-${id}`, setup, { ...options, suffix });
    expect(result.beforeEqual).toBe(true);
    expect(result.afterEqual).toBe(true);
    completed.push(`S-${id}`);
  }
  expect(bytes(`e${"́".repeat(33)}`).length).toBe(67);
  expect(cases).toHaveLength(10);
});

test("source-only ordinary stream attempts 20 fresh checkpoints under the raw-tail cap", async () => {
  const targets = [32_768, 65_520, 98_304, 131_072, 131_073];
  for (const cols of [12, 40])
    for (const alternate of [false, true]) {
      const source = terminal(cols);
      const tail = new BoundedRecoveryTail();
      let total = 0;
      let attempts = 0;
      const replies = [];
      const listener = source.onData((reply) => replies.push(reply));
      try {
        if (alternate) await writeParsed(source, bytes("\u001b[?47h"));
        for (const target of targets) {
          while (total < target) {
            const chunk = bytes("A".repeat(Math.min(2048, target - total)));
            tail.append(chunk);
            await writeParsed(source, chunk);
            total += chunk.length;
            peaks.tailBytes = Math.max(peaks.tailBytes, tail.retainedBytes);
          }
          const result = await install(source, 10);
          const reference = terminal(cols);
          let afterEqual = false;
          try {
            if (alternate) await writeParsed(reference, bytes("\u001b[?47h"));
            await writeParsed(reference, bytes("A".repeat(total)));
            expect(same(source, reference)).toBe(true);
            expect(result.beforeEqual).toBe(true);
            for (const suffix of ["\u001b[3b", "́", "\u001b8Q"]) {
              await writeParsed(reference, bytes(suffix));
              await writeParsed(result.receiver, bytes(suffix));
              expect(same(reference, result.receiver)).toBe(true);
            }
            afterEqual = true;
          } finally {
            reference.dispose();
            result.receiver.dispose();
          }
          outcomes.push({
            id: `S-stream-${cols}-${alternate}-${target}`,
            beforeEqual: result.beforeEqual,
            afterEqual,
            firstDifference: result.firstDifference,
            tailAvailable: tail.available,
          });
          attempts++;
          if (result.beforeEqual && afterEqual) tail.resetAfterProvedCheckpoint();
        }
        expect(attempts).toBe(5);
        expect(total).toBe(131_073);
        expect(tail.available).toBe(true);
        expect(replies).toEqual([]);
        completed.push(`S-stream-${cols}-${alternate ? "alternate" : "normal"}`);
      } finally {
        listener.dispose();
        source.dispose();
      }
    }
  expect(outcomes.filter(({ id }) => id.startsWith("S-stream-"))).toHaveLength(20);
});

const mixedNormal = `${"N".repeat(65)}\r\n\u001b[2;4r\u001b)0\u000e\u001b[2;3H\u001b[31m\u001b7\u000f\u001b)B`;
const historyNormal = `${"H".repeat(200)}\r\n中é😀\r\n\u001b[2;3r\u001b)0\u000e\u001b[2;3H\u001b[31m\u001b7\u000f\u001b)B`;
const alternateContent =
  `\u001b[?47h\u001b[1;1H${"B".repeat(40)}A` +
  "\u001b[2;40H\u001b[1;3;48;5;201m中́" +
  "\u001b[3;41H\u001b[48;2;12;34;56m \u001b[0m";

test("source-only combined geometry attempts both row orders, history and joined continuation", async () => {
  for (const shortRow of [0, 3]) {
    const result = await trial(`S-mixed-${shortRow}`, mixedNormal + alternateContent, {
      initialCols: 41,
      cols: 40,
      finish: `\u001b[${shortRow + 1};1H\u001b[L\u001b[${shortRow + 1};40HZ\u001b[0m\u001b[4;1H`,
      suffix: `\u001b[${shortRow + 1};40H\u001b[@\u001b[${shortRow + 1};40H\u001b[P`,
    });
    expect(result.beforeEqual).toBe(false);
    expect(result.firstDifference).toBe("public.normal.lines.1.cells.23.chars");
    completed.push(`S-mixed-${shortRow}`);
  }
  const history = await trial("S-history", historyNormal + alternateContent, {
    initialCols: 41,
    cols: 40,
    rows: 3,
    scrollback: 3,
    finish: "\u001b[1;1H\u001b[L\u001b[1;40HZ\u001b[0m\u001b[3;1H",
    suffix: "\u001b[1;40H\u001b[@\u001b[1;40H\u001b[P",
  });
  expect(history.beforeEqual).toBe(false);
  expect(history.firstDifference).toBe("public.alternate.lines.1.cells.0.fg");
  completed.push("S-history");
  const joined = await trial("S-mixed-final-print", mixedNormal + alternateContent, {
    initialCols: 41,
    cols: 40,
    finish: "\u001b[1;1H\u001b[L\u001b[1;40HZ\u001b[0m\u001b[4;5HQ",
    suffix: "́\u001b[3b",
  });
  expect(joined.beforeEqual).toBe(false);
  expect(joined.firstDifference).toBe("public.normal.lines.1.cells.23.chars");
  completed.push("S-mixed-final-print");
});

test("source-only profile rejects excess geometry and caps output without a receiver", async () => {
  const source = terminal(12);
  try {
    await writeParsed(source, bytes("A".repeat(100)));
    expect(() => createSourceDerivedRecovery(source, { maxCols: 11 })).toThrow(
      /geometry exceeds profile/,
    );
    expect(() => createSourceDerivedRecovery(source, { maxScannedCells: 1 })).toThrow(
      /cell scan exceeds cap/,
    );
    expect(() => createSourceDerivedRecovery(source, { maxBaselineBytes: 1 })).toThrow(
      /captured text exceeds cap/,
    );
    expect(() => createSourceDerivedRecovery(source, { maxBaselineBytes: 100 })).toThrow(
      /baseline exceeds byte cap/,
    );
    completed.push("S-bounds");
  } finally {
    source.dispose();
  }
});

test("source-only 120x40 and 1000-line history stays within declared scan and VT caps", async () => {
  const source = terminal(120, 40, 1000);
  let result;
  try {
    await writeParsed(source, bytes(`${"X".repeat(119)}\r\n`.repeat(1040)));
    result = await install(source, 1000);
    const generated = createSourceDerivedRecovery(source);
    expect(result.beforeEqual).toBe(true);
    expect(generated.metrics.scannedCells).toBeLessThanOrEqual(2 * 120 * 1040);
    expect(generated.metrics.encodedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(generated.metrics.geometryOperations).toBeLessThanOrEqual(1040 * 2 + 3);
    outcomes.push({
      id: "S-profile-120x40-1000",
      beforeEqual: result.beforeEqual,
      firstDifference: result.firstDifference,
    });
    completed.push("S-profile-120x40-1000");
  } finally {
    result?.receiver.dispose();
    source.dispose();
  }
});
