import type { Terminal } from "@xterm/xterm";
import type { InputIntent } from "@cove/protocol/view";

export type InputSource = InputIntent["source"];

export interface BrowserInputTracker {
  current(fallback: InputSource): InputSource;
  dispose(): void;
}

export function trackBrowserInput(
  container: HTMLElement,
  terminal: Terminal,
  onBlur: () => void,
): BrowserInputTracker {
  let source: InputSource | undefined;
  let composing = false;
  let token = 0;
  const listeners: Array<[EventTarget, string, EventListener, boolean]> = [];
  const listen = (target: EventTarget, type: string, listener: EventListener, capture = true) => {
    target.addEventListener(type, listener, capture);
    listeners.push([target, type, listener, capture]);
  };
  const tag = (next: InputSource) => {
    source = next;
    const current = ++token;
    // Chromium may run a microtask checkpoint between listeners on the same native event. Keep
    // the tag through that dispatch turn, then clear it before the next unrelated task.
    setTimeout(() => {
      if (token === current && !composing) source = undefined;
    }, 0);
  };
  listen(container, "keydown", () => tag("keyboard"));
  listen(container, "keypress", () => tag("keyboard"));
  listen(container, "beforeinput", () => tag("keyboard"));
  listen(container, "input", () => tag("keyboard"));
  listen(container, "paste", () => tag("paste"));
  for (const event of ["mousedown", "mouseup", "mousemove", "wheel", "auxclick"])
    listen(container, event, () => tag("mouse"));
  // Drag/release handlers are installed by xterm on the owning document after mousedown. Capture
  // them there as well so the later core emission cannot fall back to a keyboard label.
  for (const event of ["mouseup", "mousemove"])
    listen(container.ownerDocument, event, () => tag("mouse"));
  const textarea = terminal.textarea;
  if (textarea) {
    listen(textarea, "blur", onBlur);
    listen(textarea, "compositionstart", () => {
      composing = true;
      tag("keyboard");
    });
    listen(textarea, "compositionend", () => {
      tag("keyboard");
      setTimeout(() => {
        composing = false;
        source = undefined;
      }, 0);
    });
  }
  return {
    current: (fallback) => source ?? fallback,
    dispose() {
      token++;
      source = undefined;
      composing = false;
      for (const [target, type, listener, capture] of listeners.reverse())
        target.removeEventListener(type, listener, capture);
    },
  };
}
