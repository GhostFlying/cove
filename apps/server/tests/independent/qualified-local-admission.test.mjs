import assert from "node:assert/strict";
import { describe, it, expect } from "vitest";
import { ADMISSION_STATUS } from "@cove/protocol/bootstrap";
import {
  cases,
  fixture,
  rawHeaders,
  lowerHeaders,
  wsInput,
  withQualifiedApplication,
} from "./qualified-local-admission-runtime.mjs";
import { qualifiedHttpCarrier } from "./qualified-http-carrier.mjs";
import { qualifiedWebSocketCarrier } from "./qualified-websocket-carrier.mjs";
import { checkHttp, checkWebSocket, runComponent } from "./qualified-local-admission-checks.mjs";
import { runFixedStatus } from "./qualified-status-carrier.mjs";
import { admissionReceipts } from "./qualified-admission-receipts.mjs";

const rows = new Map(cases.rows.map((row) => [row.id, row]));

async function runHttp(row) {
  await withQualifiedApplication(
    row,
    async ({ local, identity, otherSecret, receipts, carriers, observer }) => {
      const input = fixture(row.input.bootstrapEnvelopeFixture ?? row.input.bodyFixture);
      const carrier = qualifiedHttpCarrier(
        local,
        row,
        input,
        rawHeaders(row.input, identity.secret, otherSecret),
        (event, fields) =>
          receipts.record(event, {
            ...fields,
            actualFactoryRawRequestID: observer.requestIDFor(carrier.request),
          }),
      );
      carriers.push(carrier);
      const reply = await carrier.route();
      receipts.record("http-original-projection-before-guards", {
        reply,
        admission: local.admission.snapshot(),
        ledger: local.core.runtime.composition.bytes.snapshot(),
        rawHeaders: carrier.request.rawHeaders,
      });
      assert.notEqual(observer.requestIDFor(carrier.request), null);
      checkHttp(row, reply, receipts);
      if (row.expected.encodedReceivedBytes)
        assert.equal(input.length, row.expected.encodedReceivedBytes);
      if (row.expected.actualBodyBytes) assert.equal(input.length, row.expected.actualBodyBytes);
    },
  );
}

function acceptPeer(local, input, peerID, receipts, carriers, held = false) {
  const pairs = input.rawHeaderPairs;
  const preparation = local.terminal.prepare(lowerHeaders(pairs));
  receipts.record("actual-public-ws-prepare-return", {
    peerID,
    rawHeaderPairs: pairs,
    kind: preparation.kind,
    claimPresent: !!preparation.claim,
    admission: local.admission.snapshot(),
  });
  if (!preparation.claim) return { preparation };
  const carrier = qualifiedWebSocketCarrier(peerID, receipts.record, held);
  carriers.push(carrier);
  local.terminal.accept(carrier.socket, preparation.claim);
  receipts.record("actual-public-ws-accept-return", {
    peerID,
    admission: local.admission.snapshot(),
  });
  return { preparation, carrier };
}

