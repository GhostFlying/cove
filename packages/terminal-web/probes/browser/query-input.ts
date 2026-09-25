import { Terminal } from "@xterm/xterm";
import { attachQueryInputAdapter, type QueryAdapterObservation } from "./query-input-adapter.js";

declare const __COVE_BUNDLED_XTERM_VERSION__: string;

type Phase = "live" | "baseline" | "replay" | "continued";
type Entry = { kind: string; bytes?: number[]; phase: Phase; occurrence: number; detail?: string };

interface QueryFixture {
  ready: boolean;
  entries: Entry[];
  outbound: number[][];
  writeDone: number[];
  deliver(bytes: number[], phase: Phase, occurrence: number): Promise<void>;
  releaseBarrier(): void;
  readCell(column: number, row: number): string;
  conformance(): {
    duplicateRejected: boolean;
    wrongVersionRejected: boolean;
    missingSurfaceRejected: boolean;
    oldWrapperDetached: boolean;
    nestedBytes: string[];
  };
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
  theme: { foreground: "#c0c0c0", background: "#101010", red: "#010203" },
});
const entries: Entry[] = [];
const outbound: number[][] = [];
const writeDone: number[] = [];
let phase: Phase = "live";
let occurrence = 0;
const pendingWrites: { phase: Phase; occurrence: number }[] = [];
let barrierRelease: (() => void) | undefined;
let disposed = false;
const subscriptions: { dispose(): void }[] = [];
let retainedBytes = 0;
const record = (entry: Entry) => {
  if (entries.length >= 4096) throw new Error("Query observation limit exceeded");
  retainedBytes += entry.bytes?.length ?? 0;
  if (retainedBytes > 65_536) throw new Error("Query observation bytes exceed 64 KiB");
  entries.push(entry);
};
const observe = (value: QueryAdapterObservation) => record({ ...value, phase, occurrence });
const adapted = params.get("adapter") === "private";
const publicAttempt = params.get("adapter") === "public";
const adapter = adapted
  ? attachQueryInputAdapter(
      terminal,
      params.get("version") ?? __COVE_BUNDLED_XTERM_VERSION__,
      observe,
    )
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
    if (outbound.reduce((sum, item) => sum + item.length, 0) + bytes.length > 65_536)
      throw new Error("Query outbound bytes exceed 64 KiB");
    outbound.push(bytes);
    record({ kind: "onData", bytes, phase, occurrence });
  }),
);
subscriptions.push(
  terminal.onBinary((data) => {
    const bytes = Array.from(data, (character) => character.charCodeAt(0));
    if (outbound.reduce((sum, item) => sum + item.length, 0) + bytes.length > 65_536)
      throw new Error("Query outbound bytes exceed 64 KiB");
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
    if (bytes.length > 65_536) return Promise.reject(new Error("Query write exceeds 64 KiB"));
    pendingWrites.push({ phase: nextPhase, occurrence: nextOccurrence });
    if (pendingWrites.length === 1) {
      phase = nextPhase;
      occurrence = nextOccurrence;
    }
    return new Promise<void>((resolve, reject) => {
      try {
        terminal.write(Uint8Array.from(bytes), () => {
          if (pendingWrites[0]?.occurrence !== nextOccurrence)
            throw new Error("xterm write callbacks changed order");
          writeDone.push(nextOccurrence);
          record({ kind: "write-done", phase: nextPhase, occurrence: nextOccurrence });
          pendingWrites.shift();
          const next = pendingWrites[0];
          if (next) {
            phase = next.phase;
            occurrence = next.occurrence;
          }
          resolve();
        });
      } catch (error) {
        pendingWrites.pop();
        reject(error);
      }
    });
  },
  releaseBarrier() {
    if (!barrierRelease) throw new Error("No held parser barrier");
    barrierRelease();
  },
  readCell(column, row) {
    return terminal.buffer.active.getLine(row)?.getCell(column)?.getChars() ?? "";
  },
  conformance() {
    const specimen = new Terminal({ cols: 2, rows: 2 });
    const nestedBytes: string[] = [];
    const sink = specimen.onData((data) => {
      nestedBytes.push(data);
      if (data === "x") specimen.input("y", true);
    });
    const specimenCore = (
      specimen as unknown as {
        _core: { coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void } };
      }
    )._core.coreService;
    const original = specimenCore.triggerDataEvent;
    const attached = attachQueryInputAdapter(specimen, "6.0.0", () => {});
    const oldWrapper = specimenCore.triggerDataEvent;
    let duplicateRejected = false;
    let wrongVersionRejected = false;
    let missingSurfaceRejected = false;
    try {
      try {
        attachQueryInputAdapter(specimen, "6.0.0", () => {});
      } catch {
        duplicateRejected = true;
      }
      const wrongVersion = new Terminal();
      try {
        attachQueryInputAdapter(wrongVersion, "0.0.0", () => {});
      } catch {
        wrongVersionRejected = true;
      } finally {
        wrongVersion.dispose();
      }
      try {
        attachQueryInputAdapter(
          { _core: { coreService: { triggerDataEvent() {} } } } as unknown as Terminal,
          "6.0.0",
          () => {},
        );
      } catch {
        missingSurfaceRejected = true;
      }
      specimen.input("x", true);
    } finally {
      attached.dispose();
    }
    const restored = specimenCore.triggerDataEvent === original;
    oldWrapper.call(specimenCore, "stale", true);
    const next = attachQueryInputAdapter(specimen, "6.0.0", () => {});
    specimen.input("z", true);
    next.dispose();
    sink.dispose();
    specimen.dispose();
    return {
      duplicateRejected,
      wrongVersionRejected,
      missingSurfaceRejected,
      oldWrapperDetached: restored && nestedBytes.join("") === "xyz",
      nestedBytes,
    };
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
