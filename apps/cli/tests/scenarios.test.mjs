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
import { stopServer } from "./server-process.mjs";

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

async function attach(client, run, viewId) {
  const recording = createRecordingView();
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
  expect(await controller.requestFocus()).toMatchObject({ ok: true });
  const sent = await controller.sendInput({ source: "keyboard", bytes: encoder.encode(text) });
  expect(sent).toMatchObject({ ok: true, value: { unknownBytes: 0, notSentBytes: 0 } });
}

const ECHO_LOOP = 'printf "loop-ready\\n"; while read line; do printf "echo:%s\\n" "$line"; done';

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
