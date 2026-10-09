// Renderer selection for one browser terminal view. xterm always owns a DOM renderer; the WebGL2
// addon is an optional accelerator loaded on top of it, so "falling back" means disposing the
// addon and repainting with the DOM renderer that xterm restores. Nothing here is visible to the
// controller or the protocol: the renderer is a private drawing choice of the view.
//
// The policy is per view, not per xterm instance. A view rebuilds its xterm for every new
// baseline (recovery, resize), and a context that was lost twice must not be retried just because
// a successor instance was created. The states are:
//
//   webgl          WebGL is allowed and no context has been lost yet. Every attached terminal
//                  tries to load the addon; a load failure moves to `dom`.
//   retry-pending  The first context loss happened. The addon was disposed and the terminal
//                  repainted on DOM. One delayed retry is scheduled; terminals attached in the
//                  meantime stay on DOM and the retry upgrades whichever terminal is current.
//   webgl-final    The single retry was spent. WebGL stays loaded while it works, but the next
//                  context loss or load failure moves to `dom`.
//   dom            DOM was requested, WebGL failed to load, or the context was lost twice. The
//                  view stays on DOM for the rest of its life.
//
// The retry is delayed because a lost context usually means the GPU process restarted or the
// page was backgrounded; recreating a context synchronously inside the loss callback tends to fail
// or to be lost again at once. One retry handles a transient loss without entering a loss loop on
// a GPU that keeps dropping contexts. Orca mobile uses the same one-retry policy.

export type XtermRenderer = "webgl" | "dom";

type Policy = "webgl" | "retry-pending" | "webgl-final" | "dom";

export interface RendererBindings<Terminal, Addon> {
  createAddon(): Addon;
  loadAddon(terminal: Terminal, addon: Addon): void;
  onContextLoss(addon: Addon, listener: () => void): { dispose(): void };
  clearTextureAtlas(addon: Addon): void;
  // Disposes the addon and releases its GPU context. Must tolerate an addon whose context is
  // already lost or whose load threw half way.
  disposeAddon(addon: Addon): void;
  // Repaints every visible row with whichever renderer is active now.
  refresh(terminal: Terminal): void;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export const WEBGL_RETRY_DELAY_MS = 250;

interface Attached<Terminal, Addon> {
  terminal: Terminal;
  addon?: Addon | undefined;
  lossSubscription?: { dispose(): void } | undefined;
}

// Renderer failures are never fatal to the view: the DOM renderer can always draw the same model.
// Every call into xterm or the addon is therefore isolated and degrades to DOM.
const attempt = (action: () => void): boolean => {
  try {
    action();
    return true;
  } catch {
    return false;
  }
};

export class RendererFallback<Terminal, Addon> {
  private policy: Policy;
  private current: Attached<Terminal, Addon> | undefined;
  private retryTimer: unknown;
  private disposed = false;
  private activeRenderer: XtermRenderer = "dom";

  constructor(
    preferred: XtermRenderer,
    private readonly bindings: RendererBindings<Terminal, Addon>,
    private readonly onChange: (renderer: XtermRenderer) => void = () => {},
    private readonly retryDelayMs = WEBGL_RETRY_DELAY_MS,
  ) {
    this.policy = preferred === "webgl" ? "webgl" : "dom";
  }

  get active(): XtermRenderer {
    return this.activeRenderer;
  }

  // Adopts a newly opened terminal as the current one. The caller detaches the previous terminal
  // first; attaching over it would leave an addon on an xterm this object no longer tracks.
  attach(terminal: Terminal): void {
    if (this.disposed) return;
    if (this.current) this.detach(this.current.terminal);
    this.current = { terminal };
    if (this.policy === "webgl" || this.policy === "webgl-final") this.load();
  }

  // Releases the addon of a terminal that is about to be disposed. A pending retry is kept: it
  // belongs to the view and upgrades the next attached terminal.
  detach(terminal: Terminal): void {
    const current = this.current;
    if (!current || current.terminal !== terminal) return;
    this.current = undefined;
    this.release(current);
    this.setActive("dom");
  }

  // Called when the view becomes visible again. A backgrounded page may keep the terminal model
  // while the browser discards GPU pixels, so the glyph atlas is rebuilt before the caller
  // repaints every row.
  reveal(): void {
    const addon = this.current?.addon;
    if (addon !== undefined) attempt(() => this.bindings.clearTextureAtlas(addon));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRetry();
    const current = this.current;
    this.current = undefined;
    if (current) this.release(current);
    this.activeRenderer = "dom";
  }

  private load(): void {
    const current = this.current!;
    const loaded = attempt(() => {
      const created = this.bindings.createAddon();
      // Record and subscribe before loading, so a loss reported during activation is handled
      // like any later loss and a throwing load still releases the half-loaded addon.
      current.addon = created;
      current.lossSubscription = this.bindings.onContextLoss(created, () =>
        this.lose(current, created),
      );
      this.bindings.loadAddon(current.terminal, created);
    });
    if (!loaded) {
      this.release(current);
      this.policy = "dom";
      attempt(() => this.bindings.refresh(current.terminal));
      this.setActive("dom");
      return;
    }
    // A loss during activation has already moved this terminal back to DOM.
    if (current.addon === undefined) return;
    // A freshly created WebGL canvas is empty until the next write; repaint the existing model.
    attempt(() => this.bindings.refresh(current.terminal));
    this.setActive("webgl");
  }

  private lose(owner: Attached<Terminal, Addon>, addon: Addon): void {
    // Only the addon currently loaded into the current terminal may change the policy. A loss
    // reported by a retired or already released addon is stale.
    if (this.disposed || this.current !== owner || owner.addon !== addon) return;
    this.release(owner);
    attempt(() => this.bindings.refresh(owner.terminal));
    this.setActive("dom");
    if (this.policy === "webgl") {
      this.policy = "retry-pending";
      this.retryTimer = this.bindings.setTimer(() => this.retry(), this.retryDelayMs);
    } else {
      this.policy = "dom";
    }
  }

  private retry(): void {
    this.retryTimer = undefined;
    if (this.disposed || this.policy !== "retry-pending") return;
    this.policy = "webgl-final";
    // Without a current terminal the next attach loads WebGL under the final policy.
    if (this.current && this.current.addon === undefined) this.load();
  }

  private cancelRetry(): void {
    if (this.retryTimer === undefined) return;
    const timer = this.retryTimer;
    this.retryTimer = undefined;
    attempt(() => this.bindings.clearTimer(timer));
  }

  private release(attached: Attached<Terminal, Addon>): void {
    const { addon, lossSubscription } = attached;
    attached.addon = undefined;
    attached.lossSubscription = undefined;
    attempt(() => lossSubscription?.dispose());
    if (addon !== undefined) attempt(() => this.bindings.disposeAddon(addon));
  }

  private setActive(renderer: XtermRenderer): void {
    if (this.disposed || this.activeRenderer === renderer) return;
    this.activeRenderer = renderer;
    attempt(() => this.onChange(renderer));
  }
}
