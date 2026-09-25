import { afterAll, expect, test } from "vitest";
import { runRecoveryFixture } from "@cove/terminal-engine/probes/recovery-boundaries";
import {
  bothBuffers,
  bytes,
  savedState,
} from "../../../tests/fixtures/terminal/engine/recovery-cases.mjs";
import { writeRecoverySuiteEvidence } from "../../../tests/fixtures/terminal/engine/recovery-evidence.mjs";

const completed = [];
afterAll(() => writeRecoverySuiteEvidence("recovery-state", completed, 10));

test("R1 saved cursor and pen survive restore and a styled print", async () => {
  const result = await runRecoveryFixture(savedState);
  expect(result.generationPure).toBe(true);
  expect(result.beforeEqual).toBe(true);
  expect(result.afterEqual).toBe(true);
  const cell = result.receiverAfter.normal.lines[1].cells[2];
  expect(cell.chars).toBe("X");
  expect(cell.fg).toBe(result.sourceAfter.normal.lines[1].cells[2].fg);
  expect(cell.fg).not.toBe(result.sourceAfter.normal.lines[1].cells[3].fg);
  completed.push(result.caseId);
});

test("R1 saved P256 and RGB colors preserve bold, italic, underline and inverse", async () => {
  for (const [caseId, style] of [
    ["R1-palette-256", "1;3;4;7;38;5;201;48;5;33"],
    ["R1-rgb", "1;3;4;7;38;2;12;34;56;48;2;100;101;102"],
  ]) {
    const result = await runRecoveryFixture({
      caseId,
      cols: 12,
      rows: 4,
      scrollback: 10,
      setupBytes: bytes(`\u001b[2;3H\u001b[${style}m\u001b7\u001b[4;9H\u001b[0m`),
      tailBytes: bytes(""),
      continuationBytes: bytes("\u001b8X"),
    });
    if (!result.beforeEqual || !result.afterEqual) throw new Error(`${caseId} restore diverged`);
    const cell = result.receiverAfter.normal.lines[1].cells[2];
    expect(cell.chars).toBe("X");
    expect(cell.flags[0]).toBe(true);
    expect(cell.flags[2]).toBe(true);
    expect(cell.flags[3]).toBe(true);
    expect(cell.flags[5]).toBe(true);
    expect(cell.fg).not.toBe(result.receiverAfter.normal.lines[1].cells[3].fg);
    completed.push(result.caseId);
  }
});

test("R1 saved G1 line drawing survives changed designation and later SI/SO", async () => {
  const result = await runRecoveryFixture({
    caseId: "R1-saved-g1-charset",
    cols: 12,
    rows: 4,
    scrollback: 10,
    setupBytes: bytes(
      "\u001b)0\u000e\u001b[2;3H\u001b[31m\u001b7\u000f\u001b)B\u001b[4;9H\u001b[34m",
    ),
    tailBytes: bytes(""),
    continuationBytes: bytes("\u001b8q\u000eqq"),
  });
  expect(result.beforeEqual).toBe(true);
  expect(result.afterEqual).toBe(true);
  expect(result.receiverAfter.normal.lines[1].cells.slice(2, 5).map((cell) => cell.chars)).toEqual([
    "─",
    "q",
    "q",
  ]);
  completed.push(result.caseId);
});

test("R3 alternate restoration retains hidden normal saved state", async () => {
  const result = await runRecoveryFixture(bothBuffers);
  expect(result.generationPure).toBe(true);
  expect(result.beforeEqual).toBe(true);
  expect(result.afterEqual).toBe(true);
  expect(result.receiverAfter.normal.lines[1].cells[2].chars).toBe("Y");
  expect(result.receiverAfter.alternate.lines).toEqual([]);
  completed.push(result.caseId);
});

test("R2 scroll margins, origin, modes, and tabs survive a checkpoint", async () => {
  const setup = bytes(
    "\u001b[2;4r\u001b[?6h\u001b[4h\u001b[?25l\u001b[3g\u001b[4G\u001bH\u001b[9G\u001bH\u001b[2;3H\u001b[31m\u001b7\u001b[2;6H\u001b[34m",
  );
  const result = await runRecoveryFixture({
    caseId: "R2-margins-modes-tabs",
    cols: 12,
    rows: 4,
    scrollback: 10,
    setupBytes: setup,
    tailBytes: bytes(""),
    continuationBytes: bytes("\u001b8M\tT\u001b[?2004h\u001b[?2004$p"),
  });
  expect(result.beforeEqual).toBe(true);
  expect(result.afterEqual).toBe(true);
  expect(result.sourceReplies.at(-1)).toBe("\u001b[?2004;1$y");
  expect(result.receiverReplies.at(-1)).toBe("\u001b[?2004;1$y");
  completed.push(result.caseId);
});

test("R2 pending wrap and saved last-column cursor survive bounded raw tail", async () => {
  const result = await runRecoveryFixture({
    caseId: "R2-pending-wrap-saved-cursor",
    cols: 12,
    rows: 4,
    scrollback: 10,
    setupBytes: bytes("\u001b[2;12H\u001b[1;38;5;201m"),
    tailBytes: bytes("Z\u001b7"),
    continuationBytes: bytes("\u001b8Q\u001b[3;1H!"),
  });
  expect(result.beforeEqual).toBe(true);
  expect(result.afterEqual).toBe(true);
  expect(result.receiverBefore.normal.lines[1].cells[11].chars).toBe("Z");
  expect(result.receiverAfter.normal.lines[1].cells[11].chars).toBe("Q");
  expect(result.receiverAfter.normal.lines[2].cells[0].chars).toBe("!");
  completed.push(result.caseId);
});

test("R3 alternate buffer variants retain hidden normal continuation", async () => {
  for (const mode of [47, 1047, 1049]) {
    const result = await runRecoveryFixture({
      caseId: `R3-alternate-${mode}`,
      cols: 12,
      rows: 4,
      scrollback: 10,
      setupBytes: bytes(`\u001b[2;3H\u001b[31m\u001b7\u001b[?${mode}hALT\u001b[0m`),
      tailBytes: bytes(""),
      continuationBytes: bytes(`\u001b[?${mode}l\u001b8Y`),
    });
    expect(result.beforeEqual).toBe(true);
    expect(result.afterEqual).toBe(true);
    expect(result.receiverAfter.normal.lines[1].cells[2].chars).toBe("Y");
    completed.push(result.caseId);
  }
});
