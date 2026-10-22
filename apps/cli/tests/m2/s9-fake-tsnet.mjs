#!/usr/bin/env node
// A stand-in for `cove-tsnet serve` (native/tailscale/PROTOCOL.md, local protocol 1) for the tests
// that exercise the server's supervision, port sync, forwarding and secret handling without a
// Go build or a control plane (s9-tsnet-supervisor, s9-tsnet-login).
// S9 itself runs the real helper against testcontrol.
//
// Node state is `<home>/state/node.json`. Auth keys: one starting `tskey-fail` is rejected
// (LOGIN_FAILED), `tskey-other` logs in as another node than the enrolled one (IDENTITY_CHANGED),
// `tskey-hang` is never answered, any other logs in. Without a key the login is interactive and
// answers with a URL; it completes at a status shortly after. Every request is appended to `<home>/fake-ops.jsonl` as its op, whether it
// carried a key and its ports, never the key itself. FAKE_TSNET_PROTOCOL overrides the protocol
// hello answers with.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
if (args[0] !== "serve") process.exit(2);
const home = flag("--home");
const stateFile = join(home, "state", "node.json");
const ops = join(home, "fake-ops.jsonl");
mkdirSync(home, { recursive: true });
let ports = [];
let pendingUrl = null;
// An interactive login completes at the first status at least this long after its URL was given,
// as if someone had opened it.
const INTERACTIVE_COMPLETES_MS = 300;
let pendingSince = 0;
const node = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null);

appendFileSync(
  ops,
  `${JSON.stringify({ op: "start", pid: process.pid, args: args.filter((a) => a !== home) })}\n`,
);
// A line with a URL, which the server must not log as is.
process.stderr.write("fake-tsnet: started, see https://login.example.test/a/startup-url\n");

function status() {
  const current = node();
  const running = current !== null;
  return {
    state: running ? "Running" : pendingUrl ? "NeedsLogin" : "LoggedOut",
    ...(pendingUrl ? { authURL: pendingUrl } : {}),
    self: running
      ? { stableNodeID: current.id, name: `${flag("--hostname") ?? "cove-fake"}.tail.example.` }
      : null,
    ports: running ? ports : [],
    streams: [],
    warnings: [],
  };
}

const answer = (id, result) =>
  process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
const refuse = (id, code) =>
  process.stdout.write(
    `${JSON.stringify({ id, ok: false, error: { code, message: code.toLowerCase() } })}\n`,
  );

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(
    ops,
    `${JSON.stringify({ op: request.op, hasKey: typeof request.authKey === "string", ports: request.ports })}\n`,
  );
  const { id } = request;
  switch (request.op) {
    case "hello":
      answer(id, {
        protocol: Number(process.env.FAKE_TSNET_PROTOCOL ?? 1),
        build: request.build,
        mode: "serve",
      });
      return;
    case "status":
      if (pendingUrl && Date.now() - pendingSince >= INTERACTIVE_COMPLETES_MS) {
        mkdirSync(join(home, "state"), { recursive: true, mode: 0o700 });
        writeFileSync(stateFile, JSON.stringify({ id: "nFake1CNTRL" }));
        pendingUrl = null;
      }
      answer(id, status());
      return;
    case "setPorts":
      ports = [...request.ports];
      answer(id, status());
      return;
    case "login": {
      const key = request.authKey;
      if (key === undefined) {
        if (node()) return refuse(id, "ALREADY_LOGGED_IN");
        pendingUrl = "https://login.example.test/a/interactive-0123456789";
        pendingSince = Date.now();
        answer(id, status());
        return;
      }
      if (key.startsWith("tskey-hang")) return;
      if (key.startsWith("tskey-fail")) return refuse(id, "LOGIN_FAILED");
      const enrolled = node();
      if (key.startsWith("tskey-other") && enrolled) return refuse(id, "IDENTITY_CHANGED");
      mkdirSync(join(home, "state"), { recursive: true, mode: 0o700 });
      writeFileSync(stateFile, JSON.stringify({ id: enrolled?.id ?? "nFake1CNTRL" }));
      pendingUrl = null;
      answer(id, status());
      return;
    }
    case "logout":
      rmSync(join(home, "state"), { recursive: true, force: true });
      pendingUrl = null;
      ports = [];
      answer(id, { ...status(), remoteLogoutConfirmed: true });
      return;
    default:
      refuse(id, "BAD_REQUEST");
  }
});
lines.on("close", () => process.exit(0));
