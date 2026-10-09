import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITerminalInitOnlyOptions, type ITerminalOptions } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { DomainErrorSchema, domainError, type DomainError } from "@cove/protocol/errors";
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
import { RendererFallback, type XtermRenderer } from "./xterm-renderer.js";
import { measureTerminalGrid } from "./xterm-view-geometry.js";

export type { XtermRenderer } from "./xterm-renderer.js";

export interface XtermTerminalViewOptions {
  // Defaults to "webgl" when the browser exposes WebGL2 and to "dom" otherwise. "webgl" is a
  // preference: a failed load or a repeated context loss still falls back to the DOM renderer.
  renderer?: XtermRenderer;
}

// The renderer is a private drawing choice of this view. It is exposed read-only for diagnostics
// and tests; controllers and the protocol must not depend on it.
export interface XtermTerminalView extends TerminalView {
  readonly renderer: XtermRenderer;
  onRendererChange(listener: (renderer: XtermRenderer) => void): { dispose(): void };
}

// Every option that affects cell metrics is shared with estimateXtermGrid.
const terminalOptions = (geometry: Geometry): ITerminalOptions & ITerminalInitOnlyOptions => ({
  cols: geometry.cols,
  rows: geometry.rows,
  scrollback: M0_LIMITS.historyLines,
  convertEol: false,
  cursorBlink: false,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 14,
  lineHeight: 1,
  letterSpacing: 0,
});

const defaultRenderer = (): XtermRenderer =>
  typeof WebGL2RenderingContext === "function" ? "webgl" : "dom";

// The WebGL addon offers no public handle on its context. The canvases it inserts are found by
// difference instead of through private fields, so its GPU context can be released on disposal.
// It inserts two: a 2D canvas for the link layer, first, and the WebGL canvas. Only a canvas
// already holding a WebGL2 context returns one from getContext("webgl2"); the 2D canvas returns
// null, so asking each new canvas picks out the right one whatever the insertion order.
const webglSurfaces = new WeakMap<
  WebglAddon,
  { canvas: HTMLCanvasElement; gl: WebGL2RenderingContext }
>();

function loadWebglAddon(terminal: Terminal, addon: WebglAddon): void {
  const before = new Set(terminal.element?.querySelectorAll("canvas") ?? []);
  try {
    terminal.loadAddon(addon);
  } finally {
    // Also record a context from an activation that threw half way, so disposal releases it.
    for (const canvas of terminal.element?.querySelectorAll("canvas") ?? []) {
      if (before.has(canvas)) continue;
      const gl = canvas.getContext("webgl2");
      if (gl) {
        webglSurfaces.set(addon, { canvas, gl });
        break;
      }
    }
  }
}

function disposeWebglAddon(addon: WebglAddon): void {
  const surface = webglSurfaces.get(addon);
  webglSurfaces.delete(addon);
  try {
    addon.dispose();
  } finally {
    // xterm removes the canvas but leaves its context to garbage collection. Every baseline
    // rebuilds the xterm, so release the context now rather than let dead contexts accumulate
    // towards the browser's active-context limit, which evicts the oldest context when reached.
    if (surface) {
      surface.gl.getExtension("WEBGL_lose_context")?.loseContext();
      surface.canvas.width = 0;
      surface.canvas.height = 0;
    }
  }
}

// The grid a view would measure in `container` before any view exists there, such as the size
// for creating a terminal. It opens a hidden xterm with the view's options and, for WebGL, the
// WebGL renderer, so it reads the same device cell the live view will, and a later measureGrid of
// the live view returns this same grid unless the space or the renderer changed. Returns
// undefined when the container cannot be measured.
export function estimateXtermGrid(
  container: HTMLElement,
  options: XtermTerminalViewOptions = {},
): Geometry | undefined {
  const host = container.ownerDocument.createElement("div");
  host.style.cssText =
    "position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden";
  let terminal: Terminal | undefined;
  let addon: WebglAddon | undefined;
  try {
    container.append(host);
    terminal = new Terminal(terminalOptions({ cols: 80, rows: 24 }));
    terminal.open(host);
    if ((options.renderer ?? defaultRenderer()) === "webgl") {
      try {
        addon = new WebglAddon();
        loadWebglAddon(terminal, addon);
      } catch {
        // The live view falls back to DOM too; measure the DOM renderer's cells.
        const failed = addon;
        addon = undefined;
        if (failed) disposeWebglAddon(failed);
      }
    }
    const unmeasurable = { cols: 0, rows: 0 };
    const grid = measureTerminalGrid(terminal, container, unmeasurable);
    return grid === unmeasurable ? undefined : grid;
  } catch {
    return undefined;
  } finally {
    for (const release of [
      () => addon && disposeWebglAddon(addon),
      () => terminal?.dispose(),
      () => host.remove(),
    ])
      try {
        release();
      } catch {
        // An estimate never fails its caller; the hidden host is removed regardless.
      }
  }
}

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

