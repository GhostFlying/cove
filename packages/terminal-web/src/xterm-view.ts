import { Terminal } from "@xterm/xterm";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError, type DomainError } from "@cove/protocol/errors";
import {
  GeometrySchema,
  PROFILE,
  BASELINE_ENCODING,
  type Appearance,
  type Geometry,
} from "@cove/protocol/profile";
import {
  MAX_PAYLOAD_BYTES,
  TerminalEventSchema,
  validateBaselineDescriptor,
  type BaselineDescriptor,
  type TerminalEvent,
} from "@cove/protocol/terminal";
import type {
  FocusIntent,
  InputIntent,
  TerminalView,
  ViewInitialization,
} from "@cove/protocol/view";
import {
  trackBrowserInput,
  type BrowserInputTracker,
  type InputSource,
} from "./browser-input-intents.js";
import { xtermTheme } from "./xterm-appearance.js";
import { attachInputOrigin, type InputOriginAttachment } from "./xterm-input-origin.js";
import { XtermParseOperation } from "./xterm-parse-operation.js";
import { measureTerminalGrid } from "./xterm-view-geometry.js";

type ViewState = "new" | "initialized" | "installing" | "ready" | "failed" | "disposed";
type Listener<T> = (value: T) => void;

interface Backend {
  terminal: Terminal;
  origin: InputOriginAttachment;
  tracker: BrowserInputTracker;
  incarnation: number;
}

interface BaselineProgress {
  descriptor: BaselineDescriptor;
  chunks: number;
  bytes: number;
}

class ListenerSet<T> {
  private readonly listeners = new Set<Listener<T>>();

  add(listener: Listener<T>): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A consumer callback is outside the renderer incarnation. It must not recursively turn
        // a valid input/failure notification into another renderer failure.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw domainError("PROFILE_UNSUPPORTED");
}

function assertGeometry(value: unknown): asserts value is Geometry {
  if (!GeometrySchema.safeParse(value).success) throw domainError("INVALID_SIZE");
}

function sameGeometry(left: Geometry, right: Geometry): boolean {
  return left.cols === right.cols && left.rows === right.rows;
}

