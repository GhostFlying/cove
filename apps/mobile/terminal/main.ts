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
      resize.disconnect();
      endpoint.dispose();
      view.dispose();
      delete window.__coveReceive;
    },
    { once: true },
  );
}

void document.fonts.ready.then(() => requestAnimationFrame(start));
