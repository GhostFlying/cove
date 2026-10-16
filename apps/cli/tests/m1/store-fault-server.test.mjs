import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { createM1Fixture } from "./fixtures.mjs";

// The compiled server with a real store worker fault or a saturated store, driven through the
// test-only entry store-fault-server.mjs (its seams are unreachable from the production
// executable; see ServerTestHooks in apps/server/src/entry/main.ts).

const ENTRY = fileURLToPath(new URL("./store-fault-server.mjs", import.meta.url));

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  delete current?.env.COVE_TEST_STORE_LIMITS;
  await current?.cleanup();
});

// The data directory as a second opener sees it (store-fault-server.mjs query mode).
function queryStore(home) {
  return new Promise((done, fail) =>
    execFile(
      process.execPath,
      [ENTRY, "--home", home],
      { env: { ...fixture.env, COVE_TEST_STORE_QUERY: "1" }, timeout: 20_000 },
      (error, stdout, stderr) =>
        error ? fail(new Error(`store query failed: ${stderr}`)) : done(JSON.parse(stdout)),
    ),
  );
}

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function listening(endpoint) {
  const { hostname, port } = new URL(endpoint);
  return new Promise((done) => {
    const socket = connect({ host: hostname.replace(/^\[|\]$/g, ""), port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

// A command that records its PID and ignores SIGHUP, so stopping its PTY takes the worker's full
// grace period: the server's cleanup is slow enough to be observed while it runs.
async function createLingeringRun(home, name) {
  const marker = join(fixture.root, `${name}.pid`);
  const run = await fixture.coveJson(
    [
      "terminal",
      "create",
      "--cwd",
      fixture.root,
      "--",
      "/bin/sh",
      "-c",
      `trap '' HUP; echo $$ > '${marker}'; while :; do sleep 0.2; done`,
    ],
    { home },
  );
  await waitFor("the command to start", () => exists(marker));
  const pid = Number((await readFile(marker, "utf8")).trim());
  await fixture.trackPid(pid);
  return { run, pid };
}

test("a store worker crash fails the compiled server closed and keeps the directory locked until cleanup ends", async () => {
  const home = fixture.home("home");
  const server = await fixture.startServerEntry(ENTRY, home);
  const { run, pid } = await createLingeringRun(home, "crash");
  const workers = await fixture.childrenOf(server.pid);
  expect(workers.length).toBeGreaterThan(0);

  await fixture.signalServer(server, "SIGUSR1");
  await waitFor("the store failure report", () => server.stderr().includes("store-failed"));
  // Cleanup is still running (the PTY outlasts SIGHUP for the grace period): a second opener is
  // refused, and the first server has not exited.
  expect(await queryStore(home)).toEqual({ lock: "in-use" });
  expect(server.wrapper.exitCode).toBeNull();

  expect(await server.exited).toBe(1);
  expect(server.stderr()).toBe(`${JSON.stringify({ event: "store-failed" })}\n`);
  expect(await exists(server.report.rendezvous)).toBe(false);
  expect(await listening(server.record.endpoint)).toBe(false);
  for (const worker of workers) expect(alive(worker)).toBe(false);
  expect(alive(pid)).toBe(false);
  // Only now is the directory free. The crash wrote no stop record: the next start marks the run
  // interrupted.
  const after = await queryStore(home);
  expect(after.lock).toBe("opened");
  expect(after.instances.at(-1)).toMatchObject({
    id: server.record.relayInstanceId,
    stopped: null,
  });
  expect(after.runs).toEqual([
    expect.objectContaining({
      id: run.runId,
      lifecycle: expect.stringMatching(/^(starting|running)$/),
    }),
  ]);
  await fixture.stopServer(server);
});

test("a store crash during an orderly stop still exits 1 with one failure event and releases the lock", async () => {
  const home = fixture.home("home");
  const server = await fixture.startServerEntry(ENTRY, home);
  await fixture.signalServer(server, "SIGHUP");
  expect(await server.exited).toBe(1);
  const events = server
    .stderr()
    .split("\n")
    .filter((line) => line.includes("store-failed"));
  expect(events).toEqual([JSON.stringify({ event: "store-failed" })]);
  // The stop record could not be written; the lock is free once the process is gone.
  const after = await queryStore(home);
  expect(after.lock).toBe("opened");
  expect(after.instances.at(-1)).toMatchObject({
    id: server.record.relayInstanceId,
    stopped: null,
  });
});

test("an orderly stop with a saturated store still writes both stop records, exits 0 and releases the lock", async () => {
  const home = fixture.home("home");
  fixture.env.COVE_TEST_STORE_LIMITS = JSON.stringify({ inFlight: 1, queued: 2 });
  const server = await fixture.startServerEntry(ENTRY, home);
  const run = await fixture.coveJson(
    ["terminal", "create", "--cwd", fixture.root, "--", "/bin/sh", "-c", "exec sleep 600"],
    { home },
  );
  await fixture.signalServer(server, "SIGUSR2");
  await waitFor("the store to be saturated", () => server.stderr().includes("saturated"));
  // SIGTERM while every store slot is taken.
  expect(await fixture.stopServer(server)).toBe(0);
  const after = await queryStore(home);
  expect(after.lock).toBe("opened");
  expect(after.instances.at(-1)).toMatchObject({
    id: server.record.relayInstanceId,
    stopped: expect.any(Number),
  });
  expect(after.runs).toEqual([
    {
      id: run.runId,
      instance: server.record.relayInstanceId,
      lifecycle: "stopped-with-server",
      verification: "final",
    },
  ]);
});
