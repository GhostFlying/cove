import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { runWrite, TSNET_WRITE_TIMING } from "../../dist/rpc/tsnet.js";

// The server.tsnet.login records (rpc/tsnet.ts runWrite) with a scripted node, an in-memory
// receipt store and a scripted response delivery: which record a helper outcome becomes, and
// that a login URL is recorded as delivered only once the transport reported the response that
// carried it handed over (relay-protocol §11.8). Timings are shortened through runWrite's
// `timing`. apps/cli/tests/m2/s9-tsnet-login.test.mjs covers the same rule through the compiled
// server's HTTP transport, with a client that times out or disconnects.

const LOGIN_URL = "https://login.example.test/a/write-0123456789";
const KEY = "tskey-auth-write0123456789abcdef";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const timing = (liveWaitMs) => ({
  liveWaitMs,
  key: { timeoutMs: 1_000, deadlineMs: 2_000 },
  interactive: { timeoutMs: 1_000, deadlineMs: 2_000 },
  sentWaitMs: 2_000,
});

// A receipt store that accepts every new operation and keeps each record written.
function store() {
  const records = [];
  return {
    records,
    composition: { serverId: "server-unit" },
    lookup: async () => ({ kind: "reserve" }),
    prepare: async () => ({
      commit: async (record) => (records.push(record), true),
      cancel() {},
    }),
    update: async (_key, record) => (records.push(record), true),
  };
}

// A response delivery the test settles: `open` as given, `sent` once `report` is called.
function response({ open = true } = {}) {
  let report;
  const sent = new Promise((done) => (report = done));
  return { delivery: { open: () => open, sent }, report };
}

// A node whose login answers `outcome` after `afterMs`, recording what it was asked.
function scripted(outcome, afterMs = 0) {
  const asked = [];
  return {
    asked,
    available: async () => ({ ok: true }),
    login: async (authKey, timeoutMs, deadlineMs) => {
      asked.push({ hasKey: authKey !== undefined, timeoutMs, deadlineMs });
      await delay(afterMs);
      return outcome;
    },
    logout: async () => outcome,
  };
}

const running = { state: "running", hostname: null, nodeId: "nUnit1CNTRL", nodeName: null };
const interactive = { kind: "answered", status: running, loginUrl: LOGIN_URL };
const login = (node, receipts, { authKey, delivery, live = 300 } = {}) =>
  runWrite(
    node,
    receipts,
    "principal-unit",
    "server.tsnet.login",
    { operationId: randomUUID() },
    authKey,
    delivery,
    timing(live),
  );
// The terminal record (the third: accepted, running, terminal), once it is written.
async function terminalOf(receipts) {
  for (let i = 0; i < 100 && receipts.records.length < 3; i++) await delay(20);
  expect(receipts.records).toHaveLength(3);
  return receipts.records[2];
}
const noUrlAnywhere = (receipts) =>
  expect(JSON.stringify(receipts.records)).not.toContain("login.example.test");

test("an interactive login's deadline ends inside the response budget", () => {
  const { liveWaitMs, interactive: limits, key } = TSNET_WRITE_TIMING;
  expect(limits.timeoutMs).toBeLessThan(limits.deadlineMs);
  expect(limits.deadlineMs).toBeLessThan(liveWaitMs);
  expect(key.timeoutMs).toBeLessThan(key.deadlineMs);
});

test("a URL is answered at once with the running record, and recorded as delivered only after the handover", async () => {
  const node = scripted(interactive, 20);
  const receipts = store();
  const { delivery, report } = response();
  const answer = await login(node, receipts, { delivery });
  expect(answer).toEqual({
    operation: expect.objectContaining({ state: "running" }),
    secrets: { loginUrl: LOGIN_URL },
  });
  expect(node.asked).toEqual([{ hasKey: false, timeoutMs: 1_000, deadlineMs: 2_000 }]);
  // No terminal record before the transport reported.
  await delay(50);
  expect(receipts.records.map((record) => record.state)).toEqual(["accepted", "running"]);
  report(true);
  expect(await terminalOf(receipts)).toMatchObject({
    state: "succeeded",
    result: { secretDelivery: "first-response-only" },
  });
  noUrlAnywhere(receipts);
});

test("a response that was not handed over leaves the login uncertain, never delivered", async () => {
  const receipts = store();
  const { delivery, report } = response();
  const answer = await login(scripted(interactive, 10), receipts, { delivery });
  expect(answer.secrets).toEqual({ loginUrl: LOGIN_URL });
  // The client timed out or went away after the answer was decided.
  report(false);
  const terminal = await terminalOf(receipts);
  expect(terminal).toMatchObject({ state: "failed", error: { kind: "TSNET_LOGIN_UNCERTAIN" } });
  expect(terminal.result).toBeUndefined();
  noUrlAnywhere(receipts);
});

test("a URL that comes when no response can carry it is dropped and the login is uncertain", async () => {
  // After the budget, with the response still open; with the response already closed; and with
  // no transport to confirm a handover at all.
  for (const [live, delivery] of [
    [50, response().delivery],
    [300, response({ open: false }).delivery],
    [300, undefined],
  ]) {
    const receipts = store();
    const answer = await login(scripted(interactive, 150), receipts, { delivery, live });
    expect(answer.secrets).toBeUndefined();
    const terminal = await terminalOf(receipts);
    expect(terminal).toMatchObject({ state: "failed", error: { kind: "TSNET_LOGIN_UNCERTAIN" } });
    expect(terminal.result).toBeUndefined();
    // Within the budget the dropped URL's record is the answer; after it, the running record was.
    expect(answer.operation.state).toBe(live === 300 ? "failed" : "running");
    noUrlAnywhere(receipts);
  }
});

test("an answer without a URL is committed before it is given", async () => {
  const receipts = store();
  const { delivery } = response();
  const done = { kind: "answered", status: running };
  const answer = await login(scripted(done), receipts, { authKey: KEY, delivery });
  expect(answer).toEqual({ operation: receipts.records[2] });
  expect(answer.operation).toMatchObject({ state: "succeeded" });
  expect(answer.operation.result).toBeUndefined();
  expect(JSON.stringify(receipts.records)).not.toContain(KEY);
});

test("an interactive login that timed out is uncertain; an auth-key one left the node unchanged", async () => {
  const timedOut = { kind: "refused", code: "LOGIN_TIMEOUT" };
  // Whether the node had state or not: the helper keeps the started node, and an enrolled one
  // held, so it is not known to be as it was.
  const interactiveAnswer = await login(scripted(timedOut), store(), {
    delivery: response().delivery,
  });
  expect(interactiveAnswer.operation).toMatchObject({
    state: "failed",
    error: { kind: "TSNET_LOGIN_UNCERTAIN" },
  });
  const keyAnswer = await login(scripted(timedOut), store(), {
    authKey: KEY,
    delivery: response().delivery,
  });
  expect(keyAnswer.operation).toMatchObject({
    state: "failed",
    error: { kind: "TSNET_LOGIN_FAILED" },
  });
  expect(JSON.stringify(keyAnswer)).not.toContain(KEY);
});
