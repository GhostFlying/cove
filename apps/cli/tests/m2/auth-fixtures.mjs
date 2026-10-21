import { spawn } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { createClient } from "@cove/client";
import { createDefaultScheduler, createUtf8Codec, createWebPorts } from "@cove/client/web-ports";
import { decodeInvitation, encodeInvitation } from "@cove/protocol/auth";
import {
  BOOTSTRAP_VERSION,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from "@cove/protocol/bootstrap";
import { BASELINE_ENCODING, PROFILE } from "@cove/protocol/profile";
import { randomBytes, randomUUID } from "node:crypto";
import { createNodeHttpPort } from "../../dist/node-ports.js";
import { cliBuildVersion } from "../../dist/session.js";
import { createM1Fixture, cli } from "../m1/fixtures.mjs";
import { waitFor } from "../recording-view.mjs";

// Shared fixtures of the M2 T1 scenarios (device auth over the loopback entry). They extend the
// M1 fixture: every process runs from the compiled artifacts with HOME and COVE_HOME inside one
// temporary root, and cleanup ends every process the scenario created. Servers start through
// auth-server-entry.mjs with an advertised SSH target fixture (`user@example.test`), since
// `cove server start` passes no server flags yet. Nothing here reads a real data directory.
//
// The secret scan (m2 S11, "秘密与操作记录的分界"). Every scenario's cleanup first scans what it
// left behind for every secret it was issued, before anything is removed: each invitation and
// token a CLI printed or a test client received, the tokens in the credential files, and the
// secret parts of both. The carriers are every file under the scenario's root (the store and its
// WAL, receipts included, server logs, CLI pending records) and every server's stderr. Credential
// files are checked separately: their exact schema, the expected current token where a scenario
// set it (`expectToken`), and no other remembered secret. A harmless sentinel proves the carriers
// are read: it is the operation ID prefix of every `invite` (so the store and the CLI pending
// records hold it), it is printed by auth-server-entry.mjs (server stderr), and it is in every
// CLI's environment (process samples, S11). The scan must find it in each carrier class it
// applies to, through the same check that must find no secret: the negative control.
//
// Tokens are remembered when they are issued or observed, not only at cleanup (#159): a token a
// test client receives, and every token a CLI command saved in a credential file of its home,
// read when the command ends and, while a background command runs, every 20 ms. Pairing and CLI
// rotation never print the token, so a token superseded by a later rotation would otherwise
// never be known to the scan; secret-scan-superseded.test.mjs is the negative control.

export const SERVER_ENTRY = resolve(import.meta.dirname, "auth-server-entry.mjs");
export const SSH_TARGET = "user@example.test";

const INVITATION_PATTERN = /cove-invite:v1:[A-Za-z0-9_-]+/g;
const TOKEN_PATTERN = /cove_d1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}/g;
const CREDENTIAL_FILE = /\/client\/servers\/[^/]+\.json$/;
const CREDENTIAL_KEYS = "alias,defaultEntry,deviceId,entries,pairedAtMs,serverId,token,version";

