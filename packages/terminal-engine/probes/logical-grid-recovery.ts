import type { Terminal } from "@xterm/headless";
import {
  absolutePosition,
  savedState,
  sgr,
  type RecoveryCheckpoint,
} from "./recovery-checkpoint.js";
import {
  readPrivateRecoveryState,
  type AttributeState,
  type PrivateBufferState,
} from "./xterm-recovery-state.js";

export interface LogicalGridCheckpoint extends RecoveryCheckpoint {
  readonly metrics: {
    readonly scannedCells: number;
    readonly capturedTextUnits: number;
    readonly encodedBytes: number;
    readonly accountedPayloadBytes: number;
    readonly disposableRows: number;
  };
}

const BASELINE_CAP = 8 * 1024 * 1024;
const CELL_CAP = 2 * 120 * 1040;
const encoder = new TextEncoder();

type PublicLine = NonNullable<ReturnType<Terminal["buffer"]["normal"]["getLine"]>>;
type PublicCell = NonNullable<ReturnType<PublicLine["getCell"]>>;

function cellAttr(cell: PublicCell): AttributeState {
  const fgMode = cell.getFgColorMode();
  const bgMode = cell.getBgColorMode();
  return {
    fg: fgMode === 0 ? 0 : fgMode * 0x1000000 + cell.getFgColor(),
    bg: bgMode === 0 ? 0 : bgMode * 0x1000000 + cell.getBgColor(),
    bold: !!cell.isBold(),
    dim: !!cell.isDim(),
    italic: !!cell.isItalic(),
    underline: !!cell.isUnderline(),
    blink: !!cell.isBlink(),
    inverse: !!cell.isInverse(),
    invisible: !!cell.isInvisible(),
    strikethrough: !!cell.isStrikethrough(),
    overline: false,
  };
}

function sameAttr(left: AttributeState, right: AttributeState): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof AttributeState] === right[key as keyof AttributeState],
  );
}

function currentModes(modes: Terminal["modes"], cursorHidden: boolean): string {
  let vt = "";
  if (modes.applicationCursorKeysMode) vt += "\u001b[?1h";
  if (modes.applicationKeypadMode) vt += "\u001b=";
  if (modes.bracketedPasteMode) vt += "\u001b[?2004h";
  if (modes.insertMode) vt += "\u001b[4h";
  if (modes.reverseWraparoundMode) vt += "\u001b[?45h";
  if (modes.sendFocusMode) vt += "\u001b[?1004h";
  if (modes.synchronizedOutputMode) vt += "\u001b[?2026h";
  if (!modes.wraparoundMode) vt += "\u001b[?7l";
  if (cursorHidden) vt += "\u001b[?25l";
  const mouse = { none: 0, x10: 9, vt200: 1000, drag: 1002, any: 1003 }[modes.mouseTrackingMode];
  if (mouse === undefined) throw new Error("Unsupported current mouse tracking mode");
  if (mouse) vt += `\u001b[?${mouse}h`;
  return vt;
}

function finalPrint(
  terminal: Terminal,
  active: PrivateBufferState,
  buffer: Terminal["buffer"]["normal"],
): string {
  const line = buffer.getLine(active.ybase + active.y);
  if (!line) throw new Error("Logical-grid final print line is not retained");
  let x = Math.min(active.x, terminal.cols) - 1;
  if (x < 0) throw new Error("Logical-grid final print lacks a proved left cell");
  if (
    !terminal.modes.wraparoundMode &&
    active.x === terminal.cols - 1 &&
    !line.getCell(x)?.getChars() &&
    !line.getCell(x + 1)?.getChars()
  )
    x++;
  while (x > 0 && line.getCell(x)?.getWidth() === 0) x--;
  const cell = line.getCell(x);
  if (!cell) throw new Error("Logical-grid final print cell is absent");
  const rejectedWide =
    !cell.getChars() && !terminal.modes.wraparoundMode && x === terminal.cols - 1;
  if (!cell.getChars() && !rejectedWide)
    throw new Error("Logical-grid final print witness is not observable");
  const glyph = rejectedWide ? "中" : cell.getChars();
  const before = terminal.modes.insertMode
    ? `\u001b[${cell.getWidth()}P`
    : rejectedWide
      ? ""
      : `\u001b[${cell.getWidth()}X`;
  const y = terminal.modes.originMode ? active.y - active.scrollTop : active.y;
  if (y < 0 || y >= terminal.rows)
    throw new Error("Logical-grid final print location is outside the visible grid");
  const position = absolutePosition(x, y);
  return position + before + position + glyph;
}

