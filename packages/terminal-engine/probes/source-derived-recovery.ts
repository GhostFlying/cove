import type { Terminal } from "@xterm/headless";
import { absolutePosition, savedState, sgr } from "./recovery-checkpoint.js";
import {
  readPrivateRecoveryState,
  type AttributeState,
  type PrivateBufferState,
} from "./xterm-recovery-state.js";

export type RecoveryInstallOperation =
  | { readonly kind: "write"; readonly bytes: Uint8Array }
  | { readonly kind: "resize"; readonly cols: number; readonly rows: number };

export interface SourceDerivedRecovery {
  readonly initialCols: number;
  readonly rows: number;
  readonly operations: readonly RecoveryInstallOperation[];
  readonly metrics: {
    readonly scannedCells: number;
    readonly capturedTextUnits: number;
    readonly encodedBytes: number;
    readonly accountedPayloadBytes: number;
    readonly geometryOperations: number;
    readonly temporaryCols: number;
    readonly disposableRows: number;
  };
}

export interface SourceDerivedLimits {
  readonly maxBaselineBytes?: number;
  readonly maxScannedCells?: number;
  readonly maxGeometryOperations?: number;
  readonly maxCols?: number;
  readonly maxRows?: number;
}

interface CapturedCell {
  readonly chars: string;
  readonly width: number;
  readonly attr: AttributeState;
}

interface CapturedLine {
  readonly wrapped: boolean;
  readonly cells: readonly CapturedCell[];
}

interface CapturedBuffer {
  readonly lines: readonly CapturedLine[];
  readonly cursorX: number;
  readonly cursorY: number;
  readonly baseY: number;
}

const encoder = new TextEncoder();
const DEFAULT_BASELINE_CAP = 8 * 1024 * 1024;
const DEFAULT_CELL_CAP = 2 * 120 * 1040;
const DEFAULT_OPERATION_CAP = 1040 * 2 + 3;

function admittedLimit(value: number | undefined, name: string, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
    throw new Error(`Invalid source-derived ${name} limit`);
  return value;
}

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

function captureBuffer(
  buffer: Terminal["buffer"]["normal"],
  count: { cells: number; textUnits: number },
  cellCap: number,
  textCap: number,
): CapturedBuffer {
  const lines: CapturedLine[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) throw new Error(`Missing retained ${buffer.type} line ${y}`);
    const cells: CapturedCell[] = [];
    for (let x = 0; x < line.length; x++) {
      if (++count.cells > cellCap) throw new Error("Source-derived cell scan exceeds cap");
      const cell = line.getCell(x);
      if (!cell) throw new Error(`Missing retained ${buffer.type} cell ${x},${y}`);
      const chars = cell.getChars();
      count.textUnits += chars.length;
      if (count.textUnits > textCap) throw new Error("Source-derived captured text exceeds cap");
      cells.push({ chars, width: cell.getWidth(), attr: cellAttr(cell) });
    }
    lines.push({ wrapped: line.isWrapped, cells });
  }
  return {
    lines,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    baseY: buffer.baseY,
  };
}

function sameAttr(left: AttributeState, right: AttributeState): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof AttributeState] === right[key as keyof AttributeState],
  );
}

function paint(cells: readonly CapturedCell[], includeTrailingNull: boolean): string {
  let end = cells.length;
  if (!includeTrailingNull) {
    while (end > 0 && !cells[end - 1]!.chars && cells[end - 1]!.width !== 0) end--;
  }
  let output = "";
  let attr: AttributeState | undefined;
  let empty = 0;
  for (let x = 0; x < end; x++) {
    const cell = cells[x]!;
    if (cell.width === 0) continue;
    if (!cell.chars) {
      empty++;
      continue;
    }
    if (empty) {
      output += `\u001b[${empty}C`;
      empty = 0;
    }
    if (!attr || !sameAttr(attr, cell.attr)) {
      output += sgr(cell.attr);
      attr = cell.attr;
    }
    output += cell.chars;
  }
  if (empty) output += `\u001b[${empty}C`;
  return output;
}

// Repack each retained soft-wrap run at the receiver's temporary width.
function normalPreimage(
  buffer: CapturedBuffer,
  temporaryCols: number,
): { vt: string; disposable: number } {
  let vt = "";
  let disposable = 0;
  if (buffer.lines[0]?.wrapped) {
    vt += "D".repeat(temporaryCols);
    disposable = 1;
  }
  for (let y = 0; y < buffer.lines.length; y++) {
    const line = buffer.lines[y]!;
    if (y > 0 && !line.wrapped) vt += "\r\n";
    const nextWrapped = buffer.lines[y + 1]?.wrapped ?? false;
    vt += paint(line.cells, nextWrapped);
  }
  return { vt, disposable };
}

