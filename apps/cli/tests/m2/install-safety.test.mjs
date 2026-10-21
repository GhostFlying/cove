import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createM1Fixture } from "../m1/fixtures.mjs";
import { INSTALL_STAMP } from "../../dist/install/closure.js";
import { installLayout } from "../../dist/install/layout.js";

// m2 T3 safety of the installation commands, against the compiled CLI and modules, without a
// service manager or a runtime closure (S1 and S2 cover those):
// - the install lock is an OS lock: of contenders for a lock whose holder was killed, exactly
//   one wins;
// - a server that holds its data directory but does not answer is never taken for a stopped one:
//   the commands that would stop it ask for confirmation without an impact list, and prune keeps
//   every build, since any of them may be the one it runs.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

// A data directory by its real path, as the CLI names it (install/layout.ts).
async function dataDirectory(name) {
  const path = fixture.home(name);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

const BUILD_A = "0.0.0+aaaaaaaaaaaaaaaa";
const BUILD_B = "0.0.0+bbbbbbbbbbbbbbbb";

function stampFor(build, contentsSha256) {
  return {
    type: "cove-install",
    version: 1,
    build,
    schemaVersion: 7,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    contentsSha256,
  };
}

// An installed build directory as `cove server prune` and `status` see it: a valid stamp. It
// holds nothing to run; this test never starts an installed build.
async function placeBuild(home, build) {
  const dir = join(home, "install", build);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, INSTALL_STAMP), JSON.stringify(stampFor(build, "0".repeat(64))));
}

async function closedPort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

const contender = join(import.meta.dirname, "install-lock-contender.mjs");

function contend(home, holdMs) {
  const child = spawn(process.execPath, [contender, home, String(holdMs)], {
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal, out: out.trim(), err })),
  );
  const said = (word) =>
    new Promise((done, fail) => {
      const check = () => out.includes(word) && done();
      child.stdout.on("data", check);
      child.once("exit", () =>
        out.includes(word) ? done() : fail(new Error(`no ${word}: ${err}`)),
      );
      check();
    });
  return { child, exited, said };
}

test("of the contenders for an install lock whose holder was killed, exactly one acquires it", async () => {
  const home = fixture.home("locked");
  await mkdir(home, { recursive: true });
  const lock = installLayout(home).lock;

  const holder = contend(home, 600_000);
  await holder.said("acquired");
  expect((await contend(home, 0).exited).out).toBe("refused");

  // The holder dies without releasing anything; its lock file stays behind.
  holder.child.kill("SIGKILL");
  expect((await holder.exited).signal).toBe("SIGKILL");
  expect(existsSync(lock)).toBe(true);

  for (let round = 0; round < 5; round++) {
    const contenders = [0, 1, 2].map(() => contend(home, 1_500));
    const outcomes = await Promise.all(contenders.map(({ exited }) => exited));
    expect(outcomes.map(({ code }) => code)).toEqual([0, 0, 0]);
    expect(outcomes.map(({ out }) => out).sort()).toEqual(["acquired", "refused", "refused"]);
  }
  // Released by its last holder's exit: free again.
  const last = contend(home, 0);
  expect((await last.exited).out).toBe("acquired");
  expect(existsSync(lock)).toBe(true);
}, 120_000);

test("a server that holds the data directory but does not answer is never taken for stopped", async () => {
  const home = await dataDirectory("unanswered");
  const server = await fixture.startServer(home);
  const rendezvous = join(home, "server", "run", "rendezvous.json");
  const original = await readFile(rendezvous, "utf8");
  const record = JSON.parse(original);
  // `current` names B while the server runs another build (here the checkout's): the case where
  // a prune that took the server for stopped would remove a build it may run.
  await placeBuild(home, BUILD_A);
  await placeBuild(home, BUILD_B);
  await symlink(BUILD_B, join(home, "install", "current"));
  const builds = async () =>
    (await readdir(join(home, "install"))).filter((name) => name.includes("+")).sort();

  // The handshake fails while the server keeps its data directory: a refused credential, and an
  // endpoint where nothing answers.
  const variants = [
    { ...record, secret: "x".repeat(43) },
    { ...record, endpoint: `http://127.0.0.1:${await closedPort()}` },
  ];
  for (const variant of variants) {
    await writeFile(rendezvous, JSON.stringify(variant), { mode: 0o600 });

    const status = await fixture.coveJson(["server", "status"], { home });
    expect(status).toMatchObject({ serverState: "unknown", server: null });
    expect(typeof status.serverError).toBe("string");

    for (const command of [
      ["server", "restart"],
      ["server", "upgrade"],
      ["server", "uninstall"],
    ]) {
      const refused = await fixture.cove(command, { home });
      expect({ command, code: refused.code }).toEqual({ command, code: 2 });
      expect(JSON.parse(refused.stdout)).toMatchObject({
        action: command.join(" "),
        confirmed: false,
        state: "unknown",
        impact: null,
      });
      expect(refused.stderr).toContain("cannot tell whether the server");
      expect(refused.stderr).toContain("--yes");
    }

    const prune = await fixture.cove(["server", "prune"], { home });
    expect(prune.code).toBe(1);
    expect(prune.stderr).toContain("nothing was removed");
    expect(await builds()).toEqual([BUILD_A, BUILD_B]);

    const start = await fixture.cove(["server", "service", "start"], { home });
    expect(start.code).toBe(1);
    expect(start.stderr).toContain("not started");
  }

  // Nothing touched the server: the same instance answers once its record is back.
  await writeFile(rendezvous, original, { mode: 0o600 });
  expect(await fixture.serverRuns(server)).toBe(true);
  const answering = await fixture.coveJson(["server", "status"], { home });
  expect(answering).toMatchObject({
    serverState: "running",
    server: { relayInstanceId: record.relayInstanceId },
  });
  expect(await builds()).toEqual([BUILD_A, BUILD_B]);
  // Answering, it says which build it runs (neither installed one): prune keeps that and the
  // active one, and removes the other.
  expect(await fixture.coveJson(["server", "prune"], { home })).toEqual({
    kept: [BUILD_B, answering.server.buildVersion],
    removed: [BUILD_A],
  });

  // Stopped, whatever its rendezvous file still says: no process holds the data directory.
  await fixture.stopServer(server);
  await mkdir(dirname(rendezvous), { recursive: true, mode: 0o700 });
  await writeFile(rendezvous, original, { mode: 0o600 });
  expect(await fixture.coveJson(["server", "status"], { home })).toMatchObject({
    serverState: "stopped",
    server: null,
  });
}, 120_000);
