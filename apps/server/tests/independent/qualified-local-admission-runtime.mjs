import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalApplication } from "../../dist/entry/main.js";
import { launchIdentity } from "../../dist/entry/local-rendezvous.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import { WorkerPool } from "../../dist/terminal/worker-pool.js";
import { RunRegistry } from "../../dist/terminal/run-registry.js";
import { LocalRuntime } from "../../dist/terminal/local-runtime.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { TerminalOperations } from "../../dist/operations/terminal-operations.js";
import { SESSION_CONTROL_RESERVE } from "../../dist/terminal/worker-pipe-session.js";
import { encodeUtf8 } from "../../dist/transport/http-rpc.js";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { actualHeaders } from "../../dist/transport/local-admission.js";
import { admissionReceipts, closeAdmissionResources } from "./qualified-admission-receipts.mjs";
import { observePublicPorts } from "./qualified-admission-observer.mjs";

export const cases = JSON.parse(
  readFileSync(new URL("./qualified-local-admission-cases.json", import.meta.url)),
);
export const options = Object.freeze({
  mode: "m0-local",
  host: "127.0.0.1",
  port: 19041,
  rendezvousPath: join(tmpdir(), "cove-qualified-unpublished"),
  allowedOrigins: ["http://127.0.0.1:19042"],
});
export function fixture(name) {
  const descriptor = cases.fixedFixtures[name];
  if (!descriptor) throw new Error("Unknown original fixture: " + name);
  const bytes = readFileSync(
    new URL(`./qualified-local-admission-fixtures/${name}.bin`, import.meta.url),
  );
  if (
    bytes.length !== descriptor.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256
  )
    throw new Error("Original fixture byte binding changed: " + name);
  return bytes;
}
export function rawHeaders(input, secret, otherSecret) {
  const pairs = input.rawHeaderPairs.map((pair) => [...pair]);
  const slot = input.credential;
  if (slot && typeof slot === "object") pairs.push([slot.header, `${slot.scheme} ${secret}`]);
  else if (slot === "OTHER_LAUNCH_SECRET") pairs.push(["Authorization", `Bearer ${otherSecret}`]);
  else if (slot === "INVALID_BEARER_SCHEME") pairs.push(["Authorization", `Basic ${secret}`]);
  else if (slot === "TWO_DISTINCT_AUTHORIZATION_VALUES")
    pairs.push(["Authorization", `Bearer ${secret}`], ["aUTHORIZATION", `Bearer ${otherSecret}`]);
  return pairs;
}
export function lowerHeaders(pairs) {
  const headers = {};
  for (const [name, value] of pairs) headers[name.toLowerCase()] = value;
  return actualHeaders(headers, pairs.flat());
}
export function wsInput(input, secret, otherSecret) {
  const name = input.bootstrapEnvelopeFixture ?? input.firstMessageFixture;
  const bytes = fixture(name);
  if (name.startsWith("terminal-") || ["empty", "invalid-json", "invalid-utf8"].includes(name))
    return bytes;
  const slot = input.credentialSlot?.privateValueSlot;
  const value =
    slot === "OTHER_LAUNCH_SECRET"
      ? otherSecret
      : slot === "INVALID_SECRET_GRAMMAR"
        ? "!".repeat(43)
        : secret;
  if (input.bootstrapEnvelopeFixture)
    return Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), secret: value }));
  if (slot === "ABSENT") {
    const decoded = JSON.parse(bytes.toString());
    delete decoded.secret;
    return Buffer.from(JSON.stringify(decoded));
  }
  const result = Buffer.from(bytes);
  Buffer.from(value).copy(result, input.credentialSlot.offset);
  return result;
}
export async function withQualifiedApplication(row, body) {
  const identity = {
    serverId: "dn-server",
    relayInstanceId: "dn-instance",
    secret: launchIdentity().secret,
  };
  const otherSecret = launchIdentity().secret;
  const receipts = admissionReceipts(row, [identity.secret, otherSecret]);
  const carriers = [];
  const timers = [];
  let now = row.input.monotonicStartMs ?? 0;
  const timer = {
    set(callback, ms) {
      const handle = { callback, ms, clears: 0, ordinal: timers.length + 1 };
      timers.push(handle);
      receipts.record("original-timer-set", { ms, ordinal: handle.ordinal });
      return handle;
    },
    clear(handle) {
      if (handle) handle.clears++;
      receipts.record("original-timer-clear", { ordinal: handle?.ordinal, clears: handle?.clears });
    },
  };
  let local;
  let observer;
  let externalReceipts;
  let externalCore;
  let primary;
  try {
    if (row.id === "DN08.same-protocol-different-build") {
      const budgets = { ...M0_LIMITS };
      const composition = new RuntimeComposition(
        identity.serverId,
        identity.relayInstanceId,
        budgets,
        new RuntimeRetainedBytes(
          budgets.runtimeBytes,
          SESSION_CONTROL_RESERVE + budgets.reservedControlBytes,
        ),
      );
      const runtime = new LocalRuntime(
        new WorkerPool(composition, 1, budgets.maxRuns),
        new RunRegistry(composition),
        encodeUtf8,
      );
      externalReceipts = new OperationReceipts(composition, encodeUtf8);
      externalCore = {
        runtime,
        operations: new TerminalOperations({
          composition,
          runtime,
          receipts: externalReceipts,
          encodeUtf8,
        }),
        buildVersion: "oracle-server-a",
      };
    }
    local = createLocalApplication(options, {
      identity,
      timer,
      monotonic: () => now,
      ...(externalCore ? { core: externalCore } : {}),
    });
    observer = observePublicPorts(local, receipts.record);
    await local.app.ready();
    receipts.record("original-row-before", {
      originalInput: row.input,
      originalExpected: row.expected,
      publicIdentity: { serverId: identity.serverId, relayInstanceId: identity.relayInstanceId },
      baseline: local.core.runtime.composition.bytes.snapshot(),
    });
    await body({
      local,
      identity,
      otherSecret,
      receipts,
      observer,
      carriers,
      timers,
      setNow: (value) => {
        now = value;
        receipts.record("original-monotonic-set", { now });
      },
    });
  } catch (error) {
    primary = error;
    receipts.record("primary-before-finally", { error });
  } finally {
    // External receipts are genuine fixture owners; factory disposal does not own them.
    try {
      await closeAdmissionResources(local, carriers, observer, receipts, primary, [
        () => {
          if (externalCore && !local) {
            externalCore.operations.dispose();
            externalCore.runtime.dispose();
          }
          externalReceipts?.dispose();
          receipts.record("fixture-owned-receipts-disposed", {
            ledger: externalCore?.runtime.composition.bytes.snapshot(),
          });
        },
      ]);
    } catch (error) {
      primary = error;
    }
  }
  if (primary) throw primary;
  if (receipts.failures.length)
    throw new AggregateError(receipts.failures, "External finally persistence failed");
}
