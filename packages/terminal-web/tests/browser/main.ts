import { Terminal } from "@xterm/xterm";
import { createXtermTerminalView } from "@cove/terminal-web/xterm-view";
import { QUERY_SUPPORT, type Appearance, type Geometry } from "@cove/protocol/profile";
import type { BaselineDescriptor, TerminalEvent } from "@cove/protocol/terminal";
import type { DomainError } from "@cove/protocol/errors";
import type { FocusIntent, InputIntent, TerminalView } from "@cove/protocol/view";
// This authored JavaScript fixture is retained from Q1 and deliberately consumed without copying
// it into V1. Its runtime shape is narrowed immediately below.
// @ts-expect-error The historical fixture intentionally has no TypeScript declaration.
import { queryCases as historicalQueryCases } from "../../../../tests/fixtures/terminal/client/query-cases.mjs";

const queryCases = historicalQueryCases as Array<{
  caseId: string;
  setupBytes: number[];
  queryBytes: number[];
  expectedLiveReplies: number[][];
  continuationBytes: number[];
}>;

const encoder = new TextEncoder();
const container = document.querySelector<HTMLElement>("#terminal")!;
const originalTerminalOpen = Terminal.prototype.open;
const captureOpenedTerminal = (terminal: Terminal, element: HTMLElement) => {
  if (element === container) capturedTerminal = terminal;
};
Terminal.prototype.open = function (element: HTMLElement): void {
  captureOpenedTerminal(this, element);
  originalTerminalOpen.call(this, element);
};
const run = { serverId: "server", relayInstanceId: "relay", runId: "run" };
const subscription = {
  run,
  connection: { connectionId: "connection", generation: 1 },
  subscriptionId: "subscription",
  viewId: "view",
};
const appearance: Appearance = {
  foreground: "ffff/ffff/ffff",
  background: "0000/0000/0000",
  palette: [{ index: 1, rgb: "cccc/0000/0000" }],
};

let view: TerminalView | undefined;
let generation = 0;
let inputs: InputIntent[] = [];
let focuses: FocusIntent[] = [];
let failures: DomainError[] = [];
let subscriptions: Array<{ dispose(): void }> = [];
let capturedTerminal: Terminal | undefined;
let currentGeometry: Geometry = { cols: 40, rows: 10 };
let heldRelease: (() => void) | undefined;
let heldOperation: Promise<void> | undefined;
let heldStatus: "idle" | "pending" | "resolved" | "rejected" = "idle";

const ownedBytes = (bytes: Uint8Array) => Array.from(bytes);
const serialInput = (intent: InputIntent) => ({ ...intent, bytes: ownedBytes(intent.bytes) });
const errorMessages = (error: unknown): string[] => {
  if (error instanceof AggregateError) return error.errors.flatMap(errorMessages);
  if (typeof error === "object" && error !== null && "kind" in error)
    return [(error as DomainError).kind];
  return [(error as Error)?.message ?? String(error)];
};

async function initialize(geometry: Geometry = { cols: 40, rows: 10 }): Promise<void> {
  view?.dispose();
  container.replaceChildren();
  view = createXtermTerminalView(container);
  inputs = [];
  focuses = [];
  failures = [];
  subscriptions = [
    view.onInputIntent((intent) => inputs.push({ ...intent, bytes: intent.bytes.slice() })),
    view.onFocusIntent((intent) => focuses.push(structuredClone(intent))),
    view.onFailure((error) => failures.push(structuredClone(error))),
  ];
  generation++;
  currentGeometry = { ...geometry };
  await view.initialize({
    profile: "pragmatic-logical-grid-v1",
    encoding: "vt-checkpoint-tail-v1",
    geometry,
    appearance,
    viewGeneration: generation,
  });
}

function descriptor(bytes: number, chunks = 1, tailBytes = 0): BaselineDescriptor {
  return {
    baselineId: `baseline-${generation}`,
    run,
    subscription,
    profile: "pragmatic-logical-grid-v1",
    encoding: "vt-checkpoint-tail-v1",
    checkpointSeq: 0,
    atSeq: 0,
    captureGeometry: currentGeometry,
    currentGeometry,
    coverage: {
      normal: {
        historyLines: 0,
        includedHistoryLines: 0,
        trimmedBefore: false,
        resizeContext: "complete",
      },
      alternate: { included: true, resizeContext: "complete" },
    },
    vtBytes: bytes - tailBytes,
    tailBytes,
    chunkCount: chunks,
  };
}

