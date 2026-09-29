import type { Terminal } from "@xterm/headless";
import { absolutePosition, cellAttr, sameAttr, sgr } from "./terminal-state-vt.js";
import { readPrivateRecoveryState, type AttributeState } from "./xterm-recovery-state.js";

const encoder = new TextEncoder();

// A preview is the active viewport only; it carries no hidden buffer or parser tail.
export function createScreenPreview(terminal: Terminal, maxBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536)
    throw new Error("Invalid preview byte cap");
  const buffer = terminal.buffer.active;
  const output = new Uint8Array(maxBytes);
  let total = 0;
  const append = (vt: string): void => {
    if (!vt) return;
    const written = encoder.encodeInto(vt, output.subarray(total));
    if (written.read !== vt.length) throw new Error("Current-screen preview exceeds byte cap");
    total += written.written;
  };
  append("\u001b[0m\u001b[H");
  for (let y = 0; y < terminal.rows; y++) {
    if (y) append("\r\n");
    const line = buffer.getLine(buffer.baseY + y);
    if (!line) throw new Error("Current-screen row is absent");
    let prior: AttributeState | null = null;
    for (let x = 0; x < terminal.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) throw new Error("Current-screen cell is absent");
      if (cell.getWidth() === 0) continue;
      const next = cellAttr(cell);
      if (!prior || !sameAttr(prior, next)) {
        append(sgr(next));
        prior = next;
      }
      append(cell.getChars() || " ");
    }
  }
  const privateState = readPrivateRecoveryState(terminal);
  append(absolutePosition(Math.min(buffer.cursorX, terminal.cols - 1), buffer.cursorY));
  if (privateState.cursorHidden) append("\u001b[?25l");
  return output.slice(0, total);
}