function alternatePreimage(buffer: CapturedBuffer): string {
  let vt = "";
  for (let y = 0; y < buffer.lines.length; y++) {
    const line = buffer.lines[y]!;
    for (let x = 0; x < line.cells.length;) {
      while (x < line.cells.length && !line.cells[x]!.chars) x++;
      if (x >= line.cells.length) break;
      const start = x;
      while (x < line.cells.length && (line.cells[x]!.chars || line.cells[x]!.width === 0)) x++;
      vt += absolutePosition(start, y) + paint(line.cells.slice(start, x), true);
    }
  }
  return vt;
}

function finalPosition(state: PrivateBufferState, originMode: boolean, cols: number): string {
  const x = Math.min(state.x, cols - 1);
  const y = originMode ? state.y - state.scrollTop : state.y;
  if (y < 0) throw new Error("Source-derived cursor is outside origin margins");
  return absolutePosition(x, y);
}

function finalWitness(
  buffer: CapturedBuffer,
  cursor: PrivateBufferState,
  terminal: Terminal,
): string {
  const visibleY = cursor.ybase + cursor.y;
  const line = buffer.lines[visibleY];
  if (!line) throw new Error("Source-derived final print has no retained cursor line");
  let x = Math.min(cursor.x, terminal.cols) - 1;
  if (
    !terminal.modes.wraparoundMode &&
    cursor.x === terminal.cols - 1 &&
    !line.cells[x]?.chars &&
    !line.cells[x + 1]?.chars
  )
    x++;
  if (x < 0) throw new Error("Source-derived final print lacks a proved left cell");
  while (x > 0 && line.cells[x]?.width === 0) x--;
  const cell = line.cells[x];
  if (!cell) throw new Error("Source-derived final print cell is absent");
  const rejectedWide = !cell.chars && !terminal.modes.wraparoundMode && x === terminal.cols - 1;
  if (!cell.chars && !rejectedWide)
    throw new Error("Source-derived final print witness is not observable at the cursor");
  const glyph = rejectedWide ? "中" : cell.chars;
  const before = terminal.modes.insertMode
    ? `\u001b[${cell.width}P`
    : rejectedWide
      ? ""
      : `\u001b[${cell.width}X`;
  const y = terminal.modes.originMode
    ? visibleY - buffer.baseY - cursor.scrollTop
    : visibleY - buffer.baseY;
  if (y < 0 || y >= terminal.rows)
    throw new Error("Source-derived final print location is outside the visible grid");
  const position = absolutePosition(x, y);
  return position + before + position + glyph;
}

