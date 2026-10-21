import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { createAuthFixture } from "./auth-fixtures.mjs";
import {
  alive,
  buildClosure,
  expectedManager,
  liveRuns,
  markerLines,
  nextVariant,
  removeService,
  serviceTests,
} from "./s1-install-fixture.mjs";

// m2 S2 (restart impact), against the compiled CLI and an installed service running a sealed
// closure of this checkout. With two live runs, `server restart` without --yes lists them with
// the platform consequences and changes nothing; an installed newer build is pending until the
// confirmed restart, which keeps the serverId, changes the instance, ends the runs without running
// them again and, under systemd, ends the processes a terminal detached; after kill -9 the
// manager starts the server again and status says so. A paired device can read the impact but
// not restart the service.

const SLOW = 180_000;

let fixture;
let closure;
let next;

beforeAll(async () => {
  fixture = await createAuthFixture();
  if (!serviceTests) return;
  closure = await buildClosure(fixture.root);
  next = await nextVariant(fixture.root, closure.dir);
}, 900_000);

afterAll(async () => {
  await fixture?.cleanup();
}, 120_000);

const status = (home) => fixture.coveJson(["server", "status"], { home });

test("restart lists the live runs first, applies a pending build only when confirmed, and status reports a crash restart", async (context) => {
  // Skipped at run time, not with test.skipIf, so that discovery (`vitest list`) always
  // counts it; the CI gate refuses a skipped test, and CI sets the variable.
  if (!serviceTests) context.skip("COVE_TEST_SERVICE_MANAGER=1 is not set");
  const home = fixture.home("service");
  const failures = [];
  try {
    const installed = await fixture.coveJson(["server", "install", "--closure", closure.dir], {
      home,
      timeoutMs: SLOW,
    });
    expect(installed.service).toMatchObject({ manager: expectedManager, running: true });
    const first = (await status(home)).server;
    const { task, tabs } = await liveRuns(fixture, home, "impact", 2, { detach: true });

    // Without --yes (and no terminal): the runs and consequences, status 2, nothing done.
    const refused = await fixture.cove(["server", "restart"], { home });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--yes");
    const listed = JSON.parse(refused.stdout);
    expect(listed).toMatchObject({ action: "server restart", confirmed: false });
    expect(listed.impact.platform).toBe(process.platform);
    expect(listed.impact.manager).toBe(expectedManager);
    expect(
      listed.impact.liveRuns.map(({ run, taskId, tabId }) => [run.runId, taskId, tabId]).sort(),
    ).toEqual(
      tabs.map(({ created, tabId }) => [created.operation.run.runId, task.taskId, tabId]).sort(),
    );
    expect(listed.impact.consequences).toEqual(
      process.platform === "linux"
        ? ["live-runs-end", "cgroup-processes-end"]
        : ["live-runs-end", "detached-processes-launchd", "logout-stops-server"],
    );
    expect((await status(home)).server.relayInstanceId).toBe(first.relayInstanceId);
    for (const { tabId } of tabs)
      expect((await fixture.coveJson(["tab", "get", tabId], { home })).latestRun).toMatchObject({
        lifecycle: "running",
        verification: "live",
      });

    // A paired device reads the impact and cannot restart the service.
    await fixture.coveJson(["server", "entry", "set", "sshTarget", "user@example.test"], {
      home,
    });
    const { invitation } = await fixture.invite(home);
    const client = fixture.home("client");
    await fixture.pairOk(client, "box", invitation);
    const remoteImpact = await fixture.coveJson(["--server", "box", "server", "impact"], {
      home: client,
    });
    expect(remoteImpact.liveRuns).toHaveLength(2);
    const remoteRestart = await fixture.cove(["--server", "box", "server", "restart", "--yes"], {
      home: client,
    });
    expect(remoteRestart.code).toBe(2);
    expect(remoteRestart.stderr).toContain("this host only");
    expect((await status(home)).server.relayInstanceId).toBe(first.relayInstanceId);

    // A newer build installed: pending, and the running server is unchanged.
    const upgrade = await fixture.coveJson(["server", "install", "--closure", next.dir], {
      home,
      timeoutMs: SLOW,
    });
    expect(upgrade).toMatchObject({
      build: next.build,
      runningBuild: closure.build,
      pending: true,
    });
    const pending = (await status(home)).server;
    expect(pending.relayInstanceId).toBe(first.relayInstanceId);
    expect(pending.buildVersion).toBe(closure.build);
    expect(pending.service).toMatchObject({
      installedBuild: next.build,
      pendingBuild: next.build,
    });

    // The running service stops answering (here: its rendezvous names a credential it refuses)
    // while `current` already names the new build. It is not taken for stopped: prune keeps the
    // build it runs, and restart asks for confirmation without an impact list.
    const rendezvous = join(home, "server", "run", "rendezvous.json");
    const record = await readFile(rendezvous, "utf8");
    await writeFile(rendezvous, JSON.stringify({ ...JSON.parse(record), secret: "x".repeat(43) }), {
      mode: 0o600,
    });
    try {
      const prune = await fixture.cove(["server", "prune"], { home });
      expect(prune.code).toBe(1);
      expect(prune.stderr).toContain("nothing was removed");
      expect(existsSync(join(home, "install", closure.build))).toBe(true);
      const unconfirmed = await fixture.cove(["server", "restart"], { home });
      expect(unconfirmed.code).toBe(2);
      expect(JSON.parse(unconfirmed.stdout)).toMatchObject({ state: "unknown", impact: null });
    } finally {
      await writeFile(rendezvous, record, { mode: 0o600 });
    }
    expect((await status(home)).server.relayInstanceId).toBe(first.relayInstanceId);

    // Confirmed: same server, new instance, the new build; the runs ended and were not re-run.
    const restarted = await fixture.coveJson(["server", "restart", "--yes"], {
      home,
      timeoutMs: SLOW,
    });
    expect(restarted).toMatchObject({
      serverId: first.serverId,
      previousRelayInstanceId: first.relayInstanceId,
      buildVersion: next.build,
      service: { manager: expectedManager, pendingBuild: null, lastStart: "manual" },
    });
    expect(restarted.relayInstanceId).not.toBe(first.relayInstanceId);
    for (const { tabId, markers } of tabs) {
      const { latestRun } = await fixture.coveJson(["tab", "get", tabId], { home });
      expect(latestRun.run.relayInstanceId).toBe(first.relayInstanceId);
      // Recorded for the PR: the manager's stop signals the worker and PTYs too (a systemd stop
      // signals the whole cgroup), so the orderly stop may or may not record the run's end.
      console.log(`${process.platform} restart: run ${latestRun.lifecycle}`);
      expect(["stopped-with-server", "interrupted"]).toContain(latestRun.lifecycle);
      expect(latestRun.verification).not.toBe("live");
      expect(await markerLines(markers)).toHaveLength(1);
    }
    expect((await fixture.coveJson(["terminal", "list"], { home })).runs).toEqual([]);
    // systemd ends the unit's whole cgroup (D2), including what the terminals detached.
    const detached = (await Promise.all(tabs.map(({ detached }) => markerLines(detached)))).flat();
    if (process.platform === "linux") {
      await waitFor("the detached processes to end", () => detached.every((pid) => !alive(pid)));
    } else {
      // launchd's behaviour is recorded rather than asserted (D2): see the PR and development.md.
      console.log(
        `launchd restart: detached processes still alive: ${detached.filter(alive).length} of ${detached.length}`,
      );
    }

    // kill -9: the manager starts it again and status reports a crash restart.
    const { unit } = await status(home);
    process.kill(unit.pid, "SIGKILL");
    let crashed;
    await waitFor(
      "the service manager to start the server again",
      async () => {
        const current = await fixture.cove(["server", "status"], { home });
        if (current.code !== 0) return false;
        crashed = JSON.parse(current.stdout);
        return (
          crashed.server !== null && crashed.server.relayInstanceId !== restarted.relayInstanceId
        );
      },
      60_000,
    );
    expect(crashed.server).toMatchObject({
      serverId: first.serverId,
      buildVersion: next.build,
      service: { manager: expectedManager, lastStart: "crash-restart" },
    });

    // Crash restarts are bounded (D2): killed again and again, the server is soon no longer
    // started (systemd's start limit; under launchd the server's own budget, after which it exits
    // 0), and status says why. A person's start brings it back.
    let instance = crashed.server.relayInstanceId;
    let kills = 0;
    let serviceUnit = crashed.unit;
    for (; kills < 8 && serviceUnit.running; kills++) {
      process.kill(serviceUnit.pid, "SIGKILL");
      await waitFor(
        "a new instance, or the manager to give up",
        async () => {
          const current = JSON.parse((await fixture.cove(["server", "status"], { home })).stdout);
          serviceUnit = current.unit;
          if (current.server && current.server.relayInstanceId !== instance) {
            instance = current.server.relayInstanceId;
            return true;
          }
          return serviceUnit.stoppedAfterCrashes;
        },
        60_000,
      );
    }
    console.log(`${process.platform}: crash restarts stopped after ${kills} more kills`);
    expect(serviceUnit).toMatchObject({
      registered: true,
      running: false,
      stoppedAfterCrashes: true,
    });
    // Not started again behind the operator's back.
    await new Promise((done) => setTimeout(done, 12_000));
    const given = await status(home);
    expect(given).toMatchObject({ serverState: "stopped", server: null });
    expect(given.unit).toMatchObject({ running: false, stoppedAfterCrashes: true });
    // Under launchd the server's own diagnostic is in the service log (systemd records its start
    // limit in the journal).
    const launchd = process.platform === "darwin";
    const log = launchd ? await readFile(join(home, "server", "log", "service.log"), "utf8") : "";
    expect({
      event: log.includes('"event":"crash-restart-budget-exhausted"'),
      advice: log.includes("cove server service start"),
    }).toEqual({ event: launchd, advice: launchd });
    const started = await fixture.coveJson(["server", "service", "start"], {
      home,
      timeoutMs: SLOW,
    });
    expect(started).toMatchObject({ running: true, stoppedAfterCrashes: false });
    expect((await status(home)).server.service.lastStart).toBe("manual");
  } finally {
    const leftover = await removeService(fixture, home);
    if (leftover) failures.push(leftover);
  }
  expect(failures).toEqual([]);
}, 600_000);
