import assert from "node:assert/strict";
import { ADMISSION_STATUS, BootstrapSuccessSchema } from "@cove/protocol/bootstrap";
import {
  composeRpcResponse,
  validateRpcResponse,
  validateRpcMethodResult,
} from "@cove/protocol/rpc";
import { validateLocalOptions } from "../../dist/entry/m0-local-options.js";
import { boundRpcResponseBody, encodeUtf8 } from "../../dist/transport/http-rpc.js";
import { admissionReceipts } from "./qualified-admission-receipts.mjs";
import { fixture, options } from "./qualified-local-admission-runtime.mjs";

export function checkHttp(row, reply, receipts) {
  const expected = row.expected;
  const status =
    typeof expected.HTTP === "number"
      ? expected.HTTP
      : expected.BootstrapFailure
        ? expected.BootstrapFailure.kind === "BOOTSTRAP_UNSUPPORTED"
          ? 400
          : 409
        : ADMISSION_STATUS[expected.admission ?? "accepted"];
  assert.equal(reply.status, status, row.id + " original HTTP status");
  const parsed = reply.body.length ? JSON.parse(reply.body.toString("utf8")) : undefined;
  if (expected.BootstrapFailure) assert.deepEqual(parsed, expected.BootstrapFailure);
  if (expected.RpcError) assert.deepEqual(parsed, expected.RpcError);
  if (Object.hasOwn(expected, "errorCode")) {
    assert.equal(parsed.error.code, expected.errorCode);
    assert.equal(parsed.error.message, expected.message);
    assert.equal(parsed.id, expected.id);
  }
  if (Object.hasOwn(expected, "bodyBytes")) assert.equal(reply.body.length, expected.bodyBytes);
  for (const [name, value] of expected.responseIdentityHeaders ?? [])
    assert.equal(String(reply.headers[name.toLowerCase()]), value);
  assert.equal(Object.hasOwn(reply.headers, "authorization"), false);
  assert.equal(reply.body.includes(Buffer.from('"secret":')), false);
  if (row.input.method === "OPTIONS" && status === 200) {
    assert.equal(reply.headers["access-control-allow-methods"], "POST");
    assert.equal(
      reply.headers["access-control-allow-headers"],
      "Authorization, Content-Type, Cove-Protocol, Cove-Server-Id, Cove-Instance-Id",
    );
    assert.equal(reply.body.length, 0);
  }
  if (
    status === 200 &&
    row.input.method === "POST" &&
    row.input.path === "/bootstrap" &&
    !expected.BootstrapFailure
  ) {
    assert.equal(BootstrapSuccessSchema.safeParse(parsed).success, true);
    assert.equal(parsed.serverId, "dn-server");
    assert.equal(parsed.relayInstanceId, "dn-instance");
    if (expected.negotiatedServerBuild)
      assert.equal(parsed.buildVersion, expected.negotiatedServerBuild);
  }
  const dispatches = receipts.events.filter(
    (event) => event.event === "pool-snapshot-enter",
  ).length;
  if (Object.hasOwn(expected, "dispatchCount")) assert.equal(dispatches, expected.dispatchCount);
  if (Object.hasOwn(expected, "dispatchCalls")) assert.equal(dispatches, expected.dispatchCalls);
  if (expected.dispatchExactly) assert.equal(dispatches, expected.dispatchExactly["server.status"]);
  if (Object.hasOwn(expected, "domainCalls")) assert.equal(dispatches, expected.domainCalls);
  if (expected.responses) {
    const original = JSON.parse(fixture(row.input.bodyFixture).toString());
    assert.equal(parsed.length, 16);
    assert.deepEqual(parsed.map((item) => item.id).sort(), original.map((item) => item.id).sort());
    for (const item of parsed) {
      assert.notEqual(validateRpcResponse(item), null);
      assert.equal(validateRpcMethodResult("server.status", item.result), true);
    }
  } else if (parsed?.result && row.input.path === "/rpc") {
    assert.notEqual(validateRpcResponse(parsed), null);
    assert.equal(validateRpcMethodResult("server.status", parsed.result), true);
  }
  if (expected.noBusinessPublication) {
    assert.equal(dispatches, 0);
    assert.equal(
      receipts.events.filter((event) => /^(operation|runtime)-.*-enter$/.test(event.event)).length,
      0,
    );
    receipts.record("denied-private-boundary-source-qualified", {
      directBusinessDecodeCounter: "NOT_EXPOSED",
      sourceInference: "Original admission/reader route returns before business decode/dispatch",
      observedPublicMutationCalls: 0,
    });
  }
}

