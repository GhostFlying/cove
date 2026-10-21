import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";

// A scripted stand-in for `cove-tsnet dial` (native/tailscale/PROTOCOL.md), for the CLI cases
// the real daemon cannot be made to produce on a test tailnet: another local protocol, an identity
// hold after a login, a logout the control plane did not confirm, a peer that answers WhoIs as
// another node. The CLI starts it through the COVE_TSNET_BINARY test override (via a small sh
// wrapper the test writes), exactly as it starts the real one.
//
//   tsnet-fake-dial.mjs version
//   tsnet-fake-dial.mjs dial --home DIR [--idle-timeout D] [--control-url U]
//
// Behavior comes from the JSON file named by COVE_TEST_FAKE_DIAL, read again for every request so
// a test can change it while the daemon runs:
//   { "build": "...", "protocol": 1,
//     "streams": [StreamInfo...],        reported in hello and status (no real stream behind them)
//     "answers": { "<op>": { "ok": true, "result": {...} } | { "ok": false, "error": {...} } },
//     "dialForward": PORT,               a successful dial forwards to 127.0.0.1:PORT
//     "dialPeer": "nodeID",              the peer a successful dial reports
//     "delayMs": N,                      wait before answering a request
//     "delays": { "<op>": N },           wait before answering that request (hello included)
//     "laterDials": answer,              the answer to every dial after the first of a label (a
//                                        hold or mismatch that starts after the bootstrap stream)
//     "exitOnce": "/path",               the first fake started exits 0 before it listens
//                                        (and creates the file); later ones run normally
//     "events": "/path" }                one JSON line per request: { op, authKey: bool, force,
//                                        bytesBeforeAnswer }; never the key itself
// It keeps no lock. In its place, a fake started while another one answers connections on the
// socket exits 75, as a real daemon that lost the lock does, so the CLI's start loop sees the
// same outcomes.

const config = () => JSON.parse(readFileSync(process.env.COVE_TEST_FAKE_DIAL, "utf8"));
const [command, ...args] = process.argv.slice(2);

if (command === "version") {
  const { build, protocol } = config();
  process.stdout.write(`cove-tsnet build=${build} protocol=${protocol}\n`);
  process.exit(0);
}
if (command !== "dial") process.exit(2);
const home = args[args.indexOf("--home") + 1];
const run = join(home, "run");
mkdirSync(run, { recursive: true, mode: 0o700 });
const sock = join(run, "dial.sock");
const owned = await new Promise((done) => {
  const probe = connect(sock);
  probe.once("connect", () => {
    probe.destroy();
    done(true);
  });
  probe.once("error", () => done(false));
});
if (owned) process.exit(75);
// A daemon that ends normally (status 0) before it listens, as one stopped or idle-exiting before
// the command that started it connected; the first start only.
const { exitOnce } = config();
if (exitOnce && !existsSync(exitOnce)) {
  writeFileSync(exitOnce, "exited\n");
  process.exit(0);
}
rmSync(sock, { force: true });
const wait = (ms) => (ms ? new Promise((done) => setTimeout(done, ms)) : undefined);

const record = (event) => {
  const { events } = config();
  if (events) appendFileSync(events, `${JSON.stringify(event)}\n`);
};
const reply = (socket, frame) => socket.write(`${JSON.stringify(frame)}\n`);
// The stream labels seen (one per CLI process and entry: "box (cove pid N)").
const labels = new Set();

const server = createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let stage = "hello";
  socket.on("error", () => socket.destroy());
  const onData = async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (stage === "stream") return;
      const end = buffer.indexOf(0x0a);
      if (end < 0) return;
      const request = JSON.parse(buffer.subarray(0, end).toString("utf8"));
      buffer = buffer.subarray(end + 1);
      const settings = config();
      if (stage === "hello") {
        stage = "request";
        await wait(settings.delays?.hello);
        if (socket.destroyed) return;
        reply(socket, {
          ok: true,
          result: {
            protocol: settings.protocol,
            build: settings.build,
            mode: "dial",
            pid: process.pid,
            streams: settings.streams ?? [],
          },
        });
        continue;
      }
      stage = request.op === "dial" ? "stream" : "done";
      await wait(settings.delayMs);
      record({
        op: request.op,
        authKey: typeof request.authKey === "string",
        force: request.force === true,
        bytesBeforeAnswer: buffer.length,
      });
      // A request held this long (or forever) after it was recorded as received.
      await wait(settings.delays?.[request.op]);
      if (socket.destroyed) return;
      if (request.op === "stop") {
        server.close();
        rmSync(sock, { force: true });
        reply(socket, { ok: true, result: {} });
        socket.end(() => process.exit(0));
        return;
      }
      // A command's first stream gets the ordinary answer; its later ones `laterDials`, if set.
      let answer = settings.answers?.[request.op];
      if (request.op === "dial") {
        if (labels.has(request.label) && settings.laterDials) answer = settings.laterDials;
        labels.add(request.label);
      }
      if (request.op === "dial" && (!answer || answer.ok)) {
        const upstream = connect({ host: "127.0.0.1", port: settings.dialForward });
        upstream.once("connect", () => {
          reply(socket, {
            ok: true,
            result: { streamId: "s1", peer: { stableNodeID: settings.dialPeer } },
          });
          if (buffer.length) upstream.write(buffer);
          socket.off("data", onData);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        return;
      }
      reply(socket, answer ?? { ok: true, result: { state: "Running", streams: [] } });
      socket.end();
      return;
    }
  };
  socket.on("data", onData);
});
server.listen(sock, () => process.stderr.write(`fake dial: listening pid=${process.pid}\n`));
process.on("SIGTERM", () => {
  rmSync(sock, { force: true });
  process.exit(0);
});
