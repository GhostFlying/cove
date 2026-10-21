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
  } finally {
    const leftover = await removeService(fixture, home);
    if (leftover) failures.push(leftover);
  }
  expect(failures).toEqual([]);
}, 600_000);
