import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function admissionReceipts(row, privateSecrets) {
  const secrets = Array.isArray(privateSecrets) ? privateSecrets : [privateSecrets];
  const redact = (value) =>
    secrets.reduce((text, secret) => text.replaceAll(secret, "?".repeat(secret.length)), value);
  const root = process.env.COVE_D_QUALIFIED_OUTPUT;
  if (!root) throw new Error("Mandatory qualified admission sink unavailable");
  const path = join(root, row.id);
  mkdirSync(path, { recursive: true });
  let ordinal = 0;
  const events = [];
  const failures = [];
  function publicValue(value, seen = new WeakSet()) {
    if (typeof value === "string") return redact(value);
    if (value instanceof Error)
      return {
        name: value.name,
        message: publicValue(value.message),
        stack: publicValue(value.stack),
      };
    if (!value || typeof value !== "object") return value;
    if (value instanceof Uint8Array) {
      const bytes = Buffer.from(value);
      const redacted = Buffer.from(redact(bytes.toString("latin1")), "latin1");
      return {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        publicBytesBase64: redacted.toString("base64"),
        privateSlotsRedacted: !bytes.equals(redacted),
      };
    }
    if (seen.has(value)) return { repeatedPublicObject: true };
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => publicValue(item, seen));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, publicValue(item, seen)]),
    );
  }
  function record(event, fields = {}) {
    try {
      const receipt = publicValue(typeof event === "object" ? event : { event, ...fields });
      receipt.originalRowID = row.id;
      receipt.captureOrdinal = ++ordinal;
      events.push(receipt);
      writeFileSync(
        join(path, `${String(ordinal).padStart(5, "0")}.json`),
        JSON.stringify(receipt, null, 2) + "\n",
      );
    } catch (error) {
      failures.push(error);
    }
  }
  function finish(state, errors) {
    record("inner-result", { state, errors, originalExpected: row.expected });
    if (failures.length) throw new AggregateError(failures, "Qualified capture persistence failed");
  }
  return { record, finish, events, failures, publicValue };
}

export async function closeAdmissionResources(
  local,
  carriers,
  observer,
  receipts,
  primary,
  additionalCleanup = [],
) {
  const errors = primary ? [primary] : [];
  receipts.record("finally-before", {
    admission: local?.admission.snapshot(),
    ledger: local?.core.runtime.composition.bytes.snapshot(),
  });
  for (const carrier of carriers) {
    try {
      await carrier.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await local?.app.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    local?.disposeCore();
  } catch (error) {
    errors.push(error);
  }
  for (const close of additionalCleanup) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (local && Object.values(local.admission.snapshot()).some((count) => count !== 0))
    errors.push(new Error("Own factory admission claims remain after real finally"));
  if (local && local.core.runtime.composition.bytes.snapshot().total !== 0)
    errors.push(
      new Error("Own factory aggregate ledger remains after disposal; no host-zero inference"),
    );
  const effectiveReleases = new Map();
  for (const event of receipts.events) {
    if (
      /^public-(lease|claim)-release-\d+-return$/.test(event.event) &&
      event.before.total > event.ledger.total
    ) {
      const count = (effectiveReleases.get(event.observerTargetID) ?? 0) + 1;
      effectiveReleases.set(event.observerTargetID, count);
      if (count > 1)
        errors.push(new Error("Same observed public lease had multiple effective byte releases"));
    }
    if (
      event.admission &&
      (event.admission.unauthenticated > 8 ||
        event.admission.authenticated > 32 ||
        event.admission.rpc > 32)
    )
      errors.push(new Error("Actual public admission exceeded original default cap"));
  }
  receipts.record("finally-after", {
    admission: local?.admission.snapshot(),
    ledger: local?.core.runtime.composition.bytes.snapshot(),
    errors,
  });
  try {
    observer?.finishObservation();
  } catch (error) {
    errors.push(error);
  }
  try {
    receipts.finish(errors.length ? "FAIL" : "PASS", errors);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Original primary and actual cleanup retained");
}
