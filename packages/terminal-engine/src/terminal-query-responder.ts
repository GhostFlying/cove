import type { Terminal } from "@xterm/headless";
import { DEFAULT_APPEARANCE, validateAppearance, type Appearance } from "@cove/protocol/profile";

const encoder = new TextEncoder();
type ReplyKind = "query" | "focus";

function normalizeColor(input: string): string | null {
  if (/^#[0-9a-fA-F]{3}$/.test(input))
    return [...input.slice(1)].map((part) => part.repeat(4).toLowerCase()).join("/");
  if (/^#[0-9a-fA-F]{6}$/.test(input))
    return input
      .slice(1)
      .match(/../g)!
      .map((part) => part.repeat(2).toLowerCase())
      .join("/");
  if (/^rgb:(?:[0-9a-fA-F]{1,4}\/){2}[0-9a-fA-F]{1,4}$/.test(input))
    return input
      .slice(4)
      .split("/")
      .map((part) => part.repeat(4).slice(0, 4).toLowerCase())
      .join("/");
  return null;
}

function setter(id: number, value: string): string {
  return `\u001b]${id};rgb:${value}\u001b\\`;
}

// The live parser owns OSC order; recovery and preview only read this bounded state.
export class TerminalQueryResponder {
  #pushed: Appearance = DEFAULT_APPEARANCE;
  #foreground: string | undefined;
  #background: string | undefined;
  #palette = new Map<number, string>();
  #epoch = 0;
  #listeners: { dispose(): void }[];
  #emit: (kind: ReplyKind, bytes: Uint8Array) => void;

  constructor(
    terminal: Terminal,
    appearance: Appearance,
    emit: (kind: ReplyKind, bytes: Uint8Array) => void,
  ) {
    this.#emit = emit;
    this.setAppearance(appearance);
    this.#listeners = [
      terminal.onData((data) => this.#emit("query", encoder.encode(data))),
      terminal.parser.registerOscHandler(10, (data) => this.#simpleColor(10, data)),
      terminal.parser.registerOscHandler(11, (data) => this.#simpleColor(11, data)),
      terminal.parser.registerOscHandler(4, (data) => this.#paletteColor(data)),
      terminal.parser.registerOscHandler(110, () => this.#resetSimple(10)),
      terminal.parser.registerOscHandler(111, () => this.#resetSimple(11)),
      terminal.parser.registerOscHandler(104, (data) => this.#resetPalette(data)),
    ];
  }

  get appearance(): Appearance {
    return {
      ...(this.#foreground ? { foreground: this.#foreground } : {}),
      ...(this.#background ? { background: this.#background } : {}),
      palette: [...this.#palette].sort(([a], [b]) => a - b).map(([index, rgb]) => ({ index, rgb })),
    };
  }

  get appearanceEpoch(): number {
    return this.#epoch;
  }
  get knownPaletteIndices(): number[] {
    return [...this.#palette.keys()].sort((a, b) => a - b);
  }

  setAppearance(input: Appearance): void {
    const value = validateAppearance(input);
    if (!value) throw new Error("Invalid appearance");
    this.#pushed = {
      ...(value.foreground ? { foreground: value.foreground.toLowerCase() } : {}),
      ...(value.background ? { background: value.background.toLowerCase() } : {}),
      palette: value.palette.map(({ index, rgb }) => ({ index, rgb: rgb.toLowerCase() })),
    };
    this.#foreground = value.foreground?.toLowerCase();
    this.#background = value.background?.toLowerCase();
    this.#palette = new Map(value.palette.map(({ index, rgb }) => [index, rgb.toLowerCase()]));
    this.#epoch++;
  }

  checkpointSetters(): Uint8Array {
    let vt = "";
    if (this.#foreground) vt += setter(10, this.#foreground);
    if (this.#background) vt += setter(11, this.#background);
    for (const [index, rgb] of this.#palette) vt += `\u001b]4;${index};rgb:${rgb}\u001b\\`;
    return encoder.encode(vt);
  }

  emitFocus(present: boolean): void {
    this.#emit("focus", encoder.encode(present ? "\u001b[I" : "\u001b[O"));
  }

  dispose(): void {
    for (const listener of this.#listeners) listener.dispose();
    this.#listeners = [];
  }

  #simpleColor(id: 10 | 11, data: string): boolean {
    const current = id === 10 ? this.#foreground : this.#background;
    if (data === "?") {
      if (current) this.#emit("query", encoder.encode(`\u001b]${id};rgb:${current}\u001b\\`));
      return true;
    }
    const color = normalizeColor(data);
    if (color) {
      if (id === 10) this.#foreground = color;
      else this.#background = color;
      this.#epoch++;
    }
    return true;
  }

  #paletteColor(data: string): boolean {
    const fields = data.split(";");
    if (fields.length % 2 !== 0) return true;
    for (let i = 0; i < fields.length; i += 2) {
      const index = Number(fields[i]);
      if (!Number.isInteger(index) || index < 0 || index > 255) continue;
      const value = fields[i + 1]!;
      if (value === "?") {
        const current = this.#palette.get(index);
        if (current)
          this.#emit("query", encoder.encode(`\u001b]4;${index};rgb:${current}\u001b\\`));
      } else {
        const color = normalizeColor(value);
        if (color) {
          this.#palette.set(index, color);
          this.#epoch++;
        }
      }
    }
    return true;
  }

  #resetSimple(id: 10 | 11): boolean {
    const color = id === 10 ? this.#pushed.foreground : this.#pushed.background;
    if (id === 10) this.#foreground = color;
    else this.#background = color;
    this.#epoch++;
    return true;
  }

  #resetPalette(data: string): boolean {
    const pushed = new Map(this.#pushed.palette.map(({ index, rgb }) => [index, rgb]));
    const indices = data
      ? data.split(";").map(Number)
      : [...new Set([...this.#palette.keys(), ...pushed.keys()])];
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index > 255) continue;
      const color = pushed.get(index);
      if (color) this.#palette.set(index, color);
      else this.#palette.delete(index);
      this.#epoch++;
    }
    return true;
  }
}
