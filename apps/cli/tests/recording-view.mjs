// A headless TerminalView that records the VT text it is given. It never parses VT or
// answers terminal queries: the server model alone answers those, so a test view must not.
export function createRecordingView(geometry = { cols: 80, rows: 24 }) {
  const decoder = new TextDecoder();
  const events = [];
  let text = "";
  const subscribe = (set) => (listener) => {
    set.add(listener);
    return { dispose: () => set.delete(listener) };
  };
  const view = {
    async initialize() {},
    async beginBaseline() {},
    async writeBaselineChunk(bytes) {
      text += decoder.decode(bytes, { stream: true });
    },
    async finishBaseline() {},
    async applyEvent(event, payload) {
      events.push(event);
      if (payload) text += decoder.decode(payload, { stream: true });
    },
    measureGrid: () => geometry,
    setAppearance() {},
    setVisibility() {},
    onInputIntent: subscribe(new Set()),
    onFocusIntent: subscribe(new Set()),
    onFailure: subscribe(new Set()),
    dispose() {},
  };
  return { view, events, text: () => text };
}

export async function waitFor(description, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
