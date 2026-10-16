import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { createSessionClient, readRendezvous } from "../dist/session.js";
import { createRecordingView, waitFor } from "./recording-view.mjs";
import { stopServer } from "./server-process.mjs";
import { isolatedEnv } from "./test-env.mjs";

// Regression for issue #103. A worker saturated on CPU answers commands late, but it is not
// lost. The runtime used to declare it lost as soon as one command (here an attach's subscribe)
// waited past recoveryDeadlineMs, which ended every subscription on the worker. The server under
// test is the compiled application with a 2 s recoveryDeadlineMs and a test-only worker entry
// (apps/server/tests/fixtures/slow-worker.mjs): the real pipe endpoint and execution, whose
// event loop is busy most of the time and whose subscribe replies are held while a flag file
// exists. A live subscription must keep streaming, in order, through three deadlines of
// slowness, while the attach that waits past its deadline fails alone; afterwards the same
// worker serves a new attach and input.
const cli = resolve(import.meta.dirname, "../dist/main.js");
const serverPackage = dirname(createRequire(import.meta.url).resolve("@cove/server/package.json"));
const launcher = join(serverPackage, "tests/fixtures/slow-worker-server.mjs");
const DEADLINE_MS = 2000;
const encoder = new TextEncoder();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let fixture;

async function launch(deadlineMs) {
  // Realpath the temp root: macOS /var is a symlink and the server refuses a symlinked
  // rendezvous ancestor.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cove-slow-worker-")));
  await mkdir(join(directory, "state"), { mode: 0o700 });
  const rendezvous = join(directory, "state", "run", "rendezvous.json");
  const flag = join(directory, "slow");
  const env = isolatedEnv(directory, {
    COVE_RENDEZVOUS: rendezvous,
    COVE_TEST_SLOW_WORKER_FLAG: flag,
  });
  const server = spawn(process.execPath, [launcher, rendezvous, String(deadlineMs)], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => (stdout += chunk));
  server.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((done) => server.once("exit", (code) => done(code)));
  fixture = { directory, env, flag, server, exited, clients: [], stderr: () => stderr };
  await waitFor(
    "the test server's ready report",
    () => server.exitCode !== null || stdout.trim().endsWith("}"),
    20_000,
  );
  if (server.exitCode !== null) throw new Error(`slow-worker server failed: ${stderr}`);
  fixture.record = await readRendezvous(rendezvous);
}

afterEach(async () => {
  if (!fixture) return;
  const { server, exited, clients, directory } = fixture;
  fixture = undefined;
  let code;
  try {
    for (const client of clients) client.dispose();
  } finally {
    try {
      code = await stopServer(server, exited, server.pid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (code !== 0) throw new Error(`the slow-worker server exited ${code} on SIGTERM`);
});

function coveJson(...args) {
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { env: fixture.env, timeout: 20_000 },
      (error, stdout, stderr) =>
        error
          ? fail(new Error(`cove ${args.join(" ")} failed: ${stderr}`))
          : done(JSON.parse(stdout)),
    );
  });
}

