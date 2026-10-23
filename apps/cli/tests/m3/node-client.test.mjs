import { spawnSync } from "node:child_process";
import { cp, chmod, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  createNodeConnectionAdapters,
  createNodeHttpPort,
  parseInvitation,
  readTsnetConfig,
  writeTsnetConfig,
} from "@cove/node-client";
import { createWebPorts, createWebSocketPort } from "@cove/client/web-ports";
import { openSession } from "../../dist/session.js";
import { createAuthFixture, portOf } from "../m2/auth-fixtures.mjs";
import { daemonHello, endDaemon, shortRoot } from "../m2/tsnet-fixtures.mjs";
import { waitFor } from "../recording-view.mjs";

const root = resolve(import.meta.dirname, "../../../..");
const cleanups = [];
afterEach(async () => {
  const errors = [];
  for (const close of cleanups.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "node-client fixture cleanup failed");
});

async function temporary(prefix = "cn1") {
  const directory = await shortRoot(prefix);
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function authServer() {
  const fixture = await createAuthFixture();
  cleanups.push(() => fixture.cleanup());
  const home = fixture.home("server");
  return { fixture, home, server: await fixture.startAuthServer(home) };
}

const adapters = () => createNodeConnectionAdapters({ tsnet: { binaryPath: () => null } });
const metadata = (server, changes = {}) => ({
  alias: "host",
  serverId: server.record.serverId,
  defaultEntry: "loopback",
  entries: { loopback: { port: portOf(server) } },
  ...changes,
});
const options = (home, changes = {}) => ({
  via: undefined,
  home,
  buildVersion: "unidentified",
  ...changes,
});
function keepSession(session) {
  cleanups.push(async () => {
    session.client.dispose();
    await session.close?.();
  });
  return session;
}

async function httpServer(handler) {
  const server = createHttpServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(
    () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  );
  return { server, endpoint: `http://127.0.0.1:${server.address().port}` };
}

const request = {
  path: "/rpc",
  headers: {},
  body: new TextEncoder().encode("{}"),
  maxResponseBytes: 128,
};

// Copy the actual delivery closure rather than symlinking package roots: a stray CLI/server
// import must not succeed by walking back into this worktree's node_modules.
test("M3 T1 compiled Node package loads in an isolated consumer without CLI or server", async () => {
  const directory = await temporary();
  const scope = join(directory, "node_modules/@cove");
  await mkdir(scope, { recursive: true });
  for (const name of ["node-client", "client", "protocol"]) {
    const target = join(scope, name);
    await mkdir(target);
    await cp(join(root, "packages", name, "dist"), join(target, "dist"), { recursive: true });
    await cp(join(root, "packages", name, "package.json"), join(target, "package.json"));
  }
  await cp(
    await realpath(join(root, "packages/protocol/node_modules/zod")),
    join(directory, "node_modules/zod"),
    { recursive: true },
  );
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createNodeConnectionAdapters, createNodeHttpPort } from '@cove/node-client';
    const adapter = createNodeConnectionAdapters({ tsnet: { binaryPath: () => null } });
    const entry = await adapter.openEntry({alias:'local',serverId:'server',defaultEntry:'loopback',entries:{loopback:{port:12345}}}, undefined, '/unused');
    if (entry.endpoint !== 'http://127.0.0.1:12345' || typeof createNodeHttpPort(entry.endpoint).post !== 'function') throw Error('invalid public transport');
    await entry.close();
  `,
    ],
    { cwd: directory, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 20_000 },
  );
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  await expect(stat(join(scope, "server"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(scope, "cli"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("M3 T1 verified pairing and connection use a host token provider without CLI token files", async () => {
  const { fixture, home, server } = await authServer();
  const hostHome = fixture.home("desktop-host");
  const adapter = adapters();
  const payload = parseInvitation((await fixture.invite(home)).invitation);
  const paired = await adapter.redeemInvitation(
    payload,
    "Desktop test host",
    undefined,
    "unidentified",
    hostHome,
  );
  fixture.remember(paired.token);
  let token = paired.token;
  const requested = [];
  const session = keepSession(
    await adapter.openRemoteConnection(
      metadata(server),
      ({ serverId }) => {
        requested.push(serverId);
        return { kind: "device-token", token };
      },
      options(hostHome),
    ),
  );
  expect((await session.client.call("server.status", {})).ok).toBe(true);
  const rotation = await session.client.call("auth.device.rotate", {
    operationId: "m3-node-rotate",
  });
  expect(rotation.ok).toBe(true);
  token = rotation.value.secrets.token;
  fixture.remember(token);
  expect((await session.credentials()).authorization).toBe(`Bearer ${token}`);
  expect((await session.client.call("server.status", {})).ok).toBe(true);
  expect(requested.length).toBeGreaterThanOrEqual(4);
  expect(new Set(requested)).toEqual(new Set([server.record.serverId]));
  await expect(stat(join(hostHome, "client/servers"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(typeof session.socketPort("/events").open).toBe("function");
});

test("M3 T1 a wrong server identity fails before the credential provider is invoked", async () => {
  const { fixture, server } = await authServer();
  let calls = 0;
  await expect(
    adapters().openRemoteConnection(
      metadata(server, { serverId: "another-server" }),
      () => {
        calls += 1;
        throw new Error("credential must not be requested");
      },
      options(fixture.home("host")),
    ),
  ).rejects.toMatchObject({ kind: "SERVER_ID_MISMATCH" });
  expect(calls).toBe(0);
});

test("M3 T1 selected unavailable entry never falls back to a reachable loopback entry", async () => {
  const { fixture, server } = await authServer();
  let calls = 0;
  await expect(
    adapters().openRemoteConnection(
      metadata(server),
      () => {
        calls += 1;
        throw new Error("credential must not be requested");
      },
      options(fixture.home("host"), { via: "tsnet" }),
    ),
  ).rejects.toThrow(/no tsnet entry.*Cove never switches entries/s);
  expect(calls).toBe(0);
});

test("M3 T1 lost pairing result is not retried and never echoes the invitation secret", async () => {
  const { fixture, home } = await authServer();
  const payload = parseInvitation((await fixture.invite(home)).invitation);
  const proxy = await fixture.pairingProxy(payload.pairingPort, "drop");
  const error = await adapters()
    .redeemInvitation(
      { ...payload, pairingPort: proxy.port },
      "Host",
      undefined,
      "unidentified",
      fixture.home("host"),
    )
    .then(
      () => null,
      (failure) => failure,
    );
  expect(error.kind).toBe("INVITATION_UNAVAILABLE");
  expect(error.message).toContain("the pairing answer was lost");
  expect(error.message).not.toContain(payload.secret);
  expect(proxy.seen.filter((path) => path === "/pair")).toHaveLength(1);
});

test("M3 T1 Node HTTP immediate cancellation stays not-sent without callbacks", async () => {
  let accepted = 0;
  const { endpoint } = await httpServer((_req, res) => {
    accepted += 1;
    res.end("{}");
  });
  const callbacks = [];
  const handle = createNodeHttpPort(endpoint).post(request, {
    onDisposition: (value) => callbacks.push(value),
    onResponse: () => callbacks.push("response"),
    onFailure: () => callbacks.push("failure"),
  });
  expect(handle.cancel()).toBe("not-sent");
  await new Promise((done) => setTimeout(done, 30));
  expect(handle.cancel()).toBe("not-sent");
  expect(callbacks).toEqual([]);
  expect(accepted).toBe(0);
});

test("M3 T1 Node HTTP cancellation after delivery is unknown and response buffering stays bounded", async () => {
  let accept;
  const received = new Promise((done) => {
    accept = done;
  });
  const held = await httpServer(() => accept());
  const handle = createNodeHttpPort(held.endpoint).post(request, {
    onDisposition() {},
    onResponse() {},
    onFailure() {},
  });
  await received;
  expect(handle.cancel()).toBe("unknown");
  expect(handle.cancel()).toBe("unknown");
  const large = await httpServer((_req, res) => res.end("x".repeat(256)));
  const failure = await new Promise((done) =>
    createNodeHttpPort(large.endpoint).post(request, {
      onDisposition() {},
      onResponse: () => done("unexpected response"),
      onFailure: done,
    }),
  );
  expect(failure).toEqual({ disposition: "handed-off", reason: "response-too-large" });
});

function fakeSocket() {
  const listeners = new Map();
  return {
    readyState: 0,
    bufferedAmount: 0,
    binaryType: "",
    sent: [],
    closes: 0,
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    emit(type, value) {
      for (const listener of listeners.get(type) ?? []) listener(value);
    },
    send(message) {
      this.sent.push(message);
    },
    close() {
      this.closes += 1;
    },
  };
}

test("M3 T1 path-selectable WS preserves terminal route and bounded byte transport semantics", () => {
  const urls = [];
  const sockets = [];
  const createWebSocket = (url) => {
    urls.push(url);
    const socket = fakeSocket();
    sockets.push(socket);
    return socket;
  };
  const messages = [];
  const callbacks = {
    onOpen(connection) {
      messages.push(connection);
    },
    onText(bytes) {
      messages.push(new TextDecoder().decode(bytes));
    },
    onBinary(bytes) {
      messages.push([...bytes]);
    },
    onClose() {
      messages.push("close");
    },
  };
  const eventPort = createWebSocketPort({
    endpoint: "http://127.0.0.1:1",
    path: "/events",
    createWebSocket,
    maxBufferedBytes: 8,
  });
  const pending = eventPort.open(callbacks);
  const socket = sockets[0];
  socket.readyState = 1;
  socket.emit("open");
  const connection = messages[0];
  expect(connection.send("hello")).toBe("handed-off");
  socket.bufferedAmount = 9;
  expect(connection.send("full")).toBe("not-sent");
  socket.emit("message", { data: "event" });
  socket.emit("message", { data: new Uint8Array([1, 2]).buffer });
  expect(messages.slice(1)).toEqual(["event", [1, 2]]);
  expect(pending.cancel()).toBe("unknown");
  socket.emit("close");
  socket.emit("error");
  expect(messages.filter((item) => item === "close")).toHaveLength(1);
  expect(connection.send("closed")).toBe("not-sent");
  const unopened = createWebPorts({
    endpoint: "http://127.0.0.1:1",
    createWebSocket,
  }).terminal.open(callbacks);
  expect(unopened.cancel()).toBe("not-sent");
  expect(urls).toEqual(["ws://127.0.0.1:1/events", "ws://127.0.0.1:1/terminal"]);
  expect(socket.sent).toEqual(["hello"]);
});

test("M3 T1 local CLI Session exposes lazy host credentials and a second socket transport", async () => {
  const { server } = await authServer();
  const session = keepSession(await openSession(server.report.rendezvous));
  expect((await session.credentials()).terminalSecret).toBe(server.record.secret);
  expect(typeof session.socketPort("/events").open).toBe("function");
  expect((await session.client.call("server.status", {})).ok).toBe(true);
});

function shell(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
async function fakeDaemon(forwardPort) {
  const directory = await temporary();
  const home = join(directory, "home");
  await mkdir(home, { mode: 0o755 });
  await chmod(home, 0o755);
  const config = join(directory, "fake.json");
  const events = join(directory, "events.jsonl");
  await writeFile(
    config,
    JSON.stringify({
      build: "m3-adapter",
      protocol: 1,
      dialForward: forwardPort,
      dialPeer: "nSERVER1",
      events,
    }),
  );
  const binary = join(directory, "cove-tsnet");
  await writeFile(
    binary,
    `#!/bin/sh\nCOVE_TEST_FAKE_DIAL=${shell(config)} exec ${shell(process.execPath)} ${shell(join(root, "apps/cli/tests/m2/tsnet-fake-dial.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  cleanups.push(() => endDaemon(home));
  return {
    home,
    events,
    adapter: createNodeConnectionAdapters({ tsnet: { binaryPath: () => binary } }),
  };
}

test("M3 T1 shared node survives one entry closing and preserves the existing home mode", async () => {
  const sockets = new Set();
  const echo = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.pipe(socket);
  });
  await new Promise((done) => echo.listen(0, "127.0.0.1", done));
  cleanups.push(
    () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        echo.close(done);
      }),
  );
  const { home, events, adapter } = await fakeDaemon(echo.address().port);
  await writeTsnetConfig(home, { idleTimeoutSeconds: 60 });
  expect(await readTsnetConfig(home)).toEqual({ idleTimeoutSeconds: 60 });
  const record = {
    alias: "shared",
    serverId: "server",
    defaultEntry: "tsnet",
    entries: { tsnet: { nodeId: "nSERVER1", name: "server.test", port: echo.address().port } },
  };
  const first = await adapter.openEntry(record, undefined, home);
  cleanups.push(() => first.close());
  const second = await adapter.openEntry(record, undefined, home);
  cleanups.push(() => second.close());
  const before = await daemonHello(home);
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(second.endpoint).port) });
  socket.on("error", () => socket.destroy());
  cleanups.push(() => socket.destroy());
  let output = "";
  socket.on("data", (data) => {
    output += data;
  });
  socket.write("before");
  await waitFor("the sibling verified stream", () => output === "before");
  await first.close();
  socket.write("after");
  await waitFor("sibling stream after entry close", () => output === "beforeafter");
  const after = await daemonHello(home);
  expect(after.pid).toBe(before.pid);
  expect((await stat(home)).mode & 0o777).toBe(0o755);
  const observed = (await readFile(events, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(observed.some((event) => event.op === "stop" || event.op === "logout")).toBe(false);
});
