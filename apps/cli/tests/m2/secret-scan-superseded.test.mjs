import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { cli } from "../m1/fixtures.mjs";
import { createAuthFixture, portOf } from "./auth-fixtures.mjs";

// The negative controls of the secret scan for superseded tokens (#159, auth-fixtures.mjs). Neither
// pairing nor a CLI rotation prints the token, and after the rotation the credential file holds
// only the new one, so the scan knows the token pairing issued only if it remembered it when the
// pairing command saved it. Planting that superseded token in a scanned file must fail the scan.
// The test reads the credential file with readFile, not through the fixture, so that it adds
// nothing to what the scan remembers. The second control rotates twice at once: the first
// rotation runs outside the fixture, so no credential file is read when it ends, and the token it
// saved is overwritten by the second one; only the token tap in front of the server
// (fixture.tokenTap) can have remembered it, whatever the timing. (Pointed at the server
// directly instead of the tap, the planted token goes unnoticed.)

let fixture;
let recorders = [];

beforeEach(async () => {
  fixture = await createAuthFixture();
});

afterEach(async () => {
  for (const recorded of recorders.splice(0)) recorded.close();
  await fixture?.cleanup();
  fixture = undefined;
});

test("a token superseded by a CLI rotation before cleanup is still found by the scan", async () => {
  const serverHome = fixture.home("server");
  await fixture.startAuthServer(serverHome);
  const client = fixture.home("client");
  const paired = await fixture.pairOk(client, "box", (await fixture.invite(serverHome)).invitation);
  const recordPath = join(client, "client", "servers", `${paired.serverId}.json`);
  const issued = JSON.parse(await readFile(recordPath, "utf8")).token;

  const rotated = await fixture.cove(["--server", "box", "auth", "device", "rotate"], {
    home: client,
  });
  expect(rotated.code).toBe(0);
  expect(rotated.stdout).not.toContain(issued.split(".")[1]);
  const current = JSON.parse(await readFile(recordPath, "utf8")).token;
  expect(current).not.toBe(issued);
  // The first use promotes the new token; the superseded one is no longer in any credential file.
  expect((await fixture.cove(["--server", "box", "status"], { home: client })).code).toBe(0);
  fixture.expectToken(client, paired.serverId, current);

  // Each part of the superseded token, planted in a scanned file, fails the scan.
  const planted = join(fixture.root, "planted.log");
  for (const value of [issued, issued.split(".")[1]]) {
    await writeFile(planted, `log line ${value}\n`);
    await expect(fixture.scanSecrets()).rejects.toThrow(`a secret is in files: ${planted}`);
  }
  await rm(planted);
  // Without the plant the scan passes, so the failure above was the planted token's.
  await fixture.scanSecrets();
}, 60_000);

// A recorder in front of `targetPort` that keeps the server's answers to itself: what the test
// learns through it adds nothing to what the scan remembers.
async function recorder(targetPort) {
  const answers = [];
  const requests = [];
  const connections = new Set();
  const server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    connections.add(client).add(upstream);
    client.on("data", (chunk) => upstream.write(chunk));
    client.on("data", (chunk) => requests.push(chunk));
    upstream.on("data", (chunk) => {
      answers.push(chunk);
      client.write(chunk);
    });
    for (const [a, b] of [
      [client, upstream],
      [upstream, client],
    ]) {
      a.on("close", () => b.destroy());
      a.on("error", () => b.destroy());
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  recorders.push({
    close() {
      for (const connection of connections) connection.destroy();
      server.close();
    },
  });
  return {
    port: server.address().port,
    requested: (text) => Buffer.concat(requests).toString("latin1").includes(text),
    tokens: () => [
      ...new Set(
        [
          ...Buffer.concat(answers)
            .toString("latin1")
            .matchAll(/cove_d1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}/g),
        ].map(([value]) => value),
      ),
    ],
  };
}

test("a token two concurrent rotations issue and overwrite while both run is still found by the scan", async () => {
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome);
  const client = fixture.home("client");
  const paired = await fixture.pairOk(client, "box", (await fixture.invite(serverHome)).invitation);
  const recordPath = join(client, "client", "servers", `${paired.serverId}.json`);
  const original = JSON.parse(await readFile(recordPath, "utf8"));
  // The client reaches the server through the test's recorder, then the fixture's token tap.
  const tap = await fixture.tokenTap(portOf(server));
  const recorded = await recorder(tap.port);
  await writeFile(
    recordPath,
    JSON.stringify({ ...original, entries: { loopback: { port: recorded.port } } }),
    { mode: 0o600 },
  );

  // A rotates outside the fixture (nothing reads its home when it ends). Once its rotation
  // reached the server it holds the record lock, and B rotates as well: B waits for the lock and
  // then overwrites the token A saved. Only B's end is observed, when the file holds B's token.
  const args = ["--home", client, "--server", "box", "auth", "device", "rotate"];
  const first = spawn(process.execPath, [cli, ...args], {
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let firstStdout = "";
  first.stdout.on("data", (chunk) => (firstStdout += chunk));
  const firstDone = new Promise((done) => first.once("exit", (code) => done(code)));
  await waitFor(
    "A's rotation to reach the server",
    () => recorded.requested("auth.device.rotate"),
    20_000,
  );
  const second = fixture.spawnCove(["--server", "box", "auth", "device", "rotate"], {
    home: client,
  });
  const results = [{ code: await firstDone, stdout: firstStdout }, await second.done];
  expect(results.map((result) => result.code)).toEqual([0, 0]);
  expect((await fixture.cove(["--server", "box", "status"], { home: client })).code).toBe(0);
  const current = JSON.parse(await readFile(recordPath, "utf8")).token;
  fixture.expectToken(client, paired.serverId, current);
  const superseded = recorded.tokens().filter((token) => token !== current);
  expect(superseded).toHaveLength(1);
  for (const result of results) expect(result.stdout).not.toContain(superseded[0].split(".")[1]);

  // Each part of that token, planted in a scanned file, fails the scan.
  const planted = join(fixture.root, "planted.log");
  for (const value of [superseded[0], superseded[0].split(".")[1]]) {
    await writeFile(planted, `log line ${value}\n`);
    await expect(fixture.scanSecrets()).rejects.toThrow(`a secret is in files: ${planted}`);
  }
  await rm(planted);
  await fixture.scanSecrets();
}, 60_000);