function open(client, run, viewId) {
  const recording = createRecordingView();
  const opened = client.openTerminal({
    run,
    viewId,
    view: recording.view,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  expect(opened.ok).toBe(true);
  return { controller: opened.value, recording };
}

const counters = (text) =>
  (text.match(/a-\d{6}(?=\r)/g) ?? []).map((line) => Number(line.slice(2)));

test("live subscriptions survive a slow worker while an attach past its deadline fails alone", async () => {
  await launch(DEADLINE_MS);
  const client = createSessionClient(fixture.record);
  fixture.clients.push(client);
  expect((await client.connect()).ok).toBe(true);

  // A streams numbered lines for the whole test.
  const streaming = await coveJson(
    "terminal",
    "create",
    "--cwd",
    fixture.directory,
    "--",
    "/bin/sh",
    "-c",
    'stty -echo; i=0; while :; do printf "a-%06d\\n" "$i"; i=$((i+1)); sleep 0.02; done',
  );
  const a = open(client, streaming, "slow-a");
  expect(await a.controller.attach()).toMatchObject({ ok: true });
  await waitFor("A's output", () => counters(a.recording.text()).length >= 10);

  const echo = await coveJson(
    "terminal",
    "create",
    "--cwd",
    fixture.directory,
    "--",
    "/bin/sh",
    "-c",
    'stty -echo; printf "b-ready\\n"; while IFS= read -r line; do printf "echo:%s\\n" "$line"; done',
  );

  // The worker turns slow: busy event loop, subscribe replies held.
  const slowSince = Date.now();
  await writeFile(fixture.flag, "slow\n");
  const before = counters(a.recording.text()).length;
  const first = open(client, echo, "slow-b-1");
  const attached = await first.controller.attach();
  // The server answered the attach definitively (not-accepted) at half the deadline, before the
  // client's own timer could make it unknown and retire the whole connection.
  expect(attached).toMatchObject({
    ok: false,
    error: { kind: "RECOVERY_EXPIRED", acceptance: "not-accepted" },
  });
  const waited = Date.now() - slowSince;
  expect(waited).toBeGreaterThanOrEqual(DEADLINE_MS / 2 - 100);
  expect(waited).toBeLessThan(DEADLINE_MS);
  await sleep(Math.max(0, slowSince + 3 * DEADLINE_MS - Date.now()));

  // Three deadlines of slowness later the live subscription is still streaming.
  const describe = () =>
    `${JSON.stringify(a.controller.snapshot())}; server stderr: ${fixture.stderr()}`;
  if (a.controller.snapshot().phase !== "ready")
    throw new Error(`A was interrupted: ${describe()}`);
  expect(counters(a.recording.text()).length).toBeGreaterThan(before);

  await rm(fixture.flag);
  const progress = counters(a.recording.text()).length;
  await waitFor("A's output after the slow period", () => {
    return counters(a.recording.text()).length > progress + 20;
  });

  // The same worker serves a fresh attach and input.
  const second = open(client, echo, "slow-b-2");
  expect(await second.controller.attach()).toMatchObject({ ok: true });
  await waitFor("B's prompt", () => second.recording.text().includes("b-ready"));
  second.controller.setInputTarget(true, true);
  expect(await second.controller.requestFocus()).toMatchObject({ ok: true });
  expect(
    await second.controller.sendInput({ source: "keyboard", bytes: encoder.encode("hello\r") }),
  ).toMatchObject({ ok: true, value: { unknownBytes: 0, notSentBytes: 0 } });
  await waitFor("B's echo", () => second.recording.text().includes("echo:hello"));

  // A was never interrupted: every line arrived once and in order.
  if (a.controller.snapshot().phase !== "ready")
    throw new Error(`A was interrupted: ${describe()}`);
  const seen = counters(a.recording.text());
  expect(seen.slice(1)).toEqual(seen.slice(0, -1).map((value) => value + 1));
}, 60_000);

// Issue #103 review (B4): the liveness window is its own constant, not recoveryDeadlineMs. A
// negotiated deadline shorter than the worker's 1 s heartbeat interval used to make an idle,
// healthy worker silent for longer than the window between two heartbeats, so it was declared
// lost and its terminals became unverifiable. This runs the production heartbeat cadence (the
// worker entry never overrides it) with a 500 ms deadline.
test("an idle worker stays live with a recovery deadline shorter than its heartbeat interval", async () => {
  const deadlineMs = 500;
  await launch(deadlineMs);
  const idle = await coveJson(
    "terminal",
    "create",
    "--cwd",
    fixture.directory,
    "--",
    "/bin/sh",
    "-c",
    "stty -echo; while IFS= read -r line; do :; done",
  );
  // Ten deadlines and several heartbeat intervals with nothing to say but heartbeats.
  await sleep(10 * deadlineMs);
  const record = await coveJson("terminal", "get", idle.runId);
  if (record.status !== "live")
    throw new Error(`the idle worker was lost: ${JSON.stringify(record)}; ${fixture.stderr()}`);
  expect(await coveJson("status")).toMatchObject({ workerCount: 1, health: "live" });
}, 30_000);

// Issue #103 review (B1): the server leaves route control pending while the worker is live, so
// the client must not give up sooner. With a fixed 5 s client deadline, an ACK held by a busy
// worker failed its view at 5 s, the detach sent after that failure timed out in turn, and the
// client retired the whole connection, ending every other subscription on it. Here the worker
// holds every ACK and progress report for 12 s while it keeps sending heartbeats.
test("route control held past the old client deadline keeps every subscription", async () => {
  await launch(DEADLINE_MS);
  const client = createSessionClient(fixture.record);
  fixture.clients.push(client);
  expect((await client.connect()).ok).toBe(true);
  const streams = [];
  for (const name of ["a", "b"]) {
    const run = await coveJson(
      "terminal",
      "create",
      "--cwd",
      fixture.directory,
      "--",
      "/bin/sh",
      "-c",
      'stty -echo; i=0; while :; do printf "a-%06d\\n" "$i"; i=$((i+1)); sleep 0.02; done',
    );
    const view = open(client, run, `route-${name}`);
    expect(await view.controller.attach()).toMatchObject({ ok: true });
    streams.push(view);
  }
  for (const view of streams)
    await waitFor("output before the hold", () => counters(view.recording.text()).length >= 10);
  const describe = () =>
    `${JSON.stringify(streams.map((view) => view.controller.snapshot()))}; server stderr: ${fixture.stderr()}`;
  const hold = `${fixture.flag}.route`;
  await writeFile(hold, "hold\n");
  await sleep(12_000);
  for (const view of streams)
    if (view.controller.snapshot().phase !== "ready")
      throw new Error(`a subscription ended while route control was held: ${describe()}`);
  await rm(hold);
  const progress = streams.map((view) => counters(view.recording.text()).length);
  for (const [index, view] of streams.entries())
    await waitFor(
      "output after the hold",
      () => counters(view.recording.text()).length > progress[index] + 20,
    );
  for (const view of streams) {
    if (view.controller.snapshot().phase !== "ready")
      throw new Error(`a subscription ended after the hold: ${describe()}`);
    const seen = counters(view.recording.text());
    expect(seen.slice(1)).toEqual(seen.slice(0, -1).map((value) => value + 1));
  }
}, 60_000);

// Issue #103 (A2): an overloaded worker is reported, informationally, through `cove status`,
// the server log and the subscriptions it serves, and reported normal again after the hold
// period; nothing about the terminal changes. The worker's event loop is busy in 450 ms bursts,
// so its event-loop delay p99 exceeds the threshold while its heartbeats still arrive.
test("an overloaded worker is reported through status, the log and its subscriptions", async () => {
  await launch(DEADLINE_MS);
  const client = createSessionClient(fixture.record);
  fixture.clients.push(client);
  expect((await client.connect()).ok).toBe(true);
  const run = await coveJson(
    "terminal",
    "create",
    "--cwd",
    fixture.directory,
    "--",
    "/bin/sh",
    "-c",
    'stty -echo; i=0; while :; do printf "a-%06d\\n" "$i"; i=$((i+1)); sleep 0.02; done',
  );
  const a = open(client, run, "health-a");
  expect(await a.controller.attach()).toMatchObject({ ok: true });
  await waitFor("output before the overload", () => counters(a.recording.text()).length >= 10);
  const workerHealth = async () => (await coveJson("status")).workers[0].health;
  expect(await workerHealth()).toEqual({ state: "normal", reasons: [] });
  expect(a.controller.snapshot().workerHealth).toEqual({ state: "normal", reasons: [] });

  await writeFile(fixture.flag, "450\n");
  const overloadedSince = Date.now();
  let reported;
  let last;
  await waitFor(
    "status to report the overload",
    async () => {
      last = await coveJson("status");
      reported = last.workers[0].health;
      return reported.state === "overloaded";
    },
    20_000,
  ).catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify(last?.workers)}; ${fixture.stderr()}`);
  });
  // Entered only after the condition held for the entry period.
  expect(Date.now() - overloadedSince).toBeGreaterThanOrEqual(5000);
  expect(reported.reasons).toContain("event-loop-delay");
  await waitFor(
    "the subscription to report the overload",
    () => a.controller.snapshot().workerHealth.state === "overloaded",
  );
  expect(fixture.stderr()).toMatch(/"event":"worker-health".*"state":"overloaded"/);
  const status = await coveJson("status");
  expect(status.workers[0].signals.eventLoopDelayP99Ms).toBeGreaterThan(200);

  await rm(fixture.flag);
  await waitFor(
    "status to report the worker normal again",
    async () => (await workerHealth()).state === "normal",
    30_000,
  );
  await waitFor(
    "the subscription to report normal again",
    () => a.controller.snapshot().workerHealth.state === "normal",
  );
  expect(fixture.stderr()).toMatch(/"event":"worker-health".*"state":"normal"/);
  // Informational only: the terminal kept streaming, in order, throughout.
  if (a.controller.snapshot().phase !== "ready")
    throw new Error(`A was interrupted: ${JSON.stringify(a.controller.snapshot())}`);
  const seen = counters(a.recording.text());
  expect(seen.slice(1)).toEqual(seen.slice(0, -1).map((value) => value + 1));
}, 90_000);