async function baseline(chunks: Uint8Array[], tailBytes = 0): Promise<void> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  await view!.beginBaseline(descriptor(total, chunks.length, tailBytes));
  for (const chunk of chunks) await view!.writeBaselineChunk(chunk);
  await view!.finishBaseline();
}

async function ready(initial = encoder.encode("\x1b[2J\x1b[H")): Promise<void> {
  await baseline([initial]);
}

function output(bytes: Uint8Array, seq = 1): Promise<void> {
  return view!.applyEvent({ type: "output", run, seq }, bytes);
}

function rows(): string[] {
  if (!capturedTerminal) return [];
  const buffer = capturedTerminal.buffer.active;
  return Array.from(
    { length: capturedTerminal.rows },
    (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "",
  );
}

function allRows(): string[] {
  if (!capturedTerminal) return [];
  const buffer = capturedTerminal.buffer.active;
  return Array.from(
    { length: buffer.length },
    (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
  );
}

function evidence() {
  return {
    inputs: inputs.map(serialInput),
    focuses: structuredClone(focuses),
    failures: structuredClone(failures),
    rows: rows(),
    allRows: allRows(),
    hidden: capturedTerminal?.element?.hasAttribute("hidden") ?? false,
    ownedRoots: container.querySelectorAll("[data-cove-terminal-view]").length,
    logical: {
      cols: capturedTerminal?.cols,
      rows: capturedTerminal?.rows,
      activeBuffer: capturedTerminal?.buffer.active.type,
      cursorX: capturedTerminal?.buffer.active.cursorX,
      cursorY: capturedTerminal?.buffer.active.cursorY,
      modes: capturedTerminal ? { ...capturedTerminal.modes } : undefined,
    },
    measurement: view?.measureGrid(),
  };
}

const fixture = {
  async reset(geometry?: Geometry) {
    await initialize(geometry);
    return evidence();
  },
  async ready(bytes?: number[]) {
    await ready(bytes ? Uint8Array.from(bytes) : undefined);
    return evidence();
  },
  async baseline(chunks: number[][], tailBytes = 0) {
    await baseline(
      chunks.map((chunk) => Uint8Array.from(chunk)),
      tailBytes,
    );
    return evidence();
  },
  async output(bytes: number[], seq = 1) {
    await output(Uint8Array.from(bytes), seq);
    return evidence();
  },
  async event(event: TerminalEvent, payload?: number[]) {
    await view!.applyEvent(event, payload ? Uint8Array.from(payload) : undefined);
    return evidence();
  },
  async queryCorpus(phase: "live" | "baseline" | "replay") {
    const supported = new Set(QUERY_SUPPORT.map((item) => item.fixture));
    const cases = queryCases.filter((item) => supported.has(item.caseId as never));
    const results = [];
    for (const item of cases) {
      const bytes = Uint8Array.from([...item.setupBytes, ...item.queryBytes]);
      const reference = new Terminal({ cols: 40, rows: 10, theme: { red: "#cc0000" } });
      const replies: number[][] = [];
      const sink = reference.onData((data) => replies.push(Array.from(encoder.encode(data))));
      reference.open(document.createElement("div"));
      await new Promise<void>((resolve) => reference.write(bytes, resolve));
      sink.dispose();
      reference.dispose();
      await initialize();
      if (phase === "live") {
        await ready();
        await output(bytes);
      } else {
        await baseline([bytes]);
        if (phase === "replay") await output(Uint8Array.from(item.continuationBytes), 1);
      }
      results.push({
        caseId: item.caseId,
        reference: replies,
        expected: item.expectedLiveReplies,
        adapted: inputs.map((i) => ownedBytes(i.bytes)),
      });
    }
    return results;
  },
  setSize(width: number, height: number) {
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    return evidence();
  },
  setHidden(hidden: boolean) {
    container.style.display = hidden ? "none" : "block";
    return evidence();
  },
  structuralLayout() {
    const root = container.querySelector<HTMLElement>(".xterm")!;
    const viewport = root.querySelector<HTMLElement>(".xterm-viewport")!;
    const screen = root.querySelector<HTMLElement>(".xterm-screen")!;
    const textarea = root.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
    const screenBox = screen.getBoundingClientRect();
    return {
      rootPosition: getComputedStyle(root).position,
      viewportPosition: getComputedStyle(viewport).position,
      screenPosition: getComputedStyle(screen).position,
      textareaPosition: getComputedStyle(textarea).position,
      textareaOpacity: getComputedStyle(textarea).opacity,
      screenWidth: screenBox.width,
      screenHeight: screenBox.height,
    };
  },
  setAppearance(next: Appearance) {
    view!.setAppearance(next);
    return evidence();
  },
  setVisibility(visible: boolean) {
    view!.setVisibility(visible);
    return evidence();
  },
  paste(text: string) {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    container.querySelector<HTMLElement>(".xterm")?.dispatchEvent(event);
    return evidence();
  },
  input(text: string) {
    capturedTerminal?.input(text, true);
    return evidence();
  },
  holdNextParse() {
    const gate = new Promise<boolean>((resolve) => {
      heldRelease = () => resolve(true);
    });
    capturedTerminal?.parser.registerOscHandler(777, () => gate);
  },
  startHeldOutput(bytes: number[]) {
    heldStatus = "pending";
    heldOperation = output(Uint8Array.from(bytes)).then(
      () => {
        heldStatus = "resolved";
      },
      () => {
        heldStatus = "rejected";
      },
    );
  },
  heldStatus() {
    return heldStatus;
  },
  async awaitHeld() {
    await heldOperation;
    return heldStatus;
  },
  releaseParse() {
    heldRelease?.();
    heldRelease = undefined;
  },
  tamperOrigin() {
    const core = (
      capturedTerminal as unknown as { _core?: { coreService?: { triggerDataEvent?: unknown } } }
    )?._core?.coreService;
    if (core) core.triggerDataEvent = () => {};
  },
  async attemptBegin(overrides: Partial<BaselineDescriptor>) {
    try {
      await view!.beginBaseline({ ...descriptor(1), ...overrides });
      return "ok";
    } catch (error) {
      return (error as DomainError).kind ?? "unknown";
    }
  },
  async attemptChunk(bytes: number[]) {
    try {
      await view!.writeBaselineChunk(Uint8Array.from(bytes));
      return "ok";
    } catch (error) {
      return (error as DomainError).kind ?? "unknown";
    }
  },
  async attemptFinish() {
    try {
      await view!.finishBaseline();
      return "ok";
    } catch (error) {
      return (error as DomainError).kind ?? "unknown";
    }
  },
  async attemptInvalidInitialization() {
    try {
      await view!.initialize({
        profile: "wrong",
        encoding: "wrong",
        geometry: currentGeometry,
        appearance,
        viewGeneration: generation + 1,
      } as never);
      return "ok";
    } catch (error) {
      return (error as DomainError).kind ?? "unknown";
    }
  },
  async attemptReset() {
    try {
      await initialize();
      return { kind: "ok", evidence: evidence() };
    } catch (error) {
      return { kind: (error as DomainError).kind ?? "unknown", evidence: evidence() };
    }
  },
  async attemptOutput(bytes: number[]) {
    try {
      await output(Uint8Array.from(bytes));
      return "ok";
    } catch (error) {
      return (error as DomainError).kind ?? "unknown";
    }
  },
  async attemptEvent(event: TerminalEvent, payload?: number[]) {
    try {
      await view!.applyEvent(event, payload ? Uint8Array.from(payload) : undefined);
      return "ok";
    } catch (error) {
      return (error as DomainError).kind ?? "unknown";
    }
  },
  async attemptConstructionFailure() {
    const original = Terminal.prototype.open;
    Terminal.prototype.open = () => {
      throw new Error("injected open failure");
    };
    const candidate = createXtermTerminalView(container);
    const observed: DomainError[] = [];
    candidate.onFailure((error) => observed.push(error));
    let kind = "ok";
    try {
      await candidate.initialize({
        profile: "pragmatic-logical-grid-v1",
        encoding: "vt-checkpoint-tail-v1",
        geometry: currentGeometry,
        appearance,
        viewGeneration: generation + 1,
      });
    } catch (error) {
      kind = (error as DomainError).kind ?? "unknown";
    } finally {
      Terminal.prototype.open = original;
      candidate.dispose();
    }
    return { kind, failures: observed.map((error) => error.kind) };
  },
  async attemptReplacementConstructionFailure() {
    await ready(encoder.encode("DIRTY"));
    const original = Terminal.prototype.open;
    Terminal.prototype.open = () => {
      throw new Error("injected replacement open failure");
    };
    let kind = "ok";
    try {
      await view!.beginBaseline(descriptor(1));
    } catch (error) {
      kind = (error as DomainError).kind ?? "unknown";
    } finally {
      Terminal.prototype.open = original;
    }
    let after = "ok";
    try {
      await output(Uint8Array.of(65));
    } catch (error) {
      after = (error as DomainError).kind ?? "unknown";
    }
    return { kind, after, evidence: evidence() };
  },
  async hiddenReplacement() {
    await ready(encoder.encode("OLD"));
    view!.setVisibility(false);
    const before = evidence();
    await baseline([encoder.encode("NEW")]);
    const replaced = evidence();
    view!.setVisibility(true);
    return { before, replaced, shown: evidence() };
  },
  async fullMaximumBaseline() {
    const markers: number[] = [];
    capturedTerminal?.parser.registerOscHandler(778, (value) => {
      markers.push(Number(value));
      return true;
    });
    const chunks = Array.from({ length: 129 }, (_, index) => {
      const prefix = encoder.encode(`\x1b]778;${index}\x07\rMARKER-${index}`);
      const chunk = new Uint8Array(65536);
      chunk.set(prefix);
      return chunk;
    });
    await baseline(chunks, 65536);
    return { markers, evidence: evidence() };
  },
  attemptRuntimeThemeFailure(withCleanupFailure = false) {
    const terminal = capturedTerminal!;
    const options = terminal.options as { theme?: unknown };
    Object.defineProperty(options, "theme", {
      configurable: true,
      set: () => {
        throw new Error("injected theme failure");
      },
    });
    let disposeCalls = 0;
    let removeCalls = 0;
    const originalRemove = container.removeEventListener.bind(container);
    if (withCleanupFailure) {
      container.removeEventListener = (
        ...args: Parameters<typeof container.removeEventListener>
      ) => {
        removeCalls++;
        originalRemove(...args);
        if (removeCalls === 1) throw new Error("injected tracker cleanup failure");
      };
    }
    const originalDispose = terminal.dispose.bind(terminal);
    terminal.dispose = () => {
      disposeCalls++;
      originalDispose();
    };
    let thrown: unknown;
    try {
      view!.setAppearance({ palette: [] });
    } catch (error) {
      thrown = error;
    } finally {
      container.removeEventListener = originalRemove;
    }
    const aggregate = thrown instanceof AggregateError ? thrown : undefined;
    let repeated = "ok";
    try {
      view!.dispose();
    } catch {
      repeated = "threw";
    }
    return {
      kind: (aggregate?.cause as DomainError | undefined)?.kind ?? (thrown as DomainError)?.kind,
      errors: errorMessages(thrown),
      disposeCalls,
      removeCalls,
      repeated,
      failures: failures.map((error) => error.kind),
      children: container.childElementCount,
    };
  },
  disposeAfterPasteWithTimerProbe() {
    let cleared = 0;
    const originalClear = globalThis.clearTimeout;
    globalThis.clearTimeout = ((timer: number) => {
      cleared++;
      return originalClear(timer);
    }) as typeof globalThis.clearTimeout;
    try {
      this.paste("timer");
      view!.dispose();
      view!.dispose();
    } finally {
      globalThis.clearTimeout = originalClear;
    }
    return { cleared, children: container.childElementCount };
  },
  async cycle(count: number) {
    for (let index = 0; index < count; index++) {
      await initialize();
      await ready();
    }
    return { children: container.childElementCount, generation };
  },
  focus() {
    document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
  },
  evidence,
  dispose() {
    for (const subscription of subscriptions.reverse()) subscription.dispose();
    subscriptions = [];
    view?.dispose();
    view = undefined;
    capturedTerminal = undefined;
    heldRelease?.();
    heldRelease = undefined;
    heldOperation = undefined;
    heldStatus = "idle";
    container.replaceChildren();
  },
};

declare global {
  interface Window {
    coveView: typeof fixture;
    coveQuery: { ready: boolean; dispose(): void };
  }
}

window.coveView = fixture;
window.coveQuery = { ready: true, dispose: () => fixture.dispose() };
window.addEventListener("pagehide", () => fixture.dispose(), { once: true });
