import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { createAuthFixture, portOf } from "./auth-fixtures.mjs";

// m2 D5 (the client's credential record) under concurrent CLI commands, against the compiled CLI
// and server. Commands that change a paired server's record take its lock and merge into the
// latest record, and a rotation holds the lock from reading the token through its first use, so
// the token saved last is the valid one and no command's change is lost. The interleaving is
// controlled: the first rotation's request is held in a TCP relay until the other commands had
// every chance to run into it.
//
// The lock is an OS lock held for the holder's process lifetime (credentials.ts withServerLock):
// a holder that is killed releases it, and contenders that all find it released at once enter
// one at a time (#159: the earlier stale-lock takeover could let a second contender remove the
// first one's live lock).

const CONTENDER = resolve(import.meta.dirname, "lock-contender.mjs");

let fixture;
let relays;
let contenders;

beforeEach(async () => {
  fixture = await createAuthFixture();
  relays = [];
  contenders = [];
});

afterEach(async () => {
  for (const relay of relays) relay.close();
  for (const contender of contenders) contender.child.kill("SIGKILL");
  await Promise.all(contenders.map((contender) => contender.exited));
  await fixture?.cleanup();
  fixture = undefined;
});

// A TCP relay to the server's business port. The server accepts its port in Host as a loopback
// literal, so bytes pass unchanged. While `hold` is set it keeps back every connection whose
// request names auth.device.rotate: it records it in `held` and forwards it only on `release()`.
// Every token in the server's answers is remembered for the secret scan before it is passed on:
// the concurrent rotations here save tokens that a later one overwrites.
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
    const read = fixture.tokenReader();
    client.on("data", (chunk) => {
      const text = chunk.toString("latin1");
      const bytes = chunk;
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
    upstream.on("data", (chunk) => {
      read(chunk);
      client.write(chunk);
    });
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
  // The lock file stays (it holds nothing); no other lock residue is left beside the record.
  expect((await readdir(join(home, "client", "servers"))).sort()).toEqual([
    `${paired.serverId}.json`,
    `${paired.serverId}.lock.sqlite`,
  ]);
}, 60_000);

// A contender process (lock-contender.mjs) for the record lock of `serverId` under `home`.
function contend(home, serverId, log, name, hold) {
  const child = spawn(process.execPath, [CONTENDER, home, serverId, log, name, String(hold)], {
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  const contender = { child, exited, stdout: () => stdout, stderr: () => stderr };
  contenders.push(contender);
  return contender;
}

test("a lock whose holder was killed is free, and its contenders enter one at a time", async () => {
  const serverHome = fixture.home("server");
  await fixture.startAuthServer(serverHome);
  const home = fixture.home("device");
  const paired = await fixture.pairOk(home, "box", (await fixture.invite(serverHome)).invitation);
  const log = join(fixture.root, "lock.log");
  await writeFile(log, "");

  // H holds the lock and is killed while holding it, after every contender is already waiting:
  // they all find the lock released at the same moment, the race #159 describes.
  const holder = contend(home, paired.serverId, log, "H", "forever");
  await waitFor("the holder to take the lock", () => holder.stdout().includes("held"), 20_000);
  const names = ["A", "B", "C", "D", "E", "F"];
  const waiting = names.map((name) => contend(home, paired.serverId, log, name, 150));
  await waitFor(
    "every contender to wait",
    () => waiting.every((contender) => contender.stdout().includes("waiting")),
    20_000,
  );
  // Each one polls the lock while H holds it; none gets in.
  await new Promise((done) => setTimeout(done, 500));
  expect(waiting.some((contender) => contender.stdout().includes("held"))).toBe(false);
  holder.child.kill("SIGKILL");
  expect((await holder.exited).signal).toBe("SIGKILL");
  const results = await Promise.all(waiting.map((contender) => contender.exited));
  const failed = results.filter((result) => result.code !== 0);
  if (failed.length > 0)
    throw new Error(`contenders failed: ${waiting.map((c) => c.stderr()).join("\n")}`);

  // The log is H's enter, then one enter/exit pair per contender with nothing in between: no two
  // holders ever overlapped, and every contender got the lock exactly once.
  const lines = (await readFile(log, "utf8")).trim().split("\n");
  expect(lines[0]).toBe("enter H");
  const pairs = lines.slice(1);
  expect(pairs).toHaveLength(names.length * 2);
  const entered = [];
  for (let index = 0; index < pairs.length; index += 2) {
    const name = pairs[index].replace(/^enter /, "");
    expect(pairs[index]).toBe(`enter ${name}`);
    expect(pairs[index + 1]).toBe(`exit ${name}`);
    entered.push(name);
  }
  expect(entered.sort()).toEqual(names);

  // A command run afterwards takes the lock at once.
  const changed = await fixture.cove(["remote", "entry", "default", "box", "loopback"], { home });
  expect(changed.code).toBe(0);
}, 60_000);
