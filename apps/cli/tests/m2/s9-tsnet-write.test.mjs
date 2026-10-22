import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

// The server.tsnet.login and logout records (apps/server rpc/tsnet.ts runWrite) in process, with
// a scripted node and an in-memory receipt store: which record a helper outcome becomes, and that
// a login LOGIN_URL is delivered exactly when the record says it was. Timings are shortened through
// runWrite's `timing`, so a LOGIN_URL that arrives after the live wait is deterministic.

const serverPackage = dirname(createRequire(import.meta.url).resolve("@cove/server/package.json"));
const { runWrite, TSNET_WRITE_TIMING } = await import(
  pathToFileURL(join(serverPackage, "dist", "rpc", "tsnet.js")).href
);

const LOGIN_URL = "https://login.example.test/a/write-0123456789";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const timing = (liveWaitMs) => ({
  liveWaitMs,
  key: { timeoutMs: 1_000, deadlineMs: 2_000 },
  interactive: { timeoutMs: 1_000, deadlineMs: 2_000 },
});

// A receipt store that accepts every new operation and keeps each record written; `commitMs`
// delays each update.
function store({ commitMs = 0 } = {}) {
  const records = [];
  return {
    records,
    composition: { serverId: "server-unit" },
    lookup: async () => ({ kind: "reserve" }),
    prepare: async () => ({
      commit: async (record) => (records.push(record), true),
      cancel() {},
    }),
    update: async (_key, record) => {
      await delay(commitMs);
      records.push(record);
      return true;
    },
  };
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
const login = (node, receipts, authKey, live = 200) =>
  runWrite(
    node,
    receipts,
    "principal-unit",
    "server.tsnet.login",
    { operationId: randomUUID() },
    authKey,
    timing(live),
  );
const terminalOf = async (receipts) => {
  for (let i = 0; i < 100 && receipts.records.length < 3; i++) await delay(20);
  return receipts.records.at(-1);
};

test("an interactive login's deadline ends inside the live wait", () => {
  const { liveWaitMs, interactive: limits, key } = TSNET_WRITE_TIMING;
  expect(limits.timeoutMs).toBeLessThan(limits.deadlineMs);
  expect(limits.deadlineMs).toBeLessThan(liveWaitMs);
  expect(key.timeoutMs).toBeLessThan(key.deadlineMs);
});

test("a LOGIN_URL that arrives within the live wait is delivered with the record that says so", async () => {
  const node = scripted(interactive, 20);
  const receipts = store();
  const answer = await login(node, receipts, undefined);
  expect(answer.secrets).toEqual({ loginUrl: LOGIN_URL });
  expect(answer.operation).toMatchObject({
    state: "succeeded",
    result: { secretDelivery: "first-response-only" },
  });
  expect(node.asked).toEqual([{ hasKey: false, timeoutMs: 1_000, deadlineMs: 2_000 }]);
  expect(JSON.stringify(receipts.records)).not.toContain("login.example.test");
});

test("a LOGIN_URL that arrives after the live wait is never recorded as delivered", async () => {
  const receipts = store();
  const answer = await login(scripted(interactive, 150), receipts, undefined, 50);
  expect(answer.operation.state).toBe("running");
  expect(answer.secrets).toBeUndefined();
  const terminal = await terminalOf(receipts);
  expect(terminal).toMatchObject({ state: "failed", error: { kind: "TSNET_LOGIN_UNCERTAIN" } });
  expect(terminal.result).toBeUndefined();
  expect(JSON.stringify(receipts.records)).not.toContain("login.example.test");
});

test("an answer claimed within the live wait is delivered even when its commit outlasts the wait", async () => {
  const receipts = store({ commitMs: 150 });
  const answer = await login(scripted(interactive, 10), receipts, undefined, 50);
  expect(answer.secrets).toEqual({ loginUrl: LOGIN_URL });
  expect(answer.operation).toMatchObject({
    state: "succeeded",
    result: { secretDelivery: "first-response-only" },
  });
  expect(receipts.records.at(-1)).toEqual(answer.operation);
});
