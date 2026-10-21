import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join, resolve } from "node:path";
import { decodeInvitation, encodeInvitation } from "@cove/protocol/auth";
import { waitFor } from "../recording-view.mjs";
import { isolatedEnv } from "../test-env.mjs";

// Shared fixtures of the M2 T4 tsnet scenarios (S7 tsnet part, S8). Nothing here touches a real
// tailnet, Tailscale's control plane or the operator's data: every node joins the test tailnet of
// `cove-tsnet-testcontrol` (native/tailscale, loopback DERP and STUN) with the environment it
// prints (TS_PANIC_IF_HIT_MAIN_CONTROL among it), and every data directory is under a temporary
// root.
//
// Builds. The scenarios run the real `cove-tsnet` from a test-owned directory, never the
// workspace's dist/: `current` (the build the CLI starts, through the COVE_TSNET_BINARY test
// override), `other` (the same sources built as another build ID, the "old version" of the D14
// version rules) and the test control plane. They are built once per source state through
// scripts/tsnet-build.mjs (the pinned Go: COVE_GO or `go` on PATH) into
// `.cache/tsnet-test/<digest>/`, and reused by every scenario file of the run; a build is written
// to a temporary name and renamed into place, so concurrent files never see a partial binary.
//
// Server node. Until the server runs its own tailnet node (m2 T5b), a scenario stands in for that
// wiring: it runs `cove-tsnet serve` itself and forwards each connection serve hands over to the
// Cove server's loopback port of the same number (business or pairing), which is the port mapping
// the client records. The invitation is the server's own with the serve node's stable ID and name
// added, as the server will advertise them.

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const buildScript = join(repositoryRoot, "scripts/tsnet-build.mjs");
export const CURRENT_BUILD = "0.0.0-t4test+current";
export const OTHER_BUILD = "0.0.0-t4test+other";

async function sourceDigest() {
  const hash = createHash("sha256");
  const walk = async (directory) => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "dist") await walk(path);
      } else if (/\.(go|mod|sum)$/.test(entry.name)) {
        hash.update(path.slice(repositoryRoot.length)).update("\0");
        hash.update(await readFile(path)).update("\0");
      }
    }
  };
  await walk(join(repositoryRoot, "native/tailscale"));
  hash.update(await readFile(buildScript));
  return hash.digest("hex").slice(0, 16);
}

function runBuild(args, env) {
  const result = spawnSync(process.execPath, [buildScript, ...args], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
    timeout: 600_000,
  });
  if (result.status !== 0)
    throw new Error(
      `tsnet-build.mjs ${args[0]} failed (${result.status ?? result.signal}); the tsnet ` +
        `scenarios need Go as pinned in native/tailscale/go.mod (COVE_GO or go on PATH):\n` +
        `${result.stdout}${result.stderr}`,
    );
}

let builds;

// The three executables, built if this source state has none yet.
export function tsnetBuilds() {
  builds ??= (async () => {
    const directory = join(repositoryRoot, ".cache/tsnet-test", await sourceDigest());
    await mkdir(directory, { recursive: true });
    const env = isolatedEnv(directory);
    const want = {
      current: ["build", "--build", CURRENT_BUILD],
      other: ["build", "--build", OTHER_BUILD],
      testcontrol: ["testcontrol"],
    };
    const paths = {};
    for (const [name, args] of Object.entries(want)) {
      const path = join(directory, name);
      if (!existsSync(path)) {
        const temporary = `${path}.${process.pid}.tmp`;
        runBuild([...args, "--out", temporary], env);
        await rename(temporary, path);
      }
      paths[name] = path;
    }
    return paths;
  })();
  return builds;
}

// A temporary root with a short path: the dial socket path is limited to 103 bytes, and macOS
// temporary directories are long.
export async function shortRoot(prefix = "ct4") {
  return realpath(await mkdtemp(join("/tmp", `${prefix}-`)));
}

// ---------------------------------------------------------------------------------------------
// CLI commands outside the auth fixture.

export const cliPath = resolve(import.meta.dirname, "../../dist/main.js");

// The environment of a CLI under `root` with the tsnet variables `extra`.
export function cliEnv(root, extra = {}) {
  return isolatedEnv(root, extra);
}

// Runs `cove --home HOME ...args` with `input` on stdin (or none), to completion:
// { code, signal, stdout, stderr, elapsedMs }.
export function runCove(env, home, args, { input, timeoutMs = 60_000 } = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, [cliPath, "--home", home, ...args], {
    env,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  if (input !== undefined) child.stdin.end(input);
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  return new Promise((done) =>
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, stdout, stderr, elapsedMs: Date.now() - started });
    }),
  );
}

