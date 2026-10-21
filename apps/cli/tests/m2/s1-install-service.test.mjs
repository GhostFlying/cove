import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { cli, createM1Fixture } from "../m1/fixtures.mjs";
import { readRendezvous } from "../../dist/session.js";
import {
  CLOSURE_CLI,
  contentsDigest,
  escapingLink,
  readStamp,
} from "../../dist/install/closure.js";
import {
  buildClosure,
  expectedManager,
  liveRuns,
  olderSchemaVariant,
  removeService,
  repositoryRoot,
  serviceTests,
  sessionShell,
} from "./s1-install-fixture.mjs";

// m2 S1 (install and service), against the compiled CLI and a sealed runtime closure built from
// this checkout (scripts/runtime-closure.mjs). The closure alone runs the server, the store
// (better-sqlite3), the terminal worker and its PTYs, with no Node on PATH and without the
// checkout; installed, it runs under the user's service manager, outlives the shell and process
// group that installed it, refuses a build that cannot open the database, and uninstalls without
// touching the data directory.
//
// Not covered here (D2's platform guarantees need a real login session): logout and boot, which
// are checked on a real Mac and Linux host; see the PR.

// Installing copies and verifies a closure of a few hundred MB; a service stop waits for the
// server's orderly stop.
const SLOW = 180_000;

let fixture;
let closure;

beforeAll(async () => {
  fixture = await createM1Fixture();
  closure = await buildClosure(fixture.root);
}, 900_000);

afterAll(async () => {
  await fixture?.cleanup();
}, 120_000);

async function filesOf(root) {
  const found = [];
  const walk = async (relative) => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  await walk("");
  return found;
}

// ELF or Mach-O (thin or universal): compiled code rather than text.
function nativeBinary(bytes) {
  if (bytes.length < 4) return false;
  const magic = bytes.readUInt32BE(0);
  return (
    magic === 0x7f454c46 ||
    [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)
  );
}

// A directory with only `git` in it: what the server needs from PATH (git), and no Node.
async function pathWithoutNode() {
  const directory = join(fixture.root, "path-git-only");
  await mkdir(directory, { recursive: true });
  const git = ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"].find(existsSync);
  if (!git) throw new Error("git was not found");
  if (!existsSync(join(directory, "git"))) await symlink(git, join(directory, "git"));
  return directory;
}

