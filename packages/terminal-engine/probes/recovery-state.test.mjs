import { expect, test } from "vitest";
import { runRecoveryFixture } from "@cove/terminal-engine/probes/recovery-boundaries";
import {
  bothBuffers,
  bytes,
  savedState,
} from "../../../tests/fixtures/terminal/engine/recovery-cases.mjs";

test("R1 saved cursor and pen survive restore and a styled print", async () => {
  const result = await runRecoveryFixture(savedState);
  expect(result.generationPure).toBe(true);
  expect(result.beforeEqual).toBe(true);
  expect(result.afterEqual).toBe(true);
  const cell = result.receiverAfter.normal.lines[1].cells[2];
  expect(cell.chars).toBe("X");
  expect(cell.fg).toBe(result.sourceAfter.normal.lines[1].cells[2].fg);
  expect(cell.fg).not.toBe(result.sourceAfter.normal.lines[1].cells[3].fg);
});

test("R3 alternate restoration retains hidden normal saved state", async () => {
  const result = await runRecoveryFixture(bothBuffers);
  expect(result.generationPure).toBe(true);
  expect(result.beforeEqual).toBe(true);
  expect(result.afterEqual).toBe(true);
  expect(result.receiverAfter.normal.lines[1].cells[2].chars).toBe("Y");
  expect(result.receiverAfter.alternate.lines).toEqual([]);
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
});
