import type { Terminal } from "@xterm/headless";
import { readPrivateRecoveryState, type PrivateBufferState } from "./xterm-recovery-state.js";

export interface RecoveryCheckpoint {
  readonly vt: Uint8Array;
  readonly byteOffset: number;
  readonly generatedMs: number;
}

interface Serializer {
  serialize(): string;
}

const ALT_MARKER = "\u001b[?1049h\u001b[H";

function sgr(fg: number, bg: number): string {
  const codes = ["0"];
  for (const [packed, base] of [
    [fg, 30],
    [bg, 40],
  ] as const) {
    const mode = (packed >>> 24) & 3;
    const color = packed & 0xffffff;
    if (mode === 0) continue;
    if (mode === 1) {
      if (color < 8) codes.push(String(base + color));
      else if (color < 16) codes.push(String(base + 60 + color - 8));
      else codes.push(String(base === 30 ? 38 : 48), "5", String(color));
    } else if (mode === 2) {
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

function absolutePosition(x: number, y: number): string {
  return `\u001b[${y + 1};${x + 1}H`;
}

function savedState(
  state: PrivateBufferState,
  cols: number,
  rows: number,
  currentFg: number,
  currentBg: number,
  restoreOrigin: boolean,
): string {
  const savedY = state.savedY - state.ybase;
  if (state.x >= cols || state.savedX >= cols || savedY < 0 || savedY >= rows)
    throw new Error("VT saved-state candidate cannot address a pending-wrap or evicted cursor");
  let vt = "\u001b[?6l";
  vt += `\u001b[${state.scrollTop + 1};${state.scrollBottom + 1}r`;
  vt += "\u001b[3g";
  for (const tab of state.tabs) {
    if (tab >= 0 && tab < cols) vt += `${absolutePosition(tab, 0)}\u001bH`;
  }
  vt += absolutePosition(state.savedX, savedY);
  vt += sgr(state.savedFg, state.savedBg);
  vt += "\u001b7";
  if (restoreOrigin) {
    if (state.y < state.scrollTop || state.y > state.scrollBottom)
      throw new Error("Origin-mode cursor is outside scroll margins");
    vt += "\u001b[?6h";
    vt += absolutePosition(state.x, state.y - state.scrollTop);
  } else vt += absolutePosition(state.x, state.y);
  vt += sgr(currentFg, currentBg);
  return vt;
}

// Checkpoints are taken only at a verified parser/decoder boundary; an in-flight sequence stays in the raw tail.
export function createRecoveryCheckpoint(
  terminal: Terminal,
  serializer: Serializer,
  byteOffset: number,
  maxBytes = 8 * 1024 * 1024,
): RecoveryCheckpoint {
  const state = readPrivateRecoveryState(terminal);
  if (
    state.parserState !== state.initialParserState ||
    state.utf8Interim.some((byte) => byte !== 0) ||
    state.precedingJoinState !== 0
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
      state.currentFg,
      state.currentBg,
      false,
    );
    vt += "\u001b[?47h\u001b[H";
    vt += stock.slice(marker + ALT_MARKER.length);
    vt += savedState(
      state.alternate,
      terminal.cols,
      terminal.rows,
      state.currentFg,
      state.currentBg,
      terminal.modes.originMode,
    );
  } else {
    vt =
      stock +
      savedState(
        state.normal,
        terminal.cols,
        terminal.rows,
        state.currentFg,
        state.currentBg,
        terminal.modes.originMode,
      );
  }
  if (state.cursorHidden) vt += "\u001b[?25l";
  if (terminal.modes.synchronizedOutputMode) vt += "\u001b[?2026h";
  const bytes = new TextEncoder().encode(vt);
  if (bytes.byteLength > maxBytes) throw new Error("Recovery checkpoint VT exceeds byte cap");
  return { vt: bytes, byteOffset, generatedMs: performance.now() - started };
}

export class BoundedRecoveryTail {
  readonly cap: number;
  #chunks: Uint8Array[] = [];
  #length = 0;
  #available = true;

  constructor(cap = 64 * 1024) {
    this.cap = cap;
  }

  append(bytes: Uint8Array): void {
    if (!this.#available) return;
    if (bytes.byteLength > this.cap - this.#length) {
      this.#chunks = [];
      this.#length = 0;
      this.#available = false;
      return;
    }
    this.#chunks.push(bytes.slice());
    this.#length += bytes.byteLength;
  }

  get available(): boolean {
    return this.#available;
  }
  get retainedBytes(): number {
    return this.#length;
  }

  snapshot(): Uint8Array {
    if (!this.#available) throw new Error("Recovery unavailable: raw tail exceeded cap");
    const tail = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      tail.set(chunk, offset);
      offset += chunk.length;
    }
    return tail;
  }

  resetAfterProvedCheckpoint(): void {
    this.#chunks = [];
    this.#length = 0;
    this.#available = true;
  }
}
