import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect, createServer as createTcpServer } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";

// The compiled module of the server package, as auth-server-entry.mjs loads the server.
const serverPackage = dirname(createRequire(import.meta.url).resolve("@cove/server/package.json"));
const { RawConnectionGate } = await import(
  pathToFileURL(join(serverPackage, "dist/transport/raw-connections.js")).href
);

// #156: the raw gate of the business listener (apps/server transport/raw-connections.ts), with
// small bounds; raw-connection-bounds.test.mjs checks the production bounds through the server. Connections reach the HTTP
// server both through its own listener and handed over with `emit("connection")`, as the tsnet
// entry hands over the connections its node forwards; the gate bounds both the same way.

const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function rig(bounds) {
  const gate = new RawConnectionGate(bounds);
  const http = createServer((_request, response) => response.end("ok"));
  gate.attach(http);
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  // A second port whose sockets are handed to the HTTP server, as network/tsnet.ts does.
  const handoff = createTcpServer((socket) => http.emit("connection", socket));
  await new Promise((done) => handoff.listen(0, "127.0.0.1", done));
  const sockets = [];
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    http.closeAllConnections();
    await new Promise((done) => handoff.close(done));
    await new Promise((done) => http.close(done));
  });
  const open = (port, head) => {
    const socket = connect({ host: "127.0.0.1", port });
    sockets.push(socket);
    socket.on("error", () => undefined);
    const state = { socket, closed: false, answer: "" };
    socket.on("data", (chunk) => (state.answer += chunk));
    socket.once("close", () => (state.closed = true));
    socket.once("connect", () => socket.write(head));
    return state;
  };
  return {
    gate,
    direct: (head) => open(http.address().port, head),
    handed: (head) => open(handoff.address().port, head),
  };
}

const STALL = "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n";
const REQUEST = "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";

test("the oldest socket awaiting a head is closed to make room, on either path", async () => {
  const { gate, direct, handed } = await rig({
    connections: 8,
    awaitingHeaders: 3,
    headerDeadlineMs: 60_000,
  });
  const stalled = [];
  // Opened one after another, so the gate's admission order is the order here.
  for (const open of [direct, handed, direct]) {
    stalled.push(open(STALL));
    await delay(50);
  }
  expect(gate.snapshot()).toMatchObject({ open: 3, awaitingHeaders: 3 });
  // A fourth stalled socket, handed over: the oldest one gives way.
  stalled.push(handed(STALL));
  await delay(100);
  expect(stalled.map((state) => state.closed)).toEqual([true, false, false, false]);
  // A request sent at once is served while the stalled ones fill the bound.
  const served = [direct(REQUEST), handed(REQUEST)];
  await delay(200);
  for (const state of served) expect(state.answer).toMatch(/^HTTP\/1\.1 200[\s\S]*ok$/);
  expect(gate.snapshot().awaitingHeaders).toBeLessThanOrEqual(3);
});

test("the connection bound refuses a new socket only when none awaits a head", async () => {
  const { gate, direct, handed } = await rig({
    connections: 2,
    awaitingHeaders: 2,
    headerDeadlineMs: 60_000,
  });
  // Two requests in progress: their heads are complete, their answers never end.
  let started = 0;
  const busy = createServer(() => started++);
  const gateBusy = new RawConnectionGate({
    connections: 2,
    awaitingHeaders: 2,
    headerDeadlineMs: 60_000,
  });
  gateBusy.attach(busy);
  await new Promise((done) => busy.listen(0, "127.0.0.1", done));
  cleanup.push(async () => {
    busy.closeAllConnections();
    await new Promise((done) => busy.close(done));
  });
  const port = busy.address().port;
  const sockets = [];
  for (const index of [0, 1, 2]) {
    const socket = connect({ host: "127.0.0.1", port });
    socket.on("error", () => undefined);
    const state = { closed: false };
    socket.once("close", () => (state.closed = true));
    socket.once("connect", () => socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
    cleanup.push(() => socket.destroy());
    sockets.push(state);
    // One at a time: the next connects once this one's request is in progress (or refused).
    for (let wait = 0; wait < 50 && started === index && !state.closed; wait++) await delay(10);
  }
  await delay(100);
  // The third arrived with both slots carrying a request: it is the one refused.
  expect(sockets.map((state) => state.closed)).toEqual([false, false, true]);
  expect(gateBusy.snapshot()).toMatchObject({ open: 2, awaitingHeaders: 0, refused: 1 });
  // On the other rig, two stalled sockets fill the bound and a third evicts the oldest.
  const a = direct(STALL);
  await delay(50);
  const b = handed(STALL);
  await delay(50);
  const c = direct(STALL);
  await delay(100);
  expect([a.closed, b.closed, c.closed]).toEqual([true, false, false]);
  expect(gate.snapshot().open).toBe(2);
});

test("a socket that has not completed a head is closed at the deadline, after accept and between requests", async () => {
  const { direct, handed } = await rig({
    connections: 8,
    awaitingHeaders: 8,
    headerDeadlineMs: 300,
  });
  const fresh = [direct(STALL), handed(STALL)];
  // A kept-alive socket: one answered request, then a stalled next head.
  const kept = direct("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  await delay(150);
  expect(kept.answer).toMatch(/^HTTP\/1\.1 200/);
  kept.socket.write(STALL);
  expect(fresh.some((state) => state.closed)).toBe(false);
  await delay(400);
  expect(fresh.map((state) => state.closed)).toEqual([true, true]);
  await delay(200);
  expect(kept.closed).toBe(true);
});
