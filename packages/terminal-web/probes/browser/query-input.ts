import { Terminal } from "@xterm/xterm";
import { attachQueryInputAdapter, type QueryAdapterObservation } from "./query-input-adapter.js";

type Phase = "live" | "baseline" | "replay" | "continued";
type Entry = { kind: string; bytes?: number[]; phase: Phase; occurrence: number; detail?: string };

interface QueryFixture {
  ready: boolean;
  entries: Entry[];
  outbound: number[][];
  writeDone: number[];
  deliver(bytes: number[], phase: Phase, occurrence: number): Promise<void>;
  releaseBarrier(): void;
  snapshot(): {
    line: string;
    cursorX: number;
    cursorY: number;
    bracketedPaste: boolean;
    applicationCursor: boolean;
    foreground: number[];
    background: number[];
    palette1: number[];
  };
  dispose(): void;
}

declare global {
  interface Window {
    coveQuery?: QueryFixture;
  }
}

const params = new URLSearchParams(location.search);
const mount = document.getElementById("terminal");
if (!mount) throw new Error("Terminal mount is absent");
const terminal = new Terminal({
  cols: Number(params.get("cols") ?? 40),
  rows: 10,
  windowOptions: { getWinSizeChars: true },
  theme: { foreground: "#c0c0c0", background: "#101010" },
});
const entries: Entry[] = [];
const outbound: number[][] = [];
const writeDone: number[] = [];
let phase: Phase = "live";
let occurrence = 0;
let barrierRelease: (() => void) | undefined;
let disposed = false;
const subscriptions: { dispose(): void }[] = [];
const record = (entry: Entry) => {
  if (entries.length >= 4096) throw new Error("Query observation limit exceeded");
  entries.push(entry);
};
const observe = (value: QueryAdapterObservation) => record({ ...value, phase, occurrence });
const adapted = params.get("adapter") === "private";
const publicAttempt = params.get("adapter") === "public";
const adapter = adapted
  ? attachQueryInputAdapter(terminal, params.get("version") ?? "6.0.0", observe)
  : undefined;

const csiIds = [
  { final: "n" },
  { prefix: "?", final: "n" },
  { final: "c" },
  { prefix: ">", final: "c" },
  { intermediates: "$", final: "p" },
  { prefix: "?", intermediates: "$", final: "p" },
  { final: "t" },
] as const;
for (const id of csiIds)
  subscriptions.push(
    terminal.parser.registerCsiHandler(id, (values) => {
      record({
        kind: "query-hook",
        phase,
        occurrence,
        detail: `CSI ${JSON.stringify(id)} ${JSON.stringify(values)}`,
      });
      return false;
    }),
  );
subscriptions.push(
  terminal.parser.registerDcsHandler({ intermediates: "$", final: "q" }, (data) => {
    record({ kind: "query-hook", phase, occurrence, detail: `DCS $q ${data}` });
    return false;
  }),
);
for (const ident of [4, 10, 11, 12])
  subscriptions.push(
    terminal.parser.registerOscHandler(ident, (data) => {
      record({ kind: "query-hook", phase, occurrence, detail: `OSC ${ident};${data}` });
      // This public-only attempt demonstrates that consuming a mixed setter/query loses its setter.
      return publicAttempt && data.includes("?");
    }),
  );
subscriptions.push(
  terminal.parser.registerOscHandler(777, (data) => {
    if (data !== "hold") return false;
    record({ kind: "barrier-enter", phase, occurrence });
    return new Promise<boolean>((resolve) => {
      barrierRelease = () => {
        barrierRelease = undefined;
        resolve(true);
      };
    });
  }),
);
subscriptions.push(
  terminal.onData((data) => {
    const bytes = Array.from(new TextEncoder().encode(data));
    outbound.push(bytes);
    record({ kind: "onData", bytes, phase, occurrence });
  }),
);
subscriptions.push(
  terminal.onBinary((data) => {
    const bytes = Array.from(data, (character) => character.charCodeAt(0));
    outbound.push(bytes);
    record({ kind: "onBinary", bytes, phase, occurrence });
  }),
);

terminal.open(mount);
const colors = () => {
  const privateCore = terminal as unknown as {
    _core?: {
      _themeService?: {
        colors?: {
          foreground: { rgba: number };
          background: { rgba: number };
          ansi: { rgba: number }[];
        };
      };
    };
  };
  const state = privateCore._core?._themeService?.colors;
  if (!state) throw new Error("xterm theme state is unavailable");
  const rgb = (rgba: number) => [(rgba >>> 24) & 255, (rgba >>> 16) & 255, (rgba >>> 8) & 255];
  return {
    foreground: rgb(state.foreground.rgba),
    background: rgb(state.background.rgba),
    palette1: rgb(state.ansi[1]!.rgba),
  };
};
const fixture: QueryFixture = {
  ready: true,
  entries,
  outbound,
  writeDone,
  deliver(bytes, nextPhase, nextOccurrence) {
    if (disposed) return Promise.reject(new Error("Disposed query fixture"));
    phase = nextPhase;
    occurrence = nextOccurrence;
    return new Promise<void>((resolve, reject) => {
      try {
        terminal.write(Uint8Array.from(bytes), () => {
          writeDone.push(nextOccurrence);
          record({ kind: "write-done", phase: nextPhase, occurrence: nextOccurrence });
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  },
  releaseBarrier() {
    if (!barrierRelease) throw new Error("No held parser barrier");
    barrierRelease();
  },
  snapshot() {
    const line =
      terminal.buffer.active.getLine(terminal.buffer.active.cursorY)?.translateToString(true) ?? "";
    return {
      line,
      cursorX: terminal.buffer.active.cursorX,
      cursorY: terminal.buffer.active.cursorY,
      bracketedPaste: terminal.modes.bracketedPasteMode,
      applicationCursor: terminal.modes.applicationCursorKeysMode,
      ...colors(),
    };
  },
  dispose() {
    if (disposed) return;
    disposed = true;
    barrierRelease?.();
    for (const subscription of subscriptions.reverse()) subscription.dispose();
    adapter?.dispose();
    terminal.dispose();
  },
};
window.coveQuery = fixture;
window.addEventListener("pagehide", () => fixture.dispose(), { once: true });
