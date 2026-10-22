import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../dist/store/database.js";
import { checkManagedDirectory, prepareHome } from "../../dist/store/home.js";
import { loadOrCreateIdentity, recordInstanceStart } from "../../dist/store/identity.js";
import {
  checkCrashRestartBudget,
  consequences,
  CRASH_RESTART_BUDGET,
  CrashRestartBudgetError,
  crashRestartsOverBudget,
  hostBootId,
  installedBuild,
  recordServiceStart,
  START_REQUEST,
  startReason,
} from "../../dist/entry/service-state.js";

// m2 T3 (D2, S1, S2): the start reason server.status reports, the installed and pending build,
// the platform consequences of a stop, and the crash restart budget under launchd.

const directories = [];
const stores = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "cove-service-test-"));
  directories.push(path);
  return path;
}

const base = { requested: false, bootId: "boot-a", linger: true };

describe("start reason", () => {
  it("is manual for a foreground start and for a start asked for through cove", () => {
    expect(startReason({ ...base, manager: "foreground", previous: null, platform: "linux" })).toBe(
      "manual",
    );
    expect(
      startReason({
        ...base,
        requested: true,
        manager: "systemd-user",
        previous: { stopped: false, bootId: "boot-a" },
        platform: "linux",
      }),
    ).toBe("manual");
  });

  it("is a crash restart only in the same boot after a start without an orderly stop", () => {
    const crashed = { stopped: false, bootId: "boot-a" };
    for (const [manager, platform] of [
      ["systemd-user", "linux"],
      ["launchd-agent", "darwin"],
    ])
      expect(startReason({ ...base, manager, previous: crashed, platform })).toBe("crash-restart");
    // Another boot (a power loss) is a boot or login, not a crash restart.
    expect(
      startReason({
        ...base,
        manager: "systemd-user",
        previous: { stopped: false, bootId: "boot-0" },
        platform: "linux",
      }),
    ).toBe("boot");
    // An unreadable boot proves nothing.
    expect(
      startReason({
        ...base,
        bootId: null,
        manager: "systemd-user",
        previous: { stopped: false, bootId: null },
        platform: "linux",
      }),
    ).toBe("boot");
  });

  it("is login on macOS and boot, login or unknown on Linux otherwise", () => {
    const stopped = { stopped: true, bootId: "boot-a" };
    expect(
      startReason({ ...base, manager: "launchd-agent", previous: stopped, platform: "darwin" }),
    ).toBe("login");
    expect(
      startReason({ ...base, manager: "systemd-user", previous: stopped, platform: "linux" }),
    ).toBe("unknown");
    expect(
      startReason({
        ...base,
        linger: false,
        manager: "systemd-user",
        previous: stopped,
        platform: "linux",
      }),
    ).toBe("login");
  });

  it("consumes a fresh start request and records the start", async () => {
    const path = await temporary();
    const layout = await prepareHome(join(path, "home"));
    const store = await Store.open({
      databasePath: layout.databasePath,
      backupDirectory: layout.backupDirectory,
    });
    stores.push(store);
    await loadOrCreateIdentity(store);
    await recordInstanceStart(store, "first", 1);
    expect(
      await recordServiceStart(store, {
        home: layout.home,
        relayInstanceId: "first",
        manager: "systemd-user",
      }),
    ).not.toBe("manual");
    await mkdir(join(layout.home, "server", "service"), { recursive: true });
    await writeFile(
      join(layout.home, START_REQUEST),
      JSON.stringify({ requestedAtMs: Date.now() }),
    );
    await recordInstanceStart(store, "second", 2);
    expect(
      await recordServiceStart(store, {
        home: layout.home,
        relayInstanceId: "second",
        manager: "systemd-user",
      }),
    ).toBe("manual");
    // Consumed: the next start does not reuse it. "second" never stopped, in this boot.
    await recordInstanceStart(store, "third", 3);
    const third = await recordServiceStart(store, {
      home: layout.home,
      relayInstanceId: "third",
      manager: "systemd-user",
    });
    expect(third).toBe("crash-restart");
  });

  it("ignores a stale start request", async () => {
    const path = await temporary();
    const layout = await prepareHome(join(path, "home"));
    const store = await Store.open({
      databasePath: layout.databasePath,
      backupDirectory: layout.backupDirectory,
    });
    stores.push(store);
    await loadOrCreateIdentity(store);
    await mkdir(join(layout.home, "server", "service"), { recursive: true });
    await writeFile(
      join(layout.home, START_REQUEST),
      JSON.stringify({ requestedAtMs: Date.now() - 600_000 }),
    );
    await recordInstanceStart(store, "first", 1);
    expect(
      await recordServiceStart(store, {
        home: layout.home,
        relayInstanceId: "first",
        manager: "launchd-agent",
      }),
    ).not.toBe("manual");
  });
});

