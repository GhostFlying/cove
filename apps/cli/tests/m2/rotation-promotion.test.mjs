import { afterEach, beforeEach, expect, test } from "vitest";
import { WS_CLOSE_CODES } from "@cove/protocol/errors";
import { waitFor } from "../recording-view.mjs";
import {
  bootstrapRequest,
  createAuthFixture,
  portOf,
  post,
  terminalAttempt,
} from "./auth-fixtures.mjs";

// m2 D4 phase two (token rotation) against the compiled CLI and server: the first use of a rotated
// token is admitted only once its promotion committed in the store, so a use of the new token that
// was answered as authenticated can never be undone by a restart, and a store that cannot commit
// the promotion answers the new token UNAVAILABLE (retryable), never UNAUTHENTICATED, and leaves
// both tokens as they were. The restarts are kill -9: no orderly shutdown writes anything late.

let fixture;

beforeEach(async () => {
  fixture = await createAuthFixture();
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

// One store call occupies the worker, one waits in the queue, and any further call is refused.
const STORE_FAULTS = { inFlight: 1, queued: 1 };

// An authenticated HTTP bootstrap with `token`: its status and failure kind, if any.
async function bootstrapWith(server, token) {
  const answer = await post(portOf(server), "/bootstrap", bootstrapRequest(server), {
    authorization: `Bearer ${token}`,
  });
  return { status: answer.status, kind: answer.json?.kind, type: answer.json?.type };
}

const ACCEPTED = { status: 200, kind: undefined, type: "cove-bootstrap-result" };
const REFUSED = { status: 401, kind: "UNAUTHENTICATED", type: "cove-bootstrap-error" };

test("a rotated token's first use commits its promotion before it is answered", async () => {
  const serverHome = fixture.home("server");
  let server = await fixture.startAuthServer(serverHome, [], { storeFaults: STORE_FAULTS });
  const deviceHome = fixture.home("device");
  const paired = await fixture.pairOk(
    deviceHome,
    "box",
    (await fixture.invite(serverHome)).invitation,
  );
  const oldToken = (await fixture.credential(deviceHome, paired.serverId)).token;
  const rotating = await fixture.deviceClient(server, oldToken);
  expect((await rotating.client.connect()).ok).toBe(true);
  const rotation = await rotating.client.call("auth.device.rotate", {
    operationId: "rotation-promotion",
  });
  expect(rotation.ok).toBe(true);
  const newToken = rotation.value.secrets.token;
  rotating.client.dispose();

  // The store refuses every call: the promotion cannot commit, so neither HTTP nor the terminal
  // WebSocket admits the new token, and both say so as retryable rather than as a wrong token.
  await fixture.signalServer(server, "SIGUSR2");
  await waitFor("the saturated store", () => server.stderr().includes('"saturated"'), 10_000);
  expect(await bootstrapWith(server, newToken)).toEqual({
    status: 503,
    kind: "UNAVAILABLE",
    type: "cove-bootstrap-error",
  });
  const attempt = await terminalAttempt(server, newToken);
  expect(attempt.code).toBe(WS_CLOSE_CODES.capacity);
  expect(attempt.messages.map((text) => JSON.parse(text).kind)).toEqual(["UNAVAILABLE"]);
  // Nothing changed: the old token still works (it needs no store write to be admitted).
  expect(await bootstrapWith(server, oldToken)).toEqual(ACCEPTED);

  // A restart while the promotion was refused keeps both tokens, so the device recovers by
  // using the new one again.
  await fixture.killServer(server);
  server = await fixture.startAuthServer(serverHome);
  expect(await bootstrapWith(server, oldToken)).toEqual(ACCEPTED);
  expect(await bootstrapWith(server, newToken)).toEqual(ACCEPTED);
  // That use was answered only after the promotion committed: the old token is refused at once,
  // and still after a kill -9 right behind the answer.
  expect(await bootstrapWith(server, oldToken)).toEqual(REFUSED);
  await fixture.killServer(server);
  server = await fixture.startAuthServer(serverHome);
  expect(await bootstrapWith(server, oldToken)).toEqual(REFUSED);
  expect(await bootstrapWith(server, newToken)).toEqual(ACCEPTED);
});

test("concurrent first uses of a rotated token share one promotion over HTTP and WebSocket", async () => {
  const serverHome = fixture.home("server");
  let server = await fixture.startAuthServer(serverHome);
  const deviceHome = fixture.home("device");
  const paired = await fixture.pairOk(
    deviceHome,
    "box",
    (await fixture.invite(serverHome)).invitation,
  );
  const oldToken = (await fixture.credential(deviceHome, paired.serverId)).token;
  const rotating = await fixture.deviceClient(server, oldToken);
  expect((await rotating.client.connect()).ok).toBe(true);
  const rotation = await rotating.client.call("auth.device.rotate", { operationId: "concurrent" });
  expect(rotation.ok).toBe(true);
  const newToken = rotation.value.secrets.token;
  rotating.client.dispose();

  const [first, second, socket] = await Promise.all([
    bootstrapWith(server, newToken),
    bootstrapWith(server, newToken),
    (async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${portOf(server)}/terminal`);
      const message = new Promise((done) =>
        ws.addEventListener("message", (event) => done(JSON.parse(String(event.data)).type)),
      );
      await new Promise((done, fail) => {
        ws.addEventListener("open", done);
        ws.addEventListener("error", fail);
      });
      ws.send(JSON.stringify({ ...bootstrapRequest(server), secret: newToken }));
      const type = await message;
      ws.close();
      return type;
    })(),
  ]);
  expect([first, second, socket]).toEqual([ACCEPTED, ACCEPTED, "cove-bootstrap-result"]);
  expect(await bootstrapWith(server, oldToken)).toEqual(REFUSED);
  await fixture.killServer(server);
  server = await fixture.startAuthServer(serverHome);
  expect(await bootstrapWith(server, oldToken)).toEqual(REFUSED);
  expect(await bootstrapWith(server, newToken)).toEqual(ACCEPTED);
});
