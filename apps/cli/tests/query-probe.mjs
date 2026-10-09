import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { waitFor } from "./recording-view.mjs";

// A process that sends DA (ESC[c) and CPR (ESC[6n) to its terminal and records every byte it
// reads back until the typed line `done`. In "wait" mode it asks after the typed line `go`;
// in "now" mode it asks at once. `<out>.seen` appears once both replies have arrived.
const SCRIPT = String.raw`import { writeFileSync } from "node:fs";
const [mode, out] = process.argv.slice(2);
process.stdin.setRawMode(true);
let received = "";
let asked = false;
let seen = false;
const ask = () => {
  asked = true;
  received = "";
  process.stdout.write("\x1b[c\x1b[6n");
};
process.stdin.on("data", (chunk) => {
  received += chunk.toString("latin1");
  if (!asked) {
    if (received.includes("go\r")) ask();
    return;
  }
  if (!seen && /\x1b\[\?[\d;]*c/.test(received) && /\x1b\[\d+;\d+R/.test(received)) {
    seen = true;
    writeFileSync(out + ".seen", "");
    process.stdout.write("replies-seen\r\n");
  }
  const end = received.indexOf("done\r");
  if (end >= 0) {
    writeFileSync(out, JSON.stringify(received.slice(0, end)));
    process.exit(0);
  }
});
process.stdout.write("query-probe-ready\r\n");
if (mode === "now") ask();
`;

// Exactly one primary DA reply and one CPR reply, in query order, then `rest`.
export const QUERY_REPLIES_THEN = (rest) =>
  new RegExp(String.raw`^\u001b\[\?[\d;]*c\u001b\[\d+;\d+R` + rest + "$");

// Write the probe into `directory`; the run is created from `argv` by the caller.
export async function writeQueryProbe(directory, mode) {
  const script = join(directory, "query-probe.mjs");
  const out = join(directory, `query-probe-${mode}.json`);
  await writeFile(script, SCRIPT);
  return {
    argv: [process.execPath, script, mode, out],
    out,
    seen: () => existsSync(`${out}.seen`),
    async received() {
      await waitFor("the probe's report", () => existsSync(out));
      return JSON.parse(await readFile(out, "utf8"));
    },
  };
}
