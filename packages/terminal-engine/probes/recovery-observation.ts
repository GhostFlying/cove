import type { Terminal } from "@xterm/headless";
import { readPrivateRecoveryState } from "./xterm-recovery-state.js";

export interface CellObservation {
  readonly chars: string;
  readonly width: number;
  readonly fg: number;
  readonly bg: number;
  readonly flags: readonly boolean[];
  readonly overline?: boolean;
}

export interface BufferObservation {
  readonly type: "normal" | "alternate";
  readonly cursorX: number;
  readonly cursorY: number;
  readonly baseY: number;
  readonly viewportY: number;
  readonly lines: readonly {
    readonly wrapped: boolean;
    readonly cells: readonly CellObservation[];
  }[];
}

export interface RecoveryObservation {
  readonly active: "normal" | "alternate";
  readonly normal: BufferObservation;
  readonly alternate: BufferObservation;
  readonly modes: Readonly<Terminal["modes"]>;
}

export interface LogicalGridObservation {
  readonly active: "normal" | "alternate";
  readonly cursorHidden: boolean;
  readonly normal: BufferObservation;
  readonly alternate: BufferObservation;
  readonly modes: Readonly<Terminal["modes"]>;
}

function logicalBuffer(buffer: Terminal["buffer"]["normal"], cols: number): BufferObservation {
  const exact = observeBuffer(buffer);
  return {
    ...exact,
    lines: exact.lines.map((line, y) => ({
      wrapped: line.wrapped,
      cells: line.cells.slice(0, cols).map((cell, x) => {
        const actual = buffer.getLine(y)?.getCell(x);
        if (!actual) throw new Error(`Missing logical-grid ${buffer.type} cell ${x},${y}`);
        const chars = cell.chars || " ";
        const overline = !!actual.isOverline();
        const visuallyBlank =
          chars === " " && !cell.flags[3] && !cell.flags[5] && !cell.flags[7] && !overline;
        return {
          ...cell,
          chars,
          fg: visuallyBlank ? 0 : actual.getFgColorMode() + actual.getFgColor(),
          bg: actual.getBgColorMode() + actual.getBgColor(),
          flags: visuallyBlank ? cell.flags.map(() => false) : cell.flags,
          overline: visuallyBlank ? false : overline,
        };
      }),
    })),
  };
}

// Null and literal unstyled spaces are equivalent at the current grid; background remains visible.
export function observeLogicalGrid(terminal: Terminal): LogicalGridObservation {
  return {
    active: terminal.buffer.active.type,
    cursorHidden: readPrivateRecoveryState(terminal).cursorHidden,
    normal: logicalBuffer(terminal.buffer.normal, terminal.cols),
    alternate: logicalBuffer(terminal.buffer.alternate, terminal.cols),
    modes: { ...terminal.modes },
  };
}

function observeBuffer(buffer: Terminal["buffer"]["normal"]): BufferObservation {
  const lines: { wrapped: boolean; cells: CellObservation[] }[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) throw new Error(`Missing ${buffer.type} line ${y}`);
    const cells: CellObservation[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) throw new Error(`Missing ${buffer.type} cell ${x},${y}`);
      cells.push({
        chars: cell.getChars(),
        width: cell.getWidth(),
        fg: cell.getFgColorMode() * 0x1000000 + cell.getFgColor(),
        bg: cell.getBgColorMode() * 0x1000000 + cell.getBgColor(),
        flags: [
          !!cell.isBold(),
          !!cell.isDim(),
          !!cell.isItalic(),
          !!cell.isUnderline(),
          !!cell.isBlink(),
          !!cell.isInverse(),
          !!cell.isInvisible(),
          !!cell.isStrikethrough(),
        ],
      });
    }
    lines.push({ wrapped: line.isWrapped, cells });
  }
  return {
    type: buffer.type,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    lines,
  };
}

// This oracle uses only public read APIs and never asks the candidate serializer for expected state.
export function observeRecovery(terminal: Terminal): RecoveryObservation {
  return {
    active: terminal.buffer.active.type,
    normal: observeBuffer(terminal.buffer.normal),
    alternate: observeBuffer(terminal.buffer.alternate),
    modes: { ...terminal.modes },
  };
}

export async function writeParsed(terminal: Terminal, bytes: Uint8Array | string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(bytes, resolve));
}
