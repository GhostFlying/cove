import type { Terminal } from "@xterm/headless";
import {
  readPrivateRecoveryState,
  type AttributeState,
  type PrivateBufferState,
  type PrivateRecoveryState,
} from "./xterm-recovery-state.js";

export interface RecoveryCheckpoint {
  readonly vt: Uint8Array;
  readonly byteOffset: number;
  readonly generatedMs: number;
}

interface Serializer {
  serialize(): string;
}

const ALT_MARKER = "\u001b[?1049h\u001b[H";

export function sgr(attr: AttributeState): string {
  const codes = ["0"];
  for (const [name, code] of [
    ["bold", "1"],
    ["dim", "2"],
    ["italic", "3"],
    ["underline", "4"],
    ["blink", "5"],
    ["inverse", "7"],
    ["invisible", "8"],
    ["strikethrough", "9"],
    ["overline", "53"],
  ] as const)
    if (attr[name]) codes.push(code);
  for (const [packed, base] of [
    [attr.fg, 30],
    [attr.bg, 40],
  ] as const) {
    const mode = (packed >>> 24) & 3;
    const color = packed & 0xffffff;
    if (mode === 0) continue;
    if (mode === 1) {
      if (color < 8) codes.push(String(base + color));
      else if (color < 16) codes.push(String(base + 60 + color - 8));
      else throw new Error(`P16 color ${color} is out of range`);
    } else if (mode === 2) {
      codes.push(String(base === 30 ? 38 : 48), "5", String(color));
    } else if (mode === 3) {
      codes.push(
        String(base === 30 ? 38 : 48),
        "2",
        String((color >> 16) & 255),
        String((color >> 8) & 255),
        String(color & 255),
      );
    } else throw new Error(`Unrepresentable SGR color mode ${mode}`);
  }
  return `\u001b[${codes.join(";")}m`;
}

export function absolutePosition(x: number, y: number): string {
  return `\u001b[${y + 1};${x + 1}H`;
}

export function savedState(
  state: PrivateBufferState,
  cols: number,
  rows: number,
  currentAttr: AttributeState,
  restoreOrigin: boolean,
  charset: PrivateRecoveryState["charset"],
  finalActive: boolean,
  allowPendingCurrentX = false,
  preservePriorSave = false,
): string {
  // A saved row evicted from scrollback is restored by stable headless at viewport row zero.
  const savedY = Math.max(0, state.savedY - state.ybase);
  if ((state.x >= cols && !allowPendingCurrentX) || state.savedX >= cols || savedY >= rows)
    throw new Error("VT saved-state candidate cannot address a pending-wrap cursor");
  let vt = "\u001b[?6l";
  vt += `\u001b[${state.scrollTop + 1};${state.scrollBottom + 1}r`;
  vt += "\u001b[3g";
  for (const tab of state.tabs) {
    if (tab >= 0 && tab < cols) vt += `${absolutePosition(tab, 0)}\u001bH`;
  }
  if (!preservePriorSave) {
    vt += absolutePosition(state.savedX, savedY);
    vt += sgr(state.savedAttr);
    vt += `\u001b(${state.savedCharset}\u000f`;
    vt += "\u001b7";
  }
  if (finalActive) {
    vt += `\u001b(${charset.g0}\u001b)${charset.g1}${charset.glevel === 1 ? "\u000e" : "\u000f"}`;
    if (charset.current !== (charset.glevel === 1 ? charset.g1 : charset.g0)) {
      if (charset.current !== state.savedCharset)
        throw new Error("Current charset is not reconstructible from saved or designated map");
      vt += "\u001b8";
    }
  } else vt += "\u001b(B\u001b)B\u000f";
  if (restoreOrigin) {
    if (state.y < state.scrollTop || state.y > state.scrollBottom)
      throw new Error("Origin-mode cursor is outside scroll margins");
    vt += "\u001b[?6h";
    vt += absolutePosition(Math.min(state.x, cols - 1), state.y - state.scrollTop);
  } else vt += absolutePosition(Math.min(state.x, cols - 1), state.y);
  vt += sgr(currentAttr);
  return vt;
}

// Checkpoints are taken only at a verified parser/decoder boundary; an in-flight sequence stays in the raw tail.
function buildRecoveryCheckpoint(
  terminal: Terminal,
  serializer: Serializer,
  byteOffset: number,
  maxBytes: number,
  allowFinalGlyph: boolean,
): RecoveryCheckpoint {
  const state = readPrivateRecoveryState(terminal);
  if (
    state.parserState !== state.initialParserState ||
    state.utf8Interim.some((byte) => byte !== 0) ||
    (!allowFinalGlyph && state.precedingJoinState !== 0)
  )
    throw new Error("Parser or UTF-8 decoder is not at a checkpoint boundary");
  const started = performance.now();
  const stock = serializer.serialize();
  let vt: string;
  if (terminal.buffer.active.type === "alternate") {
    const marker = stock.indexOf(ALT_MARKER);
    if (marker < 0 || stock.indexOf(ALT_MARKER, marker + 1) >= 0)
      throw new Error("Stable serializer alternate-buffer marker changed");
    vt = stock.slice(0, marker);
    vt += savedState(
      state.normal,
      terminal.cols,
      terminal.rows,
      state.currentAttr,
      false,
      state.charset,
      false,
      allowFinalGlyph,
    );
    vt += "\u001b[?47h\u001b[H";
    if (allowFinalGlyph && terminal.buffer.alternate.getLine(0)?.isWrapped)
      vt += "D".repeat(terminal.cols);
    vt += stock.slice(marker + ALT_MARKER.length);
    vt += savedState(
      state.alternate,
      terminal.cols,
      terminal.rows,
      state.currentAttr,
      terminal.modes.originMode,
      state.charset,
      true,
      allowFinalGlyph,
    );
  } else {
    vt =
      stock +
      savedState(
        state.normal,
        terminal.cols,
        terminal.rows,
        state.currentAttr,
        terminal.modes.originMode,
        state.charset,
        true,
        allowFinalGlyph,
      );
  }
  if (state.cursorHidden) vt += "\u001b[?25l";
  if (terminal.modes.synchronizedOutputMode) vt += "\u001b[?2026h";
  const bytes = new TextEncoder().encode(vt);
  if (bytes.byteLength > maxBytes) throw new Error("Recovery checkpoint VT exceeds byte cap");
  return { vt: bytes, byteOffset, generatedMs: performance.now() - started };
}

