import { execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { readRendezvous } from "../dist/session.js";
import { createRecordingView, waitFor } from "./recording-view.mjs";
import { stopServer } from "./server-process.mjs";
import { createTappedClient } from "./wire-tap.mjs";

// Every resize makes each attached client recover its baseline and then ack it, so with three
// clients on one run three applied-acks reach the run's worker together. Here two clients with
// different grids take turns holding focus, and each handoff resizes the PTY to the new
// holder's grid while a third client watches. The runtime lets up to
// PIPE_ROUTE_CONTROL_COMMANDS route-control commands be outstanding per worker; a worker that
// queued fewer shut itself down on the third and failed every later operation with
// RESULT_UNKNOWN. That needs the three acks to reach the worker in one read, which in the
// field happens when the worker is busy or descheduled under load. The test makes it happen
// every round: the tap withholds each client's post-recovery ack, the test suspends the
// server's worker processes, releases the three acks, proves the server wrote all three into
// the worker pipe (see `forwardedBarrier`), and resumes the workers, which then read all three
// at once.
const cli = resolve(import.meta.dirname, "../dist/main.js");
const encoder = new TextEncoder();
const ROUNDS = 4;
const GRIDS = [
  { cols: 100, rows: 30 },
  { cols: 90, rows: 25 },
  { cols: 80, rows: 24 },
];

let fixture;

beforeEach(async () => {
  // Realpath the temp root: on macOS /var is a symlink and the server refuses a rendezvous
  // reached through a symlinked ancestor. HOME points there so the CLI's start lock under
  // ~/.cove never touches the user's real home.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cove-cli-")));
  const rendezvous = join(directory, "state", "run", "rendezvous.json");
  const env = { ...process.env, HOME: directory, COVE_RENDEZVOUS: rendezvous };
  const server = spawn(process.execPath, [cli, "--rendezvous", rendezvous, "server", "start"], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => (stdout += chunk));
  server.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((done) => server.once("exit", (code) => done(code)));
  fixture = { directory, env, server, exited, clients: [] };
  await waitFor(
    "the server start report",
    () => server.exitCode !== null || stdout.trim().endsWith("}"),
    20_000,
  );
  if (server.exitCode !== null) throw new Error(`cove server start failed: ${stderr}`);
  fixture.started = JSON.parse(stdout);
  fixture.record = await readRendezvous(rendezvous);
});

afterEach(async () => {
  if (!fixture) return;
  const { server, exited, clients, started, directory } = fixture;
  fixture = undefined;
  let code;
  try {
    for (const client of clients) client.dispose();
  } finally {
    try {
      code = await stopServer(server, exited, started?.pid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (code !== 0) throw new Error(`cove server start exited ${code} on SIGTERM`);
});

// The worker processes are the real server's direct children; PTYs are the workers' children.
async function workerPids() {
  const listing = await new Promise((done, fail) =>
    execFile("ps", ["-A", "-o", "pid=", "-o", "ppid="], (error, stdout) =>
      error ? fail(error) : done(stdout),
    ),
  );
  return listing
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, ppid]) => ppid === fixture.started.pid)
    .map(([pid]) => pid);
}

// Run `step` with every worker suspended, resuming them even if it throws, so a failing round
// never leaves a stopped process behind for cleanup to hang on.
// Proves the server has written this connection's released ack into the worker pipe, without
// the worker's help. The server handles one connection's frames in order, and for an ACK on an
// idle route it runs synchronously from the frame to the pipe write: subscription admission,
// the route queue, LocalRuntime.request and WorkerPipeSession.request all reach
// child.stdin.write before their first await. So once the server answers a later frame on the
// same connection, the ack ahead of it is in the pipe. The probe is an ACK for a subscription
// that does not exist, which the server refuses itself with STALE_CONNECTION; it touches no
// route and no worker. The acks are a few hundred bytes into a pipe the stopped worker had
// drained, so the kernel takes them whole and the resumed worker reads them in one read.
async function forwardedBarrier({ tap, controller }) {
  const ref = controller.snapshot().subscription;
  const reply = await tap.inject(
    {
      type: "applied-ack",
      run: ref.run,
      subscription: { ...ref, subscriptionId: `barrier-${ref.subscriptionId}` },
      appliedSeq: 0,
    },
    undefined,
    5_000,
  );
  expect(reply.metadata).toMatchObject({ type: "error", error: { kind: "STALE_CONNECTION" } });
}

async function withWorkersSuspended(step) {
  const pids = await workerPids();
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) process.kill(pid, "SIGSTOP");
  try {
    await step();
  } finally {
    for (const pid of pids) process.kill(pid, "SIGCONT");
  }
}

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