async function runQuota(row) {
  await withQualifiedApplication(
    row,
    async ({ local, identity, otherSecret, receipts, carriers, observer }) => {
      const input = row.input;
      const lower = input.rawUpgrade ?? input.bootstrap;
      const authenticated = [];
      for (const peerID of input.heldAuth ?? input.peers ?? []) {
        const accepted = acceptPeer(local, lower, peerID, receipts, carriers);
        assert.ok(accepted.carrier);
        accepted.carrier.message(wsInput(lower, identity.secret, otherSecret), false);
        await accepted.carrier.settle();
        assert.equal(accepted.carrier.closeCodes.length, 0);
        authenticated.push(accepted.carrier);
      }
      const unauthenticated = [];
      for (const peerID of input.heldUnauth ?? input.upgrades ?? []) {
        const accepted = acceptPeer(local, lower, peerID, receipts, carriers);
        assert.ok(accepted.carrier);
        unauthenticated.push(accepted.carrier);
      }
      const before = local.admission.snapshot();
      receipts.record("quota-original-before-attempt", {
        before,
        authenticatedPeerIDs: authenticated.map(
          (_, index) => (input.heldAuth ?? input.peers)[index],
        ),
        unauthenticatedPeerIDs: input.heldUnauth ?? input.upgrades ?? [],
      });
      if (input.attempt) {
        const attempt = acceptPeer(local, lower, input.attempt, receipts, carriers);
        if (input.heldAuth) {
          assert.ok(attempt.carrier);
          attempt.carrier.message(wsInput(lower, identity.secret, otherSecret), false);
          await attempt.carrier.settle();
          receipts.record("quota-original-after-attempt-before-guards", {
            codes: attempt.carrier.closeCodes,
            after: local.admission.snapshot(),
          });
          assert.equal(attempt.carrier.closeCodes[0], row.expected.WSclose);
          assert.equal(local.admission.snapshot().authenticated, row.expected.authAfter);
        } else {
          receipts.record("quota-original-after-attempt-before-guards", {
            preparation: attempt.preparation,
            after: local.admission.snapshot(),
          });
          assert.equal(ADMISSION_STATUS[attempt.preparation.kind], row.expected.HTTP);
          assert.equal(local.admission.snapshot().unauthenticated, row.expected.unauthAfter);
        }
      } else if (input.promote) {
        const peer = unauthenticated[input.heldUnauth.indexOf(input.promote)];
        assert.ok(peer);
        assert.equal(before.unauthenticated, row.expected.unauthBefore);
        peer.message(wsInput(lower, identity.secret, otherSecret), false);
        receipts.record("promotion-denied-until-genuine-close", {
          codes: peer.closeCodes,
          admission: local.admission.snapshot(),
        });
        assert.equal(local.admission.snapshot().unauthenticated, row.expected.unauthUntilOwnClose);
        await peer.settle();
        receipts.record("promotion-denied-after-genuine-close-before-guards", {
          codes: peer.closeCodes,
          admission: local.admission.snapshot(),
        });
        assert.equal(peer.closeCodes[0], row.expected.WSclose);
        assert.equal(local.admission.snapshot().unauthenticated, row.expected.unauthAfterOwnClose);
        assert.equal(local.admission.snapshot().authenticated, row.expected.authAfter);
        const counterpart = rows.get("DN03.rpc-exact");
        const statusBytes = fixture(counterpart.input.bodyFixture);
        const status = qualifiedHttpCarrier(
          local,
          counterpart,
          statusBytes,
          rawHeaders(counterpart.input, identity.secret, otherSecret),
          (event, fields) =>
            receipts.record(event, {
              ...fields,
              control: "original-healthy-status-counterpart",
              actualFactoryRawRequestID: observer.requestIDFor(status.request),
            }),
        );
        carriers.push(status);
        const reply = await status.route();
        receipts.record("healthy-status-counterpart-before-guards", {
          reply,
          admission: local.admission.snapshot(),
        });
        assert.equal(reply.status, 200);
        assert.equal(JSON.parse(reply.body.toString()).result.serverId, "dn-server");
      } else if (input.peers) {
        receipts.record("quota-original-auth32-before-guards", { admission: before });
        assert.equal(before.authenticated, row.expected.authPeak);
        assert.equal(before.unauthenticated, row.expected.unauthFinal);
        assert.equal(authenticated.length, row.expected.authAccepted);
      } else {
        receipts.record("quota-original-unauth8-before-guards", { admission: before });
        assert.equal(before.unauthenticated, row.expected.unauthPeak);
        assert.equal(before.authenticated, row.expected.auth);
        assert.equal(unauthenticated.length, row.expected.upgradeAccepted);
      }
      for (const peer of authenticated) assert.equal(peer.transport.closed, false);
      receipts.record("quota-healthy-peers-preserved", {
        actualAuth: local.admission.snapshot().authenticated,
        publicOperationsCalls: receipts.events.filter((event) =>
          /^(operation|runtime)-.*-enter$/.test(event.event),
        ).length,
      });
      assert.equal(
        receipts.events.filter((event) => /^(operation|runtime)-.*-enter$/.test(event.event))
          .length,
        0,
      );
    },
  );
}

