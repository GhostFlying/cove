import { createRequire } from "node:module";
import { afterAll, expect, test } from "vitest";
import {
  BoundedRecoveryTail,
  createLogicalGridCheckpoint,
  observeLogicalGrid,
  observeRecovery,
  writeParsed,
} from "@cove/terminal-engine/probes/recovery-boundaries";
import { writeRecoverySuiteEvidence } from "../../../tests/fixtures/terminal/engine/recovery-evidence.mjs";
import {
  parserSequences,
  queryBytes,
  expectedLiveReplies,
} from "../../../tests/fixtures/terminal/engine/recovery-cases.mjs";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");
const bytes = (value) => (value instanceof Uint8Array ? value : new TextEncoder().encode(value));
const completed = [];

afterAll(() =>
  writeRecoverySuiteEvidence("recovery-pragmatic", completed, 175, {
    contract: "pragmatic-logical-grid-v1",
    classification: "required",
    outcome: "pass",
    scenarioFamilies: 16,
    joinedCases: 10,
    freshCheckpoints: 20,
    parserCuts: 138,
    c0Effects: 7,
    queryFamilies: 9,
    oracleControls: 2,
  }),
);

async function run(caseId, setup, tail, continuation, geometry = {}) {
  const options = {
    cols: geometry.cols ?? 12,
    rows: geometry.rows ?? 4,
    scrollback: geometry.scrollback ?? 10,
    allowProposedApi: true,
  };
  const source = new Terminal(options);
  const receiver = new Terminal(options);
  const sourceReplies = [];
  const receiverReplies = [];
  const sourceTitles = [];
  const receiverTitles = [];
  let sourceBells = 0;
  let receiverBells = 0;
  const sourceListener = source.onData((reply) => sourceReplies.push(reply));
  const receiverListener = receiver.onData((reply) => receiverReplies.push(reply));
  const sideEffects = [
    source.onBell(() => sourceBells++),
    receiver.onBell(() => receiverBells++),
    source.onTitleChange((title) => sourceTitles.push(title)),
    receiver.onTitleChange((title) => receiverTitles.push(title)),
  ];
  const appearance = [];
  if (geometry.appearance) {
    for (const [terminal, replies] of [
      [source, sourceReplies],
      [receiver, receiverReplies],
    ]) {
      for (const [id, data, color] of [
        [10, "?", "ffff/ffff/ffff"],
        [11, "?", "0000/0000/0000"],
        [4, "1;?", "cccc/0000/0000"],
      ]) {
        appearance.push(
          terminal.parser.registerOscHandler(id, (value) => {
            if (value !== data) return false;
            replies.push(`\u001b]${id};${id === 4 ? "1;" : ""}rgb:${color}\u001b\\`);
            return true;
          }),
        );
      }
    }
  }
  const write = async (terminal, value) => {
    const payload = bytes(value);
    if (!geometry.chunkSize) return writeParsed(terminal, payload);
    for (let offset = 0; offset < payload.length; offset += geometry.chunkSize)
      await writeParsed(terminal, payload.subarray(offset, offset + geometry.chunkSize));
  };
  try {
    await write(source, setup);
    if (geometry.sourceResize) source.resize(...geometry.sourceResize);
    if (geometry.sourceResize) receiver.resize(...geometry.sourceResize);
    const sourceRepliesAtCheckpoint = [...sourceReplies];
    const before = observeRecovery(source);
    const checkpoint = createLogicalGridCheckpoint(source, bytes(setup).length);
    expect(observeRecovery(source)).toEqual(before);
    expect(sourceReplies).toEqual(sourceRepliesAtCheckpoint);
    const rawTail = new BoundedRecoveryTail();
    rawTail.append(bytes(tail));
    await write(source, tail);
    await write(receiver, checkpoint.vt);
    await write(receiver, rawTail.snapshot());
    expect(observeLogicalGrid(receiver)).toEqual(observeLogicalGrid(source));
    await write(source, continuation);
    await write(receiver, continuation);
    expect(observeLogicalGrid(receiver)).toEqual(observeLogicalGrid(source));
    expect(receiverReplies).toEqual(sourceReplies.slice(sourceRepliesAtCheckpoint.length));
    expect(receiverBells).toBe(sourceBells);
    expect(receiverTitles).toEqual(sourceTitles);
    completed.push(caseId);
    return { sourceReplies, receiverReplies, checkpoint };
  } finally {
    for (const listener of sideEffects) listener.dispose();
    for (const listener of appearance) listener.dispose();
    sourceListener.dispose();
    receiverListener.dispose();
    source.dispose();
    receiver.dispose();
  }
}

test("pragmatic normal saved position and current pen continue", async () => {
  const result = await run(
    "normal-saved-position-pen",
    "\u001b[2;3H\u001b[31m\u001b7\u001b[4;9H\u001b[34m",
    "",
    "C\u001b8S\u001b[4;9HX",
  );
  expect(result.checkpoint.vt.length).toBeGreaterThan(0);
});

