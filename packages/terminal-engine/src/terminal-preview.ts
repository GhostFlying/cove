import type { Terminal } from "@xterm/headless";
import { absolutePosition, cellAttr, sameAttr, sgr } from "./terminal-state-vt.js";
import { readPrivateRecoveryState, type AttributeState } from "./xterm-recovery-state.js";

const encoder = new TextEncoder();

// A preview is the active viewport only; it carries no hidden buffer or parser tail.
export function createScreenPreview(terminal: Terminal, maxBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536)
    throw new Error("Invalid preview byte cap");
  const buffer = terminal.buffer.active;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const append = (vt: string): void => {
    if (!vt) return;
    const chunk = encoder.encode(vt);
    if (chunk.length > maxBytes - total) throw new Error("Current-screen preview exceeds byte cap");
    chunks.push(chunk);
    total += chunk.length;
  };
  append("\u001b[0m\u001b[H");
  for (let y = 0; y < terminal.rows; y++) {
    if (y) append("\r\n");
    const line = buffer.getLine(buffer.baseY + y);
    if (!line) throw new Error("Current-screen row is absent");
    let row = "";
    let prior: AttributeState | null = null;
    for (let x = 0; x < terminal.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) throw new Error("Current-screen cell is absent");
      if (cell.getWidth() === 0) continue;
      const next = cellAttr(cell);
      if (!prior || !sameAttr(prior, next)) {
        row += sgr(next);
        prior = next;
      }
      row += cell.getChars() || " ";
    }
    append(row);
  }
  const privateState = readPrivateRecoveryState(terminal);
  append(absolutePosition(Math.min(buffer.cursorX, terminal.cols - 1), buffer.cursorY));
  if (privateState.cursorHidden) append("\u001b[?25l");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
