import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");
const decoder = new TextDecoder();

// A headless TerminalView that renders what it is given into an xterm grid, so a test can
// compare the screen a client recovered with the server model's preview. Like a real view
// it never forwards xterm's automatic replies (onData): the server model alone answers
// terminal queries.
export function createScreenView(geometry = { cols: 80, rows: 24 }) {
  let terminal;
  let text = "";
  const events = [];
  const write = (bytes) =>
    new Promise((resolve) => {
      text += decoder.decode(bytes, { stream: true });
      terminal.write(bytes, resolve);
    });
  const fresh = ({ cols, rows }) => {
    terminal?.dispose();
    // M0 retains at most 1000 history lines; match it so recovered history fits.
    terminal = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  };
  const subscribe = (set) => (listener) => {
    set.add(listener);
    return { dispose: () => set.delete(listener) };
  };
  const view = {
    async initialize(input) {
      fresh(input.geometry);
    },
    async beginBaseline(descriptor) {
      fresh(descriptor.currentGeometry);
      events.push({ type: "baseline-start", atSeq: descriptor.atSeq });
    },
    writeBaselineChunk: write,
    async finishBaseline() {},
    async applyEvent(event, payload) {
      events.push(event);
      if (event.type === "output" && payload) await write(payload);
      else if (event.type === "resize") terminal.resize(event.geometry.cols, event.geometry.rows);
    },
    measureGrid: () => geometry,
    setAppearance() {},
    setVisibility() {},
    onInputIntent: subscribe(new Set()),
    onFocusIntent: subscribe(new Set()),
    onFailure: subscribe(new Set()),
    dispose() {
      terminal?.dispose();
      terminal = undefined;
    },
  };
  return {
    view,
    events,
    text: () => text,
    // The visible rows, trimmed on the right, plus cursor and active buffer.
    screen() {
      const buffer = terminal.buffer.active;
      const rows = [];
      for (let y = 0; y < terminal.rows; y++)
        rows.push(
          buffer
            .getLine(buffer.baseY + y)
            .translateToString(true)
            .trimEnd(),
        );
      return {
        geometry: { cols: terminal.cols, rows: terminal.rows },
        rows,
        cursor: { x: buffer.cursorX, y: buffer.cursorY },
        buffer: buffer.type,
      };
    },
    // Every line of the normal buffer, history included.
    normalLines() {
      const buffer = terminal.buffer.normal;
      const lines = [];
      for (let y = 0; y < buffer.length; y++)
        lines.push(buffer.getLine(y).translateToString(true).trimEnd());
      return lines;
    },
  };
}

// A server preview is the active viewport rendered as SGR runs separated by CRLF, then an
// absolute cursor position (and optionally a hidden-cursor mode). Reduce it to the same
// shape as ScreenView.screen() without the buffer kind, which a preview does not carry.
export function parsePreview(preview) {
  const vt = decoder.decode(preview.bytes);
  // oxlint-disable-next-line no-control-regex -- matching ESC-introduced sequences is the point.
  const cursor = /\u001b\[(\d+);(\d+)H(?:\u001b\[\?25l)?$/.exec(vt);
  if (!vt.startsWith("\u001b[0m\u001b[H") || !cursor) throw new Error("Unexpected preview shape");
  const body = vt.slice("\u001b[0m\u001b[H".length, cursor.index);
  return {
    geometry: { ...preview.geometry },
    rows: body
      // oxlint-disable-next-line no-control-regex -- strips SGR runs between cells.
      .replace(/\u001b\[[0-9;:]*m/g, "")
      .split("\r\n")
      .map((row) => row.trimEnd()),
    cursor: { x: Number(cursor[2]) - 1, y: Number(cursor[1]) - 1 },
  };
}
