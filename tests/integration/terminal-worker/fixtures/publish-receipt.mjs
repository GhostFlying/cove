import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Fixture children publish receipts that the parent polls for and parses as soon as the path
// exists (`receipt()` in pipe-harness.mjs). A plain writeFileSync creates the path before its
// bytes land, so a poll between the two read an empty or partial file and failed with
// "Unexpected end of JSON input" (#87). Writing a sibling temporary file and renaming it over the
// path means a reader sees either no receipt or all of it.
export function publishReceipt(path, text) {
  const temporary = join(dirname(path), `.${basename(path)}-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