function asDomainError(error: unknown): DomainError {
  const direct = DomainErrorSchema.safeParse(error);
  if (direct.success) return direct.data;
  if (error instanceof AggregateError) {
    const cause = DomainErrorSchema.safeParse(error.cause);
    if (cause.success) return cause.data;
    for (const item of error.errors) {
      const nested = DomainErrorSchema.safeParse(item);
      if (nested.success) return nested.data;
    }
  }
  return domainError("RECOVERY_UNAVAILABLE");
}

function combineErrors(primary: unknown, cleanup: unknown[], message: string): unknown {
  if (!cleanup.length) return primary;
  return new AggregateError([primary, ...cleanup], message, { cause: primary });
}

function cleanupAll(actions: Array<() => void>): unknown[] {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function createXtermTerminalView(
  container: HTMLElement,
  options: XtermTerminalViewOptions = {},
): XtermTerminalView {
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
  const rendererChanges = new ListenerSet<XtermRenderer>();
  // Renderer trouble never fails the view: it degrades to the DOM renderer, which draws the same
  // model. See xterm-renderer.ts for the fallback state machine.
  const renderers = new RendererFallback<Terminal, WebglAddon>(
    options.renderer ?? defaultRenderer(),
    {
      createAddon: () => new WebglAddon(),
      loadAddon: loadWebglAddon,
      onContextLoss: (addon, listener) => addon.onContextLoss(listener),
      clearTextureAtlas: (addon) => addon.clearTextureAtlas(),
      disposeAddon: disposeWebglAddon,
      refresh: (terminal) => terminal.refresh(0, Math.max(0, terminal.rows - 1)),
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    () => announceRenderer(),
  );
  // Renderer changes are announced only between view transitions. The fallback reports changes
  // synchronously from attach and detach, which run in the middle of initialize, a baseline's
  // backend replacement and a fatal retirement. A listener may reenter the view (initialize a
  // newer generation, dispose it), and doing that halfway through a transition let the
  // resumed transition overwrite and leak the listener's successor. So every transition runs
  // inside `transition`, and once the outermost one has committed, listeners get the renderer
  // that is active then, only if it differs from what they last saw. Retiring one WebGL xterm
  // and attaching the next is therefore no change at all.
  let transitionDepth = 0;
  let announced = renderers.active;
  function announceRenderer(): void {
    if (transitionDepth > 0 || state === "disposed") return;
    const current = renderers.active;
    if (current === announced) return;
    announced = current;
    rendererChanges.emit(current);
  }
  const transition = <T>(step: () => T): T => {
    transitionDepth++;
    try {
      return step();
    } finally {
      transitionDepth--;
      announceRenderer();
    }
  };
  const register = <T>(listeners: ListenerSet<T>, listener: Listener<T>) => {
    if (state === "disposed") throw domainError("RESYNC_REQUIRED");
    return listeners.add(listener);
  };

  const publishFailure = (error: DomainError, fatal: boolean, targetIncarnation = incarnation) => {
    if (state === "disposed") return;
    if (fatal) {
      if (targetIncarnation !== incarnation || failurePublishedFor === targetIncarnation) return;
      failurePublishedFor = targetIncarnation;
      state = "failed";
    }
    failures.emit(error);
  };

  const publishFocus = (focused: boolean, deliberateActivation = false) => {
    if (state === "disposed" || (!deliberateActivation && focused === effectivelyFocused))
      return true;
    if (focusSeq === Number.MAX_SAFE_INTEGER) {
      publishFailure(domainError("COUNTER_EXHAUSTED"), true);
      return false;
    }
    focusSeq++;
    effectivelyFocused = focused;
    focuses.emit({ viewGeneration, focusSeq, focused, geometry: { ...geometry } });
    return true;
  };
  const acceptsInputFrom = (targetIncarnation: number) =>
    targetIncarnation === incarnation &&
    backend?.incarnation === targetIncarnation &&
    state !== "disposed" &&
    state !== "failed";

  const publishInput = (bytes: Uint8Array, source: InputSource, targetIncarnation: number) => {
    if (!acceptsInputFrom(targetIncarnation)) return;
    // Local DOM focus does not prove that this client still owns server control. Every deliberate
    // input therefore carries a fresh monotonic focus intent that a controller can stage before
    // the bytes; ordinary blur remains transition-only.
    if (!publishFocus(true, true)) return;
    // Focus observers are synchronous and may replace, hide, fail or dispose the view. Never let
    // the old callback label bytes with a successor generation or emit after focus was withdrawn.
    if (!acceptsInputFrom(targetIncarnation) || !effectivelyFocused) return;
    inputs.emit({ viewGeneration, source, bytes: bytes.slice() });
  };

  const disposeBackend = (reason = domainError("RESYNC_REQUIRED")): unknown[] => {
    incarnation++;
    parser.cancel(reason);
    const retired = backend;
    backend = undefined;
    baseline = undefined;
    pristine = false;
    if (!retired) return [];
    return cleanupAll([
      () => retired.tracker.dispose(),
      () => retired.origin.dispose(),
      () => renderers.detach(retired.terminal),
      () => retired.terminal.dispose(),
    ]);
  };

  const retireFatal = (error: unknown, targetIncarnation = incarnation): unknown =>
    transition(() => retireFatalNow(error, targetIncarnation));

  const retireFatalNow = (error: unknown, targetIncarnation: number): unknown => {
    const failure = asDomainError(error);
    if (
      state === "disposed" ||
      targetIncarnation !== incarnation ||
      failurePublishedFor === targetIncarnation
    )
      return error instanceof AggregateError ? error : failure;
    // Latch and detach the exact incarnation before notifying consumers. A failure listener may
    // synchronously initialize a successor, which the retiring callback must never tear down.
    failurePublishedFor = targetIncarnation;
    state = "failed";
    const cleanup = disposeBackend(failure);
    failures.emit(failure);
    return combineErrors(
      error instanceof AggregateError ? error : failure,
      cleanup,
      "Terminal failure and cleanup failed",
    );
  };

  const constructBackend = (targetGeometry: Geometry, targetAppearance: Appearance): Backend => {
    const targetIncarnation = ++incarnation;
    let terminal: Terminal | undefined;
    let tracker: BrowserInputTracker | undefined;
    let origin: InputOriginAttachment | undefined;
    let built: Backend;
    try {
      terminal = new Terminal({
        ...terminalOptions(targetGeometry),
        theme: xtermTheme(targetAppearance),
      });
      origin = attachInputOrigin(
        terminal,
        (fallback) => tracker?.current(fallback) ?? fallback,
        (bytes, source) => publishInput(bytes, source, targetIncarnation),
        (error) => {
          if (error.kind === "INPUT_REJECTED") publishFailure(error, false, targetIncarnation);
          else void retireFatal(error, targetIncarnation);
        },
      );
      // A hidden logical view must not flash a replacement terminal between open() and the
      // element-level hidden attribute. Temporarily hide the host, restore its prior author style
      // only after the new xterm root is hidden, and also restore it when open() throws.
      const previousHostVisibility = container.style.visibility;
      if (!visible) container.style.visibility = "hidden";
      try {
        terminal.open(container);
        if (!visible) terminal.element?.setAttribute("hidden", "");
      } finally {
        if (!visible) container.style.visibility = previousHostVisibility;
      }
      tracker = trackBrowserInput(container, terminal, () => {
        if (targetIncarnation === incarnation && effectivelyFocused) publishFocus(false);
      });
      terminal.element?.setAttribute("data-cove-terminal-view", "xterm-dom-v1");
      // Load the renderer last: it cannot fail construction, and a construction failure above
      // must not leave a GPU context behind.
      renderers.attach(terminal);
      built = { terminal, origin, tracker, incarnation: targetIncarnation };
    } catch (error) {
      const primary = asDomainError(error);
      const cleanup = cleanupAll([
        () => tracker?.dispose(),
        () => origin?.dispose(),
        () => terminal?.dispose(),
      ]);
      throw combineErrors(primary, cleanup, "Terminal construction and cleanup failed");
    }
    // Renderer changes are announced only after the enclosing transition commits, but opening an
    // xterm and attaching its input and renderer still run foreign code synchronously. If anything
    // in it disposed or reinitialized the view, this xterm no longer belongs to the view: retire
    // it here rather than install it and revive a disposed view or replace a successor.
    if (state === "disposed" || targetIncarnation !== incarnation) {
      const cleanup = cleanupAll([
        () => built.tracker.dispose(),
        () => built.origin.dispose(),
        () => renderers.detach(built.terminal),
        () => built.terminal.dispose(),
      ]);
      throw combineErrors(
        domainError("RESYNC_REQUIRED"),
        cleanup,
        "Superseded terminal construction cleanup failed",
      );
    }
    return built;
  };

  const failAndRetire = (error: unknown, targetIncarnation = incarnation): never => {
    throw retireFatal(error, targetIncarnation);
  };

  const requireBackend = (): Backend => {
    if (state === "disposed" || state === "failed" || !backend)
      throw domainError("RESYNC_REQUIRED");
    if (!backend.origin.ownsSurface())
      failAndRetire(domainError("PROFILE_UNSUPPORTED"), backend.incarnation);
    return backend;
  };

  const replaceBackend = () => transition(replaceBackendNow);

  const replaceBackendNow = () => {
    const cleanup = disposeBackend();
    if (cleanup.length) {
      const failure = domainError("RECOVERY_UNAVAILABLE");
      publishFailure(failure, true);
      throw combineErrors(failure, cleanup, "Terminal replacement cleanup failed");
    }
    // Retire only this construction's incarnation on failure; a listener called during
    // construction may already have built a successor that must survive.
    const target = incarnation + 1;
    try {
      backend = constructBackend(geometry, appearance);
      pristine = true;
    } catch (error) {
      failAndRetire(error, target);
    }
  };

  const parse = async (bytes: Uint8Array) => {
    const current = requireBackend();
    const owned = bytes.slice();
    await parser.write(
      current.terminal,
      owned,
      current.incarnation,
      () => backend === current && current.incarnation === incarnation && state !== "disposed",
      (error) => retireFatal(error, current.incarnation),
    );
    pristine = false;
  };

  const initializeNow = (input: ViewInitialization): void => {
    if (state === "disposed") throw domainError("RESYNC_REQUIRED");
    if (input.profile !== PROFILE || input.encoding !== BASELINE_ENCODING)
      throw domainError("PROFILE_UNSUPPORTED");
    assertGeometry(input.geometry);
    const nextTheme = xtermTheme(input.appearance);
    void nextTheme;
    assertGeneration(input.viewGeneration);
    if (viewGeneration >= 0 && input.viewGeneration <= viewGeneration)
      throw domainError("RESYNC_REQUIRED");
    const cleanup = disposeBackend();
    if (cleanup.length) {
      const failure = domainError("RECOVERY_UNAVAILABLE");
      publishFailure(failure, true);
      throw combineErrors(failure, cleanup, "Terminal initialization cleanup failed");
    }
    viewGeneration = input.viewGeneration;
    geometry = { ...input.geometry };
    proposedGeometry = geometry;
    appearance = input.appearance;
    effectivelyFocused = false;
    focusSeq = 0;
    failurePublishedFor = -1;
    // As in replaceBackend, a failure retires only this construction's incarnation.
    const target = incarnation + 1;
    try {
      backend = constructBackend(geometry, appearance);
    } catch (error) {
      failAndRetire(error, target);
    }
    pristine = true;
    state = "initialized";
  };

  return {
    async initialize(input: ViewInitialization): Promise<void> {
      transition(() => initializeNow(input));
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
          } catch (error) {
            failAndRetire(error, current.incarnation);
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
        const theme = xtermTheme(event.appearance);
        try {
          current.terminal.options.theme = theme;
        } catch (error) {
          failAndRetire(error, current.incarnation);
        }
        appearance = event.appearance;
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
      const current = backend;
      if (current && state !== "disposed" && state !== "failed") {
        try {
          current.terminal.options.theme = theme;
        } catch (error) {
          failAndRetire(error, current.incarnation);
        }
      }
      appearance = nextAppearance;
    },

    setVisibility(nextVisible: boolean): void {
      if (state === "disposed") return;
      visible = nextVisible;
      const element = backend?.terminal.element;
      if (element) {
        const current = backend!;
        try {
          if (visible) {
            element.removeAttribute("hidden");
            renderers.reveal();
            current.terminal.refresh(0, Math.max(0, current.terminal.rows - 1));
          } else {
            element.setAttribute("hidden", "");
            if (effectivelyFocused) {
              current.terminal.blur();
              publishFocus(false);
            }
          }
        } catch (error) {
          failAndRetire(error, current.incarnation);
        }
      }
    },

    onInputIntent: (listener) => register(inputs, listener),
    onFocusIntent: (listener) => register(focuses, listener),
    onFailure: (listener) => register(failures, listener),

    get renderer(): XtermRenderer {
      return renderers.active;
    },
    onRendererChange: (listener) => register(rendererChanges, listener),

    dispose(): void {
      if (state === "disposed") return;
      state = "disposed";
      // Dispose the renderer policy first: it cancels a pending retry and releases the addon
      // without publishing a renderer change to listeners that are about to be cleared.
      renderers.dispose();
      const cleanup = disposeBackend();
      inputs.clear();
      focuses.clear();
      failures.clear();
      rendererChanges.clear();
      if (cleanup.length) throw new AggregateError(cleanup, "Terminal view cleanup failed");
    },
  };
}