test("pragmatic alternate baseline preserves hidden normal on exit", async () => {
  const result = await run(
    "alternate-normal-exit",
    "normal\u001b[2;3H\u001b7\u001b[?47hALT\u001b[32m",
    "",
    "Z\u001b[?47l\u001b8Q",
  );
  expect(result.checkpoint.vt.length).toBeGreaterThan(0);
});

test("pragmatic split query tail replies only through the live source sink", async () => {
  const result = await run("split-query-tail", "ready", "\u001b[?6", "n");
  expect(result.sourceReplies).toEqual(["\u001b[?1;6R"]);
});

const commonCases = [
  {
    caseId: "alternate-current-pen",
    setup: "\u001b[?47h\u001b[1;53;38;5;201mALT",
    continuation: "Z",
  },
  {
    caseId: "alternate-saved-position",
    setup: "\u001b[?47h\u001b[2;3H\u001b7\u001b[4;9H",
    continuation: "X\u001b8Y",
  },
  {
    caseId: "current-pending-wrap",
    setup: "123456789ABC",
    continuation: "D\u001b[b",
  },
  {
    caseId: "origin-margins-scroll",
    setup: "\u001b[2;4r\u001b[?6h\u001b[?25l\u001b[2;3H\u001b[31mA",
    continuation: "\u001b[3;1H\nZ\u001b[?6n",
  },
  {
    caseId: "visible-custom-tabs",
    setup: "\u001b[3g\u001b[4G\u001bH\u001b[9G\u001bH\u001b[1;1H",
    continuation: "\tX\tY",
  },
  {
    caseId: "in-grid-edit",
    setup: "abcdefghijkl\u001b[1;4H",
    continuation: "\u001b[2@XY\u001b[3P\u001b[2X",
  },
  {
    caseId: "alternate-cleared-normal-snapshot",
    setup: "home\u001b[?1049hOLD\u001b[?1049l\u001b[?1049hNEW",
    continuation: "Z\u001b[?1049lQ",
  },
  {
    caseId: "three-line-history",
    setup: Array.from({ length: 10 }, (_, index) => `L${index}\r\n`).join(""),
    continuation: "tail\u001b[2;2HX",
    geometry: { scrollback: 3 },
  },
  {
    caseId: "full-history-budget",
    setup: Array.from(
      { length: 1007 },
      (_, index) => `L${String(index).padStart(4, "0")}\r\n`,
    ).join(""),
    continuation: "tail\u001b[2;2HX",
    geometry: { scrollback: 1000 },
  },
  {
    caseId: "unicode-at-margin",
    setup: "\u001b[1;10H中e\u0301",
    continuation: "😀\u001b[b",
  },
  {
    caseId: "osc-dcs-c0-tail",
    setup: "A",
    tail: "\u001b]0;title\u0007\u001bP1$r",
    continuation: "m\u001b\\\u0008\tZ",
  },
  {
    caseId: "source-resize-fresh-baseline",
    setup: "abcdefghijklmnopqrstuvwx\r\nnormal",
    continuation: "Z\u001b[?6n",
    geometry: { sourceResize: [10, 4] },
  },
  {
    caseId: "reverse-wrap-and-input-modes",
    setup: "\u001b[?45h\u001b[?1h\u001b=\u001b[?2004h\u001b[?1004h\u001b[?1000h\u001b[2;1H",
    continuation: "\u0008Q\u001b[?1$p\u001b[?2004$p",
  },
];

test.each(commonCases)(
  "pragmatic $caseId",
  async ({ caseId, setup, tail = "", continuation, geometry }) => {
    const result = await run(caseId, setup, tail, continuation, geometry);
    expect(result.checkpoint.vt.length).toBeGreaterThan(0);
  },
);

test("pragmatic oracle rejects a missing visible overline and P256 color", async () => {
  const options = { cols: 12, rows: 4, allowProposedApi: true };
  const styled = new Terminal(options);
  const plain = new Terminal(options);
  try {
    await writeParsed(styled, "\u001b[53;38;5;201mA");
    await writeParsed(plain, "A");
    expect(observeLogicalGrid(styled)).not.toEqual(observeLogicalGrid(plain));
    await writeParsed(plain, "\u001b[1;1H\u001b[38;5;201mA");
    expect(observeLogicalGrid(styled)).not.toEqual(observeLogicalGrid(plain));
    completed.push("oracle-visible-overline-color");
  } finally {
    styled.dispose();
    plain.dispose();
  }
});

test("pragmatic oracle rejects wrong cursor visibility", async () => {
  const options = { cols: 12, rows: 4, allowProposedApi: true };
  const hidden = new Terminal(options);
  const shown = new Terminal(options);
  try {
    await writeParsed(hidden, "\u001b[?25l");
    expect(observeLogicalGrid(hidden)).not.toEqual(observeLogicalGrid(shown));
    completed.push("oracle-cursor-visibility");
  } finally {
    hidden.dispose();
    shown.dispose();
  }
});

