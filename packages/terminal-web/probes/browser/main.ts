import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

declare global {
  interface Window {
    coveProbe?: {
      terminal: Terminal;
      input: string;
      ready: boolean;
    };
  }
}

const element = document.getElementById("terminal");
if (!element) throw new Error("Terminal mount is absent");
const terminal = new Terminal({ cols: 40, rows: 10 });
const probe = { terminal, input: "", ready: false };
window.coveProbe = probe;
terminal.open(element);
terminal.onData((data) => {
  probe.input += data;
});
terminal.write("COVE_BROWSER_READY", () => {
  probe.ready = true;
});
window.addEventListener("pagehide", () => terminal.dispose(), { once: true });
