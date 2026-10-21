import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
//     "events": "/path" }                one JSON line per request: { op, authKey: bool, force,
//                                        bytesBeforeAnswer }; never the key itself
// It keeps no lock: a scenario runs one fake daemon per home.

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
rmSync(sock, { force: true });

const record = (event) => {
  const { events } = config();
  if (events) appendFileSync(events, `${JSON.stringify(event)}\n`);
};
const reply = (socket, frame) => socket.write(`${JSON.stringify(frame)}\n`);

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
      if (settings.delayMs) await new Promise((done) => setTimeout(done, settings.delayMs));
      record({
        op: request.op,
        authKey: typeof request.authKey === "string",
        force: request.force === true,
        bytesBeforeAnswer: buffer.length,
      });
      if (request.op === "stop") {
        server.close();
        rmSync(sock, { force: true });
        reply(socket, { ok: true, result: {} });
        socket.end(() => process.exit(0));
        return;
      }
      const answer = settings.answers?.[request.op];
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