// The output is a deterministic installation schedule. This function does not create or inspect a receiver.
export function createSourceDerivedRecovery(
  terminal: Terminal,
  limits: SourceDerivedLimits = {},
): SourceDerivedRecovery {
  const maxCols = admittedLimit(limits.maxCols, "maxCols", 120);
  const maxRows = admittedLimit(limits.maxRows, "maxRows", 40);
  const maxBaselineBytes = admittedLimit(
    limits.maxBaselineBytes,
    "maxBaselineBytes",
    DEFAULT_BASELINE_CAP,
  );
  const maxScannedCells = admittedLimit(
    limits.maxScannedCells,
    "maxScannedCells",
    DEFAULT_CELL_CAP,
  );
  const maxGeometryOperations = admittedLimit(
    limits.maxGeometryOperations,
    "maxGeometryOperations",
    DEFAULT_OPERATION_CAP,
  );
  const cols = terminal.cols;
  const rows = terminal.rows;
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    cols < 1 ||
    cols > maxCols ||
    rows < 1 ||
    rows > maxRows
  )
    throw new Error("Source-derived logical geometry exceeds profile");
  const state = readPrivateRecoveryState(terminal);
  if (state.parserState !== state.initialParserState || state.utf8Interim.some(Boolean))
    throw new Error("Source-derived checkpoint is not at a parser boundary");
  const count = { cells: 0, textUnits: 0 };
  const normal = captureBuffer(terminal.buffer.normal, count, maxScannedCells, maxBaselineBytes);
  const alternate = captureBuffer(
    terminal.buffer.alternate,
    count,
    maxScannedCells,
    maxBaselineBytes,
  );
  const temporaryCols = Math.max(
    cols,
    ...normal.lines.map((line) => line.cells.length),
    ...alternate.lines.map((line) => line.cells.length),
  );
  if (temporaryCols > maxCols) throw new Error("Source-derived retained extent exceeds profile");
  const operations: RecoveryInstallOperation[] = [];
  let encodedBytes = 0;
  let geometryOperations = 0;
  const write = (vt: string): void => {
    if (!vt) return;
    const bytes = encoder.encode(vt);
    if (bytes.length > maxBaselineBytes - encodedBytes)
      throw new Error("Source-derived baseline exceeds byte cap");
    encodedBytes += bytes.length;
    operations.push({ kind: "write", bytes });
  };
  const resize = (width: number): void => {
    if (++geometryOperations > maxGeometryOperations)
      throw new Error("Source-derived geometry operation cap exceeded");
    operations.push({ kind: "resize", cols: width, rows });
  };
  const normalImage = normalPreimage(normal, temporaryCols);
  const earlyNormalSave = state.normal.savedY < state.normal.ybase;
  if (earlyNormalSave) {
    // A saved absolute row older than ybase must be set before replay scrolls it away.
    if (state.normal.savedY >= rows || state.normal.savedX >= temporaryCols)
      throw new Error("Source-derived evicted saved cursor lacks a bounded prehistory position");
    write(
      absolutePosition(state.normal.savedX, state.normal.savedY) +
        sgr(state.normal.savedAttr) +
        `\u001b(${state.normal.savedCharset}\u000f\u001b7\u001b(B\u001b[0m\u001b[H`,
    );
  }
  write(normalImage.vt);
  const activeAlternate = terminal.buffer.active.type === "alternate";
  write(
    savedState(
      state.normal,
      temporaryCols,
      rows,
      state.currentAttr,
      !activeAlternate && terminal.modes.originMode,
      state.charset,
      !activeAlternate,
      true,
      earlyNormalSave,
    ),
  );
  if (activeAlternate) {
    const alternateImage = alternate.lines[0]?.wrapped
      ? normalPreimage(alternate, temporaryCols)
      : { vt: alternatePreimage(alternate), disposable: 0 };
    write("\u001b[?47h\u001b[H" + alternateImage.vt);
    write(
      savedState(
        state.alternate,
        temporaryCols,
        rows,
        state.currentAttr,
        terminal.modes.originMode,
        state.charset,
        true,
        true,
      ),
    );
  } else if (alternate.lines.some((line) => line.cells.some((cell) => cell.chars))) {
    throw new Error("Source-derived hidden alternate reconstruction has no proved switch rule");
  }
  if (temporaryCols !== cols) resize(cols);
  if (activeAlternate) {
    const shortRows = alternate.lines.flatMap((line, index) =>
      line.cells.length < temporaryCols ? [index] : [],
    );
    for (const row of shortRows.reverse()) {
      write(absolutePosition(0, row) + "\u001b[M\u001b[L" + absolutePosition(0, row));
      geometryOperations += 2;
      if (geometryOperations > maxGeometryOperations)
        throw new Error("Source-derived geometry operation cap exceeded");
      write(
        alternatePreimage({
          ...alternate,
          lines: alternate.lines.map((line, index) =>
            index === row ? line : { ...line, cells: [] },
          ),
        }),
      );
    }
  }
  const activeState = activeAlternate ? state.alternate : state.normal;
  write(finalPosition(activeState, terminal.modes.originMode, cols));
  if (terminal.modes.insertMode) write("\u001b[4h");
  if (!terminal.modes.wraparoundMode) write("\u001b[?7l");
  if (state.cursorHidden) write("\u001b[?25l");
  if (terminal.modes.synchronizedOutputMode) write("\u001b[?2026h");
  if (state.precedingJoinState !== 0)
    write(finalWitness(activeAlternate ? alternate : normal, activeState, terminal));
  return {
    initialCols: temporaryCols,
    rows,
    operations,
    metrics: {
      scannedCells: count.cells,
      capturedTextUnits: count.textUnits,
      encodedBytes,
      accountedPayloadBytes: encodedBytes * 3 + count.textUnits * 2,
      geometryOperations,
      temporaryCols,
      disposableRows:
        normalImage.disposable + (activeAlternate && alternate.lines[0]?.wrapped ? 1 : 0),
    },
  };
}
