import { execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { createSessionClient, readRendezvous } from "../dist/session.js";
import { createRecordingView, waitFor } from "./recording-view.mjs";
import { stopServer } from "./server-process.mjs";

// Regression: the server used to keep every settled request identity until the worker or
// connection closed, capped at 4096, after which every attach, create and ack on the whole
// server failed with BUSY until restart. Each awaited input below is one settled request on
// this connection and one worker pipe request, so the loop deterministically crosses both
// old caps; the idle server's once-a-second preview status also keeps spending pipe IDs.
const cli = resolve(import.meta.dirname, "../dist/main.js");
const OLD_CAP = 4096;
const REQUESTS = OLD_CAP + 200;

let fixture;

beforeEach(async () => {
  // Realpath the temp root: macOS /var is a symlink and the server refuses a rendezvous
  // reached through a symlinked ancestor. HOME keeps the CLI start lock out of ~/.cove.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cove-identity-")));
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

test("more settled requests than the old identity cap leave input, attach and create available", async () => {
  // The run discards its input, so no terminal content is involved.
  const run = await createRun("exec cat >/dev/null");
  const client = await connectClient();
  const holder = open(client, run, "holder");
  expect(await holder.attach()).toMatchObject({ ok: true });
  holder.setInputTarget(true, true);
  expect(await holder.requestFocus()).toMatchObject({ ok: true });
  const key = new TextEncoder().encode("x");
  for (let index = 0; index < REQUESTS; index++) {
    const sent = await holder.sendInput({ source: "keyboard", bytes: key });
    if (!sent.ok || sent.value.unknownBytes !== 0 || sent.value.notSentBytes !== 0)
      throw new Error(`input ${index} did not settle accepted: ${JSON.stringify(sent)}`);
  }
  expect(client.snapshot().status).toBe("connected");

  const probeClient = await connectClient();
  const probe = open(probeClient, run, "probe");
  expect(await probe.attach()).toMatchObject({ ok: true });
  expect((await probe.detach()).ok).toBe(true);
  probe.dispose();

  const created = await cove(
    "terminal",
    "create",
    "--cwd",
    fixture.directory,
    "--",
    "/bin/sh",
    "-c",
    "sleep 30",
  );
  expect(created).toMatchObject({ code: 0 });
  expect(JSON.parse(created.stdout)).toMatchObject({ serverId: fixture.record.serverId });
}, 180_000);
