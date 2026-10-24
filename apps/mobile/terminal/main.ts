import { createTerminalViewBridgeEndpoint } from "@cove/terminal-web/view-bridge";
import { createXtermTerminalView, estimateXtermGrid } from "@cove/terminal-web/xterm-view";

declare global {
  interface Window {
    __coveBridgeGeneration: number;
    __coveReceive?: (message: string) => void;
    ReactNativeWebView: { postMessage(message: string): void };
  }
}

const container = document.querySelector<HTMLElement>("#terminal")!;
const options = { renderer: "dom" as const };
const deadline = performance.now() + 5000;

function start() {
  const geometry = estimateXtermGrid(container, options);
  if (!geometry) {
    if (performance.now() < deadline) requestAnimationFrame(start);
    return;
  }
  const view = createXtermTerminalView(container, options);
  // xterm's mouse activation focuses its textarea, but a mobile WebView touch
  // can leave only the outer WebView focused. Focus the existing input during
  // the user's touch gesture so the OS keyboard targets it. This emits no
  // terminal bytes or protocol focus; genuine input still uses the view bridge.
  const focusTouchInput = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !event.isPrimary || !event.isTrusted) return;
    container.querySelector("textarea")?.focus({ preventScroll: true });
  };
  container.addEventListener("pointerdown", focusTouchInput, { capture: true, passive: true });
  const endpoint = createTerminalViewBridgeEndpoint({
    bridgeGeneration: window.__coveBridgeGeneration,
    view,
    initialGeometry: geometry,
    postMessage: (message) => window.ReactNativeWebView.postMessage(message),
  });
  window.__coveReceive = (message) => endpoint.receiveMessage(message);
  const resize = new ResizeObserver(() => {
    const measured = estimateXtermGrid(container, options);
    if (measured) endpoint.publishGeometry(measured);
  });
  resize.observe(container);
  window.addEventListener(
    "pagehide",
    () => {
      container.removeEventListener("pointerdown", focusTouchInput, true);
      resize.disconnect();
      endpoint.dispose();
      view.dispose();
      delete window.__coveReceive;
    },
    { once: true },
  );
}

void document.fonts.ready.then(() => requestAnimationFrame(start));
