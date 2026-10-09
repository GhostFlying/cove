import { execFile, spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BOOTSTRAP_VERSION,
  LOCAL_PATHS,
  M0_CAPABILITIES,
  PROTOCOL_VERSION,
} from "@cove/protocol/bootstrap";
import { BASELINE_ENCODING, DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { createSessionClient, readRendezvous } from "../dist/session.js";
import { createRecordingView, waitFor } from "./recording-view.mjs";
import { createScreenView, parsePreview } from "./screen-view.mjs";
import { stopServer } from "./server-process.mjs";
import { QUERY_REPLIES_THEN, writeQueryProbe } from "./query-probe.mjs";
import { createTappedClient } from "./wire-tap.mjs";

// Every scenario drives the compiled `cove` executable, which spawns the compiled server.
const cli = resolve(import.meta.dirname, "../dist/main.js");
const encoder = new TextEncoder();

let fixture;

beforeEach(async () => {
  // Realpath the temp root: on macOS /var is a symlink and the server refuses a rendezvous
  // reached through a symlinked ancestor.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cove-cli-")));
  const rendezvous = join(directory, "state", "run", "rendezvous.json");
  // The CLI keeps its start lock under ~/.cove; point HOME at the temp directory so a
  // test never touches the user's real home.
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
  fixture = { directory, rendezvous, env, server, exited, clients: [] };
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

function cove(...args) {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { env: fixture.env, timeout: 20_000 },
      (error, stdout, stderr) => done({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

async function coveJson(...args) {
  const result = await cove(...args);
  if (result.code !== 0) throw new Error(`cove ${args.join(" ")} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function createRun(script) {
  return coveJson("terminal", "create", "--cwd", fixture.directory, "--", "/bin/sh", "-c", script);
}

async function connectClient() {
  const client = createSessionClient(fixture.record);
  fixture.clients.push(client);
  const connected = await client.connect();
  expect(connected.ok).toBe(true);
  return client;
}

async function attach(client, run, viewId, recording = createRecordingView()) {
  const opened = client.openTerminal({
    run,
    viewId,
    view: recording.view,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  expect(opened.ok).toBe(true);
  const controller = opened.value;
  expect(await controller.attach()).toMatchObject({ ok: true });
  return { controller, recording };
}

async function focusAndType(controller, text) {
  controller.setInputTarget(true, true);
  const grant = await controller.requestFocus();
  expect(grant).toMatchObject({ ok: true });
  await typeText(controller, text);
  return grant.value;
}

async function typeText(controller, text, source = "keyboard") {
  const sent = await controller.sendInput({ source, bytes: encoder.encode(text) });
  expect(sent).toMatchObject({ ok: true, value: { unknownBytes: 0, notSentBytes: 0 } });
}

const ECHO_LOOP = 'printf "loop-ready\\n"; while read line; do printf "echo:%s\\n" "$line"; done';

// One shell probe drives S3–S7 through typed commands. Typed lines are echoed by the tty, so
// every assertion matches the probe's reply format (`size-TAG:`, `seq-`, `burst-N-done`, ...)
// rather than the command text itself. `flood` pipes through cat so the PTY sees large
// writes and the flood arrives as a modest number of large output events.
const PROBE = String.raw`printf 'probe-ready\n'
while IFS= read -r line; do
  set -- $line
  case "$1" in
    size) printf 'size-%s:%s\n' "$2" "$(stty size)" ;;
    burst) i=$2; while [ "$i" -le "$3" ]; do printf 'seq-%05d\n' "$i"; i=$((i+1)); done; printf 'burst-%s-done\n' "$3" ;;
    flood) awk -v a="$2" -v b="$3" 'BEGIN { for (i = a; i <= b; i++) printf "flood-%06d-abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz\n", i }' | cat; printf 'flood-%s-done\n' "$3" ;;
    alt-enter) printf '\033[?1049h\033[H\033[2Jalt-screen-%s\n' "$2" ;;
    alt-exit) printf '\033[?1049lnormal-again-%s\n' "$2" ;;
    *) printf 'echo:%s\n' "$line" ;;
  esac
done`;

// The numbers of the `flood` lines in a stream, in the order they appear.
const floodNumbers = (text) =>
  [...text.matchAll(/flood-(\d{6})-abcdefghij/g)].map((match) => Number(match[1]));

// The first position where `numbers` is not exactly 1..count, or null when it is.
function firstOutOfSequence(numbers, count) {
  for (let index = 0; index < Math.max(numbers.length, count); index++)
    if (numbers[index] !== index + 1) return { index, found: numbers[index] };
  return null;
}

async function connectTapped() {
  const tapped = createTappedClient(fixture.record);
  fixture.clients.push(tapped.client);
  expect((await tapped.client.connect()).ok).toBe(true);
  return tapped;
}

// Bring a client back after its connection was lost: a new connection, then a fresh attach
// of the same controller, which installs a new baseline.
async function reattach(tapped, attached) {
  expect((await tapped.client.reconnect()).ok).toBe(true);
  expect(await attached.controller.attach()).toMatchObject({ ok: true });
}

function rejectionKind(reply) {
  expect(reply.metadata.type).toBe("error");
  return reply.metadata.error.kind;
}

// Every size change makes each attached controller run its own baseline recovery, and output
// reaching one client says nothing about another's. Before a handoff or a hand-built command,
// wait until this controller is ready at the expected geometry and epoch and the server has
// answered an applied-ack covering everything it applied; until then requestFocus() refuses
// locally and the server may answer RESYNC_REQUIRED instead of the rejection under test.
async function waitForSettled(label, { controller }, tap, geometry, epoch) {
  try {
    await settledWait(label, controller, tap, geometry, epoch);
  } catch (error) {
    // Metadata only: frame payloads may carry terminal content.
    const brief = ({ metadata: { type, requestId, appliedSeq, atSeq, seq, epoch, error } }) => ({
      type,
      requestId,
      appliedSeq,
      atSeq,
      seq,
      epoch,
      error,
    });
    const { phase, appliedSeq, appliedGeometry, appliedAuthority, controlEpoch, inputReady } =
      controller.snapshot();
    throw new Error(
      `${error.message}; expected ${JSON.stringify({ geometry, epoch })}; snapshot ${JSON.stringify(
        { phase, appliedSeq, appliedGeometry, appliedAuthority, controlEpoch, inputReady },
      )}; last outbound ${JSON.stringify(tap.outbound.slice(-8).map(brief))}; last inbound ${JSON.stringify(
        tap.inbound.slice(-12).map(brief),
      )}`,
      { cause: error },
    );
  }
}

async function settledWait(label, controller, tap, geometry, epoch) {
  await waitFor(`${label} to settle`, () => {
    const snapshot = controller.snapshot();
    if (
      snapshot.phase !== "ready" ||
      snapshot.appliedGeometry?.geometry.cols !== geometry.cols ||
      snapshot.appliedGeometry?.geometry.rows !== geometry.rows ||
      snapshot.appliedAuthority?.epoch !== epoch
    )
      return false;
    const acked = new Set(
      tap.inbound
        .filter((frame) => frame.metadata.type === "applied-ack-result")
        .map((frame) => frame.metadata.requestId),
    );
    return tap.outbound.some(
      ({ metadata }) =>
        metadata.type === "applied-ack" &&
        metadata.subscription.subscriptionId === snapshot.subscription.subscriptionId &&
        metadata.appliedSeq >= snapshot.appliedSeq &&
        acked.has(metadata.requestId),
    );
  });
}

// Compare the client's rendered screen with the server model's preview at the same seq. The
// caller makes the run quiescent first, so the two converge on one seq.
async function expectScreenMatchesServer(client, run, controller, screen) {
  let preview;
  await waitFor("a server preview at the client's applied seq", async () => {
    preview = await client.getPreview(run);
    expect(preview).toMatchObject({ ok: true, status: "transfer" });
    return preview.atSeq === controller.snapshot().appliedSeq;
  });
  const local = screen.screen();
  const server = parsePreview(preview);
  expect({ geometry: local.geometry, rows: local.rows, cursor: local.cursor }).toEqual(server);
  return { local, server };
}

async function createQueryProbe(mode) {
  const probe = await writeQueryProbe(fixture.directory, mode);
  const run = await coveJson("terminal", "create", "--cwd", fixture.directory, "--", ...probe.argv);
  return { run, ...probe };
}

describe("H1 operator scenarios over the compiled server and CLI", () => {
  test("S1 create from the CLI, attach, focus, type, see output and observe the exit code", async () => {
    const run = await createRun(
      'printf "s1-ready\\n"; read line; printf "got:%s\\n" "$line"; exit 7',
    );
    expect(run).toMatchObject({
      serverId: fixture.record.serverId,
      relayInstanceId: fixture.record.relayInstanceId,
    });
    const client = await connectClient();
    const { controller, recording } = await attach(client, run, "s1-view");
    await waitFor("the run's first output", () => recording.text().includes("s1-ready"));
    await focusAndType(controller, "from-s1\r");
    await waitFor("the run's reply", () => recording.text().includes("got:from-s1"));
    await waitFor("exit evidence", () => controller.snapshot().execution.status === "exited");
    expect(controller.snapshot().execution).toMatchObject({
      status: "exited",
      source: "run-event",
      exitCode: 7,
    });
    // The server records the exit before publishing it, so the record already agrees.
    expect(await coveJson("terminal", "get", run.runId)).toMatchObject({ status: "exited" });
  });

  test("S2 a PTY outlives every client and accepts input after a fresh client re-attaches", async () => {
    const run = await createRun(ECHO_LOOP);
    const first = await connectClient();
    const before = await attach(first, run, "s2-first");
    await waitFor("the first view's output", () => before.recording.text().includes("loop-ready"));
    await focusAndType(before.controller, "first-line\r");
    await waitFor("the first echo", () => before.recording.text().includes("echo:first-line"));
    expect((await before.controller.detach()).ok).toBe(true);
    before.controller.dispose();
    first.dispose();

    expect(await coveJson("terminal", "get", run.runId)).toMatchObject({ status: "live" });
    const second = await connectClient();
    const after = await attach(second, run, "s2-second");
    // The new view's baseline is the server model's screen, including pre-reconnect output.
    await waitFor("the recovered screen", () => after.recording.text().includes("echo:first-line"));
    await focusAndType(after.controller, "second-line\r");
    await waitFor("the second echo", () => after.recording.text().includes("echo:second-line"));
    expect(after.controller.snapshot().execution.status).not.toBe("exited");
  });

  test("S1 keys typed right after a click and during a theme change all reach the PTY in order", async () => {
    const run = await createRun(ECHO_LOOP);
    const client = await connectClient();
    // Emit focus and input intents the way the xterm view does: each deliberate key is
    // preceded by a focus intent, and nothing waits for the click's focus to be granted.
    const recording = createRecordingView();
    const focusListeners = new Set();
    const inputListeners = new Set();
    const subscribe = (set) => (listener) => {
      set.add(listener);
      return { dispose: () => set.delete(listener) };
    };
    const view = {
      ...recording.view,
      onFocusIntent: subscribe(focusListeners),
      onInputIntent: subscribe(inputListeners),
    };
    const opened = client.openTerminal({
      run,
      viewId: "s1-typing-view",
      view,
      initialAppearance: DEFAULT_APPEARANCE,
    });
    expect(opened.ok).toBe(true);
    const controller = opened.value;
    expect(await controller.attach()).toMatchObject({ ok: true });
    await waitFor("the run's first output", () => recording.text().includes("loop-ready"));
    const outcomes = [];
    controller.onInputOutcome((notice) => outcomes.push(notice.outcome));

    const line = "typed-fast-0123456789-abcdefghijklmnopqrstuvwxyz";
    const keys = [...`${line}\r`];
    const viewGeneration = controller.snapshot().viewGeneration;
    const geometry = recording.view.measureGrid();
    controller.setInputTarget(true, true);
    const focus = controller.requestFocus(geometry);
    keys.forEach((key, index) => {
      for (const listener of focusListeners)
        listener({ viewGeneration, focusSeq: index + 1, focused: true, geometry });
      for (const listener of inputListeners)
        listener({ viewGeneration, source: "keyboard", bytes: encoder.encode(key) });
    });
    expect(await focus).toMatchObject({ ok: true });
    await waitFor("every input outcome", () => outcomes.length === keys.length);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
    await waitFor("the echoed line", () => recording.text().includes(`echo:${line}`));
    // One click is one grant: per-key focus intents must not mint further epochs.
    expect(controller.snapshot().controlEpoch).toBe((await focus).value.epoch);

    // Change the theme mid-typing: keys typed while the granted appearance change settles are
    // held behind its result and covering ack, not rejected, and still arrive in order.
    const second = "typed-while-restyling-0123456789";
    const secondKeys = [...`${second}\r`];
    const half = secondKeys.length >> 1;
    let focusSeq = keys.length;
    const typeKey = (key) => {
      const applied = controller.snapshot().appliedGeometry.geometry;
      for (const listener of focusListeners)
        listener({ viewGeneration, focusSeq: ++focusSeq, focused: true, geometry: applied });
      for (const listener of inputListeners)
        listener({ viewGeneration, source: "keyboard", bytes: encoder.encode(key) });
    };
    secondKeys.slice(0, half).forEach(typeKey);
    const appearance = { ...DEFAULT_APPEARANCE, background: "1111/2222/3333" };
    const restyle = controller.updateAppearance(appearance);
    secondKeys.slice(half).forEach(typeKey);
    expect(await restyle).toMatchObject({ ok: true });
    const total = keys.length + secondKeys.length;
    await waitFor("every input outcome", () => outcomes.length === total);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
    await waitFor("the second echoed line", () => recording.text().includes(`echo:${second}`));
    await waitFor("the appearance fact", () =>
      recording.events.some((event) => event.type === "appearance"),
    );
    expect(controller.snapshot().controlEpoch).toBe((await focus).value.epoch);
  });

  test("S3 the PTY size follows the focus holder and the server rejects spectator and stale input", async () => {
    const run = await createRun(PROBE);
    const a = await connectTapped();
    const b = await connectTapped();
    const spectator = await connectTapped();
    // Each client measures a different grid, so the PTY size names whoever applied it.
    const A = await attach(a.client, run, "s3-a", createRecordingView({ cols: 100, rows: 30 }));
    const B = await attach(b.client, run, "s3-b", createRecordingView({ cols: 90, rows: 25 }));
    const C = await attach(
      spectator.client,
      run,
      "s3-c",
      createRecordingView({ cols: 110, rows: 35 }),
    );
    await waitFor("the probe on every view", () =>
      [A, B, C].every(({ recording }) => recording.text().includes("probe-ready")),
    );

    const aSize = { cols: 100, rows: 30 };
    const bSize = { cols: 90, rows: 25 };
    // Taking focus at a new grid makes every connection, the new holder's included, recover
    // its baseline. Each step waits for the clients it uses next to settle, so focus requests,
    // typed input and hand-built commands never race a recovery.
    const handoff = async (handle, tap, size, text) => {
      handle.controller.setInputTarget(true, true);
      const grant = await handle.controller.requestFocus();
      expect(grant).toMatchObject({ ok: true });
      await waitForSettled("the new holder", handle, tap, size, grant.value.epoch);
      await typeText(handle.controller, text);
      return grant.value;
    };
    const firstGrant = await handoff(A, a.tap, aSize, "size a1\r");
    await waitFor("A's size", () => C.recording.text().includes("size-a1:30 100"));
    await waitForSettled("B after A's resize", B, b.tap, aSize, firstGrant.epoch);
    const bGrant = await handoff(B, b.tap, bSize, "size b1\r");
    await waitFor("B's size", () => C.recording.text().includes("size-b1:25 90"));
    await waitForSettled("A after B's resize", A, a.tap, bSize, bGrant.epoch);
    const aGrant = await handoff(A, a.tap, aSize, "size a2\r");
    await waitFor("A's size again", () => C.recording.text().includes("size-a2:30 100"));
    expect(aGrant.epoch).toBeGreaterThan(bGrant.epoch);
    await waitForSettled("B after A's second resize", B, b.tap, aSize, aGrant.epoch);
    await waitForSettled("the spectator", C, spectator.tap, aSize, aGrant.epoch);

    // A spectator cannot resize: locally it holds no grant, and a hand-built resize under the
    // current epoch is refused by the server.
    expect(await C.controller.requestResize({ cols: 110, rows: 35 })).toMatchObject({ ok: false });
    const cRef = C.controller.snapshot().subscription;
    const spectatorResize = await spectator.tap.inject({
      type: "resize",
      run: cRef.run,
      subscription: cRef,
      epoch: aGrant.epoch,
      geometry: { cols: 110, rows: 35 },
    });
    expect(rejectionKind(spectatorResize)).toBe("STALE_CONTROL");

    // Spectator input under the current epoch, and B's input under its superseded epoch, are
    // refused and never written.
    const spectatorInput = await spectator.tap.inject(
      { type: "input", run: cRef.run, subscription: cRef, epoch: aGrant.epoch, inputSeq: 1 },
      encoder.encode("spectator-bytes\r"),
    );
    expect(rejectionKind(spectatorInput)).toBe("STALE_CONTROL");
    const bRef = B.controller.snapshot().subscription;
    const bInputs = b.tap.outbound.filter((frame) => frame.metadata.type === "input");
    const staleInput = await b.tap.inject(
      {
        type: "input",
        run: bRef.run,
        subscription: bRef,
        epoch: bGrant.epoch,
        inputSeq: Math.max(...bInputs.map((frame) => frame.metadata.inputSeq)) + 1,
      },
      encoder.encode("stale-bytes\r"),
    );
    expect(rejectionKind(staleInput)).toBe("STALE_CONTROL");

    // The PTY applies inputs in order, so once the holder's later line is echoed any
    // accepted spectator or stale bytes would already be visible.
    await typeText(A.controller, "size a3\r");
    await waitFor("the holder's later line", () => C.recording.text().includes("size-a3:30 100"));
    for (const { recording } of [A, B, C]) {
      expect(recording.text()).not.toContain("spectator-bytes");
      expect(recording.text()).not.toContain("stale-bytes");
    }
    // The spectator never sent input of its own.
    expect(spectator.tap.sentInput(cRef.subscriptionId)).toBe("");
  });

  test("S4 the server answers DA and CPR exactly once while two clients watch", async () => {
    const probe = await createQueryProbe("wait");
    const holder = await connectTapped();
    const watcher = await connectTapped();
    // Both views parse with xterm, which would emit its own DA/CPR replies; a client must
    // never forward those, so the process sees only the server model's replies.
    const H = await attach(holder.client, probe.run, "s4-holder", createScreenView());
    const W = await attach(watcher.client, probe.run, "s4-watcher", createScreenView());
    await waitFor("the probe on both views", () =>
      [H, W].every(({ recording }) => recording.text().includes("query-probe-ready")),
    );
    await focusAndType(H.controller, "go\r");
    await waitFor("the probe to see both replies", probe.seen);
    // Both views have parsed the queries, which precede this line in the output.
    await waitFor("both views to parse the queries", () =>
      [H, W].every(({ recording }) => recording.text().includes("replies-seen")),
    );
    // Real keyboard and paste input still arrives, after the replies and unaltered.
    await typeText(H.controller, "kbd-1");
    await typeText(H.controller, "paste-2", "paste");
    await typeText(H.controller, "done\r");
    expect(await probe.received()).toMatch(QUERY_REPLIES_THEN("kbd-1paste-2"));
    // On the wire, the clients sent only what was typed.
    const holderRef = H.controller.snapshot().subscription;
    expect(holder.tap.sentInput(holderRef.subscriptionId)).toBe("go\rkbd-1paste-2done\r");
    expect(watcher.tap.outbound.filter((frame) => frame.metadata.type === "input")).toEqual([]);
  });

  test("S4 the server answers DA and CPR exactly once with no client attached", async () => {
    const probe = await createQueryProbe("now");
    // No client is connected while the probe asks.
    await waitFor("the probe to see both replies", probe.seen);
    const holder = await connectTapped();
    const H = await attach(holder.client, probe.run, "s4-late", createScreenView());
    // The baseline carries the earlier screen; installing it must not answer again.
    await waitFor("the recovered screen", () => H.recording.text().includes("replies-seen"));
    await focusAndType(H.controller, "done\r");
    expect(await probe.received()).toMatch(QUERY_REPLIES_THEN(""));
    expect(holder.tap.sentInput(H.controller.snapshot().subscription.subscriptionId)).toBe(
      "done\r",
    );
  });

  test("S5 a reconnecting client recovers from a baseline plus increments with nothing lost or duplicated", async () => {
    const run = await createRun(PROBE);
    const a = await connectTapped();
    const b = await connectTapped();
    const A = await attach(a.client, run, "s5-a", createScreenView());
    const B = await attach(b.client, run, "s5-b", createScreenView());
    await waitFor("the probe on both views", () =>
      [A, B].every(({ recording }) => recording.text().includes("probe-ready")),
    );
    await focusAndType(B.controller, "burst 1 100\r");
    await waitFor("the first burst on A", () => A.recording.text().includes("burst-100-done"));

    // A loses its connection; output continues while it is away.
    a.tap.disconnect();
    await waitFor("A to notice the loss", () => A.controller.snapshot().phase === "unavailable");
    await typeText(B.controller, "burst 101 400\r");
    await waitFor("the burst A missed", () => B.recording.text().includes("burst-400-done"));
    const missedSeq = B.controller.snapshot().appliedSeq;

    // Reconnect while more output is being produced, so the baseline lands mid-stream.
    expect((await a.client.reconnect()).ok).toBe(true);
    await typeText(B.controller, "burst 401 700\r");
    expect(await A.controller.attach()).toMatchObject({ ok: true });
    await waitFor("the overlapping burst on A", () =>
      A.recording.text().includes("burst-700-done"),
    );
    // And output that certainly follows the new baseline.
    await typeText(B.controller, "burst 701 720\r");
    await waitFor("the last burst on both views", () =>
      [A, B].every(({ recording }) => recording.text().includes("burst-720-done")),
    );

    // The new baseline covers what A missed, and increments followed it.
    const baselines = A.recording.events.filter((event) => event.type === "baseline-start");
    expect(baselines).toHaveLength(2);
    expect(baselines[1].atSeq).toBeGreaterThanOrEqual(missedSeq);
    const afterBaseline = A.recording.events.slice(A.recording.events.indexOf(baselines[1]));
    expect(afterBaseline.some((event) => event.type === "output")).toBe(true);

    // Every numbered line is present exactly once and in order, matching the client that
    // never disconnected.
    const numbered = (screen) => screen.normalLines().filter((line) => /^seq-\d{5}$/.test(line));
    const expected = Array.from(
      { length: 720 },
      (_, index) => `seq-${String(index + 1).padStart(5, "0")}`,
    );
    expect(numbered(A.recording)).toEqual(expected);
    expect(numbered(B.recording)).toEqual(expected);
    await expectScreenMatchesServer(a.client, run, A.controller, A.recording);
  });

  test("S6 reconnecting inside and after the alternate screen restores the right buffer", async () => {
    const run = await createRun(PROBE);
    const a = await connectTapped();
    const b = await connectTapped();
    const A = await attach(a.client, run, "s6-a", createScreenView());
    const B = await attach(b.client, run, "s6-b", createScreenView());
    await waitFor("the probe on both views", () =>
      [A, B].every(({ recording }) => recording.text().includes("probe-ready")),
    );
    await focusAndType(B.controller, "burst 1 30\r");
    await waitFor("normal-screen output on A", () => A.recording.text().includes("burst-30-done"));
    await typeText(B.controller, "alt-enter one\r");
    await waitFor("A in the alternate screen", () => A.recording.screen().buffer === "alternate");

    // Disconnect inside the alternate screen and miss output drawn there.
    a.tap.disconnect();
    await waitFor("A to notice the loss", () => A.controller.snapshot().phase === "unavailable");
    await typeText(B.controller, "inside-alt\r");
    await waitFor("output inside the alternate screen", () =>
      B.recording.screen().rows.includes("echo:inside-alt"),
    );
    await reattach(a, A);
    await waitFor("the recovered alternate screen", () =>
      A.recording.screen().rows.includes("echo:inside-alt"),
    );
    const inside = await expectScreenMatchesServer(a.client, run, A.controller, A.recording);
    expect(inside.local.buffer).toBe("alternate");
    expect(inside.local.rows).toContain("alt-screen-one");
    expect(inside.local.rows.some((row) => row.startsWith("seq-"))).toBe(false);
    expect(inside.local).toEqual(B.recording.screen());

    // Leaving the alternate screen restores the normal buffer on the recovered view.
    await typeText(B.controller, "alt-exit one\r");
    await waitFor("A back on the normal screen", () =>
      A.recording.screen().rows.includes("normal-again-one"),
    );
    const left = await expectScreenMatchesServer(a.client, run, A.controller, A.recording);
    expect(left.local.buffer).toBe("normal");
    expect(left.local.rows).toContain("seq-00030");
    expect(left.local).toEqual(B.recording.screen());

    // Reconnecting after the exit shows the normal screen, with nothing of the alternate one.
    a.tap.disconnect();
    await waitFor("A to notice the loss", () => A.controller.snapshot().phase === "unavailable");
    await reattach(a, A);
    await waitFor("the recovered normal screen", () =>
      A.recording.screen().rows.includes("normal-again-one"),
    );
    const after = await expectScreenMatchesServer(a.client, run, A.controller, A.recording);
    expect(after.local.buffer).toBe("normal");
    expect(after.local.rows).toContain("seq-00030");
    expect(after.local.rows).not.toContain("alt-screen-one");
    expect(after.local.rows).not.toContain("echo:inside-alt");
    expect(after.local).toEqual(B.recording.screen());
  });

  test("S7 the server retires a slow client's subscription while a healthy client keeps working", async () => {
    const run = await createRun(PROBE);
    const slow = await connectTapped();
    const healthy = await connectTapped();
    const S = await attach(slow.client, run, "s7-slow", createScreenView());
    const H = await attach(healthy.client, run, "s7-healthy", createRecordingView());
    await waitFor("the probe on both views", () =>
      [S, H].every(({ recording }) => recording.text().includes("probe-ready")),
    );
    await focusAndType(H.controller, "before-flood\r");
    await waitFor("the first echo on the slow view", () =>
      S.recording.text().includes("echo:before-flood"),
    );

    // The slow client stops consuming: its frames are held at the transport port, so it
    // neither parses nor acknowledges, and the server's backlog for it grows past the limit.
    const evicted = S.controller.snapshot().subscription;
    slow.tap.pause();
    const slowAppliedSeq = S.controller.snapshot().appliedSeq;
    await typeText(H.controller, "flood 1 20000\r");
    // Probe the server with a hand-built acknowledgement on the old subscription: once the
    // server has retired it, it refuses it with RESYNC_REQUIRED, whatever the client does.
    await waitFor(
      "the server to retire the slow subscription",
      async () => {
        const ack = await slow.tap.inject({
          type: "applied-ack",
          run: evicted.run,
          subscription: evicted,
          appliedSeq: slowAppliedSeq,
        });
        return ack.metadata.type === "error" && ack.metadata.error.kind === "RESYNC_REQUIRED";
      },
      30_000,
    );
    const healthyAtEviction = floodNumbers(H.recording.text()).length;
    await waitFor(
      "the first flood on the healthy view",
      () => H.recording.text().includes("flood-20000-done"),
      30_000,
    );

    // While the slow client is still held, the healthy client types, produces more output,
    // refocuses and keeps receiving every line.
    await typeText(H.controller, "during-eviction\r");
    await typeText(H.controller, "flood 20001 25000\r");
    await waitFor(
      "the whole flood on the healthy view",
      () => H.recording.text().includes("flood-25000-done"),
      30_000,
    );
    expect(H.recording.text()).toContain("echo:during-eviction");
    await focusAndType(H.controller, "refocused\r");
    await waitFor("input after refocusing", () => H.recording.text().includes("echo:refocused"));
    expect(slow.tap.paused).toBe(true);
    expect(S.controller.snapshot().appliedSeq).toBe(slowAppliedSeq);
    const flood = floodNumbers(H.recording.text());
    expect(flood.length).toBeGreaterThan(healthyAtEviction);
    expect(firstOutOfSequence(flood, 25_000)).toBeNull();
    // The server sent the retired subscription nothing produced after the retirement.
    const evictedOutput = slow.tap.inbound
      .filter(
        (frame) =>
          frame.metadata.type === "run-event" &&
          frame.metadata.subscription.subscriptionId === evicted.subscriptionId,
      )
      .map((frame) => new TextDecoder().decode(frame.payload))
      .join("");
    expect(evictedOutput).not.toContain("echo:during-eviction");
    expect(Math.max(0, ...floodNumbers(evictedOutput))).toBeLessThanOrEqual(20_000);
    // terminal.get reads the server's periodically refreshed run record, so wait for it.
    const holder = H.controller.snapshot().subscription;
    await waitFor("the run record to name the healthy holder", async () => {
      const record = await coveJson("terminal", "get", run.runId);
      return record.controlHolder?.subscriptionId === holder.subscriptionId;
    });

    // When the slow client catches up, its stale subscription is refused and it attaches
    // again from a new baseline.
    await slow.tap.resume();
    await waitFor(
      "the slow client to see the eviction",
      () => S.controller.snapshot().phase === "unavailable",
      20_000,
    );
    // The client's own command on the evicted subscription was refused with RESYNC_REQUIRED.
    const evictedRequests = new Set(
      slow.tap.outbound
        .filter((frame) => frame.metadata.subscription?.subscriptionId === evicted.subscriptionId)
        .map((frame) => frame.metadata.requestId),
    );
    expect(
      slow.tap.inbound.some(
        (frame) =>
          evictedRequests.has(frame.metadata.requestId) &&
          frame.metadata.type === "error" &&
          frame.metadata.error.kind === "RESYNC_REQUIRED",
      ),
    ).toBe(true);
    // The client cannot release the evicted subscription, so it retires its connection;
    // it reconnects and attaches from a new baseline.
    await waitFor(
      "the slow client to drop its connection",
      () => slow.client.snapshot().status !== "connected",
    );
    await reattach(slow, S);
    expect(S.controller.snapshot().subscription.subscriptionId).not.toBe(evicted.subscriptionId);
    expect(S.recording.events.filter((event) => event.type === "baseline-start")).toHaveLength(2);
    await waitFor("the new baseline", () => S.recording.screen().rows.includes("echo:refocused"));
    await typeText(H.controller, "after-eviction\r");
    await waitFor("output after the new baseline", () =>
      S.recording.screen().rows.includes("echo:after-eviction"),
    );
    await expectScreenMatchesServer(slow.client, run, S.controller, S.recording);
  });

  test("S8 a wrong protocol version is refused on both channels without touching a live PTY", async () => {
    const run = await createRun(ECHO_LOOP);
    const { record } = fixture;
    for (const protocolVersion of [PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1]) {
      const offer = {
        type: "cove-bootstrap",
        bootstrapVersion: BOOTSTRAP_VERSION,
        expectedServerId: record.serverId,
        expectedRelayInstanceId: record.relayInstanceId,
        protocolVersion,
        buildVersion: "s8-client",
        capabilities: [...M0_CAPABILITIES],
        profiles: [PROFILE],
        encodings: [BASELINE_ENCODING],
      };
      const http = await postBootstrap(record, offer, protocolVersion);
      expect(http.status).toBeGreaterThanOrEqual(400);
      expect(http.body).toMatchObject({
        type: "cove-bootstrap-error",
        kind: "PROTOCOL_MISMATCH",
        supportedVersions: { protocol: [PROTOCOL_VERSION] },
      });
      const terminal = await terminalBootstrap(record, { ...offer, secret: record.secret });
      expect(terminal.messages).toHaveLength(1);
      expect(terminal.messages[0]).toMatchObject({
        type: "cove-bootstrap-error",
        kind: "PROTOCOL_MISMATCH",
        supportedVersions: { protocol: [PROTOCOL_VERSION] },
      });
      expect(terminal.closed).toBe(true);
    }

    expect(await coveJson("terminal", "get", run.runId)).toMatchObject({ status: "live" });
    const client = await connectClient();
    const { controller, recording } = await attach(client, run, "s8-view");
    await waitFor("the run's output", () => recording.text().includes("loop-ready"));
    await focusAndType(controller, "still-alive\r");
    await waitFor("the echo", () => recording.text().includes("echo:still-alive"));
  });
});

// Raw node:http rather than fetch: Node's fetch marks itself as a browser request
// (Sec-Fetch-Mode: cors), which the server rightly rejects without an approved Origin.
function postBootstrap(record, offer, protocolVersion) {
  const body = JSON.stringify(offer);
  return new Promise((done, fail) => {
    const req = request(
      new URL(LOCAL_PATHS.bootstrap, record.endpoint),
      {
        method: "POST",
        agent: false,
        timeout: 10_000,
        headers: {
          Authorization: `Bearer ${record.secret}`,
          "Content-Type": "application/json",
          "Cove-Protocol": String(protocolVersion),
          "Cove-Server-Id": record.serverId,
          "Cove-Instance-Id": record.relayInstanceId,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => done({ status: res.statusCode, body: JSON.parse(text) }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("bootstrap request timed out")));
    req.on("error", fail);
    req.end(body);
  });
}

function terminalBootstrap(record, message) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(`${record.endpoint.replace("http", "ws")}${LOCAL_PATHS.terminal}`);
    const messages = [];
    const timer = setTimeout(() => {
      socket.close();
      fail(new Error("terminal bootstrap did not close"));
    }, 10_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify(message)));
    socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data)));
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      done({ messages, closed: true });
    });
  });
}
