import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { PIPE_ROUTE_CONTROL_COMMANDS } from "@cove/protocol/pipe";
import { readRendezvous } from "../dist/session.js";
import { createRecordingView, waitFor } from "./recording-view.mjs";
import { stopServer } from "./server-process.mjs";
import { createTappedClient } from "./wire-tap.mjs";
import { isolatedEnv } from "./test-env.mjs";

// Regression for issue #96. Every streaming subscription keeps one applied-ack in flight, and
// the server has a single worker whose route-control window is PIPE_ROUTE_CONTROL_COMMANDS
// commands across every subscription. One client watching more output-heavy terminals than
// that window used to get BUSY for the surplus acks, and the client ended each such
// subscription for good: a probe with eight streams kept three. Here one client subscribes to
// eight terminals that all print paced, numbered lines at the same time; every subscription
// must stay ready and receive every line exactly once, in order, with contiguous event seqs.
const cli = resolve(import.meta.dirname, "../dist/main.js");
const STREAMS = 8;
const BATCHES = 60;
const BATCH_LINES = 64;
const PAD = "y".repeat(48);

let fixture;

beforeEach(async () => {
  // Realpath the temp root: macOS /var is a symlink and the server refuses a symlinked
  // rendezvous ancestor. isolatedEnv points HOME and COVE_HOME there so a test never touches
  // the user's real home or data directory.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cove-acks-")));
  const rendezvous = join(directory, "state", "run", "rendezvous.json");
  const env = isolatedEnv(directory, { COVE_RENDEZVOUS: rendezvous });
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

// Each terminal waits on its own FIFO, so every subscription is attached before any output,
// then prints BATCHES batches of BATCH_LINES numbered lines (about 64 KiB/s per terminal).
function producer(stream, gate) {
  const batch =
    `awk -v b="$b" 'BEGIN{for(i=0;i<${BATCH_LINES};i++)` +
    `printf "s${stream}-%06d-${PAD}\\n", b*${BATCH_LINES}+i}'`;
  return (
    `stty -echo; printf "ready-${stream}\\n"; IFS= read -r token < '${gate}'; b=0; ` +
    `while [ "$b" -lt ${BATCHES} ]; do ${batch}; b=$((b+1)); sleep 0.05; done; ` +
    `printf "done-${stream}\\n"; IFS= read -r never`
  );
}

// Records the run-event seqs a subscription applies, beside the recording view's text.
function seqRecordingView() {
  const recording = createRecordingView();
  const seqs = [];
  const applyEvent = recording.view.applyEvent;
  recording.view.applyEvent = async (event, payload) => {
    seqs.push(event.seq);
    await applyEvent(event, payload);
  };
  return { ...recording, seqs };
}

test("one client keeps eight streaming subscriptions beyond the route-control window", async () => {
  expect(STREAMS).toBeGreaterThan(PIPE_ROUTE_CONTROL_COMMANDS);
  // The tap records the server's replies, so the test can see each final ACK accepted.
  const { client, tap } = createTappedClient(fixture.record);
  fixture.clients.push(client);
  expect((await client.connect()).ok).toBe(true);
  const streams = [];
  for (let stream = 0; stream < STREAMS; stream++) {
    const gate = join(fixture.directory, `gate-${stream}`);
    execFileSync("mkfifo", [gate]);
    const run = await coveJson(
      "terminal",
      "create",
      "--cwd",
      fixture.directory,
      "--",
      "/bin/sh",
      "-c",
      producer(stream, gate),
    );
    const recording = seqRecordingView();
    const opened = client.openTerminal({
      run,
      viewId: `acks-${stream}`,
      view: recording.view,
      initialAppearance: DEFAULT_APPEARANCE,
    });
    expect(opened.ok).toBe(true);
    const controller = opened.value;
    expect(await controller.attach()).toMatchObject({ ok: true });
    streams.push({ stream, gate, controller, recording });
  }
  for (const { stream, recording } of streams)
    await waitFor(`terminal ${stream} to be ready`, () =>
      recording.text().includes(`ready-${stream}`),
    );
  const firstLiveSeq = streams.map(({ recording }) => recording.seqs.length);
  // Opening a FIFO for writing completes once its producer is reading it.
  await Promise.all(streams.map(({ gate }) => writeFile(gate, "go\n")));

  const lines = (stream, text) =>
    text.match(new RegExp(`s${stream}-\\d{6}-${PAD}(?=\\r)`, "g")) ?? [];
  const describe = () =>
    JSON.stringify(
      streams.map(({ stream, controller, recording }) => {
        const snapshot = controller.snapshot();
        return {
          stream,
          phase: snapshot.phase,
          error: snapshot.error,
          appliedSeq: snapshot.appliedSeq,
          lines: lines(stream, recording.text()).length,
        };
      }),
    );
  try {
    await waitFor(
      "every stream to finish",
      () =>
        streams.every(
          ({ stream, controller, recording }) =>
            recording.text().includes(`done-${stream}`) || controller.snapshot().phase !== "ready",
        ),
      60_000,
    );
  } catch (error) {
    throw new Error(`${error.message}; ${describe()}`, { cause: error });
  }

  // Not one subscription was lost to a refused ack.
  const phases = streams.map(({ controller }) => controller.snapshot().phase);
  if (phases.some((phase) => phase !== "ready")) throw new Error(`lost: ${describe()}`);
  const total = BATCHES * BATCH_LINES;
  for (const [index, { stream, controller, recording }] of streams.entries()) {
    const received = lines(stream, recording.text());
    expect(received).toHaveLength(total);
    received.forEach((line, at) =>
      expect(line.slice(0, 8 + String(stream).length)).toBe(
        `s${stream}-${String(at).padStart(6, "0")}`,
      ),
    );
    // Live events arrived exactly once and in order on each subscription.
    const seqs = recording.seqs.slice(firstLiveSeq[index]);
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs.slice(1)).toEqual(seqs.slice(0, -1).map((seq) => seq + 1));
    // The ACK covering the last event was sent and the server accepted it. The client's own
    // appliedSeq advances before its ACK is even sent (a newer one may wait folded behind
    // the one in flight), so only the server's reply proves the boundary.
    const { subscriptionId } = controller.snapshot().subscription;
    await waitFor(`terminal ${stream}'s last ack accepted`, () =>
      tap.inbound.some(
        ({ metadata }) =>
          metadata.type === "applied-ack-result" &&
          metadata.subscription.subscriptionId === subscriptionId &&
          metadata.appliedSeq === recording.seqs.at(-1),
      ),
    );
  }
  for (const { controller } of streams)
    expect(await controller.detach()).toMatchObject({ ok: true });
}, 120_000);
