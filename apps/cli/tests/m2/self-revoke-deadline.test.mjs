import { createServer } from "node:net";
import { afterEach, expect, test } from "vitest";
import { directCallClient } from "../../dist/remote/direct-rpc.js";

// The direct JSON-RPC request a device revoking itself sends (remote/direct-rpc.ts, #159), from
// the compiled module, against task-owned loopback listeners. The request has a bounded deadline
// and is cancelled through its handle at it. A request that reached a connection and then stalled
// is RESULT_UNKNOWN (the revocation may have been accepted), never reported as not sent; only a
// request that never connected is operation-not-sent.

const SERVER_ID = "srv_0123456789abcdef";
const INSTANCE_ID = "rin_0123456789abcdef";
const OPERATION_ID = "op_self-revoke-deadline";

let servers = [];

afterEach(async () => {
  for (const { server, sockets } of servers) {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(() => done()));
  }
  servers = [];
});

// A listener that reads every request and never answers, or answers `late` ms after the request
// with a valid-looking HTTP response (which must be ignored once the deadline has passed).
async function stallingListener({ late } = {}) {
  const sockets = new Set();
  const received = [];
  const closed = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    let bytes = "";
    socket.on("data", (chunk) => {
      bytes += chunk.toString("latin1");
      if (!bytes.includes("\r\n\r\n")) return;
      received.push(bytes);
      if (late !== undefined)
        setTimeout(() => {
          if (!socket.destroyed)
            socket.end(
              "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}",
            );
        }, late);
    });
    socket.on("close", () => closed.push(Date.now()));
    socket.on("error", () => undefined);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push({ server, sockets });
  return { port: server.address().port, received, closed };
}

function caller(port, timeoutMs) {
  const delegated = [];
  const client = { call: (...args) => (delegated.push(args), Promise.resolve(null)) };
  const target = {
    serverId: SERVER_ID,
    relayInstanceId: INSTANCE_ID,
    endpoint: `http://127.0.0.1:${port}`,
  };
  const direct = directCallClient(
    client,
    target,
    () => "Bearer not-a-real-token",
    "auth.device.revoke",
    timeoutMs,
  );
  return { direct, delegated };
}

test("a request stalled after it was handed to a connection ends at the deadline as RESULT_UNKNOWN", async () => {
  const listener = await stallingListener();
  const { direct, delegated } = caller(listener.port, 400);
  const started = Date.now();
  const outcome = await direct.call("auth.device.revoke", {
    operationId: OPERATION_ID,
    deviceId: "dev_0123456789abcdef",
  });
  const elapsed = Date.now() - started;
  expect(outcome).toMatchObject({
    ok: false,
    kind: "operation-unknown",
    operation: { method: "auth.device.revoke", operationId: OPERATION_ID },
    error: { kind: "RESULT_UNKNOWN", acceptance: "unknown" },
  });
  expect(elapsed).toBeGreaterThanOrEqual(350);
  expect(elapsed).toBeLessThan(5_000);
  // The request reached the listener, and the deadline cancelled it: the connection is closed.
  expect(listener.received).toHaveLength(1);
  expect(listener.received[0]).toContain("POST /rpc ");
  await expect.poll(() => listener.closed.length, { timeout: 2_000 }).toBe(1);
  // Other methods still go to the session client.
  await direct.call("status.get", {});
  expect(delegated).toEqual([["status.get", {}]]);
});

test("an answer arriving after the deadline does not change the unknown outcome", async () => {
  const listener = await stallingListener({ late: 600 });
  const { direct } = caller(listener.port, 200);
  const outcome = await direct.call("auth.device.revoke", {
    operationId: OPERATION_ID,
    deviceId: "dev_0123456789abcdef",
  });
  expect(outcome).toMatchObject({ ok: false, kind: "operation-unknown" });
  await new Promise((done) => setTimeout(done, 800));
});

test("a request that never connected is proven not sent", async () => {
  // A port that was free a moment ago: nothing listens, the connection is refused.
  const listener = await stallingListener();
  const { port } = listener;
  const { server } = servers.pop();
  await new Promise((done) => server.close(() => done()));
  const { direct } = caller(port, 2_000);
  const outcome = await direct.call("auth.device.revoke", {
    operationId: OPERATION_ID,
    deviceId: "dev_0123456789abcdef",
  });
  expect(outcome).toMatchObject({ ok: false, kind: "operation-not-sent" });
});