async function attachTapped(run, viewId, grid) {
  const tapped = createTappedClient(fixture.record);
  fixture.clients.push(tapped.client);
  expect((await tapped.client.connect()).ok).toBe(true);
  const recording = createRecordingView(grid);
  const opened = tapped.client.openTerminal({
    run,
    viewId,
    view: recording.view,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  expect(opened.ok).toBe(true);
  const controller = opened.value;
  expect(await controller.attach()).toMatchObject({ ok: true });
  return { ...tapped, controller, recording };
}

// Every baseline-progress the client sent has its reply, so released acks are the only
// route-control commands in flight and the burst stays within the runtime's window.
const progressSettled = ({ tap }) => {
  const answered = new Set(tap.inbound.map((frame) => frame.metadata.requestId));
  return tap.outbound
    .filter((frame) => frame.metadata.type === "baseline-progress")
    .every((frame) => answered.has(frame.metadata.requestId));
};

// Metadata only: frame payloads may carry terminal content.
function describeClient({ controller, tap }) {
  const { phase, appliedSeq, appliedGeometry, controlEpoch } = controller.snapshot();
  const brief = ({ metadata: { type, requestId, appliedSeq, error } }) => ({
    type,
    requestId,
    appliedSeq,
    error,
  });
  return {
    phase,
    appliedSeq,
    geometry: appliedGeometry?.geometry,
    controlEpoch,
    held: tap.heldOutbound.length,
    lastOutbound: tap.outbound.slice(-4).map(brief),
    lastInbound: tap.inbound.slice(-6).map(brief),
  };
}

test("three clients' simultaneous recovery acks after resizes keep the run's worker alive", async () => {
  const run = await coveJson(
    "terminal",
    "create",
    "--cwd",
    fixture.directory,
    "--cols",
    "80",
    "--rows",
    "24",
    "--",
    "/bin/sh",
    "-c",
    'printf "loop-ready\\n"; while read line; do printf "echo:%s:%s\\n" "$line" "$(stty size)"; done',
  );
  const clients = [];
  for (const [index, viewId] of ["acks-a", "acks-b", "acks-watch"].entries())
    clients.push(await attachTapped(run, viewId, GRIDS[index]));
  await waitFor("the run's output on every client", () =>
    clients.every(({ recording }) => recording.text().includes("loop-ready")),
  );

  for (let round = 0; round < ROUNDS; round++) {
    const holder = clients[round % 2];
    const size = GRIDS[round % 2];
    // Hold the first ack each client sends after it starts recovering: the one that covers
    // its new baseline. A client keeps a single ack in flight, so that is one per client.
    for (const { tap } of clients) {
      let recovering = false;
      tap.holdOutbound((metadata) => {
        if (metadata.type === "recover") recovering = true;
        return recovering && metadata.type === "applied-ack";
      });
    }
    // The grant resolves only after the holder's own recovery ack is answered, so it is
    // awaited after the release.
    holder.controller.setInputTarget(true, true);
    const granted = holder.controller.requestFocus();
    try {
      await waitFor(
        `round ${round}: every client to recover at ${size.cols}x${size.rows} and send its ack`,
        () =>
          clients.every(
            (client) => client.tap.heldOutbound.length === 1 && progressSettled(client),
          ),
        4_000,
      );
    } catch (error) {
      throw new Error(`${error.message}; ${JSON.stringify(clients.map(describeClient))}`, {
        cause: error,
      });
    }
    const released = clients.map(
      ({ tap }) =>
        tap.outbound.findLast((frame) => frame.metadata.type === "applied-ack").metadata.requestId,
    );
    await withWorkersSuspended(async () => {
      for (const { tap } of clients) tap.releaseOutbound();
      // All three acks are in the suspended worker's pipe before it may read any of them.
      await Promise.all(clients.map(forwardedBarrier));
      // Nothing in the pipe was answered while the worker was stopped.
      expect(
        clients.some(({ tap }, index) =>
          tap.inbound.some((frame) => frame.metadata.requestId === released[index]),
        ),
      ).toBe(false);
    });
    const replies = () =>
      clients.map(({ tap }, index) =>
        tap.inbound.find((frame) => frame.metadata.requestId === released[index]),
      );
    try {
      await waitFor(`round ${round}: a reply to every released ack`, () =>
        replies().every(Boolean),
      );
    } catch (error) {
      throw new Error(`${error.message}; ${JSON.stringify(clients.map(describeClient))}`, {
        cause: error,
      });
    }
    // Before the fix the worker shut down on the third ack and these were RESULT_UNKNOWN.
    expect(replies().map((frame) => frame.metadata)).toMatchObject(
      released.map((requestId) => ({ type: "applied-ack-result", requestId })),
    );
    expect(await granted).toMatchObject({ ok: true });
  }

  // The worker still runs the PTY: the last holder's input reaches it at that holder's grid.
  const last = GRIDS[(ROUNDS - 1) % 2];
  const sent = await clients[(ROUNDS - 1) % 2].controller.sendInput({
    source: "keyboard",
    bytes: encoder.encode("alive\r"),
  });
  expect(sent).toMatchObject({ ok: true, value: { unknownBytes: 0, notSentBytes: 0 } });
  for (const { recording } of clients)
    await waitFor("the echo on every client", () =>
      recording.text().includes(`echo:alive:${last.rows} ${last.cols}`),
    );
  for (const { controller } of clients) expect(controller.snapshot().phase).toBe("ready");
});
