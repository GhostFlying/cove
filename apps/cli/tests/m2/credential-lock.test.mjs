import { readFile, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { createAuthFixture, portOf } from "./auth-fixtures.mjs";

// m2 D5 (the client's credential record) under concurrent CLI commands, against the compiled CLI
// and server. Commands that change a paired server's record take its lock and merge into the
// latest record, and a rotation holds the lock from reading the token through its first use, so
// the token saved last is the valid one and no command's change is lost. The interleaving is
// controlled: the first rotation's request is held in a TCP relay until the other commands had
// every chance to run into it.

let fixture;
let relays;

beforeEach(async () => {
  fixture = await createAuthFixture();
  relays = [];
});

afterEach(async () => {
  for (const relay of relays) relay.close();
  await fixture?.cleanup();
  fixture = undefined;
});

// A TCP relay to the server's business port. It rewrites the Host header the server checks and,
// while `hold` is set, keeps back every connection whose request names auth.device.rotate: it
// records it in `held` and forwards it only on `release()`.
async function businessRelay(targetPort) {
  const held = [];
  const sockets = new Set();
  const waiting = [];
  let hold = true;
  const server = createServer((client) => {
    sockets.add(client);
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    sockets.add(upstream);
    let parked = null;
    client.on("data", (chunk) => {
      const text = chunk
        .toString("latin1")
        .replace(`Host: 127.0.0.1:${relay.port}`, `Host: 127.0.0.1:${targetPort}`)
        .replace(`host: 127.0.0.1:${relay.port}`, `host: 127.0.0.1:${targetPort}`);
      const bytes = Buffer.from(text, "latin1");
      if (parked) parked.push(bytes);
      else if (hold && text.includes('"auth.device.rotate"')) {
        parked = [bytes];
        held.push(text);
        waiting.push(() => {
          for (const part of parked) upstream.write(part);
          parked = null;
        });
      } else upstream.write(bytes);
    });
    upstream.on("data", (chunk) => client.write(chunk));
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const relay = {
    port: server.address().port,
    held,
    release() {
      hold = false;
      for (const forward of waiting.splice(0)) forward();
    },
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
  relays.push(relay);
  return relay;
}

test("concurrent record changes are serialized and the token saved last is the valid one", async () => {
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome);
  const home = fixture.home("device");
  const paired = await fixture.pairOk(home, "box", (await fixture.invite(serverHome)).invitation);
  const recordPath = join(home, "client", "servers", `${paired.serverId}.json`);
  const original = JSON.parse(await readFile(recordPath, "utf8"));
  // The client reaches the server through the relay.
  const relay = await businessRelay(portOf(server));
  await writeFile(
    recordPath,
    JSON.stringify({ ...original, entries: { loopback: { port: relay.port } } }),
    { mode: 0o600 },
  );
  expect((await fixture.cove(["--server", "box", "status"], { home })).code).toBe(0);

  // A rotates; its rotate request is held in the relay, with A holding the record lock.
  const first = fixture.spawnCove(["--server", "box", "auth", "device", "rotate"], { home });
  await waitFor("the first rotation to reach the relay", () => relay.held.length === 1, 20_000);
  // B rotates and C changes the default entry meanwhile. Both wait for A's lock: neither B's
  // rotation nor anything else reaches the server while A's request is held.
  const second = fixture.spawnCove(["--server", "box", "auth", "device", "rotate"], { home });
  const entry = fixture.spawnCove(["remote", "entry", "default", "box", "loopback"], { home });
  await new Promise((done) => setTimeout(done, 1_500));
  expect(relay.held).toHaveLength(1);
  expect(JSON.parse(await readFile(recordPath, "utf8")).token).toBe(original.token);

  relay.release();
  const results = await Promise.all([first.done, second.done, entry.done]);
  expect(results.map((result) => result.code)).toEqual([0, 0, 0]);
  // Serialized: B rotated with the token A saved, so the saved token is B's, and it works; both
  // earlier tokens are refused. The relay port C read under the lock is kept as well.
  const saved = JSON.parse(await readFile(recordPath, "utf8"));
  expect(saved).toEqual({
    ...original,
    entries: { loopback: { port: relay.port } },
    token: saved.token,
  });
  expect(saved.token).not.toBe(original.token);
  expect((await fixture.cove(["--server", "box", "status"], { home })).code).toBe(0);
  const old = await fixture.deviceClient(server, original.token);
  expect((await old.client.connect()).ok).toBe(false);
  old.client.dispose();
  await expect(readFile(`${recordPath.replace(/\.json$/, "")}.lock`)).rejects.toThrow("ENOENT");
}, 60_000);

test("a lock left by a command that no longer runs is taken over", async () => {
  const serverHome = fixture.home("server");
  await fixture.startAuthServer(serverHome);
  const home = fixture.home("device");
  const paired = await fixture.pairOk(home, "box", (await fixture.invite(serverHome)).invitation);
  const lock = join(home, "client", "servers", `${paired.serverId}.lock`);
  // A PID that is not running: a short-lived process that has exited.
  const gone = fixture.spawnCove(["remote", "list"], { home });
  await gone.done;
  await writeFile(lock, `${gone.child.pid}\n`, { mode: 0o600 });
  const changed = await fixture.cove(["remote", "entry", "default", "box", "loopback"], { home });
  expect(changed.code).toBe(0);
  await expect(readFile(lock)).rejects.toThrow("ENOENT");
});
