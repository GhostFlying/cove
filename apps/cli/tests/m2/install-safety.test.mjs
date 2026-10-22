import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  cp,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { cli, createM1Fixture } from "../m1/fixtures.mjs";
import { waitFor } from "../recording-view.mjs";
import { removeService } from "./s1-install-fixture.mjs";
import { contentsDigest, INSTALL_STAMP } from "../../dist/install/closure.js";
import { installClosure } from "../../dist/install/installer.js";
import {
  acquireInstallLock,
  ensureInstallDirectory,
  installLayout,
} from "../../dist/install/layout.js";
import { describeImpact, startupFailureSince } from "../../dist/install/commands.js";
import {
  fileTail,
  serviceBackend,
  serviceOutputTail,
  SERVICE_LOG_BYTES,
  SERVICE_LOG_LINES,
  systemdGaveUp,
  systemdUnit,
} from "../../dist/install/service.js";

// m2 T3 safety of the installation commands, against the compiled CLI and modules, without a
// service manager or a runtime closure (S1 and S2 cover those):
// - the install lock is an OS lock: of contenders for a lock whose holder was killed, exactly
//   one wins;
// - a server that holds its data directory but does not answer is never taken for a stopped one:
//   the commands that would stop it ask for confirmation without an impact list, and prune keeps
//   every build, since any of them may be the one it runs;
// - an upgrade reads the server's state again after installing, right before its restart: a
//   server that started meanwhile is asked about;
// - the systemd unit escapes `$` and `%` in paths;
// - a failed systemd unit is reported as stopped after crashes only when systemd hit its start
//   limit, not when a requested stop failed after earlier crash restarts;
// - an installed build is reused only when its contents are the closure's.

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
  await mkdir(join(home, "install"), { recursive: true, mode: 0o700 });
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

