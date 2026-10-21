import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import { bootstrapRequest, createAuthFixture, portOf } from "./auth-fixtures.mjs";

// Request shapes a Cove client never sends, written byte for byte on a raw socket against the
// compiled server (relay-protocol §11.1):
// - an absolute-form request target (`POST http://evil.example/bootstrap`), which the router would
//   match by its path alone, is malformed (400) before admission on the business port, for
//   /bootstrap, /rpc, OPTIONS and the terminal WebSocket upgrade, whatever its authority.
// Each case has an origin-form control on the same connection shape that is admitted.

let fixture;

beforeEach(async () => {
  fixture = await createAuthFixture();
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

// Sends `head` (CRLF-joined lines) and `body` on a new connection; resolves with the status code
// and the whole answer once the server has answered (or closed).
function raw(port, lines, body = "") {
  return new Promise((done, fail) => {
    const socket = connect({ host: "127.0.0.1", port });
    let received = "";
    const finish = () => {
      socket.destroy();
      const status = /^HTTP\/1\.1 (\d{3})/.exec(received);
      done({ status: status ? Number(status[1]) : null, raw: received });
    };
    socket.setTimeout(5_000, finish);
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      // One answer is enough: a complete head plus its declared body, or a 101.
      const head = received.indexOf("\r\n\r\n");
      if (head < 0) return;
      if (received.startsWith("HTTP/1.1 101")) return finish();
      const length = /\r\ncontent-length: (\d+)/i.exec(received.slice(0, head));
      if (!length || received.length - head - 4 >= Number(length[1])) finish();
    });
    socket.once("end", finish);
    socket.once("error", fail);
    socket.once("connect", () => {
      const payload = Buffer.from(body);
      socket.write(
        [
          ...lines,
          ...(body ? ["Content-Type: application/json", `Content-Length: ${payload.length}`] : []),
          "",
          "",
        ].join("\r\n"),
      );
      if (body) socket.write(payload);
    });
  });
}

const upgrade = () => [
  "Upgrade: websocket",
  "Connection: Upgrade",
  `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
  "Sec-WebSocket-Version: 13",
];

test("an absolute-form request target is malformed before admission on the business port", async () => {
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome);
  const port = portOf(server);
  const { serverId, relayInstanceId, secret } = server.record;
  const host = `Host: 127.0.0.1:${port}`;
  const identity = JSON.stringify(bootstrapRequest(server));
  const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "task.list", params: {} });
  const business = [
    `Authorization: Bearer ${secret}`,
    "Cove-Protocol: 2",
    `Cove-Server-Id: ${serverId}`,
    `Cove-Instance-Id: ${relayInstanceId}`,
  ];
  const preflight = [
    "Origin: http://example.test",
    "Access-Control-Request-Method: POST",
    "Access-Control-Request-Headers: content-type",
  ];
  const cases = [
    { method: "POST", path: "/bootstrap", extra: [], body: identity, admitted: 200 },
    { method: "POST", path: "/rpc", extra: business, body: rpc, admitted: 200 },
    { method: "GET", path: "/terminal", extra: upgrade, body: "", admitted: 101 },
  ];
  for (const { method, path, extra, body, admitted } of cases) {
    const headers = () => (typeof extra === "function" ? extra() : extra);
    // The control: the same request in origin form is admitted.
    const control = await raw(port, [`${method} ${path} HTTP/1.1`, host, ...headers()], body);
    expect({ path, status: control.status }).toEqual({ path, status: admitted });
    for (const authority of ["http://evil.example", `http://127.0.0.1:${port}`, "http://[::1]"]) {
      const answer = await raw(
        port,
        [`${method} ${authority}${path} HTTP/1.1`, host, ...headers()],
        body,
      );
      expect({ path, authority, status: answer.status }).toEqual({ path, authority, status: 400 });
      expect(answer.raw).not.toContain(serverId);
      expect(answer.raw).not.toContain("jsonrpc");
    }
  }
  // OPTIONS (preflight) for each route, and the asterisk form.
  for (const path of ["/bootstrap", "/rpc"]) {
    const answer = await raw(port, [
      `OPTIONS http://evil.example${path} HTTP/1.1`,
      host,
      ...preflight,
    ]);
    expect({ path, status: answer.status }).toEqual({ path, status: 400 });
    expect(answer.raw).not.toMatch(/access-control-allow-methods/i);
  }
  expect((await raw(port, ["OPTIONS * HTTP/1.1", host, ...preflight])).status).not.toBe(200);
}, 60_000);
