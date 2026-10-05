import assert from "node:assert/strict";
import { validateRpcMethodResult } from "@cove/protocol/rpc";
import {
  cases,
  fixture,
  rawHeaders,
  withQualifiedApplication,
} from "./qualified-local-admission-runtime.mjs";
import { qualifiedHttpCarrier } from "./qualified-http-carrier.mjs";
import { admissionReceipts } from "./qualified-admission-receipts.mjs";

function statusResult(reply, original) {
  assert.equal(reply.status, 200);
  const parsed = JSON.parse(reply.body.toString());
  assert.equal(parsed.id, JSON.parse(original.toString()).id);
  assert.equal(validateRpcMethodResult("server.status", parsed.result), true);
}

async function readerAdmission(row) {
  await withQualifiedApplication(
    row,
    async ({ local, identity, otherSecret, receipts, carriers }) => {
      const original = fixture(row.input.bodyFixture);
      assert.equal(original.length, 75);
      const pairs = [
        ...rawHeaders(row.input, identity.secret, otherSecret),
        ["Content-Length", "75"],
      ];
      const aliases =
        row.id === "DN09.inflight-32"
          ? [...row.input.heldIds, row.input.attemptId]
          : row.input.heldIds;
      const held = [];
      for (const alias of aliases) {
        const carrier = qualifiedHttpCarrier(local, row, original, pairs, (event, fields) =>
          receipts.record(event, { transportAlias: alias, ...fields }),
        );
        carriers.push(carrier);
        carrier.beginReader(original.subarray(0, 74));
        await new Promise((resolve) => process.nextTick(resolve));
        receipts.record("original-reader-held-before-guards", {
          transportAlias: alias,
          admission: local.admission.snapshot(),
          first74: original.subarray(0, 74),
          remaining1: original.subarray(74),
          readerReadableEnded: carrier.request.readableEnded,
          requestDestroyed: carrier.request.destroyed,
          ledger: local.core.runtime.composition.bytes.snapshot(),
        });
        assert.equal(local.admission.snapshot().rpc, held.length + 1);
        assert.equal(carrier.request.readableEnded, false);
        held.push(carrier);
      }
      assert.equal(local.admission.snapshot().rpc, 32);
      assert.equal(
        receipts.events.filter((event) => event.event === "pool-snapshot-enter").length,
        0,
      );
      if (row.id === "DN09.inflight-33") {
        const attempt = qualifiedHttpCarrier(local, row, original, pairs, (event, fields) =>
          receipts.record(event, { transportAlias: row.input.attemptId, ...fields }),
        );
        carriers.push(attempt);
        const before = local.admission.snapshot().rpc;
        const reply = await attempt.route();
        receipts.record("original33-refusal-before-guards", {
          reply,
          before,
          after: local.admission.snapshot().rpc,
          dispatches: receipts.events.filter((event) => event.event === "pool-snapshot-enter")
            .length,
        });
        assert.equal(reply.status, row.expected.HTTP);
        assert.equal(before, row.expected.beforeInflight);
        assert.equal(local.admission.snapshot().rpc, row.expected.afterInflight);
        assert.equal(
          receipts.events.filter((event) => event.event === "pool-snapshot-enter").length,
          row.expected.dispatchDelta,
        );
        for (const holder of held) assert.equal(holder.request.destroyed, false);
      }
      for (const carrier of held) {
        carrier.endReader(original.subarray(74));
        const reply = await carrier.completeResponse();
        receipts.record("original-held-status-completed-before-guards", {
          reply,
          admission: local.admission.snapshot(),
        });
        statusResult(reply, original);
      }
      assert.equal(local.admission.snapshot().rpc, 0);
      assert.equal(
        receipts.events.filter((event) => event.event === "pool-snapshot-enter").length,
        32,
      );
    },
  );
}

async function publicReentry(row) {
  await withQualifiedApplication(
    row,
    async ({ local, identity, otherSecret, receipts, carriers }) => {
      const original = fixture(row.input.bodyFixture);
      const pairs = rawHeaders(row.input, identity.secret, otherSecret);
      const first = qualifiedHttpCarrier(local, row, original, pairs, (event, fields) =>
        receipts.record(event, { transportAlias: "first-original75", ...fields }),
      );
      const next = qualifiedHttpCarrier(local, row, original, pairs, (event, fields) =>
        receipts.record(event, { transportAlias: "second-original75", ...fields }),
      );
      carriers.push(first, next);
      let continuation;
      first.beginReader(original);
      first.endReader();
      const firstReply = await first.completeResponse(() => {
        receipts.record("real-public-client-end-issues-next", {
          admission: local.admission.snapshot(),
          sameOriginal75: original,
        });
        continuation = next.route();
      });
      statusResult(firstReply, original);
      assert.ok(continuation);
      const secondReply = await continuation;
      receipts.record("reentrant-two-original-results-before-guards", {
        firstReply,
        secondReply,
        admission: local.admission.snapshot(),
      });
      statusResult(secondReply, original);
      assert.equal(local.admission.snapshot().rpc, 0);
      assert.equal(
        receipts.events.filter((event) => event.event === "pool-snapshot-enter").length,
        2,
      );
      const requestIDs = receipts.events
        .filter((event) => event.event === "actual-framework-request")
        .map((event) => event.frameworkRequestID);
      assert.equal(new Set(requestIDs).size, 2);
      assert.equal(requestIDs.includes(null), false);
    },
  );
}

export async function runFixedStatus(rows) {
  const completed = [];
  const namedStageNotExercised = [];
  for (const row of rows) {
    if (row.id === "DN09.inflight-32" || row.id === "DN09.inflight-33") await readerAdmission(row);
    else if (row.id === "DN09.reentrant-completion-next-request") await publicReentry(row);
    else {
      const receipts = admissionReceipts(row, []);
      receipts.record("named-fixed-status-stage-not-exercised", {
        originalInput: row.input,
        originalExpected: row.expected,
        stage:
          "No proven exact close/held/late chronological carrier callback; no domain async substitution",
        productExecutionCredit: false,
      });
      receipts.finish("NOT_EXERCISED", []);
      namedStageNotExercised.push(row.id);
      continue;
    }
    completed.push(row.id);
  }
  assert.equal(cases.groups.fixedStatus5.length, rows.length);
  return { completed, namedStageNotExercised };
}