export function checkWebSocket(row, carrier, local, receipts, timers) {
  const expected = row.expected;
  if (expected.WSclose) assert.equal(carrier.closeCodes[0], expected.WSclose);
  if (expected.BootstrapFailure)
    assert.deepEqual(JSON.parse(carrier.writes[0].toString()), expected.BootstrapFailure);
  if (
    expected.authenticated ||
    expected.authPromotion === 1 ||
    typeof expected.authPromotion === "string"
  ) {
    assert.equal(local.admission.snapshot().authenticated, 1);
    assert.equal(local.admission.snapshot().unauthenticated, 0);
    const result = JSON.parse(carrier.writes[0].toString());
    assert.equal(BootstrapSuccessSchema.safeParse(result).success, true);
    assert.equal(Object.hasOwn(result, "secret"), false);
    assert.equal(result.connection.generation, 1);
    assert.notEqual(result.connection.connectionId, "dn-connection");
  }
  if (expected.authPromotion === 0) assert.equal(local.admission.snapshot().authenticated, 0);
  if (expected.cancelAuthTimerOnce) assert.equal(timers[0].clears, 1);
  if (expected.noLaterTimeoutClose) assert.equal(carrier.closeCodes.length, 0);
  if (expected.claimRelease === 1) assert.equal(local.admission.snapshot().unauthenticated, 0);
  if (expected.noBusinessPublication) {
    assert.equal(
      receipts.events.filter((event) => /^(operation|runtime)-.*-enter$/.test(event.event)).length,
      0,
    );
    receipts.record("ws-denied-private-boundary-source-qualified", {
      actualPublicMutationCalls: 0,
      directBusinessDecodeCounter: "NOT_EXPOSED",
      sourceInference:
        "Original first-message branch denies before TerminalCommandService business input",
    });
  }
}

const domainKeys = [
  "workerCreates",
  "runCreates",
  "receiptReservations",
  "spawn",
  "stop",
  "input",
  "resize",
  "control",
  "openSubscription",
  "closeSubscription",
  "ackApplied",
  "preview",
  "businessDecode",
  "dispatch",
  "foreignMutations",
  "sensitivePublications",
];
function checkDeniedTrace(trace) {
  for (const [key, refused] of Object.entries({
    accepted: true,
    businessDecode: 1,
    unauthPeak: 9,
    sensitivePublications: 1,
    sameOwnerReleaseEvents: 2,
    foreignMutations: 1,
  })) {
    if (
      Object.hasOwn(trace, key) &&
      (key === "accepted" ? trace[key] === refused : trace[key] >= refused)
    )
      throw new Error(key);
  }
  assert.equal(trace.admission, "forbidden");
  assert.equal(trace.HTTP, 403);
  assert.equal(trace.ownQuotaAfterFinally, 0);
  assert.equal(trace.foreignUnchanged, true);
  assert.equal(trace.sensitivePublications, 0);
  assert.deepEqual(Object.keys(trace.domainDelta).sort(), [...domainKeys].sort());
  for (const value of Object.values(trace.domainDelta)) assert.equal(value, 0);
}

export function runComponent(row) {
  const receipts = admissionReceipts(row, []);
  let primary;
  try {
    receipts.record("component-original-before", {
      input: row.input,
      expected: row.expected,
      runtimeClass: "COMPONENT_ONLY",
    });
    if (row.id.startsWith("DN01.")) {
      const input = {
        ...options,
        mode: row.input.explicit ? row.input.mode : undefined,
        host: row.input.listen,
        port: row.input.port === "ABSENT" ? undefined : row.input.port,
      };
      assert.throws(() => validateLocalOptions(input), /Invalid explicit m0-local options/);
      receipts.record("options-refusal", { bindOrPublication: "NOT_INVOKED_COMPONENT_ONLY" });
    } else if (row.id.startsWith("DN09.")) {
      const bytes = fixture(
        row.input.schemaValidGenericRpcResponseFixture ?? row.input.schemaInvalidRpcResponseFixture,
      );
      const parsed = JSON.parse(bytes.toString());
      const composed = composeRpcResponse(parsed, encodeUtf8);
      const bounded = boundRpcResponseBody(JSON.stringify(composed ?? parsed), 262144);
      receipts.record("real-production-composer-before-guards", {
        originalBytes: bytes,
        composed,
        bounded,
        runtimeClass: "COMPONENT_ONLY",
      });
      if (row.expected.productionComposeResult === null) {
        assert.equal(composed, null);
        if (row.expected.encodedBytes) assert.equal(bounded.status, 413);
      } else {
        assert.deepEqual(composed, parsed);
        assert.equal(bounded.status, 200);
        assert.equal(Buffer.byteLength(bounded.body), row.expected.encodedBytes);
      }
    } else if (row.expected.expectedCheckerResult === "REFUSE") {
      assert.throws(
        () => checkDeniedTrace(row.input.deliberatelyMutatedLocalTrace),
        new RegExp(row.expected.minimumMismatchField),
      );
      receipts.record("checker-refused-original-mutation", { productRuntimeCredit: false });
    } else {
      checkDeniedTrace(row.input.checkerOnlyTrace);
      receipts.record("checker-accepted-original-control", { productRuntimeCredit: false });
    }
  } catch (error) {
    primary = error;
    receipts.record("component-primary", { error });
  }
  receipts.finish(primary ? "FAIL" : "PASS", primary ? [primary] : []);
  if (primary) throw primary;
}