// A closure in miniature whose `bin/node`, which activation runs for the schema check, stops at a
// gate: it creates `reached`, waits until `gate` exists, then reports a supported schema.
async function gatedClosure(dir, build, reached, gate) {
  await mkdir(join(dir, "bin"), { recursive: true });
  await writeFile(
    join(dir, "bin", "node"),
    `#!/bin/sh\n: > '${reached}'\nwhile [ ! -e '${gate}' ]; do sleep 0.1; done\n` +
      `echo '{"database":0,"supported":1000}'\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(dir, INSTALL_STAMP),
    JSON.stringify(stampFor(build, await contentsDigest(dir))),
  );
}

test("an upgrade asks again when a server started while it installed", async () => {
  const home = await dataDirectory("upgrade-race");
  const closure = join(fixture.root, "closure-gated");
  const reached = join(fixture.root, "schema-check-reached");
  const gate = join(fixture.root, "schema-check-gate");
  await gatedClosure(closure, BUILD_A, reached, gate);
  let server;
  let leftover;
  try {
    // No server runs when the upgrade begins, so it needs no confirmation then.
    const upgrade = fixture.cove(["server", "upgrade", "--closure", closure], {
      home,
      timeoutMs: 60_000,
    });
    await waitFor("the upgrade to reach its schema check", () => existsSync(reached));
    server = await fixture.startServer(home);
    const { relayInstanceId } = (await fixture.coveJson(["server", "status"], { home })).server;
    await writeFile(gate, "");

    // A server runs by the time of the restart: asked about, refused without --yes or a
    // terminal, and left running; the new build stays installed and active.
    const refused = await upgrade;
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      action: "server upgrade",
      build: BUILD_A,
      confirmed: false,
      state: "running",
      impact: { liveRuns: [] },
    });
    expect(refused.stderr).toContain(
      `build ${BUILD_A} was installed and activated, but the server was not restarted`,
    );
    // #175: stderr lists what a terminal would have been shown, every consequence included.
    const { impact } = JSON.parse(refused.stdout);
    expect(refused.stderr).toContain(describeImpact(impact));
    expect(impact.consequences.length).toBeGreaterThan(0);
    expect(await fixture.serverRuns(server)).toBe(true);
    expect((await fixture.coveJson(["server", "status"], { home })).server).toMatchObject({
      relayInstanceId,
    });
    expect(await readlink(join(home, "install", "current"))).toBe(BUILD_A);
  } finally {
    if (server) await fixture.stopServer(server);
    // Only an upgrade that went ahead regardless would have registered a service.
    leftover = await removeService(fixture, home);
  }
  expect(leftover).toBeNull();
}, 120_000);

test("the systemd unit keeps `$` and `%` in paths literal", () => {
  const home = "/home/user/data $HOME %h";
  const unit = systemdUnit(installLayout(home));
  const exec = unit.split("\n").find((line) => line.startsWith("ExecStart="));
  // `%` starts a specifier everywhere; `$` starts a variable in ExecStart's arguments only, not in
  // the executable path (systemd.service(5), "Command lines").
  const [executable, ...args] = exec.slice("ExecStart=".length).match(/"(?:[^"\\]|\\.)*"/g);
  expect(executable).toBe('"/home/user/data $HOME %%h/install/current/bin/node"');
  expect(args).toContain('"/home/user/data $$HOME %%h"');
  expect(args.join(" ")).not.toMatch(/[^$]\$HOME/);
  // Environment= expands specifiers but not variables.
  const environment = unit.split("\n").find((line) => line.startsWith("Environment="));
  expect(environment).toContain('"COVE_HOME=/home/user/data $HOME %%h"');
  expect(unit).toContain("Description=Cove server (/home/user/data $HOME %%h)");
});

test("a failed systemd unit is stopped after crashes only when systemd hit its start limit", () => {
  const unit = "cove-server-0123456789abcdef.service";
  const started = [`Starting ${unit} - Cove server (/home/user/data)...`, `Started ${unit}.`];
  const crashed = (count) => [
    `${unit}: Main process exited, code=killed, status=9/KILL`,
    `${unit}: Failed with result 'signal'.`,
    `${unit}: Scheduled restart job, restart counter is at ${count}.`,
  ];
  const limited = [
    ...crashed(5),
    `${unit}: Start request repeated too quickly.`,
    `${unit}: Failed with result 'signal'.`,
    `Failed to start ${unit} - Cove server (/home/user/data).`,
  ];
  // A stop someone asked for that failed (here the server exited 1 while stopping).
  const stopFailed = [
    `Stopping ${unit} - Cove server (/home/user/data)...`,
    `${unit}: Main process exited, code=exited, status=1/FAILURE`,
    `${unit}: Failed with result 'exit-code'.`,
    `Stopped ${unit} - Cove server (/home/user/data).`,
  ];
  const journal =
    (...parts) =>
    () =>
      parts.flat().join("\n");
  const unread = () => {
    throw new Error("the journal is not needed");
  };
  expect({
    limit: systemdGaveUp("signal", journal(started, crashed(1), started, limited)),
    limitResult: systemdGaveUp("start-limit-hit", unread),
    stopAfterCrashes: systemdGaveUp(
      "exit-code",
      journal(started, crashed(1), started, crashed(2), started, stopFailed),
    ),
    stopAfterPersonsStart: systemdGaveUp("exit-code", journal(limited, started, stopFailed)),
    noJournal: systemdGaveUp("signal", () => null),
  }).toEqual({
    limit: true,
    limitResult: true,
    stopAfterCrashes: false,
    stopAfterPersonsStart: false,
    noJournal: false,
  });
});

// A sealed closure in miniature: one file and a stamp over it. Installing copies and verifies it;
// nothing in it runs.
async function miniClosure(dir, build, text) {
  await mkdir(join(dir, "bin"), { recursive: true });
  await writeFile(join(dir, "bin", "payload"), text);
  await writeFile(
    join(dir, INSTALL_STAMP),
    JSON.stringify(stampFor(build, await contentsDigest(dir))),
  );
}

test("an installed build is reused only when its contents are the closure's", async () => {
  const home = await dataDirectory("reuse");
  const layout = installLayout(home);
  const first = join(fixture.root, "closure-first");
  await miniClosure(first, BUILD_A, "first\n");
  expect(await installClosure(layout, first)).toMatchObject({ build: BUILD_A, created: true });

  const copy = join(fixture.root, "closure-copy");
  await cp(first, copy, { recursive: true });
  expect(await installClosure(layout, copy)).toMatchObject({ build: BUILD_A, created: false });

  // Another closure under the same build ID: refused, and the installed build is unchanged.
  const other = join(fixture.root, "closure-other");
  await miniClosure(other, BUILD_A, "other\n");
  await expect(installClosure(layout, other)).rejects.toThrow(
    "already installed with different contents",
  );
  expect(await contentsDigest(join(home, "install", BUILD_A))).toBe(await contentsDigest(first));
  expect(
    (await readdir(join(home, "install"))).filter((name) => name.startsWith(".staging-")),
  ).toEqual([]);
});

// #175: the impact a refusal prints names every consequence, the systemd cgroup one included.
test("the printed impact names every live run and every consequence", () => {
  const text = describeImpact({
    liveRuns: [{ run: { runId: "r1" }, taskId: "t1", tabId: null }],
    consequences: ["live-runs-end", "cgroup-processes-end", "some-future-consequence"],
  });
  expect(text).toBe(
    "Live runs that end:\n  run r1 (task t1, tab -)\n" +
      "- every live run ends and is recorded as interrupted; nothing is run again automatically\n" +
      "- systemd ends every process of the service's cgroup, including processes a terminal " +
      "detached with nohup, setsid or tmux\n" +
      "- some-future-consequence\n",
  );
});

// #172: the cause a wait for a started server reports is this start's, bounded and printable.
test("a startup failure is read from the service output only from this start on", () => {
  const event = (atMs, detail, category = "rendezvous") =>
    JSON.stringify({ event: "startup-failed", atMs, category, cleanup: "verified", detail });
  const output = [
    event(100, "an earlier start's cause"),
    "cove-server: an earlier start's cause",
    '{"event":"stopping","liveRuns":[]}',
    "not json {",
    event(200, "the first failure of this start"),
    event(300, "the latest\u0007 failure\nof this start"),
    "",
  ].join("\n");
  expect(startupFailureSince(output, 150)).toBe("the latest? failure?of this start");
  expect(startupFailureSince(output, 400)).toBeNull();
  expect(startupFailureSince(null, 0)).toBeNull();
  expect(startupFailureSince(event(500, null, "worker"), 0)).toBe(
    "the server's worker step failed",
  );
  expect(startupFailureSince(event(500, "x".repeat(5000)), 0)).toHaveLength(600);
});

test("the service log is read as a bounded tail of whole lines", async () => {
  const path = join(fixture.root, "service.log");
  await writeFile(path, `${"a".repeat(100)}\n${"b\n".repeat(SERVICE_LOG_LINES + 50)}`);
  const tail = fileTail(path, 1024);
  expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(1024);
  expect(tail.startsWith("b")).toBe(true);
  const lines = fileTail(path);
  expect(lines.split("\n").length).toBeLessThanOrEqual(SERVICE_LOG_LINES);
  expect(fileTail(join(fixture.root, "no-such.log"))).toBeNull();
});

test("install adoption rejects managed modes and symlinks without changing them", async () => {
  const home = await dataDirectory("strict-install");
  const layout = installLayout(home);
  for (const name of ["install", "bin", "server", "server/service", "server/log"]) {
    const path = join(home, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o755);
    await expect(ensureInstallDirectory(path)).rejects.toThrow(
      `Cove directory ${path} has owner uid`,
    );
    expect((await lstat(path)).mode & 0o777).toBe(0o755);
    await chmod(path, 0o700);
  }
  await chmod(layout.installDirectory, 0o755);
  await expect(acquireInstallLock(layout)).rejects.toThrow("mode 0755");
  await chmod(layout.installDirectory, 0o700);
  const alias = join(home, "alias");
  await symlink(join(home, "bin"), alias);
  await expect(ensureInstallDirectory(alias)).rejects.toThrow("not be symbolic links");
});

test("startup polling bounds both manager probes by the remaining deadline and keeps failures unknown", async () => {
  const calls = [];
  const original = childProcess.spawnSync;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  let denied = false;
  childProcess.spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("show-environment")) return { status: 0, stdout: "", stderr: "" };
    if (denied)
      return {
        status: 1,
        stdout: "ActiveState=failed\nResult=start-limit-hit\n",
        stderr: "denied",
      };
    if (command === "systemctl")
      return { status: 0, stdout: "ActiveState=failed\nResult=exit-code\n", stderr: "" };
    return {
      status: 0,
      stdout: Buffer.from("Started Cove.\nStart request repeated too quickly.\n"),
      stderr: Buffer.alloc(0),
    };
  };
  Object.defineProperty(process, "platform", { value: "linux" });
  syncBuiltinESMExports();
  try {
    const { backend } = serviceBackend(installLayout(await dataDirectory("bounded-probes")));
    calls.length = 0;
    const deadline = Date.now() + 37;
    expect(backend.recentOutput(0, deadline)).toContain("Started Cove");
    expect(backend.gaveUpSince(0, deadline)).toBe(true);
    expect(calls.map((call) => call.command)).toEqual(["journalctl", "systemctl", "journalctl"]);
    for (const { options } of calls) expect(options.timeout).toBeGreaterThan(0);
    for (const { options } of calls) expect(options.timeout).toBeLessThanOrEqual(37);
    calls.length = 0;
    expect(backend.gaveUpSince(0, Date.now() - 1)).toBe(false);
    expect(backend.recentOutput(0, Date.now() - 1)).toBeNull();
    expect(calls).toHaveLength(0);
    denied = true;
    expect(backend.gaveUpSince(0, Date.now() + 100)).toBe(false);
    expect(backend.recentOutput(0, Date.now() + 100)).toBeNull();
  } finally {
    childProcess.spawnSync = original;
    Object.defineProperty(process, "platform", platform);
    syncBuiltinESMExports();
  }
});

test("journal tails enforce the UTF-8 byte limit and discard partial leading lines", async () => {
  const bytes = Buffer.from(("汉😀".repeat(100) + "\n").repeat(250));
  const text = serviceOutputTail(bytes);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SERVICE_LOG_BYTES);
  expect(text).not.toContain("�");
  expect(text.split("\n").length).toBeLessThanOrEqual(SERVICE_LOG_LINES);
  expect(serviceOutputTail(Buffer.from("汉".repeat(SERVICE_LOG_BYTES)))).toBe("");
  const log = join(fixture.root, "single-line.log");
  await writeFile(log, "汉".repeat(SERVICE_LOG_BYTES));
  expect(fileTail(log)).toBe("");
});

// Run the actual compiled CLI router, mocking only the host service-manager subprocesses. Every
// path and persistent marker belongs to this fixture; no real launchctl/systemctl mutation runs.
async function publicCommandRig(home, name, registered = true) {
  const root = join(fixture.root, name);
  await mkdir(root);
  const state = join(root, "service.json");
  const effects = join(root, "effects.jsonl");
  const preload = join(root, "service-mock.mjs");
  const initial = JSON.stringify({ registered, running: registered });
  await writeFile(state, initial);
  await writeFile(effects, "");
  await writeFile(
    preload,
    `
    import cp from "node:child_process";
    import {readFileSync, writeFileSync, appendFileSync} from "node:fs";
    import {syncBuiltinESMExports} from "node:module";
    const original = cp.spawnSync;
    cp.spawnSync = (command, args, options) => {
      if (command !== "/bin/launchctl" && command !== "systemctl") return original(command,args,options);
      const state = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
      const result = (status, stdout="") => ({status, stdout, stderr:""});
      if (command === "/bin/launchctl") {
        if (args[0] === "print") {
          if (!args[1].includes("/dev.cove.server.")) return result(0);
          return state.registered ? result(0, "state = " + (state.running ? "running" : "waiting") + "\\n") : result(1);
        }
      } else {
        if (args.includes("show-environment")) return result(0);
        if (args.includes("show")) return result(0, "LoadState=" + (state.registered ? "loaded" : "not-found") + "\\nActiveState=" + (state.running ? "active" : "inactive") + "\\nSubState=" + (state.running ? "running" : "dead") + "\\n");
      }
      appendFileSync(${JSON.stringify(effects)}, JSON.stringify([command,...args]) + "\\n");
      if (args.includes("bootout") || args.includes("disable")) {state.registered=false; state.running=false;}
      else if (args.includes("start") || args.includes("restart") || args.includes("bootstrap") || args.includes("kickstart")) {state.registered=true; state.running=true;}
      writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
      return result(0);
    };
    syncBuiltinESMExports();
  `,
  );
  return {
    initial,
    state,
    effects: async () => (await readFile(effects, "utf8")).trim(),
    run: (args) =>
      new Promise((done) =>
        childProcess.execFile(
          process.execPath,
          ["--import", preload, cli, "--home", home, ...args],
          { env: fixture.env, timeout: 5_000, killSignal: "SIGKILL" },
          (error, stdout, stderr) =>
            done({
              code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
              stdout,
              stderr,
            }),
        ),
      ),
  };
}

// A tiny executable closure whose schema probe succeeds; copying, checking and activating it
// still use the production implementation. It contains no service or long-running process.
async function runnableClosure(dir, build) {
  await mkdir(join(dir, "bin"), { recursive: true });
  await writeFile(
    join(dir, "bin/node"),
    `#!/bin/sh\nprintf '%s\\n' '{"database":0,"supported":7}'\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(dir, INSTALL_STAMP),
    JSON.stringify(stampFor(build, await contentsDigest(dir))),
  );
}

