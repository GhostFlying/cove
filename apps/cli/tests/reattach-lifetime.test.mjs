import { execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  BOOTSTRAP_VERSION,
  LOCAL_PATHS,
  M0_CAPABILITIES,
  PROTOCOL_VERSION,
} from "@cove/protocol/bootstrap";
import { BASELINE_ENCODING, DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import {
  TERMINAL_FRAME_CLASSES,
  createTerminalDecoder,
  encodeTerminalFrame,
} from "@cove/protocol/terminal";
import { createSessionClient, readRendezvous } from "../dist/session.js";
import { createRecordingView, waitFor } from "./recording-view.mjs";
import { stopServer } from "./server-process.mjs";

// Regression: the server retained retired subscription state until the connection, the
// run or the worker went away. The worker pipe refused every subscribe with BUSY after
// maxRuns × subscriptionsPerConnection (2048) lifetime attaches, one connection was refused
// attach after 4096 (each retired route kept its record and lease until close), and one run
// refused new controlling subscriptions after authenticatedSockets ×
// subscriptionsPerConnection (512) of them (each retired control counter was kept until the
// run was released). A long-lived terminal reattached through reloads and reconnects
// reaches all three.
const cli = resolve(import.meta.dirname, "../dist/main.js");
const OLD_ATTACH_CAP = 4096;
const OLD_CONTROL_CAP = 32 * 16;

let fixture;

beforeEach(async () => {
  // Realpath the temp root: macOS /var is a symlink and the server refuses a rendezvous
  // reached through a symlinked ancestor. HOME keeps the CLI start lock out of ~/.cove.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cove-reattach-")));
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

async function createRun(script) {
  const result = await cove(
    "terminal",
    "create",
    "--cwd",
    fixture.directory,
    "--",
    "/bin/sh",
    "-c",
    script,
  );
  if (result.code !== 0) throw new Error(`cove terminal create failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function connectClient() {
  const client = createSessionClient(fixture.record);
  fixture.clients.push(client);
  expect((await client.connect()).ok).toBe(true);
  return client;
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
  return opened.value;
}

// The public client refuses attach after 256 retired subscriptions on one connection (a
// client-side window handled separately), so the per-connection server cap is crossed with a
// minimal raw terminal connection that only correlates command results.
async function rawConnection(record) {
  const socket = new WebSocket(`${record.endpoint.replace("http", "ws")}${LOCAL_PATHS.terminal}`);
  socket.binaryType = "arraybuffer";
  fixture.clients.push({ dispose: () => socket.close() });
  const decoder = createTerminalDecoder();
  const text = new TextDecoder("utf-8", { fatal: true });
  const waiters = new Map();
  let bootstrap;
  let failure;
  socket.addEventListener("close", () => {
    failure = new Error("raw terminal connection closed");
    for (const waiter of waiters.values()) waiter.fail(failure);
    waiters.clear();
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      bootstrap = JSON.parse(event.data);
      return;
    }
    let rest = new Uint8Array(event.data);
    while (rest.byteLength) {
      const read = decoder.read(rest);
      if (read.status === "error") throw new Error(`invalid server frame ${read.error.code}`);
      rest = rest.subarray(read.consumedBytes);
      for (const frame of read.frames) {
        const metadata = JSON.parse(text.decode(frame.metadata));
        // Only results and errors settle a command; baseline and run events are dropped.
        if (metadata.type !== "error" && !metadata.type.endsWith("-result")) continue;
        const waiter = waiters.get(metadata.requestId);
        waiters.delete(metadata.requestId);
        waiter?.done(metadata);
      }
      if (read.status === "need-input") break;
    }
  });
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  socket.send(
    JSON.stringify({
      type: "cove-bootstrap",
      bootstrapVersion: BOOTSTRAP_VERSION,
      expectedServerId: record.serverId,
      expectedRelayInstanceId: record.relayInstanceId,
      protocolVersion: PROTOCOL_VERSION,
      buildVersion: "reattach-lifetime",
      capabilities: [...M0_CAPABILITIES],
      profiles: [PROFILE],
      encodings: [BASELINE_ENCODING],
      secret: record.secret,
    }),
  );
  await waitFor("the terminal bootstrap", () => bootstrap || failure, 10_000);
  if (bootstrap?.type !== "cove-bootstrap-result") throw new Error("terminal bootstrap failed");
  let sequence = 0;
  return {
    connection: bootstrap.connection,
    request(command) {
      const requestId = `raw-${++sequence}`;
      const encoded = encodeTerminalFrame(
        TERMINAL_FRAME_CLASSES.command,
        new TextEncoder().encode(JSON.stringify({ ...command, requestId })),
        new Uint8Array(),
      );
      if (!encoded.ok) throw new Error("cannot encode terminal command");
      if (failure) return Promise.reject(failure);
      return new Promise((done, fail) => {
        waiters.set(requestId, { done, fail });
        socket.send(encoded.value);
      });
    },
  };
}

async function reattach(client, run, index) {
  const terminal = open(client, run, `view-${index}`);
  try {
    const attached = await terminal.attach();
    if (!attached.ok) throw new Error(`attach ${index} failed: ${JSON.stringify(attached)}`);
    terminal.setInputTarget(true, true);
    const focused = await terminal.requestFocus();
    if (!focused.ok) throw new Error(`focus ${index} failed: ${JSON.stringify(focused)}`);
    const detached = await terminal.detach();
    if (!detached.ok) throw new Error(`detach ${index} failed: ${JSON.stringify(detached)}`);
  } finally {
    terminal.dispose();
  }
}

test("one connection attaches and detaches past the old per-connection route cap", async () => {
  const run = await createRun("exec cat >/dev/null");
  const raw = await rawConnection(fixture.record);
  let retired;
  for (let index = 0; index < OLD_ATTACH_CAP + 100; index++) {
    const attached = await raw.request({
      type: "attach",
      run,
      connection: raw.connection,
      viewId: "raw-view",
      profile: PROFILE,
      encoding: BASELINE_ENCODING,
    });
    if (attached.type !== "attach-result")
      throw new Error(`attach ${index} failed: ${JSON.stringify(attached)}`);
    const detached = await raw.request({
      type: "detach",
      run,
      subscription: attached.subscription,
    });
    if (detached.type !== "detach-result")
      throw new Error(`detach ${index} failed: ${JSON.stringify(detached)}`);
    retired = attached.subscription;
  }
  // A released subscription is still refused rather than silently accepted.
  expect(await raw.request({ type: "detach", run, subscription: retired })).toMatchObject({
    type: "error",
    error: { kind: "STALE_CONNECTION" },
  });
}, 120_000);

// The public client's 256-retired window is per connection, so the run's controlling
// subscriptions are spread over several sequential connections.
test("one run grants control to more subscriptions than the old per-run counter cap", async () => {
  const run = await createRun("exec cat >/dev/null");
  const PER_CONNECTION = 200;
  for (let index = 0; index < OLD_CONTROL_CAP + 40;) {
    const client = await connectClient();
    for (let count = 0; count < PER_CONNECTION && index < OLD_CONTROL_CAP + 40; count++, index++)
      await reattach(client, run, index);
    expect(client.snapshot().status).toBe("connected");
    client.dispose();
  }

  // A fresh connection still takes control and writes input on the long-lived run.
  const probe = open(await connectClient(), run, "probe");
  expect(await probe.attach()).toMatchObject({ ok: true });
  probe.setInputTarget(true, true);
  expect(await probe.requestFocus()).toMatchObject({ ok: true });
  const sent = await probe.sendInput({ source: "keyboard", bytes: new TextEncoder().encode("x") });
  expect(sent).toMatchObject({ ok: true, value: { unknownBytes: 0, notSentBytes: 0 } });
}, 120_000);