const joinedCases = [
  ["interior", "\u001b[2;3H\u001b7\u001b[1;38;5;201mA", "\u001b[3b", {}],
  ["pending", "\u001b[2;12H\u001b7A", "\u0301", {}],
  ["wide", "\u001b[2;4H中", "\u001b[3b", {}],
  ["combined", "\u001b[2;4He\u0301", "\u0301", {}],
  ["dec", "\u001b(0\u001b[2;4Hq", "\u001b[3b", {}],
  ["insert", "ABCDE\u001b[1;3H\u001b[4hZ", "Q", {}],
  ["rejected-wide", "\u001b[?7l\u001b[1;12H中", "\u001b[3b", {}],
  ["bottom-margin", "\u001b[2;4r\u001b[4;12HA", "\u001b8Q", {}],
  ["cluster-67", `e${"\u0301".repeat(33)}`, "\u0301", {}],
  ["print-resize", "\u001b[2;4He\u0301", "\u001b[3b", { sourceResize: [11, 4] }],
];

test.each(joinedCases)("pragmatic joined $0", async (id, setup, continuation, geometry) => {
  const result = await run(`joined-${id}`, setup, "", continuation, geometry);
  expect(result.checkpoint.vt.length).toBeGreaterThan(0);
});

test("pragmatic printable stream proves twenty fresh checkpoints before resetting each tail", async () => {
  const targets = [32_768, 65_520, 98_304, 131_072, 131_073];
  let attempts = 0;
  let peakTail = 0;
  for (const cols of [12, 40])
    for (const alternate of [false, true]) {
      const options = { cols, rows: 4, scrollback: 10, allowProposedApi: true };
      const source = new Terminal(options);
      const tail = new BoundedRecoveryTail();
      let total = 0;
      try {
        if (alternate) await writeParsed(source, "\u001b[?47h");
        for (const target of targets) {
          while (total < target) {
            const chunk = bytes("A".repeat(Math.min(2048, target - total)));
            tail.append(chunk);
            await writeParsed(source, chunk);
            total += chunk.length;
            peakTail = Math.max(peakTail, tail.retainedBytes);
          }
          const checkpoint = createLogicalGridCheckpoint(source, total);
          const reference = new Terminal(options);
          const receiver = new Terminal(options);
          try {
            if (alternate) await writeParsed(reference, "\u001b[?47h");
            await writeParsed(reference, bytes("A".repeat(total)));
            expect(observeLogicalGrid(source)).toEqual(observeLogicalGrid(reference));
            await writeParsed(receiver, checkpoint.vt);
            expect(observeLogicalGrid(receiver)).toEqual(observeLogicalGrid(reference));
            for (const suffix of ["\u001b[3b", "\u0301", "\u001b8Q"]) {
              await writeParsed(reference, suffix);
              await writeParsed(receiver, suffix);
              expect(observeLogicalGrid(receiver)).toEqual(observeLogicalGrid(reference));
            }
            attempts++;
            tail.resetAfterProvedCheckpoint();
          } finally {
            reference.dispose();
            receiver.dispose();
          }
        }
      } finally {
        source.dispose();
      }
    }
  expect(attempts).toBe(20);
  expect(peakTail).toBeLessThanOrEqual(64 * 1024);
  completed.push("fresh-stream-20");
});

test("pragmatic parser covers every interior UTF-8 and control-sequence cut", async () => {
  let cuts = 0;
  for (const [id, sequence] of parserSequences)
    for (let cut = 1; cut < sequence.length; cut++)
      for (const chunkSize of [undefined, 1]) {
        await run(
          `parser-${id}-${cut}-${chunkSize ?? "coalesced"}`,
          "",
          sequence.subarray(0, cut),
          Uint8Array.from([...sequence.subarray(cut), 0x21]),
          { chunkSize },
        );
        cuts++;
      }
  expect(cuts).toBe(138);
});

test("pragmatic C0 effects inside CSI execute exactly once", async () => {
  for (const [id, control] of [
    ["lf", "\n"],
    ["cr", "\r"],
    ["bs", "\b"],
    ["ht", "\t"],
    ["si", "\u000f"],
    ["so", "\u000e"],
    ["bel", "\u0007"],
  ])
    await run(`c0-${id}`, "\u001b[2;3H", `\u001b[1${control}`, ";2H!");
  expect(completed.filter((id) => id.startsWith("c0-"))).toHaveLength(7);
});

test("pragmatic source answers nine live query families without replay to its sink", async () => {
  const queries = Uint8Array.from(Object.values(queryBytes).flatMap((part) => [...part]));
  const expected = Object.values(expectedLiveReplies).map((part) => new TextDecoder().decode(part));
  const { sourceReplies, receiverReplies } = await run(
    "nine-live-queries",
    queries,
    queries,
    queries,
    { appearance: true },
  );
  expect(sourceReplies).toEqual([...expected, ...expected, ...expected]);
  expect(receiverReplies).toEqual([...expected, ...expected]);
});
