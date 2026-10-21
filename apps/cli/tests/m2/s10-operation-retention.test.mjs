import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { publishPending } from "../../dist/commands/_pending.js";
import { createSessionClient, readRendezvous } from "../../dist/session.js";
import { waitFor } from "../recording-view.mjs";
import { cli, createM1Fixture } from "../m1/fixtures.mjs";

// S10 (docs/milestones/m2.md, D13, #97): operation receipt retention, driven through the compiled
// server and CLI on temporary data directories. "30 days later" is a restart of the server on a
// wall clock shifted by s10-clock-server.mjs (and a CLI run through s10-clock-cli.mjs), not a wait.

const DAY = 24 * 60 * 60 * 1000;
const LATER = 31 * DAY;
const clockServer = new URL("./s10-clock-server.mjs", import.meta.url).pathname;
const clockCli = new URL("./s10-clock-cli.mjs", import.meta.url).pathname;

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

async function markerLines(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(Number);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// The compiled server on a wall clock `offset` ms ahead. After a kill -9 the killed server's
// rendezvous is still on disk until the new one replaces it, so `previous` (that server) names the
// record to wait past.
async function startAt(offset, home, previous) {
  fixture.env.COVE_TEST_CLOCK_OFFSET_MS = String(offset);
  const server = await fixture.startServerEntry(clockServer, home);
  if (previous) {
    const stale = previous.record.relayInstanceId;
    await waitFor("the new server's rendezvous", async () => {
      const record = await readRendezvous(server.report.rendezvous).catch(() => null);
      if (!record || record.relayInstanceId === stale) return false;
      server.record = record;
      return true;
    });
  }
  return server;
}

// `cove --home H ...args` on a wall clock `offset` ms ahead.
function coveAt(offset, args, home) {
  return new Promise((done) =>
    execFile(
      process.execPath,
      [clockCli, cli, "--home", home, ...args],
      { env: { ...fixture.env, COVE_TEST_CLOCK_OFFSET_MS: String(offset) } },
      (error, stdout, stderr) =>
        done({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout), stderr }),
    ),
  );
}

