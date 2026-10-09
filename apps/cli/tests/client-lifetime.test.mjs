import { execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { createSessionClient, readRendezvous } from "../dist/session.js";
import { createRecordingView, waitFor } from "./recording-view.mjs";
import { stopServer } from "./server-process.mjs";
import { createTappedClient } from "./wire-tap.mjs";

// Regressions for client state that outlived its use on one long-lived connection: every
// settled preview and every retired subscription ref used to be remembered until the
// connection closed and checked against a fixed 256-entry cap, so a page that polls
// previews or reopens terminals stopped working on that connection. A refused detach of a
// subscription the server had already retired also tore down the whole healthy connection.
// Each loop below crosses the old cap on a single connection.
const cli = resolve(import.meta.dirname, "../dist/main.js");
const OLD_CAP = 256;
const CYCLES = OLD_CAP + 44;
const encoder = new TextEncoder();

let fixture;

beforeEach(async () => {
  // Realpath the temp root: macOS /var is a symlink and the server refuses a rendezvous
  // reached through a symlinked ancestor. HOME keeps the CLI start lock out of ~/.cove.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cove-lifetime-")));
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

function createRun(script) {
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      [cli, "terminal", "create", "--cwd", fixture.directory, "--", "/bin/sh", "-c", script],
      { env: fixture.env, timeout: 20_000 },
      (error, stdout, stderr) =>
        error
          ? fail(new Error(`cove terminal create failed: ${stderr}`))
          : done(JSON.parse(stdout)),
    );
  });
}

async function connectClient() {
  const client = createSessionClient(fixture.record);
  fixture.clients.push(client);
  expect((await client.connect()).ok).toBe(true);
  return client;
}

async function connectTapped() {
  const tapped = createTappedClient(fixture.record);
  fixture.clients.push(tapped.client);
  expect((await tapped.client.connect()).ok).toBe(true);
  return tapped;
}

