import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { waitFor } from "./recording-view.mjs";

// A process that, each time it reads `p`, clears the screen and fills the first two rows to the
// last column of its current tty width: an ASCII row ending in `Z`, then a mixed ASCII and CJK
// row ending in the wide character 身. It then reports that width in `<out>.<n>` for the n-th
// print, so a test knows the grid the PTY really had when the rows were drawn.
const SCRIPT = String.raw`import { writeFileSync } from "node:fs";
const [out] = process.argv.slice(2);
process.stdin.setRawMode(true);
let prints = 0;
process.stdin.on("data", (chunk) => {
  for (const byte of chunk) {
    if (byte === 0x71) process.exit(0);
    if (byte !== 0x70) continue;
    const cols = process.stdout.columns;
    const ascii = "x".repeat(cols - 1) + "Z";
    let mixed = "";
    let cells = 0;
    while (cells + 3 <= cols - 2) {
      mixed += "a自";
      cells += 3;
    }
    while (cells < cols - 2) {
      mixed += "=";
      cells += 1;
    }
    mixed += "身";
    process.stdout.write("\x1b[2J\x1b[H" + ascii + mixed + "\r\n");
    writeFileSync(out + "." + ++prints, JSON.stringify({ cols, ascii, mixed }));
  }
});
process.stdout.write("fit-probe-ready\r\n");
`;

export async function writeFitProbe(directory) {
  const script = join(directory, "fit-probe.mjs");
  const out = join(directory, "fit-probe");
  await writeFile(script, SCRIPT);
  let prints = 0;
  return {
    argv: [process.execPath, script, out],
    // Resolves with the next print's report once the probe has written its rows.
    async nextPrint() {
      const path = `${out}.${++prints}`;
      await waitFor("the fit probe's report", () => existsSync(path));
      return JSON.parse(await readFile(path, "utf8"));
    },
  };
}