test("30 days after they ended receipts are purged to tombstones that refuse every resend", async () => {
  const home = fixture.home("home");
  const markers = join(fixture.root, "markers");
  // Each started command records its PID once, then stays alive: the marker count is the number
  // of commands that ever executed.
  const command = ["--", "/bin/sh", "-c", `echo $$ >> '${markers}'; exec sleep 600`];
  const create = (operationId) =>
    fixture.coveJson(
      ["terminal", "create", "--cwd", fixture.root, "--operation-id", operationId, ...command],
      { home },
    );
  const operation = (id) => fixture.coveJson(["operation", "get", id], { home });
  const root = join(fixture.root, "next-root");

  // Day 0: three operations that end, and one left unfinished by a kill -9.
  const first = await startAt(0, home);
  const launched = await create("s10-launch");
  await waitFor("the command to start", async () => (await markerLines(markers)).length === 1);
  for (const pid of await markerLines(markers)) await fixture.trackPid(pid);
  await fixture.coveJson(["terminal", "stop", "--operation-id", "s10-stop", launched.runId], {
    home,
  });
  await fixture.coveJson(["config", "set", "workspaceRoot", root, "--operation-id", "s10-config"], {
    home,
  });
  const ended = ["s10-launch", "s10-stop", "s10-config"];
  for (const id of ended) expect((await operation(id)).state).toBe("succeeded");
  // Suspend the worker, so this create is accepted and running but never spawned; a kill -9 leaves
  // it unfinished, and the next start turns it into requires_attention.
  const [worker] = await fixture.childrenOf(first.pid);
  await fixture.trackPid(worker);
  await fixture.signalTracked(worker, "SIGSTOP");
  const pending = fixture.spawnCove(
    ["terminal", "create", "--cwd", fixture.root, "--operation-id", "s10-attention", ...command],
    { home },
  );
  await waitFor(
    "s10-attention to be running",
    async () => {
      const read = await fixture.cove(["operation", "get", "s10-attention"], { home });
      return read.code === 0 && JSON.parse(read.stdout).state === "running";
    },
    10_000,
  );
  await fixture.killServer(first);
  expect((await pending.done).code).not.toBe(0);

  // Still day 0: startup verification records requires_attention now, so that record is as old
  // as the others when the clock moves on. Nothing is due yet.
  const second = await startAt(0, home, first);
  const attention = await operation("s10-attention");
  expect(attention).toMatchObject({
    state: "requires_attention",
    error: { kind: "RESULT_UNKNOWN" },
  });
  await fixture.stopServer(second);

  // Day 31: the retention pass that follows startup verification purges the ended receipts.
  const later = await startAt(LATER, home);
  const expired = (result) =>
    result.code !== 0 && result.stderr.includes("OPERATION_HISTORY_EXPIRED");
  await waitFor(
    "the ended receipts to be purged",
    async () => {
      for (const id of ended)
        if (!expired(await fixture.cove(["operation", "get", id], { home }))) return false;
      return true;
    },
    10_000,
  );
  const get = await fixture.cove(["operation", "get", "s10-config"], { home });
  expect(get.stdout).toBe("");
  expect(get.stderr).toMatch(/s10-config ended more than 30 days ago.*never executes/);
  // requires_attention has not ended, so it is kept, however old.
  expect(await operation("s10-attention")).toEqual(attention);

  // `operation resend` sends the saved request; the server refuses it without executing it.
  for (const id of ended) {
    const resent = await fixture.cove(["operation", "resend", id], { home });
    expect(resent.code).toBe(1);
    expect(resent.stdout).toBe("");
    expect(resent.stderr).toContain("OPERATION_HISTORY_EXPIRED");
    expect(resent.stderr).toContain("never executes the operation again");
  }
  // The same through a direct RPC with the saved params, and another request reusing an ID.
  const saved = async (id) =>
    JSON.parse(await readFile(join(home, "cli", "operations", `${id}.json`), "utf8"));
  const client = createSessionClient(later.record);
  try {
    expect((await client.connect()).ok).toBe(true);
    for (const id of ended) {
      const { method, params } = await saved(id);
      expect(await client.call(method, params)).toMatchObject({
        ok: false,
        kind: "rpc-error",
        error: { kind: "OPERATION_HISTORY_EXPIRED", acceptance: "not-accepted" },
      });
    }
    expect(
      await client.call("config.set", {
        operationId: "s10-config",
        patch: { workspaceRoot: join(fixture.root, "other-root") },
      }),
    ).toMatchObject({ ok: false, error: { kind: "OPERATION_ID_CONFLICT" } });
  } finally {
    client.dispose();
  }
  // Nothing ran again: no second command, no further configuration change.
  expect(await markerLines(markers)).toHaveLength(1);
  expect(await fixture.coveJson(["config", "get"], { home })).toMatchObject({
    revision: 1,
    settings: { workspaceRoot: { value: root } },
  });
  expect((await fixture.coveJson(["terminal", "list"], { home })).runs).toEqual([]);
  await fixture.stopServer(later);

  // The tombstones keep the IDs and nothing of the requests or results.
  const db = new DatabaseSync(join(home, "server", "cove.db"), { readOnly: true });
  try {
    const tombstones = db
      .prepare("SELECT * FROM operation_tombstones ORDER BY operation_id")
      .all()
      .map((row) => ({ ...row }));
    expect(tombstones.map((row) => [row.operation_id, row.method, row.state])).toEqual([
      ["s10-config", "config.set", "succeeded"],
      ["s10-launch", "terminal.create", "succeeded"],
      ["s10-stop", "terminal.stop", "succeeded"],
    ]);
    for (const row of tombstones) {
      // Ended on day 0 by the real clock, purged on day 31 by the shifted one.
      expect(row.ended_at_ms).toBeLessThan(Date.now() + DAY);
      expect(row.purged_at_ms - row.ended_at_ms).toBeGreaterThanOrEqual(30 * DAY);
    }
    const text = JSON.stringify(tombstones);
    for (const fragment of [root, markers, fixture.root, launched.runId])
      expect(text).not.toContain(fragment);
    expect(
      db
        .prepare("SELECT operation_id, state FROM operations ORDER BY operation_id")
        .all()
        .map((row) => [row.operation_id, row.state]),
    ).toEqual([["s10-attention", "requires_attention"]]);
  } finally {
    db.close();
  }
});

test("a local pending record past 30 days is refused by resend and never sent", async () => {
  const home = fixture.home("home");
  const server = await startAt(0, home);
  const root = join(fixture.root, "unsent-root");
  // Saved by a command that died before sending it.
  await publishPending(home, {
    version: 1,
    serverId: server.record.serverId,
    method: "config.set",
    params: { operationId: "s10-unsent", patch: { workspaceRoot: root } },
    savedAtMs: Date.now(),
  });

  // 31 days later on the CLI's clock: refused before anything is sent.
  const resend = await coveAt(LATER, ["operation", "resend", "s10-unsent"], home);
  expect(resend.code).toBe(1);
  expect(resend.stdout).toBe("");
  expect(resend.stderr).toMatch(
    /operation s10-unsent was saved at .* and expired after 30 days, so it is never sent again; nothing was sent/,
  );
  // Reusing the operation ID for the same request is refused the same way.
  const reuse = await coveAt(
    LATER,
    ["config", "set", "workspaceRoot", root, "--operation-id", "s10-unsent"],
    home,
  );
  expect(reuse.code).toBe(1);
  expect(reuse.stderr).toMatch(/expired after 30 days; nothing was sent/);
  // The server never received it.
  const get = await fixture.cove(["operation", "get", "s10-unsent"], { home });
  expect(get.code).toBe(1);
  expect(get.stderr).toContain("OPERATION_NOT_FOUND");
  expect(await fixture.coveJson(["config", "get"], { home })).toMatchObject({ revision: 0 });

  // Within the retention period the same record is still resent.
  const fresh = await coveAt(29 * DAY, ["operation", "resend", "s10-unsent"], home);
  expect(fresh.code).toBe(0);
  expect(JSON.parse(fresh.stdout)).toMatchObject({ operationId: "s10-unsent", state: "succeeded" });
});