describe("installed build and consequences", () => {
  it("reads the build install/current names", async () => {
    const home = await temporary();
    expect(installedBuild(home)).toBeNull();
    const build = "1.0.0+0123456789abcdef";
    await mkdir(join(home, "install", build), { recursive: true });
    await writeFile(
      join(home, "install", build, "cove-install.json"),
      JSON.stringify({ type: "cove-install", version: 1, build }),
    );
    await symlink(build, join(home, "install", "current"));
    expect(installedBuild(home)).toBe(build);
  });

  it("names the platform consequences of a stop", () => {
    expect(consequences("systemd-user")).toEqual(["live-runs-end", "cgroup-processes-end"]);
    expect(consequences("launchd-agent")).toEqual([
      "live-runs-end",
      "detached-processes-launchd",
      "logout-stops-server",
    ]);
    expect(consequences("foreground")).toEqual(["live-runs-end"]);
  });
});

describe("crash restart budget (launchd)", () => {
  const crash = (startedAtMs) => ({ reason: "crash-restart", startedAtMs });
  const now = 1_000_000;

  it("counts the consecutive crash restarts within the window", () => {
    const five = Array.from({ length: 5 }, (_, index) => crash(now - index * 1_000));
    expect(crashRestartsOverBudget(five, now)).toBeNull();
    expect(crashRestartsOverBudget([crash(now), ...five], now)).toBe(6);
    // Another kind of start ends the chain: a person's start begins a new budget.
    expect(
      crashRestartsOverBudget(
        [...five, { reason: "manual", startedAtMs: now - 6_000 }, ...five],
        now,
      ),
    ).toBeNull();
    // Crash restarts older than the window are not counted.
    const old = now - CRASH_RESTART_BUDGET.windowMs - 1;
    expect(crashRestartsOverBudget([...five, crash(old), crash(old)], now)).toBeNull();
    // An instance of an earlier build has no recorded reason.
    expect(
      crashRestartsOverBudget([...five, { reason: null, startedAtMs: now - 6_000 }], now),
    ).toBeNull();
  });

  it("stops the sixth crash restart under launchd and leaves systemd to its start limit", async () => {
    const path = await temporary();
    const layout = await prepareHome(join(path, "home"));
    const store = await Store.open({
      databasePath: layout.databasePath,
      backupDirectory: layout.backupDirectory,
    });
    stores.push(store);
    await loadOrCreateIdentity(store);
    const start = Date.now();
    const outcomes = [];
    for (let index = 0; index <= CRASH_RESTART_BUDGET.restarts; index++) {
      const relayInstanceId = `crashed-${index}`;
      await recordInstanceStart(store, relayInstanceId, start + index);
      await store.call("service.recordStart", {
        relayInstanceId,
        manager: "launchd-agent",
        bootId: "boot-a",
        reason: "crash-restart",
      });
      outcomes.push(
        await checkCrashRestartBudget(store, {
          manager: "launchd-agent",
          lastStart: "crash-restart",
          now: start + index,
        }).then(
          () => "serves",
          (error) => (error instanceof CrashRestartBudgetError ? error.crashRestarts : error),
        ),
      );
    }
    expect(outcomes).toEqual(["serves", "serves", "serves", "serves", "serves", 6]);
    await expect(
      checkCrashRestartBudget(store, {
        manager: "systemd-user",
        lastStart: "crash-restart",
        now: start + 6,
      }),
    ).resolves.toBeUndefined();
    await expect(
      checkCrashRestartBudget(store, { manager: "launchd-agent", lastStart: "manual" }),
    ).resolves.toBeUndefined();
  });

  // A startup that fails after the budget check (here: the business port is taken, so listen
  // fails after the worker started) is not an orderly stop. Started again and again as launchd
  // would, every start after the first is a crash restart, and the sixth one stops the loop.
  it("counts startups that fail after the budget check as crashes", async (context) => {
    // Skipped at run time so that discovery always counts it (the CI gate refuses a skipped test).
    if (hostBootId() === null) context.skip("this host's boot ID cannot be read");
    const home = join(await temporary(), "home");
    const taken = createServer();
    await new Promise((done) => taken.listen(0, "127.0.0.1", done));
    try {
      const argv = [
        ...["--mode", "m0-local", "--host", "127.0.0.1", "--port", String(taken.address().port)],
        ...["--rendezvous", join(home, "server", "run", "rendezvous.json"), "--home", home],
        ...["--service", "launchd-agent"],
      ];
      const starts = [];
      for (let index = 0; index < CRASH_RESTART_BUDGET.restarts + 2; index++) {
        const { code, stderr } = await serverProcess(argv);
        starts.push({
          code,
          exhausted: stderr.includes('"event":"crash-restart-budget-exhausted"'),
        });
      }
      expect(starts).toEqual([
        ...Array.from({ length: CRASH_RESTART_BUDGET.restarts + 1 }, () => ({
          code: 1,
          exhausted: false,
        })),
        { code: 0, exhausted: true },
      ]);
    } finally {
      await new Promise((done) => taken.close(done));
    }
  }, 120_000);
});