function open(client, run, viewId, recording = createRecordingView()) {
  const opened = client.openTerminal({
    run,
    viewId,
    view: recording.view,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  expect(opened.ok).toBe(true);
  return { controller: opened.value, recording };
}

// The server may refuse a focus with BUSY when it is momentarily out of command capacity, as
// it can be on a loaded machine. That refusal is definite (not accepted), and the protocol's
// answer is to back off and retry, which is what a client page would do; anything else fails.
async function takeFocus(controller) {
  for (let attempt = 0; ; attempt++) {
    const focus = await controller.requestFocus();
    const busy =
      !focus.ok && focus.error.kind === "BUSY" && focus.error.acceptance === "not-accepted";
    if (!busy || attempt === 20) return focus;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function typeText(controller, text) {
  const sent = await controller.sendInput({ source: "keyboard", bytes: encoder.encode(text) });
  expect(sent).toMatchObject({ ok: true, value: { unknownBytes: 0, notSentBytes: 0 } });
}

// The flood is far more than one subscription's credit (256 KiB) plus its share of the
// connection's backlog (1 MiB), so a held subscription is always retired.
const ECHO_LOOP = `printf 'loop-ready\\n'
while IFS= read -r line; do
  case "$line" in
    flood) awk 'BEGIN { for (i = 1; i <= 60000; i++) printf "flood-%06d-abcdefghijklmnopqrstuvwxyz0123456789\\n", i }' | cat; printf 'flood-done\\n' ;;
    *) printf 'echo:%s\\n' "$line" ;;
  esac
done`;

test("more previews than the old cap on one connection all succeed", async () => {
  const run = await createRun("printf 'preview-me\\n'; exec cat >/dev/null");
  const client = await connectClient();
  let version;
  for (let index = 0; index < CYCLES; index++) {
    const preview = await client.getPreview(run, version);
    if (!preview.ok) throw new Error(`preview ${index} failed: ${JSON.stringify(preview)}`);
    version = preview.version;
  }
  expect(client.snapshot().status).toBe("connected");
}, 180_000);

test("more attach/detach cycles than the old cap on one connection all succeed", async () => {
  const run = await createRun("printf 'cycle-me\\n'; exec cat >/dev/null");
  const client = await connectClient();
  const { controller } = open(client, run, "cycler");
  for (let index = 0; index < CYCLES; index++) {
    const attached = await controller.attach();
    if (!attached.ok) throw new Error(`attach ${index} failed: ${JSON.stringify(attached)}`);
    const detached = await controller.detach();
    if (!detached.ok) throw new Error(`detach ${index} failed: ${JSON.stringify(detached)}`);
  }
  expect(client.snapshot().status).toBe("connected");
  controller.dispose();
}, 180_000);

test("a second terminal on the connection keeps working after the server retires the first", async () => {
  // Separate runs keep B's run idle while A floods, so A's backlog alone fills its share of
  // the shared connection and the server retires A, not B.
  const runA = await createRun(ECHO_LOOP);
  const runB = await createRun(ECHO_LOOP);
  const tapped = await connectTapped();
  const A = open(tapped.client, runA, "retired");
  const B = open(tapped.client, runB, "healthy");
  expect(await A.controller.attach()).toMatchObject({ ok: true });
  expect(await B.controller.attach()).toMatchObject({ ok: true });
  await waitFor("the loop on both views", () =>
    [A, B].every(({ recording }) => recording.text().includes("loop-ready")),
  );
  for (const { controller } of [A, B]) {
    controller.setInputTarget(true, true);
    expect(await takeFocus(controller)).toMatchObject({ ok: true });
  }

  // Hold only A's events, so A neither parses nor acknowledges them, then make A's run flood.
  // The input's reply is not held, so A can still type; the server's backlog for A then grows
  // until it retires A.
  const retired = A.controller.snapshot().subscription;
  const appliedSeq = A.controller.snapshot().appliedSeq;
  const subscriptionOf = (frame) =>
    frame.metadata.subscription?.subscriptionId ??
    frame.metadata.descriptor?.subscription?.subscriptionId;
  tapped.tap.pause((frame) => frame.kind === 3 && subscriptionOf(frame) === retired.subscriptionId);
  await typeText(A.controller, "flood\r");
  await waitFor(
    "the server to retire the held subscription",
    async () => {
      const ack = await tapped.tap.inject({
        type: "applied-ack",
        run: retired.run,
        subscription: retired,
        appliedSeq,
      });
      return ack.metadata.type === "error" && ack.metadata.error.kind === "RESYNC_REQUIRED";
    },
    60_000,
  );
  await typeText(B.controller, "during-retirement\r");
  await waitFor("input on the healthy view while the other is held", () =>
    B.recording.text().includes("echo:during-retirement"),
  );

  // A catches up: its next command on the retired subscription is refused, it fails, and its
  // detach of the retired subscription is refused too.
  await tapped.tap.resume();
  await waitFor(
    "the retired view to fail",
    () => A.controller.snapshot().phase === "unavailable",
    30_000,
  );
  const detachIds = () =>
    new Set(
      tapped.tap.outbound
        .filter(
          (frame) =>
            frame.metadata.type === "detach" &&
            frame.metadata.subscription.subscriptionId === retired.subscriptionId,
        )
        .map((frame) => frame.metadata.requestId),
    );
  await waitFor("the refusal of the retired subscription's detach", () => {
    const ids = detachIds();
    return tapped.tap.inbound.some(
      (frame) =>
        ids.has(frame.metadata.requestId) &&
        frame.metadata.type === "error" &&
        frame.metadata.error.acceptance === "not-accepted",
    );
  });

  // The connection and the other terminal on it are untouched.
  expect(tapped.client.snapshot().status).toBe("connected");
  expect(B.controller.snapshot().phase).toBe("ready");
  await typeText(B.controller, "after-retirement\r");
  await waitFor("input on the healthy view after the retirement", () =>
    B.recording.text().includes("echo:after-retirement"),
  );
  // The retired terminal attaches again on the same connection from a new baseline and
  // takes input again.
  expect(await A.controller.attach()).toMatchObject({ ok: true });
  expect(A.controller.snapshot().subscription.subscriptionId).not.toBe(retired.subscriptionId);
  expect(await takeFocus(A.controller)).toMatchObject({ ok: true });
  await typeText(A.controller, "back-again\r");
  await waitFor("input on the reattached view", () =>
    A.recording.text().includes("echo:back-again"),
  );
  expect(tapped.client.snapshot().status).toBe("connected");
  A.controller.dispose();
  B.controller.dispose();
}, 180_000);
