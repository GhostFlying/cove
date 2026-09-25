import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Terminal } from "@xterm/headless";

const require = createRequire(import.meta.url);
const PINNED = {
  headless: "17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed",
  serialize: "65d8dd7c2b3b37a77f583ea5e0d14a23bbcc846e4ae0d6bb534ae12a380aea0d",
};

export interface PrivateBufferState {
  readonly x: number;
  readonly y: number;
  readonly ybase: number;
  readonly savedX: number;
  readonly savedY: number;
  readonly savedFg: number;
  readonly savedBg: number;
  readonly scrollTop: number;
  readonly scrollBottom: number;
  readonly tabs: readonly number[];
}

export interface PrivateRecoveryState {
  readonly parserState: number;
  readonly initialParserState: number;
  readonly utf8Interim: readonly number[];
  readonly precedingJoinState: number;
  readonly currentFg: number;
  readonly currentBg: number;
  readonly cursorHidden: boolean;
  readonly normal: PrivateBufferState;
  readonly alternate: PrivateBufferState;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(`Missing ${label}`);
  return value as Record<string, unknown>;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function attr(value: unknown, label: string): { fg: number; bg: number } {
  const data = object(value, label);
  return { fg: number(data.fg, `${label}.fg`), bg: number(data.bg, `${label}.bg`) };
}

function buffer(value: unknown, label: string): PrivateBufferState {
  const data = object(value, label);
  const saved = attr(data.savedCurAttrData, `${label}.savedCurAttrData`);
  const tabs = object(data.tabs, `${label}.tabs`);
  return {
    x: number(data.x, `${label}.x`),
    y: number(data.y, `${label}.y`),
    ybase: number(data.ybase, `${label}.ybase`),
    savedX: number(data.savedX, `${label}.savedX`),
    savedY: number(data.savedY, `${label}.savedY`),
    savedFg: saved.fg,
    savedBg: saved.bg,
    scrollTop: number(data.scrollTop, `${label}.scrollTop`),
    scrollBottom: number(data.scrollBottom, `${label}.scrollBottom`),
    tabs: Object.keys(tabs)
      .filter((key) => tabs[key] === true)
      .map(Number)
      .sort((a, b) => a - b),
  };
}

export function assertPinnedRecoveryPackages(): void {
  const packages = [
    { name: "@xterm/headless", version: "6.0.0", sha256: PINNED.headless },
    { name: "@xterm/addon-serialize", version: "0.14.0", sha256: PINNED.serialize },
  ];
  for (const item of packages) {
    const manifestPath = require.resolve(`${item.name}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version?: string;
      main?: string;
    };
    if (manifest.version !== item.version || !manifest.main)
      throw new Error(`${item.name} version or entry changed`);
    const entryPath = require.resolve(item.name);
    const actual = createHash("sha256").update(readFileSync(entryPath)).digest("hex");
    if (actual !== item.sha256) throw new Error(`${item.name} entry hash changed`);
  }
}

// A read-only, version-pinned surface. No private value is ever installed in another terminal.
export function readPrivateRecoveryState(terminal: Terminal): PrivateRecoveryState {
  const core = object((terminal as unknown as Record<string, unknown>)._core, "core");
  const handler = object(core._inputHandler, "input handler");
  const parser = object(handler._parser, "parser");
  const decoder = object(handler._utf8Decoder, "UTF-8 decoder");
  const interim = decoder.interim;
  if (!(interim instanceof Uint8Array) || interim.length !== 3)
    throw new Error("UTF-8 decoder shape changed");
  const service = object(core._bufferService, "buffer service");
  const buffers = object(service.buffers, "buffers");
  const current = attr(handler._curAttrData, "current attributes");
  const coreService = object(core.coreService, "core service");
  if (typeof coreService.isCursorHidden !== "boolean")
    throw new Error("Cursor visibility shape changed");
  return {
    parserState: number(parser.currentState, "parser state"),
    initialParserState: number(parser.initialState, "initial parser state"),
    utf8Interim: [...interim],
    precedingJoinState: number(parser.precedingJoinState, "preceding join state"),
    currentFg: current.fg,
    currentBg: current.bg,
    cursorHidden: coreService.isCursorHidden,
    normal: buffer(buffers.normal, "normal buffer"),
    alternate: buffer(buffers.alt, "alternate buffer"),
  };
}