export function createRecoveryCheckpoint(
  terminal: Terminal,
  serializer: Serializer,
  byteOffset: number,
  maxBytes = 8 * 1024 * 1024,
): RecoveryCheckpoint {
  return buildRecoveryCheckpoint(terminal, serializer, byteOffset, maxBytes, false);
}

export interface FinalGlyphWitness {
  readonly bytes: Uint8Array;
  readonly startX: number;
  readonly startY: number;
  readonly cellWidth: 1 | 2;
  readonly preimage: "erase" | "delete" | "none";
}

// An authored, bounded preimage experiment; the witness location is not inferred from arbitrary output.
export function createFinalGlyphCheckpoint(
  terminal: Terminal,
  serializer: Serializer,
  byteOffset: number,
  witness: FinalGlyphWitness,
  maxBytes = 8 * 1024 * 1024,
): RecoveryCheckpoint {
  if (witness.bytes.length === 0 || witness.bytes.length > 64)
    throw new Error("Final glyph witness exceeds bounded size");
  const rendered = new TextDecoder("utf-8", { fatal: true }).decode(witness.bytes);
  if ([...rendered].some((character) => character.codePointAt(0)! < 0x20 || character === "\u007f"))
    throw new Error("Final glyph witness contains control data");
  if (
    !Number.isInteger(witness.startX) ||
    !Number.isInteger(witness.startY) ||
    witness.startX < 0 ||
    witness.startX >= terminal.cols ||
    witness.startY < 0 ||
    witness.startY >= terminal.rows
  )
    throw new Error("Final glyph witness position is outside the logical grid");
  const state = readPrivateRecoveryState(terminal);
  const base = buildRecoveryCheckpoint(terminal, serializer, byteOffset, maxBytes, true);
  if (state.precedingJoinState === 0)
    throw new Error("Final glyph witness has no join state to rebuild");
  let addressY = witness.startY;
  if (terminal.modes.originMode) {
    const active = terminal.buffer.active.type === "alternate" ? state.alternate : state.normal;
    addressY -= active.scrollTop;
    if (addressY < 0) throw new Error("Final glyph witness is outside origin margins");
  }
  const position = absolutePosition(witness.startX, addressY);
  const preimage =
    witness.preimage === "erase"
      ? `\u001b[${witness.cellWidth}X`
      : witness.preimage === "delete"
        ? `\u001b[${witness.cellWidth}P`
        : "";
  const prefix = new TextEncoder().encode(`${position}${preimage}${position}`);
  const leadingContext = terminal.buffer.normal.getLine(0)?.isWrapped
    ? new TextEncoder().encode("D".repeat(terminal.cols))
    : new Uint8Array();
  const bytes = new Uint8Array(
    leadingContext.length + base.vt.length + prefix.length + witness.bytes.length,
  );
  bytes.set(leadingContext);
  bytes.set(base.vt, leadingContext.length);
  bytes.set(prefix, leadingContext.length + base.vt.length);
  bytes.set(witness.bytes, leadingContext.length + base.vt.length + prefix.length);
  if (bytes.length > maxBytes) throw new Error("Final glyph checkpoint VT exceeds byte cap");
  return { vt: bytes, byteOffset, generatedMs: base.generatedMs };
}

export class BoundedRecoveryTail {
  readonly cap: number;
  #buffer: Uint8Array | null = null;
  #length = 0;
  #available = true;

  constructor(cap = 64 * 1024) {
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 64 * 1024)
      throw new Error("Recovery tail cap must be between 1 and 65536 bytes");
    this.cap = cap;
  }

  append(bytes: Uint8Array): void {
    if (!this.#available) return;
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > this.cap - this.#length) {
      this.#buffer = null;
      this.#length = 0;
      this.#available = false;
      return;
    }
    this.#buffer ??= new Uint8Array(this.cap);
    this.#buffer.set(bytes, this.#length);
    this.#length += bytes.byteLength;
  }

  get available(): boolean {
    return this.#available;
  }
  get retainedBytes(): number {
    return this.#length;
  }
  get allocatedBytes(): number {
    return this.#buffer?.byteLength ?? 0;
  }

  snapshot(): Uint8Array {
    if (!this.#available) throw new Error("Recovery unavailable: raw tail exceeded cap");
    return this.#buffer?.slice(0, this.#length) ?? new Uint8Array();
  }

  resetAfterProvedCheckpoint(): void {
    this.#buffer = null;
    this.#length = 0;
    this.#available = true;
  }
}