export function createXtermTerminalView(container: HTMLElement): TerminalView {
  let state: ViewState = "new";
  let backend: Backend | undefined;
  let viewGeneration = -1;
  let incarnation = 0;
  let geometry: Geometry = { cols: 80, rows: 24 };
  let appearance: Appearance = { palette: [] };
  let proposedGeometry = geometry;
  let baseline: BaselineProgress | undefined;
  let pristine = false;
  let visible = true;
  let effectivelyFocused = false;
  let focusSeq = 0;
  let failurePublishedFor = -1;
  const parser = new XtermParseOperation();
  const inputs = new ListenerSet<InputIntent>();
  const focuses = new ListenerSet<FocusIntent>();
  const failures = new ListenerSet<DomainError>();

  const publishFailure = (error: DomainError, fatal: boolean, targetIncarnation = incarnation) => {
    if (state === "disposed") return;
    if (fatal) {
      if (targetIncarnation !== incarnation || failurePublishedFor === targetIncarnation) return;
      failurePublishedFor = targetIncarnation;
      state = "failed";
    }
    failures.emit(error);
  };

  const publishFocus = (focused: boolean) => {
    if (state === "disposed" || focused === effectivelyFocused) return true;
    if (focusSeq === Number.MAX_SAFE_INTEGER) {
      publishFailure(domainError("COUNTER_EXHAUSTED"), true);
      return false;
    }
    focusSeq++;
    effectivelyFocused = focused;
    focuses.emit({ viewGeneration, focusSeq, focused, geometry: { ...geometry } });
    return true;
  };

  const publishInput = (bytes: Uint8Array, source: InputSource, targetIncarnation: number) => {
    if (targetIncarnation !== incarnation || state === "disposed" || state === "failed") return;
    if (!publishFocus(true)) return;
    inputs.emit({ viewGeneration, source, bytes: bytes.slice() });
  };

  const disposeBackend = (reason = domainError("RESYNC_REQUIRED")) => {
    incarnation++;
    parser.cancel(reason);
    const retired = backend;
    backend = undefined;
    baseline = undefined;
    pristine = false;
    retired?.tracker.dispose();
    retired?.origin.dispose();
    retired?.terminal.dispose();
  };

  const constructBackend = (targetGeometry: Geometry, targetAppearance: Appearance): Backend => {
    const terminal = new Terminal({
      cols: targetGeometry.cols,
      rows: targetGeometry.rows,
      scrollback: M0_LIMITS.historyLines,
      convertEol: false,
      cursorBlink: false,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 14,
      lineHeight: 1,
      letterSpacing: 0,
      theme: xtermTheme(targetAppearance),
    });
    const targetIncarnation = ++incarnation;
    let tracker: BrowserInputTracker | undefined;
    let origin: InputOriginAttachment | undefined;
    try {
      origin = attachInputOrigin(
        terminal,
        (fallback) => tracker?.current(fallback) ?? fallback,
        (bytes, source) => publishInput(bytes, source, targetIncarnation),
        (error) => publishFailure(error, error.kind !== "INPUT_REJECTED", targetIncarnation),
      );
      terminal.open(container);
      tracker = trackBrowserInput(container, terminal, () => {
        if (targetIncarnation === incarnation && effectivelyFocused) publishFocus(false);
      });
      terminal.element?.setAttribute("data-cove-terminal-view", "xterm-dom-v1");
      return { terminal, origin, tracker, incarnation: targetIncarnation };
    } catch (error) {
      tracker?.dispose();
      origin?.dispose();
      terminal.dispose();
      if (typeof error === "object" && error !== null && "kind" in error) throw error;
      throw domainError("RECOVERY_UNAVAILABLE");
    }
  };

  const requireBackend = (): Backend => {
    if (state === "disposed" || state === "failed" || !backend)
      throw domainError("RESYNC_REQUIRED");
    if (!backend.origin.ownsSurface()) {
      const error = domainError("PROFILE_UNSUPPORTED");
      publishFailure(error, true, backend.incarnation);
      throw error;
    }
    return backend;
  };

  const replaceBackend = () => {
    disposeBackend();
    backend = constructBackend(geometry, appearance);
    pristine = true;
  };

  const parse = async (bytes: Uint8Array) => {
    const current = requireBackend();
    const owned = bytes.slice();
    await parser.write(
      current.terminal,
      owned,
      current.incarnation,
      () => backend === current && current.incarnation === incarnation && state !== "disposed",
      (error) => publishFailure(error, true, current.incarnation),
    );
    pristine = false;
  };

  return {
    async initialize(input: ViewInitialization): Promise<void> {
      if (state === "disposed") throw domainError("RESYNC_REQUIRED");
      if (input.profile !== PROFILE || input.encoding !== BASELINE_ENCODING)
        throw domainError("PROFILE_UNSUPPORTED");
      assertGeometry(input.geometry);
      const nextTheme = xtermTheme(input.appearance);
      void nextTheme;
      assertGeneration(input.viewGeneration);
      if (viewGeneration >= 0 && input.viewGeneration <= viewGeneration)
        throw domainError("RESYNC_REQUIRED");
      disposeBackend();
      viewGeneration = input.viewGeneration;
      geometry = { ...input.geometry };
      proposedGeometry = geometry;
      appearance = input.appearance;
      effectivelyFocused = false;
      focusSeq = 0;
      failurePublishedFor = -1;
      try {
        backend = constructBackend(geometry, appearance);
      } catch (error) {
        const failure =
          typeof error === "object" && error !== null && "kind" in error
            ? (error as DomainError)
            : domainError("RECOVERY_UNAVAILABLE");
        publishFailure(failure, true);
        throw error;
      }
      pristine = true;
      state = "initialized";
      if (!visible) backend.terminal.element?.setAttribute("hidden", "");
    },

    async beginBaseline(descriptor: BaselineDescriptor): Promise<void> {
      if (state !== "initialized" && state !== "ready") throw domainError("RESYNC_REQUIRED");
      if (parser.active) throw domainError("BUSY");
      const checked = validateBaselineDescriptor(descriptor);
      if (
        !checked ||
        checked.profile !== PROFILE ||
        checked.encoding !== BASELINE_ENCODING ||
        !sameGeometry(checked.captureGeometry, checked.currentGeometry) ||
        !sameGeometry(checked.currentGeometry, geometry)
      )
        throw domainError("RESYNC_REQUIRED");
      if (!pristine) replaceBackend();
      requireBackend();
      baseline = { descriptor: checked, chunks: 0, bytes: 0 };
      state = "installing";
    },

    async writeBaselineChunk(bytes: Uint8Array): Promise<void> {
      if (state !== "installing" || !baseline) throw domainError("RESYNC_REQUIRED");
      if (parser.active) throw domainError("BUSY");
      const nextBytes = baseline.bytes + bytes.byteLength;
      const declaredBytes = baseline.descriptor.vtBytes + baseline.descriptor.tailBytes;
      if (
        bytes.byteLength < 1 ||
        bytes.byteLength > MAX_PAYLOAD_BYTES ||
        baseline.chunks >= baseline.descriptor.chunkCount ||
        nextBytes > declaredBytes
      )
        throw domainError("RESYNC_REQUIRED");
      await parse(bytes);
      baseline.chunks++;
      baseline.bytes = nextBytes;
    },

    async finishBaseline(): Promise<void> {
      if (state !== "installing" || !baseline || parser.active)
        throw domainError(parser.active ? "BUSY" : "RESYNC_REQUIRED");
      if (
        baseline.chunks !== baseline.descriptor.chunkCount ||
        baseline.bytes !== baseline.descriptor.vtBytes + baseline.descriptor.tailBytes
      )
        throw domainError("RESYNC_REQUIRED");
      baseline = undefined;
      state = "ready";
    },

    async applyEvent(event: TerminalEvent, payload?: Uint8Array): Promise<void> {
      if (state !== "ready") throw domainError("RESYNC_REQUIRED");
      if (parser.active) throw domainError("BUSY");
      if (!TerminalEventSchema.safeParse(event).success) throw domainError("RESYNC_REQUIRED");
      if (event.type === "output") {
        if (!payload || payload.byteLength < 1 || payload.byteLength > MAX_PAYLOAD_BYTES)
          throw domainError("RESYNC_REQUIRED");
        await parse(payload);
        return;
      }
      if (payload?.byteLength) throw domainError("RESYNC_REQUIRED");
      const current = requireBackend();
      if (event.type === "resize") {
        if (event.requiresBaseline) throw domainError("RESYNC_REQUIRED");
        if (!sameGeometry(event.geometry, geometry)) {
          try {
            current.terminal.resize(event.geometry.cols, event.geometry.rows);
          } catch {
            const error = domainError("RECOVERY_UNAVAILABLE");
            publishFailure(error, true, current.incarnation);
            throw error;
          }
          geometry = { ...event.geometry };
        }
        return;
      }
      if (event.type === "control") {
        if (!sameGeometry(event.geometry, geometry)) throw domainError("RESYNC_REQUIRED");
        return;
      }
      if (event.type === "appearance") {
        appearance = event.appearance;
        current.terminal.options.theme = xtermTheme(appearance);
        return;
      }
      if (event.type === "exit") return;
      throw domainError("RESYNC_REQUIRED");
    },

    measureGrid(): Geometry {
      if (!backend || state === "disposed") return { ...proposedGeometry };
      proposedGeometry = measureTerminalGrid(backend.terminal, container, proposedGeometry);
      return { ...proposedGeometry };
    },

    setAppearance(nextAppearance: Appearance): void {
      const theme = xtermTheme(nextAppearance);
      appearance = nextAppearance;
      if (backend && state !== "disposed" && state !== "failed")
        backend.terminal.options.theme = theme;
    },

    setVisibility(nextVisible: boolean): void {
      if (state === "disposed") return;
      visible = nextVisible;
      const element = backend?.terminal.element;
      if (element) {
        if (visible) {
          element.removeAttribute("hidden");
          backend?.terminal.refresh(0, Math.max(0, backend.terminal.rows - 1));
        } else {
          element.setAttribute("hidden", "");
          if (effectivelyFocused) {
            backend?.terminal.blur();
            publishFocus(false);
          }
        }
      }
    },

    onInputIntent: (listener) => inputs.add(listener),
    onFocusIntent: (listener) => focuses.add(listener),
    onFailure: (listener) => failures.add(listener),

    dispose(): void {
      if (state === "disposed") return;
      state = "disposed";
      disposeBackend();
      inputs.clear();
      focuses.clear();
      failures.clear();
    },
  };
}
