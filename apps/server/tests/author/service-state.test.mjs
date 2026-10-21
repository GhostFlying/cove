import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../dist/store/database.js";
import { prepareHome } from "../../dist/store/home.js";
import { loadOrCreateIdentity, recordInstanceStart } from "../../dist/store/identity.js";
import {
  consequences,
  installedBuild,
  recordServiceStart,
  START_REQUEST,
  startReason,
} from "../../dist/entry/service-state.js";

// m2 T3 (D2, S1, S2): the start reason server.status reports, the installed and pending build,
// and the platform consequences of a stop.

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