async function invalidParent(path, kind, name) {
  const external = join(fixture.root, name);
  await mkdir(external);
  await writeFile(join(external, "cove"), "unrelated launcher\n");
  await writeFile(join(external, "service.log"), "unrelated log\n");
  if (kind === "symlink") await symlink(external, path);
  else {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o755);
  }
  return external;
}

test("public activation and uninstall refuse invalid bin before current or service changes", async () => {
  for (const kind of ["mode", "symlink"]) {
    for (const operation of ["activate", "uninstall"]) {
      const home = await dataDirectory(`${kind}-${operation}`);
      const layout = installLayout(home);
      await mkdir(layout.installDirectory, { mode: 0o700 });
      await runnableClosure(join(layout.installDirectory, BUILD_A), BUILD_A);
      await runnableClosure(join(layout.installDirectory, BUILD_B), BUILD_B);
      await symlink(BUILD_A, layout.current);
      const external = await invalidParent(
        join(home, "bin"),
        kind,
        `${kind}-${operation}-external`,
      );
      const mock = await publicCommandRig(home, `${kind}-${operation}-manager`);
      const args =
        operation === "activate"
          ? ["server", "install", "--activate", BUILD_B]
          : ["server", "uninstall", "--yes"];
      const result = await mock.run(args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Cove directory ${join(home, "bin")}`);
      expect(await readlink(layout.current)).toBe(BUILD_A);
      expect(await readFile(join(external, "cove"), "utf8")).toBe("unrelated launcher\n");
      expect(await mock.effects()).toBe("");
      expect(await readFile(mock.state, "utf8")).toBe(mock.initial);
      expect(existsSync(join(layout.installDirectory, BUILD_A, INSTALL_STAMP))).toBe(true);
      expect(existsSync(join(layout.installDirectory, BUILD_B, INSTALL_STAMP))).toBe(true);
    }
  }
});

test("public uninstall leaves an absent bin absent", async () => {
  const home = await dataDirectory("no-bin");
  const layout = installLayout(home);
  await mkdir(layout.installDirectory, { mode: 0o700 });
  await runnableClosure(join(layout.installDirectory, BUILD_A), BUILD_A);
  await symlink(BUILD_A, layout.current);
  const mock = await publicCommandRig(home, "no-bin-manager", false);
  const result = await mock.run(["server", "uninstall", "--yes"]);
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  expect(existsSync(join(home, "bin"))).toBe(false);
  expect(existsSync(layout.current)).toBe(false);
});

test.runIf(process.platform === "darwin")(
  "public launchd commands preflight invalid logs before activation or service effects",
  async () => {
    for (const kind of ["mode", "symlink"]) {
      for (const operation of ["start", "restart", "upgrade", "install"]) {
        const home = await dataDirectory(`${kind}-log-${operation}`);
        const layout = installLayout(home);
        await mkdir(layout.installDirectory, { mode: 0o700 });
        await runnableClosure(join(layout.installDirectory, BUILD_A), BUILD_A);
        await symlink(BUILD_A, layout.current);
        await mkdir(join(home, "server"), { mode: 0o700 });
        const external = await invalidParent(
          layout.logDirectory,
          kind,
          `${kind}-log-${operation}-external`,
        );
        const source = join(fixture.root, `${kind}-log-${operation}-closure`);
        await runnableClosure(source, BUILD_B);
        const mock = await publicCommandRig(home, `${kind}-log-${operation}-manager`);
        const commands = {
          start: ["server", "service", "start"],
          restart: ["server", "restart", "--yes"],
          upgrade: ["server", "upgrade", "--yes", "--closure", source],
          install: ["server", "install", "--closure", source],
        };
        const result = await mock.run(commands[operation]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`Cove directory ${layout.logDirectory}`);
        expect(await readlink(layout.current)).toBe(BUILD_A);
        expect(await readFile(join(external, "service.log"), "utf8")).toBe("unrelated log\n");
        expect(await mock.effects()).toBe("");
        expect(await readFile(mock.state, "utf8")).toBe(mock.initial);
        expect(existsSync(join(layout.installDirectory, BUILD_B))).toBe(false);
      }
    }
  },
);

test("malformed and incomplete service output respects the final UTF-8 bound and keeps diagnostics", async () => {
  const diagnostic =
    JSON.stringify({
      event: "startup-failed",
      atMs: 10,
      category: "worker",
      cleanup: "verified",
      detail: "safe EPIPE cause",
    }) + "\n";
  for (const bytes of [
    Buffer.concat([Buffer.alloc(SERVICE_LOG_BYTES - 1, 0xff), Buffer.from("\n")]),
    Buffer.concat([Buffer.alloc(60_000, 0xff), Buffer.from("\n" + diagnostic)]),
    Buffer.concat([
      Buffer.alloc(60_000, 0xff),
      Buffer.from("\n" + diagnostic),
      Buffer.from([0xe2, 0x82]),
    ]),
  ]) {
    const output = serviceOutputTail(bytes);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(SERVICE_LOG_BYTES);
    expect(Buffer.from(output).toString("utf8")).toBe(output);
    const log = join(fixture.root, "malformed.log");
    await writeFile(log, bytes);
    expect(Buffer.byteLength(fileTail(log))).toBeLessThanOrEqual(SERVICE_LOG_BYTES);
  }
  const output = serviceOutputTail(
    Buffer.concat([Buffer.alloc(60_000, 0xff), Buffer.from("\n" + diagnostic)]),
  );
  expect(startupFailureSince(output, 0)).toContain("safe EPIPE cause");
});
