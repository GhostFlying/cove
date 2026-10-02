import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function publishTimingReceipt(path, value, writeTemporary = writeFileSync) {
  const serialized = JSON.stringify(value);
  const temporary = join(dirname(path), `.${basename(path)}-${process.pid}-${randomUUID()}.tmp`);
  let owned = false;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    owned = true;
    try {
      writeTemporary(descriptor, serialized);
    } finally {
      closeSync(descriptor);
    }
    // The strict reader must see either the previous receipt or all new bytes.
    renameSync(temporary, path);
  } finally {
    if (owned) rmSync(temporary, { force: true });
  }
}
