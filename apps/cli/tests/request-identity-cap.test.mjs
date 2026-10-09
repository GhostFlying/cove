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
// connection closed, capped at 4096. A focused view over heavy output sends roughly one
// applied-ack per event, so after ~4096 events every attach, create and ack on the whole
// server failed with BUSY until restart. Each worker pipe identity is now released when its
// request settles, and each connection keeps only in-flight IDs plus a bounded recent window.
const cli = resolve(import.meta.dirname, "../dist/main.js");
// Well past the old 4096 lifetime cap; before the fix the wedge hit near 4500 events.
const TARGET_APPLIED_SEQ = 12_000;

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

test("heavy output past the old request identity cap leaves attach and create available", async () => {
  // Synthetic output only; no real terminal content.
  const run = await createRun('i=0; while :; do i=$((i+1)); printf "line %d\\n" "$i"; done');
  const holderClient = await connectClient();
  const holder = open(holderClient, run, "holder");
  expect(await holder.attach()).toMatchObject({ ok: true });
  holder.setInputTarget(true, true);
  expect(await holder.requestFocus()).toMatchObject({ ok: true });

  await waitFor(
    "the focused view to apply events well past the old cap",
    () => {
      const phase = holder.snapshot().phase;
      if (phase === "unavailable") throw new Error("the focused view lost its subscription");
      return holder.snapshot().appliedSeq >= TARGET_APPLIED_SEQ;
    },
    120_000,
  );
  expect(holderClient.snapshot().status).toBe("connected");

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