// Current-grid cells are read from the authority; no retained off-grid storage is installed.
export function createLogicalGridCheckpoint(
  terminal: Terminal,
  byteOffset: number,
  maxBytes = BASELINE_CAP,
): LogicalGridCheckpoint {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0)
    throw new Error("Invalid logical-grid byte offset");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > BASELINE_CAP)
    throw new Error("Invalid logical-grid baseline cap");
  if (
    !Number.isSafeInteger(terminal.cols) ||
    !Number.isSafeInteger(terminal.rows) ||
    terminal.cols < 1 ||
    terminal.cols > 120 ||
    terminal.rows < 1 ||
    terminal.rows > 40
  )
    throw new Error("Logical-grid geometry exceeds profile");
  const state = readPrivateRecoveryState(terminal);
  if (state.parserState !== state.initialParserState || state.utf8Interim.some(Boolean))
    throw new Error("Logical-grid checkpoint is not at a parser boundary");
  const started = performance.now();
  const chunks: Uint8Array[] = [];
  let encodedBytes = 0;
  let scannedCells = 0;
  let capturedTextUnits = 0;
  let disposableRows = 0;
  const append = (value: string): void => {
    if (!value) return;
    const chunk = encoder.encode(value);
    if (chunk.length > maxBytes - encodedBytes)
      throw new Error("Logical-grid baseline exceeds byte cap");
    encodedBytes += chunk.length;
    chunks.push(chunk);
  };
  const render = (buffer: Terminal["buffer"]["normal"]): void => {
    if (buffer.getLine(0)?.isWrapped) {
      append("D".repeat(terminal.cols));
      disposableRows++;
    }
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line) throw new Error(`Missing logical-grid ${buffer.type} line ${y}`);
      if (y > 0 && !line.isWrapped) append("\r\n");
      let vt = "";
      let attr: AttributeState | undefined;
      for (let x = 0; x < terminal.cols; x++) {
        if (++scannedCells > CELL_CAP) throw new Error("Logical-grid cell scan exceeds cap");
        const cell = line.getCell(x);
        if (!cell) throw new Error(`Missing logical-grid ${buffer.type} cell ${x},${y}`);
        if (cell.getWidth() === 0) continue;
        const chars = cell.getChars();
        capturedTextUnits += chars.length;
        if (capturedTextUnits > maxBytes) throw new Error("Logical-grid captured text exceeds cap");
        const nextAttr = cellAttr(cell);
        if (!attr || !sameAttr(attr, nextAttr)) {
          vt += sgr(nextAttr);
          attr = nextAttr;
        }
        vt += chars || " ";
      }
      append(vt);
    }
  };
  render(terminal.buffer.normal);
  const activeAlternate = terminal.buffer.active.type === "alternate";
  append(
    savedState(
      state.normal,
      terminal.cols,
      terminal.rows,
      state.currentAttr,
      !activeAlternate && terminal.modes.originMode,
      state.charset,
      !activeAlternate,
      true,
    ),
  );
  append("\u001b[?47h\u001b[H");
  render(terminal.buffer.alternate);
  append(
    savedState(
      state.alternate,
      terminal.cols,
      terminal.rows,
      state.currentAttr,
      activeAlternate && terminal.modes.originMode,
      state.charset,
      activeAlternate,
      true,
    ),
  );
  if (!activeAlternate) {
    append("\u001b[?47l");
    append(
      savedState(
        state.normal,
        terminal.cols,
        terminal.rows,
        state.currentAttr,
        terminal.modes.originMode,
        state.charset,
        true,
        true,
      ),
    );
  }
  append(currentModes(terminal.modes, state.cursorHidden));
  if (state.precedingJoinState !== 0)
    append(
      finalPrint(
        terminal,
        activeAlternate ? state.alternate : state.normal,
        terminal.buffer.active,
      ),
    );
  const vt = new Uint8Array(encodedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    vt.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    vt,
    byteOffset,
    generatedMs: performance.now() - started,
    metrics: {
      scannedCells,
      capturedTextUnits,
      encodedBytes,
      accountedPayloadBytes: encodedBytes * 3 + capturedTextUnits * 2,
      disposableRows,
    },
  };
}