export async function runCoveJson(env, home, args, options) {
  const result = await runCove(env, home, args, options);
  if (result.code !== 0)
    throw new Error(`cove ${args.join(" ")} exited ${result.code}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// ---------------------------------------------------------------------------------------------
// The test tailnet.

export async function startTailnet(builds, { requireAuthKey = false } = {}) {
  const child = spawn(builds.testcontrol, requireAuthKey ? ["--require-auth-key"] : [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((done) => child.once("exit", done));
  await waitFor(
    "the test control plane",
    () => stdout.includes("\n") || child.exitCode !== null,
    20_000,
  );
  if (child.exitCode !== null) throw new Error(`cove-tsnet-testcontrol exited: ${stderr}`);
  const info = JSON.parse(stdout.split("\n")[0]);
  return {
    controlURL: info.controlURL,
    authKey: info.authKey,
    nodeEnv: info.nodeEnv,
    async stop() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

// The environment of a CLI (or of this test process, for in-process sessions) whose tsnet node
// joins `tailnet` and whose dial daemon is `binary`.
export function clientEnv(tailnet, binary) {
  return {
    ...tailnet.nodeEnv,
    COVE_TSNET_BINARY: binary,
    COVE_TSNET_CONTROL_URL: tailnet.controlURL,
  };
}

// ---------------------------------------------------------------------------------------------
// A standalone serve node standing in for the server's tailnet wiring (T5b).

// `cove-tsnet serve` joined to `tailnet`, forwarding each tailnet connection on `port` to
// 127.0.0.1:`targets[port]()`. `recorded` holds every byte peers sent through it, per port.
export async function startServeNode(builds, tailnet, root, { hostname = "cove-srv" } = {}) {
  const forwardDirectory = join(root, "fwd");
  await mkdir(forwardDirectory, { recursive: true, mode: 0o700 });
  const socketPath = join(forwardDirectory, "s.sock");
  const targets = new Map();
  const recorded = [];
  const connections = new Set();
  const forward = createServer((inbound) => {
    connections.add(inbound);
    inbound.on("close", () => connections.delete(inbound));
    let header = Buffer.alloc(0);
    const onHeader = (chunk) => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf(0x0a);
      if (end < 0) return;
      inbound.off("data", onHeader);
      const info = JSON.parse(header.subarray(0, end).toString("utf8"));
      const rest = header.subarray(end + 1);
      const entry = { port: info.port, peer: info.peer, bytes: [] };
      recorded.push(entry);
      const target = targets.get(info.port)?.();
      if (target === undefined) {
        inbound.destroy();
        return;
      }
      const upstream = connect({ host: "127.0.0.1", port: target });
      connections.add(upstream);
      upstream.on("close", () => connections.delete(upstream));
      const take = (chunk) => {
        entry.bytes.push(chunk);
        upstream.write(chunk);
      };
      if (rest.length) take(rest);
      inbound.on("data", take);
      upstream.on("data", (chunk) => inbound.write(chunk));
      inbound.on("end", () => upstream.end());
      upstream.on("end", () => inbound.end());
      for (const [a, b] of [
        [inbound, upstream],
        [upstream, inbound],
      ]) {
        a.on("close", () => b.destroy());
        a.on("error", () => b.destroy());
      }
    };
    inbound.on("data", onHeader);
    inbound.on("error", () => inbound.destroy());
  });
  await new Promise((done) => forward.listen(socketPath, done));

  const child = spawn(
    builds.current,
    [
      "serve",
      ...["--home", join(root, "tsnet"), "--forward-socket", socketPath],
      ...["--hostname", hostname, "--control-url", tailnet.controlURL],
    ],
    { env: isolatedEnv(root, tailnet.nodeEnv), stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((done) => child.once("exit", done));
  const pending = new Map();
  let nextId = 0;
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const answer = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      pending.get(answer.id)?.(answer);
      pending.delete(answer.id);
    }
  });
  const call = (request) =>
    new Promise((done, fail) => {
      const id = String(++nextId);
      const timer = setTimeout(
        () => fail(new Error(`serve ${request.op} timed out: ${stderr}`)),
        90_000,
      );
      pending.set(id, (answer) => {
        clearTimeout(timer);
        done(answer);
      });
      child.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
    });
  const hello = await call({ op: "hello", protocol: 1, build: "t4-fixture" });
  if (!hello.ok) throw new Error(`serve hello failed: ${JSON.stringify(hello)}`);

  const node = {
    recorded,
    stderr: () => stderr,
    // Logs the node in and returns its identity: { stableNodeID, name } (the name without the
    // trailing dot, as an invitation carries it).
    async login() {
      const answer = await call({ op: "login", authKey: tailnet.authKey });
      if (!answer.ok || answer.result.state !== "Running")
        throw new Error(`serve login failed: ${JSON.stringify(answer)}`);
      const self = answer.result.self;
      node.self = { stableNodeID: self.stableNodeID, name: self.name.replace(/\.$/, "") };
      return node.self;
    },
    async logout() {
      const answer = await call({ op: "logout" });
      if (!answer.ok) throw new Error(`serve logout failed: ${JSON.stringify(answer)}`);
    },
    // Serves `port` on the tailnet and forwards it to 127.0.0.1:`target()` (a function, so a
    // scenario can repoint it).
    async serve(map) {
      for (const [port, target] of map) targets.set(port, target);
      const answer = await call({ op: "setPorts", ports: [...targets.keys()] });
      if (!answer.ok) throw new Error(`serve setPorts failed: ${JSON.stringify(answer)}`);
    },
    // Every byte peers sent on `port`, as latin1 text.
    sent(port) {
      return recorded
        .filter((entry) => entry.port === port)
        .map((entry) => Buffer.concat(entry.bytes).toString("latin1"))
        .join("");
    },
    async stop() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      await exited;
      clearTimeout(timer);
      for (const connection of connections) connection.destroy();
      await new Promise((done) => forward.close(done));
    },
  };
  return node;
}

// The server's invitation with the serve node added as its tsnet entry.
export function withTsnetEntry(invitation, self) {
  const payload = decodeInvitation(invitation);
  if (!payload) throw new Error("not an invitation");
  return encodeInvitation({
    ...payload,
    entries: { ...payload.entries, tsnet: { nodeId: self.stableNodeID, name: self.name } },
  });
}

// ---------------------------------------------------------------------------------------------
// Dial daemons.

export const socketOf = (home) => join(home, "tsnet-client", "run", "dial.sock");

// One request on a fresh dial-socket connection after hello: { hello, answer, socket }. With
// `keep` the socket stays open (a dial stream); otherwise it is closed after the answer.
export function dialRequest(home, request, { keep = false, build = "t4-fixture" } = {}) {
  return new Promise((done, fail) => {
    const socket = connect({ path: socketOf(home) });
    let buffer = "";
    const frames = [];
    const timer = setTimeout(() => {
      socket.destroy();
      fail(new Error(`dial ${request?.op ?? "hello"} timed out`));
    }, 30_000);
    const finish = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      if (!keep) socket.destroy();
      done({ hello: frames[0], answer: frames[1], socket });
    };
    const onData = (chunk) => {
      buffer += chunk.toString("latin1");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        frames.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
        if (frames.length === 1 && request) socket.write(`${JSON.stringify(request)}\n`);
        if (frames.length === (request ? 2 : 1)) finish();
      }
    };
    socket.on("data", onData);
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ op: "hello", protocol: 1, build })}\n`),
    );
    socket.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
  });
}

