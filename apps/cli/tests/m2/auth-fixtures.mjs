import { spawn } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { createClient } from "@cove/client";
import { createDefaultScheduler, createUtf8Codec, createWebPorts } from "@cove/client/web-ports";
import { decodeInvitation, encodeInvitation } from "@cove/protocol/auth";
import { randomUUID } from "node:crypto";
import { createNodeHttpPort } from "../../dist/node-ports.js";
import { cliBuildVersion } from "../../dist/session.js";
import { createM1Fixture, cli } from "../m1/fixtures.mjs";
import { waitFor } from "../recording-view.mjs";

// Shared fixtures of the M2 T1 scenarios (device auth over the loopback entry). They extend the
// M1 fixture: every process runs from the compiled artifacts with HOME and COVE_HOME inside one
// temporary root, and cleanup ends every process the scenario created. Servers start through
// auth-server-entry.mjs with an advertised SSH target fixture (`user@example.test`), since
// `cove server start` passes no server flags yet. Nothing here reads a real data directory.

export const SERVER_ENTRY = resolve(import.meta.dirname, "auth-server-entry.mjs");
export const SSH_TARGET = "user@example.test";

export async function createAuthFixture() {
  const base = await createM1Fixture();
  // A paired-server selection inherited from the operator's shell must not redirect a command.
  delete base.env.COVE_SERVER;
  const sockets = [];
  const proxies = [];

  const fixture = {
    ...base,

    // A server for `home` with the auth flags; `args` adds more (e.g. --pairing-port).
    async startAuthServer(home, args = []) {
      // startServerEntry waits for the rendezvous to exist; the one a killed server left would
      // be taken for the new server's, so it is removed first (it names no live server).
      await rm(join(home, "server", "run", "rendezvous.json"), { force: true });
      base.env.COVE_TEST_SERVER_ARGS = JSON.stringify(["--ssh-target", SSH_TARGET, ...args]);
      try {
        return await base.startServerEntry(SERVER_ENTRY, home);
      } finally {
        delete base.env.COVE_TEST_SERVER_ARGS;
      }
    },

    // Runs `cove --home H ...args` with `input` on stdin (never in argv), to completion, from
    // `cwd` when given.
    // `sample`, when given, runs with the command's PID once the input was written; the caller
    // keeps the command alive meanwhile (e.g. a proxy holding its request).
    coveInput(args, input, { home, sample, cwd } = {}) {
      const child = spawn(process.execPath, [cli, "--home", home, ...args], {
        env: base.env,
        ...(cwd === undefined ? {} : { cwd }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const done = new Promise((settle) =>
        child.once("exit", (code, signal) => settle({ code, signal, stdout, stderr })),
      );
      const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
      return (async () => {
        try {
          child.stdin.end(input);
          const sampled = sample ? await sample(child.pid) : undefined;
          const result = await done;
          return { ...result, sampled };
        } finally {
          clearTimeout(timeout);
        }
      })();
    },

    // `cove auth invite create` on `home`: the printed { operation, invitation }.
    invite(home, args = []) {
      return base.coveJson(["auth", "invite", "create", ...args], { home });
    },

    // `cove remote add ALIAS` on `home` with `invitation` on stdin.
    pair(home, alias, invitation, args = [], options = {}) {
      return fixture.coveInput(["remote", "add", alias, ...args], invitation, {
        home,
        ...options,
      });
    },

    async pairOk(home, alias, invitation, args = []) {
      const result = await fixture.pair(home, alias, invitation, args);
      if (result.code !== 0)
        throw new Error(`cove remote add exited ${result.code}: ${result.stderr}`);
      return JSON.parse(result.stdout);
    },

    // The client's saved record of a paired server (the credential file, D5).
    async credential(home, serverId) {
      return JSON.parse(
        await readFile(join(home, "client", "servers", `${serverId}.json`), "utf8"),
      );
    },

    // A client of `server` with a device token (or the local secret when `token` is null), whose
    // terminal sockets record their close codes in `closes`.
    async deviceClient(server, token) {
      const { record } = server;
      const closes = [];
      const credentials = () =>
        token === null
          ? { authorization: `Bearer ${record.secret}`, terminalSecret: record.secret }
          : { authorization: `Bearer ${token}`, terminalSecret: token };
      const createWebSocket = (url) => {
        const socket = new WebSocket(url);
        socket.addEventListener("close", (event) => closes.push(event.code));
        sockets.push(socket);
        return socket;
      };
      const client = createClient({
        expectedServerId: record.serverId,
        expectedRelayInstanceId: record.relayInstanceId,
        buildVersion: cliBuildVersion(),
        credentials,
        codec: createUtf8Codec(),
        createOpaqueId: () => randomUUID(),
        scheduler: createDefaultScheduler(),
        http: createNodeHttpPort(record.endpoint),
        terminal: createWebPorts({ endpoint: record.endpoint, createWebSocket }).terminal,
      });
      return { client, closes };
    },

    // A forwarding proxy in front of a pairing listener on `targetPort`, for the scenarios that
    // lose or delay the redemption answer (S11, S12). It forwards each request with the Host the
    // listener expects; `mode` decides what happens to a /pair answer: "forward", "drop" (the
    // client's connection is destroyed once the server answered, so the redemption committed and
    // its answer is lost) or a function awaited before forwarding the request.
    async pairingProxy(targetPort, mode = "forward") {
      const seen = [];
      const server = createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", async () => {
          seen.push(req.url);
          if (req.url === "/pair" && typeof mode === "function") await mode();
          const upstream = request(
            {
              host: "127.0.0.1",
              port: targetPort,
              path: req.url,
              method: req.method,
              headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
              agent: false,
            },
            (answer) => {
              const body = [];
              answer.on("data", (chunk) => body.push(chunk));
              answer.on("end", () => {
                if (req.url === "/pair" && mode === "drop") {
                  res.socket.destroy();
                  return;
                }
                res.writeHead(answer.statusCode, answer.headers);
                res.end(Buffer.concat(body));
              });
            },
          );
          upstream.on("error", () => res.socket?.destroy());
          upstream.end(Buffer.concat(chunks));
        });
      });
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      const proxy = {
        port: server.address().port,
        seen,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      };
      proxies.push(proxy);
      return proxy;
    },

    async cleanup() {
      for (const socket of sockets) socket.close();
      await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
      await base.cleanup();
    },
  };
  return fixture;
}

// An invitation with some payload fields replaced (a wrong secret, another pairing port).
export function alteredInvitation(invitation, changes) {
  const payload = decodeInvitation(invitation);
  if (!payload) throw new Error("not an invitation");
  return encodeInvitation({ ...payload, ...changes });
}

export function payloadOf(invitation) {
  return decodeInvitation(invitation);
}

// A different valid secret than `secret`.
export function wrongSecret(secret) {
  return `${secret[0] === "A" ? "B" : "A"}${secret.slice(1)}`;
}

// Whether something accepts TCP connections on 127.0.0.1:port.
export function connectable(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

export function waitUntilClosed(port) {
  return waitFor(`port ${port} to stop accepting`, async () => !(await connectable(port)), 10_000);
}

// A raw POST to 127.0.0.1:port, for the pre-authentication surfaces.
export function post(port, path, body, headers = {}) {
  return new Promise((done, fail) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(text),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            json = undefined;
          }
          done({ status: res.statusCode, raw, json });
        });
      },
    );
    req.on("error", fail);
    req.end(text);
  });
}

// Every file under `directory` (recursively), with its bytes.
export async function filesUnder(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else if (entry.isFile()) found.push({ path, bytes: await readFile(path) });
  }
  return found;
}
