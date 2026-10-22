import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { waitFor } from "../recording-view.mjs";
import { isolatedEnv } from "../test-env.mjs";

// The real `cove-tsnet` for S9 (s9-tsnet-node.test.mjs): the server's node and a peer node on the
// test tailnet of `cove-tsnet-testcontrol` (native/tailscale, loopback DERP and STUN). Every node
// gets the environment the control plane prints, TS_PANIC_IF_HIT_MAIN_CONTROL among it, so
// nothing can reach Tailscale's real control plane, and every directory is test-owned.
//
// Builds go through scripts/tsnet-build.mjs (the pinned Go: COVE_GO or `go` on PATH) into
// `.cache/tsnet-test/<digest of the native sources and the build script>/`, written to a temporary
// name and renamed into place. The directory, the digest and the names (`current`, `testcontrol`)
// are those of the T4 scenarios' fixture, so a run that has both builds each executable once.

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const buildScript = join(repositoryRoot, "scripts/tsnet-build.mjs");
const CURRENT_BUILD = "0.0.0-t4test+current";

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

let builds;

// { current, testcontrol }: the executables, built if this source state has none yet.
export function tsnetBuilds() {
  builds ??= (async () => {
    const directory = join(repositoryRoot, ".cache/tsnet-test", await sourceDigest());
    await mkdir(directory, { recursive: true });
    const want = {
      current: ["build", "--build", CURRENT_BUILD],
      testcontrol: ["testcontrol"],
    };
    const paths = {};
    for (const [name, args] of Object.entries(want)) {
      const path = join(directory, name);
      if (!existsSync(path)) {
        const temporary = `${path}.${process.pid}.tmp`;
        const result = spawnSync(process.execPath, [buildScript, ...args, "--out", temporary], {
          cwd: repositoryRoot,
          env: isolatedEnv(directory),
          encoding: "utf8",
          timeout: 600_000,
        });
        if (result.status !== 0)
          throw new Error(
            `tsnet-build.mjs ${args[0]} failed (${result.status ?? result.signal}); S9 needs Go ` +
              `as pinned in native/tailscale/go.mod (COVE_GO or go on PATH):\n` +
              `${result.stdout}${result.stderr}`,
          );
        await rename(temporary, path);
      }
      paths[name] = path;
    }
    return paths;
  })();
  return builds;
}

// A temporary root with a short path: a dial socket path is limited to 103 bytes, and macOS
// temporary directories are long.
export async function shortRoot(prefix = "cs9") {
  return realpath(await mkdtemp(join("/tmp", `${prefix}-`)));
}

export async function startTailnet(builds) {
  const child = spawn(builds.testcontrol, [], { stdio: ["pipe", "pipe", "pipe"] });
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

// ---------------------------------------------------------------------------------------------
// The peer: a `cove-tsnet dial` daemon of its own, a node of the same tailnet that dials the
// server's node by stable ID (PROTOCOL.md "cove-tsnet dial").

const socketOf = (home) => join(home, "run", "dial.sock");

// One connection to the daemon: hello, then `request`; resolves with the answer frame and the
// socket, whose further bytes (a dial stream) are the caller's.
function daemonRequest(home, request) {
  return new Promise((done, fail) => {
    const socket = connect({ path: socketOf(home) });
    let buffer = Buffer.alloc(0);
    let frames = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      fail(new Error(`dial daemon ${request.op} timed out`));
    }, 60_000);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let end = buffer.indexOf(0x0a); end >= 0; end = buffer.indexOf(0x0a)) {
        const frame = JSON.parse(buffer.subarray(0, end).toString("utf8"));
        buffer = buffer.subarray(end + 1);
        if (++frames === 1) {
          socket.write(`${JSON.stringify(request)}\n`);
          continue;
        }
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("close", onClose);
        done({ answer: frame, socket, rest: buffer });
        return;
      }
    };
    const onClose = () => {
      clearTimeout(timer);
      fail(new Error(`dial daemon ${request.op}: closed unanswered`));
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", () => undefined);
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ op: "hello", protocol: 1, build: "s9-peer" })}\n`),
    );
  });
}

export async function startPeer(binary, tailnet, root) {
  const home = join(root, "peer");
  const child = spawn(
    binary,
    ["dial", "--home", home, "--hostname", "s9-peer", "--control-url", tailnet.controlURL],
    { env: isolatedEnv(root, tailnet.nodeEnv), stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr.on("data", () => undefined);
  await waitFor("the peer's dial socket", () => existsSync(socketOf(home)), 10_000);
  const login = await daemonRequest(home, {
    op: "login",
    authKey: tailnet.authKey,
    timeoutMs: 60_000,
  });
  login.socket.destroy();
  if (!login.answer.ok) throw new Error(`the peer did not log in: ${login.answer.error?.code}`);
  return {
    // A stream to `port` of the node `stableNodeID`: { ok, code } when the dial was refused, else
    // the bytes answered to `bytes` until the stream closes.
    async exchange(stableNodeID, port, bytes) {
      const { answer, socket, rest } = await daemonRequest(home, {
        op: "dial",
        target: { stableNodeID },
        port,
        timeoutMs: 15_000,
      });
      if (!answer.ok) {
        socket.destroy();
        return { ok: false, code: answer.error?.code };
      }
      return new Promise((done) => {
        let received = rest.toString("latin1");
        socket.on("data", (chunk) => (received += chunk.toString("latin1")));
        socket.once("close", () => done({ ok: true, answer: received }));
        const timer = setTimeout(() => socket.destroy(), 20_000);
        socket.once("close", () => clearTimeout(timer));
        socket.write(bytes);
      });
    },
    async stop() {
      const stop = await daemonRequest(home, { op: "stop", force: true }).catch(() => null);
      stop?.socket.destroy();
      const exited = new Promise((done) => child.once("exit", done));
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      if (child.exitCode === null && child.signalCode === null) await exited;
      clearTimeout(timer);
    },
  };
}

// An HTTP/1.1 POST of `body` (an object) with `headers`, closing after the answer.
export function httpPost(port, path, body, headers = {}) {
  const text = JSON.stringify(body);
  return (
    `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
    Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("") +
    `Connection: close\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`
  );
}

// The JSON body of an HTTP answer.
export const bodyOf = (answer) => JSON.parse(answer.slice(answer.indexOf("\r\n\r\n") + 4));