// The running daemon's hello for `home`, or null when none answers.
export async function daemonHello(home) {
  try {
    return (await dialRequest(home, null)).hello.result;
  } catch {
    return null;
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A daemon this test starts itself (another build, or one paused at a debug point), as a child
// of the test process.
export function spawnDaemon(binary, home, tailnet, args = []) {
  const child = spawn(
    binary,
    [
      "dial",
      "--home",
      join(home, "tsnet-client"),
      ...(tailnet ? ["--control-url", tailnet.controlURL] : []),
      ...args,
    ],
    { env: isolatedEnv(home, tailnet?.nodeEnv ?? {}), stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  return { child, pid: child.pid, stderr: () => stderr, exited };
}

// Ends whatever daemon serves `home` (stop with force, then SIGKILL of the PID it reported), and
// waits until it is gone. For cleanup: a daemon the CLI started outlives the command by design.
export async function endDaemon(home) {
  const hello = await daemonHello(home);
  if (!hello) return;
  await dialRequest(home, { op: "stop", force: true }).catch(() => undefined);
  try {
    await waitFor(`dial daemon ${hello.pid} to exit`, () => !alive(hello.pid), 10_000);
  } catch {
    process.kill(hello.pid, "SIGKILL");
    await waitFor(`dial daemon ${hello.pid} to die`, () => !alive(hello.pid), 5_000);
  }
}

// Every file under `directory` whose bytes contain `secret`.
export async function filesHolding(directory, secret) {
  const found = [];
  const walk = async (path) => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && (await readFile(child)).includes(secret)) found.push(child);
    }
  };
  await walk(directory);
  return found;
}

export async function modeOf(path) {
  return (await stat(path)).mode & 0o777;
}

export async function removeRoot(root) {
  await rm(root, { recursive: true, force: true });
}