test("the sealed closure holds every runtime part and runs alone, with no Node on PATH and no checkout", async () => {
  const dir = closure.dir;
  // The parts D1 lists: server, CLI, worker, production dependencies with native addons, the
  // pinned Node and cove-tsnet.
  for (const part of [
    "bin/node",
    "bin/cove-tsnet",
    CLOSURE_CLI,
    "app/node_modules/@cove/server/dist/entry/main.js",
    "app/node_modules/@cove/server/node_modules/.bin/cove-terminal-worker",
  ])
    expect({ part, exists: existsSync(join(dir, part)) }).toEqual({ part, exists: true });
  const files = await filesOf(dir);
  expect(
    files.some((file) =>
      new RegExp(
        `better-sqlite3/(prebuilds/${process.platform}-${process.arch}|build/Release/better_sqlite3)\\.node$`,
      ).test(file),
    ),
  ).toBe(true);
  expect(files.some((file) => file.endsWith("pty.node"))).toBe(true);

  // Its identity: a valid stamp naming the contents, no link out of it, and no code, manifest or
  // configuration that names the checkout it was built from. Compiled native binaries are not
  // scanned: one built in the checkout (node-pty's pty.node and spawn-helper) records its build
  // directory as a string, which is not a dependency; the run below proves nothing is loaded
  // from the checkout.
  const stamp = await readStamp(dir);
  expect(stamp).toMatchObject({ type: "cove-install", build: closure.build, schemaVersion: 7 });
  expect(await contentsDigest(dir)).toBe(stamp.contentsSha256);
  expect(await escapingLink(dir)).toBeNull();
  const checkout = Buffer.from(repositoryRoot);
  const naming = [];
  for (const file of files) {
    const bytes = await readFile(join(dir, file));
    if (nativeBinary(bytes)) continue;
    if (bytes.includes(checkout)) naming.push(file);
  }
  expect(naming).toEqual([]);
  // Nothing the deploy copied from a workspace package's local caches (terminal-web's browsers).
  expect(files.filter((file) => file.includes("/.cache/"))).toEqual([]);

  // cove-tsnet carries the closure's build ID.
  const tsnet = await new Promise((done) => {
    const child = spawn(join(dir, "bin/cove-tsnet"), ["version"], { env: fixture.env });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.once("exit", () => done(out));
  });
  expect(tsnet).toContain(`build=${closure.build}`);

  // The server of the closure with a PATH that holds git only. On macOS the checkout is also made
  // unreadable to it (sandbox-exec), so nothing can be loaded from the source build.
  const home = fixture.home("closure-alone");
  await mkdir(join(home, "server"), { recursive: true, mode: 0o700 });
  const rendezvous = join(home, "server", "run", "rendezvous.json");
  const serverArgs = [
    join(dir, "app/node_modules/@cove/server/dist/entry/main.js"),
    ...["--mode", "m0-local", "--host", "127.0.0.1", "--port", "0"],
    ...["--rendezvous", rendezvous, "--home", home],
  ];
  const env = { ...fixture.env, PATH: await pathWithoutNode() };
  let command = join(dir, "bin/node");
  let args = serverArgs;
  if (process.platform === "darwin") {
    const profile = join(fixture.root, "deny-checkout.sb");
    await writeFile(
      profile,
      `(version 1)\n(allow default)\n(deny file-read* (subpath ${JSON.stringify(repositoryRoot)}))\n`,
    );
    args = ["-f", profile, command, ...serverArgs];
    command = "/usr/bin/sandbox-exec";
  }
  const server = spawn(command, args, {
    env,
    cwd: fixture.root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((done) => server.once("exit", (code) => done(code)));
  try {
    await waitFor(
      "the closure's server to publish its rendezvous",
      async () =>
        server.exitCode !== null ||
        (await readRendezvous(rendezvous).then(
          () => true,
          () => false,
        )),
      30_000,
    );
    expect({ exitCode: server.exitCode, stderr }).toMatchObject({ exitCode: null });
    const status = await fixture.coveJson(["status"], { home });
    expect(status.buildVersion).toBe(closure.build);
    expect(status.workerCount).toBe(1);
    // The store answered (status above) and a PTY run in the worker writes its marker.
    const { tabs } = await liveRuns(fixture, home, "alone", 1);
    const tab = await fixture.coveJson(["tab", "get", tabs[0].tabId], { home });
    expect(tab.latestRun).toMatchObject({ lifecycle: "running", verification: "live" });
  } finally {
    server.kill("SIGTERM");
    await exited;
  }
  expect(await exited).toBe(0);
}, 120_000);

async function sha256(path) {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

test("an installed service outlives the installing shell, refuses an older schema and uninstalls without touching the data", async (context) => {
  // Skipped at run time, not with test.skipIf, so that discovery (`vitest list`) always
  // counts it; the CI gate refuses a skipped test, and CI sets the variable.
  if (!serviceTests) context.skip("COVE_TEST_SERVICE_MANAGER=1 is not set");
  const home = fixture.home("installed");
  const failures = [];
  try {
    // The install runs in a shell that is its own process group, as a terminal or SSH session.
    const output = join(fixture.root, "install.json");
    const shell = sessionShell(
      fixture,
      `'${process.execPath}' '${cli}' --home '${home}' server install --closure '${closure.dir}' > '${output}' 2> '${output}.err'; echo done >> '${output}.done'; exec sleep 600`,
    );
    await waitFor("the install to finish", async () => existsSync(`${output}.done`), 180_000);
    const installed = JSON.parse(await readFile(output, "utf8"));
    expect(installed).toMatchObject({
      build: closure.build,
      activated: true,
      service: { manager: expectedManager, registered: true, running: true },
    });
    expect(installed.entry.businessPort).toBeGreaterThanOrEqual(20_000);
    expect(installed.entry.pairingPort).not.toBe(installed.entry.businessPort);
    // The versioned directory, `current` and the launcher.
    expect(await readlink(join(home, "install", "current"))).toBe(closure.build);
    expect((await lstat(join(home, "install", closure.build))).isDirectory()).toBe(true);
    expect(await contentsDigest(join(home, "install", closure.build))).toBe(
      (await readStamp(closure.dir)).contentsSha256,
    );

    // The unit references the installation only through `current`.
    const unit = await readFile(installed.service.unitPath, "utf8");
    expect(unit).toContain(join(home, "install", "current", "bin", "node"));
    expect(unit).not.toContain(join(home, "install", closure.build));
    expect(unit).not.toContain(repositoryRoot);
    expect(unit).not.toContain(closure.dir);

    const status = await fixture.coveJson(["server", "status"], { home });
    expect(status).toMatchObject({
      installedBuild: closure.build,
      builds: [closure.build],
      unit: { manager: expectedManager, running: true },
      server: {
        buildVersion: closure.build,
        service: {
          manager: expectedManager,
          installedBuild: closure.build,
          pendingBuild: null,
          lastStart: "manual",
        },
      },
    });
    const before = status.server;
    expect(
      Number(
        new URL((await readRendezvous(join(home, "server/run/rendezvous.json"))).endpoint).port,
      ),
    ).toBe(installed.entry.businessPort);

    // A live run, then the installing shell and its whole process group end.
    const { tabs } = await liveRuns(fixture, home, "service", 1);
    shell.kill();
    await shell.exited;
    await new Promise((done) => setTimeout(done, 2_000));
    const after = await fixture.coveJson(["server", "status"], { home });
    expect(after.server.relayInstanceId).toBe(before.relayInstanceId);
    expect(after.unit.pid).toBe(status.unit.pid);
    const tab = await fixture.coveJson(["tab", "get", tabs[0].tabId], { home });
    expect(tab.latestRun).toMatchObject({ lifecycle: "running", verification: "live" });

    // `<home>/bin/cove` runs the installed CLI without Node on PATH.
    const launched = await new Promise((done) => {
      const child = spawn(join(home, "bin", "cove"), ["server", "status"], {
        env: { ...fixture.env, PATH: "/usr/bin:/bin", COVE_HOME: home },
      });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.once("exit", (code) => done({ code, out }));
    });
    expect(launched.code).toBe(0);
    expect(JSON.parse(launched.out).server.relayInstanceId).toBe(before.relayInstanceId);

    // A build that stops at the previous schema is installed but never activated, and the
    // database is unchanged. The service is stopped first so that nothing else writes it.
    await fixture.coveJson(["server", "service", "stop", "--yes"], { home, timeoutMs: SLOW });
    const database = join(home, "server", "cove.db");
    const hashes = async () => [await sha256(database), await sha256(`${database}-wal`)];
    const unchanged = await hashes();
    const older = await olderSchemaVariant(fixture.root, closure.dir);
    expect(older.schemaVersion).toBe(6);
    const refused = await fixture.cove(["server", "install", "--closure", older.dir], {
      home,
      timeoutMs: SLOW,
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("not activated");
    expect(refused.stderr).toContain("schema 7");
    expect(await readlink(join(home, "install", "current"))).toBe(closure.build);
    const activate = await fixture.cove(["server", "install", "--activate", older.build], {
      home,
      timeoutMs: SLOW,
    });
    expect(activate.code).toBe(1);
    expect(activate.stderr).toContain("nothing was changed");
    expect(activate.stderr).toContain("server/backups/");
    expect(await readlink(join(home, "install", "current"))).toBe(closure.build);
    expect(await hashes()).toEqual(unchanged);

    // Uninstall removes the unit, the builds and the launcher; the data directory stays.
    const unitPath = installed.service.unitPath;
    const serverId = before.serverId;
    const removed = await fixture.coveJson(["server", "uninstall", "--yes"], {
      home,
      timeoutMs: SLOW,
    });
    expect(removed).toMatchObject({ uninstalled: true });
    expect(existsSync(unitPath)).toBe(false);
    expect(await fixture.coveJson(["server", "service", "status"], { home })).toMatchObject({
      registered: false,
      running: false,
    });
    // Only the install lock's file stays: a lock file is never removed (os-lock.ts).
    expect(await readdir(join(home, "install"))).toEqual([".lock.sqlite"]);
    expect(existsSync(join(home, "bin", "cove"))).toBe(false);
    expect(existsSync(database)).toBe(true);
    expect((await fixture.coveJson(["server", "init"], { home })).serverId).toBe(serverId);
  } finally {
    const leftover = await removeService(fixture, home);
    if (leftover) failures.push(leftover);
  }
  expect(failures).toEqual([]);
}, 600_000);
