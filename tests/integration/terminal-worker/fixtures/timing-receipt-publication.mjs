import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function publishTimingReceipt(
  path,
  value,
  writeTemporary = writeFileSync,
  { closeTemporary = closeSync, removeTemporary = rmSync } = {},
) {
  const serialized = JSON.stringify(value);
  const temporary = join(dirname(path), `.${basename(path)}-${process.pid}-${randomUUID()}.tmp`);
  const errors = [];
  let descriptor;
  let owned = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    owned = true;
    writeTemporary(descriptor, serialized);
  } catch (error) {
    errors.push(error);
  }
  if (descriptor !== undefined) {
    try {
      closeTemporary(descriptor);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) {
    try {
      // The strict reader must see either the previous receipt or all new bytes.
      renameSync(temporary, path);
      owned = false;
    } catch (error) {
      errors.push(error);
    }
  }
  if (owned) {
    try {
      removeTemporary(temporary, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Timing receipt publication failed", { cause: errors[0] });
}
