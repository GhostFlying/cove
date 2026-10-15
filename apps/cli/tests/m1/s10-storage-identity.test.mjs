import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createSessionClient } from "../../dist/session.js";
import { waitFor } from "../recording-view.mjs";
import { alive, createM1Fixture } from "./fixtures.mjs";

// S10 (docs/milestones/m1.md): storage, identity and operation deduplication across a restart,
// driven through the compiled CLI and server against temporary data directories.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

async function snapshot(directory) {
  const files = {};
  for (const name of (await readdir(directory)).sort()) {
    if (name === "run" || name === "backups") continue;
    files[name] = createHash("sha256")
      .update(await readFile(join(directory, name)))
      .digest("hex");
  }
  return files;
}

async function markerLines(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(Number);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("a second server on the same data directory is refused and the first keeps serving", async () => {
  const home = fixture.home("home");
  const first = await fixture.startServer(home);
  const before = await fixture.coveJson(["config", "get"], { home });

  const second = await fixture.cove(["server", "start"], { home });
  expect(second.code).not.toBe(0);
  expect(second.stderr).toContain("in use by another server");

  // The first server's rendezvous, identity and state are untouched and it still answers.
  expect(alive(first.pid)).toBe(true);
  const status = await fixture.coveJson(["status"], { home });
  expect(status).toMatchObject({
    serverId: first.record.serverId,
    relayInstanceId: first.record.relayInstanceId,
  });
  expect(await fixture.coveJson(["config", "get"], { home })).toEqual(before);
  const set = await fixture.coveJson(
    ["config", "set", "workspaceRoot", join(fixture.root, "elsewhere")],
    { home },
  );
  expect(set.state).toBe("succeeded");
});

test("a live record of another server at the data directory's rendezvous path is preserved", async () => {
  const home = fixture.home("home");
  const own = await fixture.startServer(home);
  const path = own.report.rendezvous;
  await fixture.stopServer(own);
  // While this data directory's server is stopped, a server of another data directory publishes
  // its record at this data directory's default rendezvous path.
  const foreign = await fixture.startServer(fixture.home("other-home"), ["--rendezvous", path]);
  expect(foreign.record.serverId).not.toBe(own.record.serverId);
  const before = await readFile(path);

  const refused = await fixture.cove(["server", "start"], { home });
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain("Another server's rendezvous is published");
  expect(await readFile(path)).toEqual(before);
  expect(alive(foreign.pid)).toBe(true);
  expect(await fixture.coveJson(["--rendezvous", path, "status"], { home })).toMatchObject({
    serverId: foreign.record.serverId,
  });

  // This data directory's own stale record (left by kill -9) is still replaced.
  await fixture.stopServer(foreign);
  const crashed = await fixture.startServer(home);
  await fixture.killServer(crashed);
  const restarted = await fixture.startServer(home);
  expect(restarted.record).toMatchObject({ serverId: own.record.serverId });
  expect(restarted.record.relayInstanceId).not.toBe(crashed.record.relayInstanceId);
});

test("a database with a newer schema is refused and left byte-for-byte unchanged", async () => {
  const home = fixture.home("home");
  const init = await fixture.coveJson(["server", "init"], { home });
  const serverDirectory = join(init.home, "server");
  const database = new DatabaseSync(join(serverDirectory, "cove.db"));
  database.exec(`PRAGMA user_version = ${init.schemaVersion + 1}`);
  database.close();
  const before = await snapshot(serverDirectory);

  const started = await fixture.cove(["server", "start"], { home });
  expect(started.code).not.toBe(0);
  expect(started.stderr).toMatch(/schema \d+ is newer than this build/);
  const initAgain = await fixture.cove(["server", "init"], { home });
  expect(initAgain.code).not.toBe(0);
  expect(initAgain.stderr).toMatch(/schema \d+ is newer than this build/);

  expect(await snapshot(serverDirectory)).toEqual(before);
});

test("server init and workspaceRoot are set through the CLI and persist across restarts", async () => {
  const home = fixture.home("home");
  const initialRoot = join(fixture.root, "workspaces-a");
  const init = await fixture.coveJson(["server", "init", "--workspace-root", initialRoot], {
    home,
  });
  expect(init).toMatchObject({ created: true, workspaceRoot: initialRoot });
  // An initialized data directory keeps its identity; a second init changes nothing.
  const again = await fixture.cove(["server", "init", "--workspace-root", initialRoot], { home });
  expect(again.code).not.toBe(0);
  expect(await fixture.coveJson(["server", "init"], { home })).toMatchObject({
    created: false,
    serverId: init.serverId,
    workspaceRoot: initialRoot,
  });

  const first = await fixture.startServer(home);
  expect(first.record.serverId).toBe(init.serverId);
  // Init records the chosen root as the first configuration revision.
  expect(await fixture.coveJson(["config", "get"], { home })).toEqual({
    revision: 1,
    settings: { workspaceRoot: { value: initialRoot, isDefault: false } },
  });
  const nextRoot = join(fixture.root, "workspaces-b");
  const set = await fixture.coveJson(
    ["config", "set", "workspaceRoot", nextRoot, "--expected-revision", "1"],
    { home },
  );
  expect(set).toMatchObject({ state: "succeeded", method: "config.set" });
  const stale = await fixture.cove(
    ["config", "set", "workspaceRoot", initialRoot, "--expected-revision", "1"],
    { home },
  );
  expect(stale.code).not.toBe(0);
  expect(stale.stderr).toContain("REVISION_CONFLICT");

  await fixture.stopServer(first);
  const second = await fixture.startServer(home);
  expect(second.record.serverId).toBe(init.serverId);
  expect(second.record.relayInstanceId).not.toBe(first.record.relayInstanceId);
  expect(await fixture.coveJson(["config", "get"], { home })).toEqual({
    revision: 2,
    settings: { workspaceRoot: { value: nextRoot, isDefault: false } },
  });
  await fixture.coveJson(["config", "reset", "workspaceRoot"], { home });
  expect(await fixture.coveJson(["config", "get"], { home })).toEqual({
    revision: 3,
    settings: { workspaceRoot: { value: join(init.home, "workspace"), isDefault: true } },
  });
});

test("saved requests resent after kill -9 return their records and never execute again", async () => {
  const home = fixture.home("home");
  const markers = join(fixture.root, "markers");
  // Each started command records its PID once, then stays alive. The marker count is the number
  // of commands that ever executed.
  const command = ["--", "/bin/sh", "-c", `echo $$ >> '${markers}'; exec sleep 600`];
  const create = (operationId) =>
    fixture.coveJson(
      ["terminal", "create", "--cwd", fixture.root, "--operation-id", operationId, ...command],
      { home },
    );
  const operation = (id, options = { home }) => fixture.coveJson(["operation", "get", id], options);

  const first = await fixture.startServer(home);
  const oldInstance = first.record.relayInstanceId;
  const kept = await create("s10-create");
  const stopped = await create("s10-create-stopped");
  await waitFor("both commands to start", async () => (await markerLines(markers)).length === 2);
  for (const pid of await markerLines(markers)) await fixture.trackPid(pid);
  await fixture.coveJson(["terminal", "stop", "--operation-id", "s10-stop", stopped.runId], {
    home,
  });
  await fixture.coveJson(
    [
      "config",
      "set",
      "workspaceRoot",
      join(fixture.root, "next-root"),
      "--operation-id",
      "s10-config",
    ],
    { home },
  );
  const originals = {
    "s10-create": await operation("s10-create"),
    "s10-stop": await operation("s10-stop"),
    "s10-config": await operation("s10-config"),
  };
  expect(Object.values(originals).map((record) => record.state)).toEqual([
    "succeeded",
    "succeeded",
    "succeeded",
  ]);
  expect(originals["s10-create"].result.run).toEqual(kept);

  // Suspend the worker, so the fourth create is accepted and running but never spawned.
  const workers = await fixture.childrenOf(first.pid);
  expect(workers).toHaveLength(1);
  const [worker] = workers;
  await fixture.trackPid(worker);
  process.kill(worker, "SIGSTOP");
  const pending = fixture.spawnCove(
    ["terminal", "create", "--cwd", fixture.root, "--operation-id", "s10-suspended", ...command],
    { home },
  );
  // Bounded observation (5 s): each read gets only the remaining budget, and an observation
  // counts only when it completed within the budget.
  const deadline = Date.now() + 5_000;
  let suspended;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error(`s10-suspended is ${suspended?.state ?? "absent"} after 5 s`);
    const read = await fixture.cove(["operation", "get", "s10-suspended"], {
      home,
      timeoutMs: remaining,
    });
    if (Date.now() > deadline) throw new Error(`s10-suspended was not observed running within 5 s`);
    if (read.code === 0) suspended = JSON.parse(read.stdout);
    if (suspended?.state === "running") break;
    await new Promise((done) => setTimeout(done, 50));
  }
  await fixture.killServer(first);
  const interrupted = await pending.done;
  expect(interrupted.code).not.toBe(0);

  // Restart on the same data directory: same server, new relay instance.
  const second = await fixture.startServer(home);
  expect(second.record.serverId).toBe(first.record.serverId);
  expect(second.record.relayInstanceId).not.toBe(oldInstance);
  const resend = (id) => fixture.coveJson(["operation", "resend", id], { home });
  expect(await resend("s10-create")).toEqual(originals["s10-create"]);
  expect((await resend("s10-create")).result.run.relayInstanceId).toBe(oldInstance);
  expect(await resend("s10-stop")).toEqual(originals["s10-stop"]);
  expect(await resend("s10-config")).toEqual(originals["s10-config"]);
  expect(await fixture.coveJson(["config", "get"], { home })).toMatchObject({ revision: 1 });
  const attention = await resend("s10-suspended");
  expect(attention).toMatchObject({
    operationId: "s10-suspended",
    method: "terminal.create",
    state: "requires_attention",
    error: { kind: "RESULT_UNKNOWN" },
  });
  expect(await operation("s10-suspended")).toEqual(attention);
  // Nothing ran again: the old instance's run and the suspended spawn are not recreated.
  expect(await markerLines(markers)).toHaveLength(2);
  expect((await fixture.coveJson(["terminal", "list"], { home })).runs).toEqual([]);

  // The same operation ID with other params: the CLI refuses it before sending (its saved request
  // differs), including the create rebuilt against the new instance and a config change to
  // another value. Sent anyway, the server answers OPERATION_ID_CONFLICT (below).
  const rebuilt = await fixture.cove(
    ["terminal", "create", "--cwd", fixture.root, "--operation-id", "s10-create", ...command],
    { home },
  );
  expect(rebuilt.code).not.toBe(0);
  expect(rebuilt.stderr).toContain("already has a saved request");
  const changed = await fixture.cove(
    [
      "config",
      "set",
      "workspaceRoot",
      join(fixture.root, "other-root"),
      "--operation-id",
      "s10-config",
    ],
    { home },
  );
  expect(changed.code).not.toBe(0);
  expect(changed.stderr).toContain("already has a saved request");

  // A new operation ID carrying the old instance as its precondition is refused as stale.
  const client = createSessionClient(second.record);
  try {
    expect((await client.connect()).ok).toBe(true);
    const staleCreate = await client.call("terminal.create", {
      executable: "/bin/sh",
      argv: ["-c", `echo $$ >> '${markers}'; exec sleep 600`],
      cwd: fixture.root,
      geometry: { cols: 80, rows: 24 },
      operationId: "s10-stale-create",
      expectedRelayInstanceId: oldInstance,
    });
    expect(staleCreate).toMatchObject({ ok: false, error: { kind: "INSTANCE_MISMATCH" } });
    const conflict = { ok: false, error: { kind: "OPERATION_ID_CONFLICT" } };
    expect(
      await client.call("terminal.create", {
        executable: "/bin/sh",
        argv: ["-c", `echo $$ >> '${markers}'; exec sleep 600`],
        cwd: fixture.root,
        geometry: { cols: 80, rows: 24 },
        operationId: "s10-create",
        expectedRelayInstanceId: second.record.relayInstanceId,
      }),
    ).toMatchObject(conflict);
    expect(
      await client.call("config.set", {
        operationId: "s10-config",
        patch: { workspaceRoot: join(fixture.root, "other-root") },
      }),
    ).toMatchObject(conflict);
    const staleStop = await client.call("terminal.stop", {
      run: kept,
      operationId: "s10-stale-stop",
      expectedRelayInstanceId: oldInstance,
    });
    expect(staleStop).toMatchObject({ ok: false, error: { kind: "INSTANCE_MISMATCH" } });
    for (const id of ["s10-stale-create", "s10-stale-stop"])
      expect((await fixture.cove(["operation", "get", id], { home })).code).not.toBe(0);
  } finally {
    client.dispose();
  }
  expect(await markerLines(markers)).toHaveLength(2);

  // Another server with its own data directory: the CLI refuses to send these saved requests
  // there, and that server's operations, settings and runs stay as they were.
  const other = await fixture.startServer(fixture.home("other-home"));
  expect(other.record.serverId).not.toBe(first.record.serverId);
  const atOther = ["--rendezvous", other.report.rendezvous];
  const otherState = async () => ({
    config: await fixture.coveJson([...atOther, "config", "get"], { home }),
    runs: await fixture.coveJson([...atOther, "terminal", "list"], { home }),
    operations: await Promise.all(
      Object.keys({ ...originals, "s10-suspended": 0 }).map(
        async (id) => (await fixture.cove([...atOther, "operation", "get", id], { home })).code,
      ),
    ),
  });
  const otherBefore = await otherState();
  expect(otherBefore.operations.every((code) => code !== 0)).toBe(true);
  for (const id of ["s10-create", "s10-stop", "s10-config", "s10-suspended"]) {
    const refused = await fixture.cove([...atOther, "operation", "resend", id], { home });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(
      `was saved for server ${first.record.serverId}, but the connected server is ${other.record.serverId}; nothing was sent`,
    );
  }
  expect(await otherState()).toEqual(otherBefore);
  expect(await markerLines(markers)).toHaveLength(2);
});