async function runWebSocket(row) {
  if (row.input.ordering === "close-before-message") {
    const receipts = admissionReceipts(row, []);
    receipts.record("original-named-stage-not-exercised", {
      originalInput: row.input,
      originalExpected: row.expected,
      stage: "physical-close-before-genuine-late-message",
      reason:
        "The lower adapter has no genuine post-close ingress; invoking its EventEmitter would manufacture delivery",
      timerOnlyWholeRowCredit: false,
    });
    receipts.finish("NOT_EXERCISED", []);
    return false;
  }
  await withQualifiedApplication(
    row,
    async ({ local, identity, otherSecret, receipts, carriers, timers, setNow }) => {
      const lower = row.input;
      let healthy;
      if (lower.callbackOrder) {
        healthy = acceptPeer(local, lower, "dn07-distinct-healthy", receipts, carriers);
        assert.ok(healthy.carrier);
      }
      const peer = acceptPeer(
        local,
        lower,
        lower.ownPeerId ?? row.id,
        receipts,
        carriers,
        !!lower.callbackOrder,
      );
      if (!peer.carrier) {
        receipts.record("original-upgrade-denied-before-guards", { preparation: peer.preparation });
        assert.equal(ADMISSION_STATUS[peer.preparation.kind], row.expected.HTTP);
        return;
      }
      const carrier = peer.carrier;
      const ownTimer = timers.filter((timer) => timer.ms === 5000).at(-1);
      assert.ok(ownTimer);
      const baseline = healthy ? local.admission.snapshot().unauthenticated : undefined;
      if (lower.messageAtMs !== undefined) setNow(lower.messageAtMs);
      if (
        lower.ordering === "expiry-before-message" ||
        lower.callbackOrder === "timeout-close-late-send"
      ) {
        receipts.record("original-due-timer-before", {
          ordinal: ownTimer.ordinal,
          deadlineMs: ownTimer.ms,
          originalMessageAtMs: lower.messageAtMs,
          physicalClosed: carrier.transport.closed,
        });
        ownTimer.callback();
        receipts.record("original-due-timer-after-before-guards", {
          ordinal: ownTimer.ordinal,
          sourceRequestedCodes: carrier.closeCodes,
          physicalClosed: carrier.transport.closed,
          admission: local.admission.snapshot(),
        });
        if (lower.ordering === "expiry-before-message") {
          assert.equal(carrier.transport.closed, false);
          assert.equal(carrier.closeCodes[0], row.expected.WSclose);
        }
      }
      if (lower.callbackOrder === "close-close-timeout") {
        await carrier.dispose();
        await carrier.dispose();
        ownTimer.callback();
      } else {
        carrier.message(
          wsInput(lower, identity.secret, otherSecret),
          lower.firstMessageKind === "binary" || lower.messageKind === "binary",
        );
        if (lower.ordering === "expiry-before-message") {
          receipts.record("original-expiry-message-delivered-before-physical-close", {
            physicalClosed: carrier.transport.closed,
            admission: local.admission.snapshot(),
          });
          assert.equal(carrier.transport.closed, false);
        }
        if (lower.extraMessageFixture)
          carrier.message(
            wsInput(
              { ...lower, firstMessageFixture: lower.extraMessageFixture },
              identity.secret,
              otherSecret,
            ),
            lower.extraMessageKind === "binary",
          );
        if (lower.ordering === "message-before-expiry") {
          assert.equal(ownTimer.clears, 1);
          receipts.record("original-canceled-timer-not-delivered", { ordinal: ownTimer.ordinal });
        }
        if (lower.callbackOrder === "promotion-send-close-late-send") await carrier.dispose();
      }
      await carrier.settle();
      if (lower.callbackOrder) {
        await carrier.dispose();
        await carrier.lateWriteCompletion();
        receipts.record("original-late-sequence-before-guards", {
          callbackOrder: lower.callbackOrder,
          ownCodes: carrier.closeCodes,
          admission: local.admission.snapshot(),
          healthyClosed: healthy.carrier.transport.closed,
        });
        assert.equal(healthy.carrier.transport.closed, false);
        assert.equal(local.admission.snapshot().unauthenticated, baseline - 1);
        assert.equal(local.admission.snapshot().authenticated, 0);
      } else {
        receipts.record("ws-original-projection-before-guards", {
          writes: carrier.writes,
          closeCodes: carrier.closeCodes,
          admission: local.admission.snapshot(),
          timers: timers.map((timer) => ({ ms: timer.ms, clears: timer.clears })),
        });
        checkWebSocket(row, carrier, local, receipts, timers);
      }
    },
  );
  return true;
}

describe("qualified local admission original fixed rows", () => {
  it("routes the original98 HTTP-group rows with actual factory carriers and quota schedules", async () => {
    const passed = [];
    for (const id of cases.groups.http98) {
      const row = rows.get(id);
      if (row.input.upgrades || row.input.heldUnauth || row.input.heldAuth || row.input.peers)
        await runQuota(row);
      else await runHttp(row);
      passed.push(id);
    }
    expect(passed).toEqual(cases.groups.http98);
  });
  it("routes the original48 lower WS-group rows with actual public handler and owned streams", async () => {
    const passed = [];
    const namedStageNotExercised = [];
    for (const id of cases.groups.wsLower48) {
      if (await runWebSocket(rows.get(id))) passed.push(id);
      else namedStageNotExercised.push(id);
    }
    expect(namedStageNotExercised).toEqual(["DN06.clock-5000-close-before-message"]);
    expect(passed).toEqual(
      cases.groups.wsLower48.filter((id) => id !== "DN06.clock-5000-close-before-message"),
    );
  });
  it("checks the original20 option composer and sensitivity component rows", () => {
    const passed = [];
    for (const id of cases.groups.component20) {
      runComponent(rows.get(id));
      passed.push(id);
    }
    expect(passed).toEqual(cases.groups.component20);
  });
  it("executes reachable fixed status admission and public completion schedules with explicit stage limits", async () => {
    const result = await runFixedStatus(cases.groups.fixedStatus5.map((id) => rows.get(id)));
    expect(result.completed).toEqual([
      "DN09.inflight-32",
      "DN09.inflight-33",
      "DN09.reentrant-completion-next-request",
    ]);
    expect(result.namedStageNotExercised).toEqual([
      "DN09.held-completion-close-late-completion",
      "DN09.close-held-completion-close",
    ]);
  });
});