// #172 (user decision 2026-10-22): directories Cove manages below the data directory are held to
// its rule (owned by this user, 0700, no symlink) and refused by name; a data directory that
// already existed and everything above it are not checked at all.
describe("Cove-managed directories", () => {
  const rule =
    "Cove's own directories must be owned by the current user, have mode 0700 and not be " +
    `symbolic links (uid ${process.getuid()}, mode 0700)`;

  it("names a Cove directory that breaks the rule, including another owner", () => {
    const facts = (uid, mode, kind = "directory") => ({
      uid,
      mode,
      isDirectory: () => kind === "directory",
      isSymbolicLink: () => kind === "symlink",
    });
    const own = process.getuid();
    expect(() => checkManagedDirectory("/x/server", facts(own, 0o40700))).not.toThrow();
    // Ownership cannot be given away without root, so another owner is shown through the facts.
    expect(() => checkManagedDirectory("/x/server", facts(own + 1, 0o40700))).toThrow(
      `Cove directory /x/server has owner uid ${own + 1} and mode 0700; ${rule}`,
    );
    expect(() => checkManagedDirectory("/x/server", facts(own, 0o40770))).toThrow(
      `Cove directory /x/server has owner uid ${own} and mode 0770; ${rule}`,
    );
    expect(() => checkManagedDirectory("/x/run", facts(own, 0o120700, "symlink"))).toThrow(
      `Cove directory /x/run is a symbolic link; ${rule}`,
    );
    expect(() => checkManagedDirectory("/x/run", facts(own, 0o100700, "file"))).toThrow(
      `Cove directory /x/run is not a directory; ${rule}`,
    );
  });

  it("adopts an existing data directory as it is and holds only Cove's own below it", async () => {
    const root = await realpath(await temporary());
    // A group- and world-writable ancestor without the sticky bit, and a home of mode 0755: the
    // earlier ancestor check refused the first, and the home was narrowed to 0700.
    const shared = join(root, "shared");
    await mkdir(shared);
    await chmod(shared, 0o777);
    const home = join(shared, "home");
    await mkdir(home);
    await chmod(home, 0o755);
    const layout = await prepareHome(home);
    expect(layout.home).toBe(home);
    // An absent tsnet state remains absent: directory validation must not trigger auto-start.
    expect(await exists(join(home, "tsnet/state"))).toBe(false);
    expect((await lstat(home)).mode & 0o777).toBe(0o755);
    expect((await lstat(layout.serverDirectory)).mode & 0o777).toBe(0o700);
    // A home reached through a symbolic link is the user's choice too.
    await symlink(home, join(root, "alias"));
    expect((await prepareHome(join(root, "alias"))).home).toBe(home);
    // A home Cove creates is Cove's: 0700.
    const created = join(shared, "new", "home");
    await prepareHome(created);
    expect((await lstat(created)).mode & 0o777).toBe(0o700);
    // <home>/server is refused, not repaired.
    await chmod(layout.serverDirectory, 0o750);
    await expect(prepareHome(home)).rejects.toThrow(
      `Cove directory ${layout.serverDirectory} has owner uid ${process.getuid()} and mode 0750; ${rule}`,
    );
    expect((await lstat(layout.serverDirectory)).mode & 0o777).toBe(0o750);
  });

  it("refuses all persistent managed descendants before readiness, with and without node state", async () => {
    for (const withState of [false, true]) {
      for (const relative of [
        "server/service",
        "server/backups",
        "tsnet",
        "tsnet/run",
        "tsnet/state",
      ]) {
        const home = await realpath(await temporary());
        await prepareHome(home);
        await mkdir(join(home, "tsnet/state"), { mode: 0o700 });
        if (withState) await writeFile(join(home, "tsnet/state/tailscaled.state"), "{}");
        const path = join(home, relative);
        await chmod(path, 0o755);
        const rendezvous = join(home, "server/run/rendezvous.json");
        const result = await serverProcess(
          [
            "--mode",
            "m0-local",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--home",
            home,
            "--rendezvous",
            rendezvous,
          ],
          isolated(home),
        );
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
          `Cove directory ${path} has owner uid ${process.getuid()} and mode 0755`,
        );
        expect(await exists(rendezvous)).toBe(false);
        expect((await lstat(path)).mode & 0o777).toBe(0o755);
      }
    }
  }, 60_000);

  it("reports safe worker spawn, pipe and confirmed early exit causes in process output", async () => {
    for (const kind of ["spawn", "pipe", "exit"]) {
      const home = await realpath(await temporary());
      const argv = [
        "--mode",
        "m0-local",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--home",
        home,
        "--rendezvous",
        join(home, "server/run/rendezvous.json"),
      ];
      const source = `
        import cp from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        const original = cp.spawn;
        cp.spawn = (bin, ...args) => {
          if (!bin.endsWith("cove-terminal-worker")) return original(bin, ...args);
          if (${JSON.stringify(kind)} === "spawn") return original("/missing-cove-worker", [], {stdio:["pipe","pipe","pipe"]});
          const child = original(process.execPath, ["-e", "process.exit(17)"], {stdio:["pipe","pipe","pipe"]});
          if (${JSON.stringify(kind)} === "pipe") {
            const error = Object.assign(new Error("PRIVATE-ERROR-MESSAGE"), {code:"EPIPE", syscall:"write"});
            child.once("spawn", () => child.stdout.emit("error", error));
          }
          return child;
        };
        syncBuiltinESMExports();
        const {runServerProcess} = await import(${JSON.stringify(new URL("../../dist/entry/main.js", import.meta.url).href)});
        runServerProcess(${JSON.stringify(argv)});
      `;
      const result = await new Promise((done, fail) =>
        execFile(
          process.execPath,
          ["--input-type=module", "-e", source],
          { env: isolated(home), timeout: 20_000 },
          (error, _stdout, stderr) =>
            error && typeof error.code !== "number"
              ? fail(error)
              : done({ code: error?.code ?? 0, stderr }),
        ),
      );
      expect(result.code).toBe(1);
      const events = result.stderr
        .split("\n")
        .filter((line) => line.startsWith('{"event":"startup-failed"'))
        .map(JSON.parse);
      expect(events).toHaveLength(1);
      const detail = events[0].detail;
      expect(events[0].category).toBe("worker");
      const expected = {
        spawn: "spawn /missing-cove-worker failed with ENOENT",
        pipe: "pipe failure: write failed with EPIPE",
        exit: "directly spawned child exited with code 17, signal none",
      }[kind];
      expect(detail).toContain(expected);
      expect(detail.length).toBeLessThanOrEqual(512);
      expect(result.stderr).toContain(
        `cove-server: ${detail}${events[0].cleanup === "unverifiable" ? "; its cleanup is unverifiable" : ""}\n`,
      );
      expect(result.stderr).not.toContain("PRIVATE-ERROR-MESSAGE");
    }
  }, 60_000);

  it("starts under a writable ancestor and reports a refused Cove directory as its startup cause", async () => {
    const root = await realpath(await temporary());
    const shared = join(root, "shared");
    await mkdir(shared);
    await chmod(shared, 0o777);
    const home = join(shared, "home");
    await mkdir(home);
    await chmod(home, 0o755);
    const rendezvous = join(home, "server", "run", "rendezvous.json");
    const argv = [
      ...["--mode", "m0-local", "--host", "127.0.0.1", "--port", "0"],
      ...["--rendezvous", rendezvous, "--home", home],
    ];
    // Starts and publishes its rendezvous; an orderly stop removes the run directory it created.
    const child = spawn(process.execPath, [serverMain, ...argv], {
      env: isolated(root),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise((done) => child.once("exit", (code) => done(code)));
    try {
      const deadline = Date.now() + 30_000;
      while (!(await exists(rendezvous))) {
        if (Date.now() > deadline || child.exitCode !== null)
          throw new Error(`the server did not publish its rendezvous: ${stderr}`);
        await new Promise((done) => setTimeout(done, 100));
      }
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
    expect((await lstat(home)).mode & 0o777).toBe(0o755);

    // A run directory of another mode: refused before listeners start, by name, with the
    // startup-failed event and the person's line on stderr, and exit status 1.
    const run = join(home, "server", "run");
    await mkdir(run);
    await chmod(run, 0o750);
    const before = Date.now();
    const refused = await serverProcess(argv, isolated(root));
    expect(refused.code).toBe(1);
    const cause =
      `Cove directory ${run} has owner uid ` + `${process.getuid()} and mode 0750; ${rule}`;
    const events = refused.stderr
      .split("\n")
      .filter((line) => line.startsWith('{"event":"startup-failed"'))
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: "store", cleanup: "verified", detail: cause });
    expect(events[0].atMs).toBeGreaterThanOrEqual(before);
    expect(refused.stderr).toContain(`cove-server: ${cause}\n`);
    // <home>/server of another mode: refused before the data directory is opened.
    await chmod(run, 0o700);
    await chmod(join(home, "server"), 0o755);
    const server = await serverProcess(argv, isolated(root));
    expect(server.code).toBe(1);
    expect(server.stderr).toContain(
      `cove-server: Cove directory ${join(home, "server")} has owner uid ${process.getuid()} ` +
        `and mode 0755; ${rule}\n`,
    );
  }, 90_000);
});

const serverMain = fileURLToPath(new URL("../../dist/entry/main.js", import.meta.url));

// A server process environment that cannot reach the operator's data directory.
function isolated(root) {
  const env = { ...process.env, HOME: root };
  delete env.COVE_HOME;
  delete env.COVE_RENDEZVOUS;
  return env;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// Runs the compiled server once, as a service manager would start it, until it exits.
function serverProcess(argv, env = process.env) {
  return new Promise((done, fail) =>
    execFile(
      process.execPath,
      [serverMain, ...argv],
      { encoding: "utf8", timeout: 60_000, env },
      (error, _stdout, stderr) =>
        error && typeof error.code !== "number"
          ? fail(error)
          : done({ code: error?.code ?? 0, stderr }),
    ),
  );
}
