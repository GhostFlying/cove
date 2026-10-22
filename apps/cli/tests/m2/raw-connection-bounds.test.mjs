import { execFile } from "node:child_process";
import { connect } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { bootstrapRequest, createAuthFixture, portOf, post } from "./auth-fixtures.mjs";

// #156, S11-style against the compiled server: the business listener bounds its raw sockets
// before the HTTP parser or any admission sees them (transport/raw-connections.ts). Peers that
// open connections and never complete a request head cannot hold more than the awaiting-headers
// bound of sockets, nor any socket past the header deadline, and a legitimate client that sends
// its head at once is still served while they try. The same gate receives the connections the
// tsnet node forwards (network/tsnet.ts emits them into this listener); S9 covers that path.

// The bounds of RAW_CONNECTION_BOUNDS, restated so that a change of them is a visible test change.
const AWAITING_HEADERS = 64;
const HEADER_DEADLINE_MS = 5_000;

let fixture;
const holders = [];

beforeEach(async () => {
  fixture = await createAuthFixture();
});

afterEach(async () => {
  for (const socket of holders.splice(0)) socket.destroy();
  await fixture?.cleanup();
  fixture = undefined;
});

// A connection that writes the start of a request head and then stalls. `closed` resolves when
// the server ends it; `closedAt` is when.
function holder(port) {
  const socket = connect({ host: "127.0.0.1", port });
  holders.push(socket);
  const state = { socket, closedAt: undefined, openedAt: Date.now() };
  state.closed = new Promise((done) => {
    socket.once("close", () => {
      state.closedAt = Date.now();
      done();
    });
  });
  socket.on("error", () => undefined);
  socket.once("connect", () =>
    socket.write(`POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application`),
  );
  return state;
}

const stillOpen = (states) => states.filter((state) => state.closedAt === undefined).length;

// The server process's established TCP sockets on `port`, as the OS reports them.
function serverSockets(pid, port) {
  return new Promise((done, fail) =>
    execFile(
      "lsof",
      ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:ESTABLISHED"],
      (error, stdout) => {
        // lsof exits 1 when it lists nothing.
        if (error && error.code !== 1) fail(error);
        else done(stdout.split("\n").filter((line) => /ESTABLISHED/.test(line)).length);
      },
    ),
  );
}

test("connections that never complete a head stay bounded and end at the deadline, while a client sending its head is served", async () => {
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome);
  const port = portOf(server);
  // More stalled connections than the listener's whole connection bound.
  const states = [];
  for (let index = 0; index < 200; index++) states.push(holder(port));
  await Promise.all(
    states.map(
      (state) =>
        new Promise((done) => {
          if (state.socket.readyState === "open") done();
          state.socket.once("connect", done);
          state.closed.then(done);
        }),
    ),
  );
  await waitFor(
    "the excess stalled connections to be closed",
    () => stillOpen(states) <= AWAITING_HEADERS,
    10_000,
  );
  expect(stillOpen(states)).toBeLessThanOrEqual(AWAITING_HEADERS);
  // The server holds no more than that either (plus the few sockets of this test's requests).
  expect(await serverSockets(server.pid, port)).toBeLessThanOrEqual(AWAITING_HEADERS + 4);

  // A legitimate client meanwhile: an identity request and a CLI command, each on new
  // connections that send their head at once, are answered. The stalled ones keep arriving.
  const more = [];
  for (let index = 0; index < 32; index++) more.push(holder(port));
  const identity = await post(port, "/bootstrap", bootstrapRequest(server));
  expect(identity.status).toBe(200);
  expect(identity.json.serverId).toBe(server.record.serverId);
  const tasks = await fixture.coveJson(["task", "list"], { home: serverHome });
  expect(tasks).toBeDefined();
  states.push(...more);

  // Every stalled connection ends within the header deadline of its opening, none earlier than
  // the deadline unless the bound evicted it.
  await Promise.all(states.map((state) => state.closed));
  const latest = Math.max(...states.map((state) => state.closedAt - state.openedAt));
  expect(latest).toBeLessThan(HEADER_DEADLINE_MS + 3_000);
  expect(await serverSockets(server.pid, port)).toBe(0);
}, 60_000);

test("a kept-alive connection that starts its next head and stalls is closed at the deadline", async () => {
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome);
  const port = portOf(server);
  const socket = connect({ host: "127.0.0.1", port });
  holders.push(socket);
  socket.on("error", () => undefined);
  let received = "";
  socket.on("data", (chunk) => (received += chunk.toString("latin1")));
  const closed = new Promise((done) => socket.once("close", () => done(Date.now())));
  await new Promise((done) => socket.once("connect", done));
  const body = JSON.stringify(bootstrapRequest(server));
  socket.write(
    `POST /bootstrap HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  await waitFor("the first answer", () => received.includes(server.record.serverId), 5_000);
  expect(received).toMatch(/^HTTP\/1\.1 200/);
  // The next head starts and stalls: the keep-alive timer no longer applies, the deadline does.
  const stalledAt = Date.now();
  socket.write(`POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
  const at = await closed;
  expect(at - stalledAt).toBeGreaterThanOrEqual(HEADER_DEADLINE_MS - 1_000);
  expect(at - stalledAt).toBeLessThan(HEADER_DEADLINE_MS + 3_000);
}, 30_000);
