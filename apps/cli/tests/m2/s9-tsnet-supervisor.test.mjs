import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";

// The compiled modules of the server package, as auth-server-entry.mjs loads the server.
const serverPackage = dirname(createRequire(import.meta.url).resolve("@cove/server/package.json"));
const compiled = (path) => import(pathToFileURL(join(serverPackage, "dist", path)).href);
const { TsnetNode, apiStatus, sanitizedText } = await compiled("network/tsnet.js");
const { entryOf, peerOf } = await compiled("transport/connection-entry.js");

// The server's tsnet node (apps/server network/tsnet.ts) in process, against a stand-in helper
// speaking the serve protocol (s9-fake-tsnet.mjs): lazy start, port sync, supervision, the
// forwarded-connection handover and shutdown. s9-tsnet-node.test.mjs runs the real helper.

const FAKE = resolve(import.meta.dirname, "s9-fake-tsnet.mjs");
const KEY = "tskey-auth-unit0123456789abcdef";

const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, check, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(50);
  }
}

function rig({ withState = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "cove-tsnet-unit-"));
  const logs = [];
  // When each event was logged, for the backoff checks.
  const logged = [];
  const handed = [];
  const portListeners = [];
  let pairingPort;
  // A listener reads a handed-over socket at once, as an HTTP server does.
  const hand = (port, socket, peer) => {
    const entry = { port, socket, peer, bytes: "" };
    socket.on("data", (chunk) => (entry.bytes += chunk));
    handed.push(entry);
  };
  const node = new TsnetNode();
  const context = {
    home,
    hostname: "cove-unit",
    buildVersion: "unit-build",
    binary: FAKE,
    businessPort: 41001,
    pairingPort: () => pairingPort,
    acceptBusiness: (socket, peer) => hand("business", socket, peer),
    acceptPairing: (socket, peer) => hand("pairing", socket, peer),
    onPairingPortChange: (listener) => portListeners.push(listener),
    log: (event) => {
      logs.push(JSON.stringify(event));
      logged.push({ event: event.event, at: Date.now() });
    },
  };
  cleanup.push(async () => {
    await node.close();
    for (const { socket } of handed) socket.destroy();
    rmSync(home, { recursive: true, force: true });
  });
  const ops = async () =>
    (await readFile(join(home, "tsnet", "fake-ops.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    home,
    node,
    context,
    logs,
    logged,
    handed,
    ops,
    async seedState() {
      await mkdir(join(home, "tsnet", "state"), { recursive: true });
      await writeFile(
        join(home, "tsnet", "state", "node.json"),
        JSON.stringify({ id: "nSeed1CNTRL" }),
      );
    },
    async setPairing(port) {
      pairingPort = port;
      for (const listener of portListeners) await listener();
    },
    withState,
    // Starts the node and waits until its helper answered and was sent the ports.
    async startRunning() {
      expect(await node.start(context)).toBeUndefined();
      await until("the helper's first port set", async () =>
        (await ops()).some((op) => op.op === "setPorts"),
      );
      expect(node.pid).toBeGreaterThan(0);
    },
  };
}

test("a node without state starts no helper and reports logged-out; a login starts it", async () => {
  const { node, context, ops, home } = rig();
  const started = await node.start(context);
  expect(started?.error.kind).toBe("ENTRY_UNAVAILABLE");
  expect(node.pid).toBeUndefined();
  expect((await node.status()).state).toBe("logged-out");
  expect(existsSync(join(home, "tsnet", "fake-ops.jsonl"))).toBe(false);

  expect(await node.available()).toEqual({ ok: true });
  const outcome = await node.login(KEY, 5_000);
  expect(outcome.kind).toBe("answered");
  expect(outcome.status).toMatchObject({
    state: "running",
    nodeId: "nFake1CNTRL",
    nodeName: "cove-unit.tail.example",
    hostname: "cove-unit",
    hold: null,
  });
  const seen = await ops();
  // The hostname is a flag, the key only ever a field of the login frame.
  expect(seen[0].args).toEqual(expect.arrayContaining(["serve", "--hostname", "cove-unit"]));
  expect(seen.map((op) => op.op)).toEqual(["start", "hello", "setPorts", "login"]);
  expect(seen.find((op) => op.op === "login").hasKey).toBe(true);
  expect(JSON.stringify(seen)).not.toContain(KEY);
});

test("ports follow the pairing listener, and an invitation advertises only a node listening on both", async () => {
  const { node, ops, seedState, setPairing, startRunning } = rig();
  await seedState();
  await startRunning();
  await until("the first port set", async () => (await ops()).some((op) => op.op === "setPorts"));
  expect((await ops()).filter((op) => op.op === "setPorts").map((op) => op.ports)).toEqual([
    [41001],
  ]);
  expect(node.invitationEntry(42001)).toBeNull();

  await setPairing(42001);
  expect(node.invitationEntry(42001)).toEqual({
    nodeId: "nSeed1CNTRL",
    name: "cove-unit.tail.example",
  });
  expect(node.invitationEntry(42002)).toBeNull();
  await setPairing(undefined);
  expect(node.invitationEntry(42001)).toBeNull();
  expect((await ops()).filter((op) => op.op === "setPorts").map((op) => op.ports)).toEqual([
    [41001],
    [41001, 42001],
    [41001],
  ]);
  expect((await node.status()).ports).toEqual([41001]);
});

test("a helper that dies is restarted with the current ports, and close stops it", async () => {
  const { node, context, ops, seedState, setPairing, logs, startRunning } = rig();
  await seedState();
  await startRunning();
  await setPairing(42001);
  const first = node.pid;
  process.kill(first, "SIGKILL");
  await until("a restarted helper", () => node.pid !== undefined && node.pid !== first);
  await until(
    "the ports sent to the restarted helper",
    async () =>
      (await ops()).filter((op) => op.op === "hello").length === 2 &&
      (await ops()).at(-1).op === "setPorts",
  );
  expect((await ops()).at(-1).ports).toEqual([41001, 42001]);
  expect((await node.status()).state).toBe("running");
  expect(logs.some((line) => line.includes("tsnet-helper-exited"))).toBe(true);
  // The helper's stderr is logged with its URL replaced.
  expect(logs.some((line) => line.includes("fake-tsnet: started"))).toBe(true);
  expect(logs.join("\n")).not.toContain("https://");

  const pid = node.pid;
  await node.close();
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  expect(existsSync(join(context.home, "tsnet", "run", "forward.sock"))).toBe(false);
});

test("forwarded connections are handed to the listener of their port with the bytes after the header", async () => {
  const { context, handed, seedState, setPairing, startRunning } = rig();
  await seedState();
  await startRunning();
  await setPairing(42001);
  const path = join(context.home, "tsnet", "run", "forward.sock");
  const send = (header, rest) => {
    const socket = connect(path);
    socket.on("error", () => undefined);
    const state = { closed: false };
    socket.once("close", () => (state.closed = true));
    socket.write(`${JSON.stringify(header)}\n${rest}`);
    cleanup.push(() => socket.destroy());
    return state;
  };
  const peer = { stableNodeID: "nPeer1CNTRL", name: "laptop.tail.example." };
  send(
    { protocol: 1, port: 41001, remoteAddr: "100.64.0.2:1", peer, whoIsError: "" },
    "GET / HTTP/1.1\r\n",
  );
  send({ protocol: 1, port: 42001, remoteAddr: "100.64.0.2:2", peer: null, whoIsError: "x" }, "");
  const unknownPort = send({ protocol: 1, port: 9, remoteAddr: "100.64.0.2:3", peer: null }, "");
  const badProtocol = send({ protocol: 2, port: 41001 }, "");
  await until("two handovers", () => handed.length === 2);
  const business = handed.find((entry) => entry.port === "business");
  expect(business.peer).toEqual({ stableNodeID: "nPeer1CNTRL", name: "laptop.tail.example" });
  expect(entryOf(business.socket)).toBe("tsnet");
  expect(peerOf(business.socket)).toEqual(business.peer);
  await until("the bytes after the header", () => business.bytes === "GET / HTTP/1.1\r\n");
  expect(handed.find((entry) => entry.port === "pairing").peer).toBeNull();
  await until("the refused connections to close", () => unknownPort.closed && badProtocol.closed);
});

// The gaps between successive events named `name`, once there are `count` of them.
async function gapsOf(logged, name, count) {
  await until(
    `${count} ${name} events`,
    () => logged.filter((entry) => entry.event === name).length >= count,
    20_000,
  );
  const times = logged.filter((entry) => entry.event === name).map((entry) => entry.at);
  return times.slice(1, count).map((at, index) => at - times[index]);
}

test("a helper that cannot be spawned is retried with a growing backoff and runs once it can be", async () => {
  const { node, context, seedState, logs, logged, home } = rig();
  await seedState();
  const binary = join(home, "cove-tsnet");
  context.binary = binary;
  expect(await node.start(context)).toBeUndefined();
  // ENOENT arrives as the child's `error` event, then `close`, never `exit`.
  const gaps = await gapsOf(logged, "tsnet-helper-failed", 3);
  expect(gaps[0]).toBeGreaterThanOrEqual(900);
  expect(gaps[1]).toBeGreaterThanOrEqual(1_900);
  expect(logs.find((line) => line.includes("tsnet-helper-failed"))).toContain('"code":"ENOENT"');
  expect(node.pid).toBeUndefined();
  const down = await node.status();
  expect(down.state).toBe("failed");
  expect(down.warnings[0]).toMatch(/could not be started \(ENOENT\)/);

  symlinkSync(FAKE, binary);
  await until("the helper to run", () => node.pid !== undefined, 15_000);
  await until("the node to run", async () => (await node.status())?.state === "running");
  expect(logs.some((line) => line.includes("tsnet-helper-started"))).toBe(true);
}, 40_000);

test("a forward socket that cannot be opened backs off as a failed start, not as a long run", async () => {
  const { node, context, seedState, logged, home } = rig();
  await seedState();
  // A file where the socket's directory belongs.
  writeFileSync(join(home, "tsnet", "run"), "");
  expect(await node.start(context)).toBeUndefined();
  const gaps = await gapsOf(logged, "tsnet-unavailable", 3);
  expect(gaps[0]).toBeGreaterThanOrEqual(900);
  expect(gaps[1]).toBeGreaterThanOrEqual(1_900);
  expect((await node.status()).warnings[0]).toMatch(/forward socket cannot be opened/);
  rmSync(join(home, "tsnet", "run"));
  await until("the helper to run", () => node.pid !== undefined, 15_000);
}, 40_000);

test("a helper speaking another protocol is not restarted", async () => {
  const { node, context, seedState, logs } = rig();
  await seedState();
  process.env.FAKE_TSNET_PROTOCOL = "2";
  try {
    // Startup does not wait for the helper; it is found incompatible in the background.
    expect(await node.start(context)).toBeUndefined();
    await until("the helper's answer", () =>
      logs.some((line) => line.includes("protocol mismatch")),
    );
    await until("the helper to exit", () => node.pid === undefined);
  } finally {
    delete process.env.FAKE_TSNET_PROTOCOL;
  }
  await delay(1_500);
  expect(node.pid).toBeUndefined();
  expect((await node.status()).warnings[0]).toMatch(/local protocol 2/);
  expect(logs.filter((line) => line.includes("tsnet-helper-started"))).toHaveLength(0);
});

test("third-party text is bounded and never carries a URL or a secret", () => {
  expect(sanitizedText("open https://login.example.test/a/x now\u0007", 100)).toBe(
    "open [url] now ",
  );
  expect(sanitizedText(`key ${KEY}`, 100, [KEY])).toBe("key [redacted]");
  expect(sanitizedText("x".repeat(600), 512)).toHaveLength(512);
  const status = apiStatus(
    {
      state: "Weird",
      self: { stableNodeID: "n-bad id", name: "UPPER.case." },
      ports: [1, 1, 70000, "x"],
      hold: "LOGIN_UNCERTAIN",
      warnings: ["a", "see http://x.test/y", 3, "c", "d", "e"],
      authURL: "https://login.example.test/a/never-shown",
    },
    null,
  );
  expect(status).toEqual({
    state: "failed",
    hostname: null,
    nodeId: null,
    nodeName: "upper.case",
    hold: "login-uncertain",
    ports: [1],
    warnings: ["a", "see [url]", "c", "d"],
  });
  expect(JSON.stringify(status)).not.toContain("never-shown");
  expect(readFileSync(FAKE, "utf8")).toContain("PROTOCOL.md");
});
