import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../dist/store/database.js";
import { prepareHome } from "../../dist/store/home.js";
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

// Runs the compiled server once, as a service manager would start it, until it exits.
function serverProcess(argv) {
  return new Promise((done, fail) =>
    execFile(
      process.execPath,
      [fileURLToPath(new URL("../../dist/entry/main.js", import.meta.url)), ...argv],
      { encoding: "utf8", timeout: 60_000 },
      (error, _stdout, stderr) =>
        error && typeof error.code !== "number"
          ? fail(error)
          : done({ code: error?.code ?? 0, stderr }),
    ),
  );
}