// The carrier class of a scanned file.
function carrierOf(path) {
  if (/\/server\/cove\.db(-wal|-shm)?$/.test(path)) return "store";
  if (/\/cli\/operations\//.test(path)) return "cli pending records";
  return "files";
}

// Every [carrier, value] where a carrier holds one of `values`.
function hits(carriers, values) {
  const found = [];
  for (const { carrier, name, bytes } of carriers)
    for (const value of values) if (bytes.includes(Buffer.from(value))) found.push([carrier, name]);
  return found;
}

export async function createAuthFixture() {
  const base = await createM1Fixture();
  // A paired-server selection inherited from the operator's shell must not redirect a command.
  delete base.env.COVE_SERVER;
  const sockets = [];
  const proxies = [];
  const servers = [];
  const secrets = new Set();
  const expectedTokens = new Map();
  const sentinel = `covesentinel${randomBytes(6).toString("hex")}`;
  base.env.COVE_TEST_SENTINEL = sentinel;
  let invitations = 0;
  // A secret and the secret part it carries, which must not leak on its own either.
  const remember = (value) => {
    secrets.add(value);
    if (value.startsWith("cove-invite:")) {
      const secret = decodeInvitation(value)?.secret;
      if (secret) secrets.add(secret);
    }
    if (value.startsWith("cove_d1_")) secrets.add(value.split(".")[1]);
  };
  // What a CLI printed on stdout (invitations and tokens are only ever printed there).
  const harvest = (text) => {
    for (const [value] of String(text).matchAll(INVITATION_PATTERN)) remember(value);
    for (const [value] of String(text).matchAll(TOKEN_PATTERN)) remember(value);
  };
  // Every token in a credential file of `home` now. A file being replaced is read as it is; an
  // unreadable or partial one is read again at the next observation.
  const observe = async (home) => {
    if (home === undefined) return;
    const directory = join(home, "client", "servers");
    let names;
    try {
      names = await readdir(directory);
    } catch {
      return;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const text = await readFile(join(directory, name), "utf8").catch(() => "");
      for (const [value] of text.matchAll(TOKEN_PATTERN)) remember(value);
    }
  };

  const fixture = {
    ...base,

    // A server for `home` with the auth flags; `args` adds more (e.g. --pairing-port).
    // `storeFaults`: store limits that enable the store-fault seams (auth-server-entry.mjs).
    async startAuthServer(home, args = [], { storeFaults } = {}) {
      // startServerEntry waits for the rendezvous to exist; the one a killed server left would
      // be taken for the new server's, so it is removed first (it names no live server).
      await rm(join(home, "server", "run", "rendezvous.json"), { force: true });
      base.env.COVE_TEST_SERVER_ARGS = JSON.stringify(["--ssh-target", SSH_TARGET, ...args]);
      if (storeFaults) base.env.COVE_TEST_STORE_FAULTS = JSON.stringify(storeFaults);
      try {
        const server = await base.startServerEntry(SERVER_ENTRY, home);
        servers.push(server);
        return server;
      } finally {
        delete base.env.COVE_TEST_SERVER_ARGS;
        delete base.env.COVE_TEST_STORE_FAULTS;
      }
    },

    sentinel,
    remember,

    // The token the credential file of `serverId` under `home` must hold when the scan runs.
    expectToken(home, serverId, token) {
      expectedTokens.set(join(home, "client", "servers", `${serverId}.json`), token);
    },

    async cove(args, options) {
      try {
        const result = await base.cove(args, options);
        harvest(result.stdout);
        return result;
      } finally {
        await observe(options?.home);
      }
    },

    async coveJson(args, options) {
      try {
        const value = await base.coveJson(args, options);
        harvest(JSON.stringify(value));
        return value;
      } finally {
        await observe(options?.home);
      }
    },

    spawnCove(args, options) {
      const spawned = base.spawnCove(args, options);
      // A background command can save a token that a concurrent one supersedes before this one
      // ends (credential-lock.test.mjs), so its home is observed while it runs as well.
      let observing = Promise.resolve();
      const poll = setInterval(() => {
        observing = observing.then(() => observe(options?.home));
      }, 20);
      return {
        ...spawned,
        done: spawned.done.then(async (result) => {
          clearInterval(poll);
          await observing;
          await observe(options?.home);
          harvest(result.stdout);
          return result;
        }),
      };
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
          harvest(result.stdout);
          return { ...result, sampled };
        } finally {
          clearTimeout(timeout);
          await observe(home);
        }
      })();
    },

    // `cove auth invite create` on `home`: the printed { operation, invitation }. Its operation ID
    // carries the sentinel unless `args` names one.
    invite(home, args = []) {
      const id = args.includes("--operation-id")
        ? []
        : ["--operation-id", `${sentinel}-invite-${++invitations}`];
      return fixture.coveJson(["auth", "invite", "create", ...id, ...args], { home });
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
      const created = createClient({
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
      // Every output secret the client receives is remembered for the scan.
      const client = new Proxy(created, {
        get(target, property, receiver) {
          const member = Reflect.get(target, property, receiver);
          if (property !== "call")
            return typeof member === "function" ? member.bind(target) : member;
          return async (...args) => {
            const outcome = await member.apply(target, args);
            if (outcome.ok && outcome.value?.secrets)
              for (const value of Object.values(outcome.value.secrets)) remember(value);
            return outcome;
          };
        },
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

    // A terminal WebSocket of `server`, authenticated with `secret`, that never closes: written on
    // a raw TCP socket, it ignores the server's close frame and keeps its side open, as a peer
    // that stopped reading would. Resolves once the bootstrap result arrived; cleanup destroys it.
    async stubbornTerminal(server, secret) {
      const port = portOf(server);
      const socket = connect({ host: "127.0.0.1", port });
      sockets.push({ close: () => socket.destroy() });
      let received = "";
      socket.on("data", (chunk) => (received += chunk.toString("latin1")));
      socket.on("error", () => undefined);
      await new Promise((done, fail) => {
        socket.once("connect", done);
        socket.once("error", fail);
      });
      socket.write(
        [
          "GET /terminal HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
      await waitFor("the WebSocket upgrade", () => received.startsWith("HTTP/1.1 101"), 5_000);
      // One masked text frame (RFC 6455 §5.2) with the first message.
      const payload = Buffer.from(JSON.stringify({ ...bootstrapRequest(server), secret }));
      const mask = randomBytes(4);
      const length =
        payload.length < 126
          ? Buffer.from([0x80 | payload.length])
          : Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 0xff]);
      const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      socket.write(Buffer.concat([Buffer.from([0x81]), length, mask, masked]));
      await waitFor(
        "the bootstrap result",
        () => received.includes('"cove-bootstrap-result"'),
        5_000,
      );
      return { closed: () => socket.destroyed || socket.readyState === "closed" };
    },

    // The secret scan (see the top of this file). Throws an assertion error naming what failed.
    async scanSecrets() {
      const files = await filesUnder(base.root);
      const failures = [];
      const credentials = files.filter(({ path }) => CREDENTIAL_FILE.test(path));
      const parsed = [];
      for (const { path, bytes } of credentials) {
        let record;
        try {
          record = JSON.parse(bytes.toString("utf8"));
        } catch {
          failures.push(`${path} is not JSON`);
          continue;
        }
        const tokenShape = new RegExp(`^cove_d1_${record.deviceId}\\.[A-Za-z0-9_-]{43}$`);
        if (
          Object.keys(record).sort().join() !== CREDENTIAL_KEYS ||
          record.version !== 1 ||
          typeof record.token !== "string" ||
          !tokenShape.test(record.token)
        )
          failures.push(`${path} does not have the credential schema`);
        else if (expectedTokens.has(path) && expectedTokens.get(path) !== record.token)
          failures.push(`${path} does not hold the current token`);
        if (typeof record.token === "string") remember(record.token);
        parsed.push({ path, bytes, token: record.token });
      }
      for (const [path] of expectedTokens)
        if (!credentials.some((file) => file.path === path)) failures.push(`${path} is missing`);
      const values = [...secrets];
      for (const { path, bytes, token } of parsed) {
        const own = typeof token === "string" ? [token, token.split(".")[1]] : [];
        const others = values.filter((value) => !own.includes(value));
        if (hits([{ carrier: "credential", name: path, bytes }], others).length > 0)
          failures.push(`${path} holds a secret other than its token`);
      }
      const carriers = [
        ...files
          .filter(({ path }) => !CREDENTIAL_FILE.test(path))
          .map(({ path, bytes }) => ({ carrier: carrierOf(path), name: path, bytes })),
        ...servers.map((server, index) => ({
          carrier: "server stderr",
          name: `server ${index}`,
          bytes: Buffer.from(server.stderr()),
        })),
      ];
      for (const [carrier, name] of hits(carriers, values))
        failures.push(`a secret is in ${carrier}: ${name}`);
      // The negative control: the sentinel, planted in each carrier class, is found by the same
      // check, so a secret there would have been found too.
      const required = new Set([
        ...(servers.length > 0 ? ["server stderr"] : []),
        ...(invitations > 0 ? ["store", "cli pending records"] : []),
      ]);
      const observed = new Set(hits(carriers, [sentinel]).map(([carrier]) => carrier));
      for (const carrier of required)
        if (!observed.has(carrier)) failures.push(`the sentinel was not found in ${carrier}`);
      if (failures.length > 0) throw new Error(`secret scan failed:\n${failures.join("\n")}`);
      return { secrets: values.length, carriers: carriers.length, observed: [...observed] };
    },

    async cleanup() {
      let scan;
      try {
        await fixture.scanSecrets();
      } catch (error) {
        scan = error;
      }
      for (const socket of sockets) socket.close();
      await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
      await base.cleanup();
      if (scan) throw scan;
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

export const portOf = (server) => Number(new URL(server.record.endpoint).port);

export function bootstrapRequest(server) {
  return {
    type: "cove-bootstrap",
    bootstrapVersion: BOOTSTRAP_VERSION,
    expectedServerId: server.record.serverId,
    expectedRelayInstanceId: server.record.relayInstanceId,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: "0.0.0+0000000000000000",
    capabilities: [...REQUIRED_CAPABILITIES],
    profiles: [PROFILE],
    encodings: [BASELINE_ENCODING],
  };
}

// A terminal WebSocket whose first frame carries `secret`: every text message and the close code.
export async function terminalAttempt(server, secret) {
  const socket = new WebSocket(`ws://127.0.0.1:${portOf(server)}/terminal`);
  const messages = [];
  socket.addEventListener("message", (event) => messages.push(String(event.data)));
  const closed = new Promise((done) =>
    socket.addEventListener("close", (event) => done(event.code)),
  );
  await new Promise((done, fail) => {
    socket.addEventListener("open", done);
    socket.addEventListener("error", fail);
  });
  socket.send(JSON.stringify({ ...bootstrapRequest(server), secret }));
  return { code: await closed, messages };
}
