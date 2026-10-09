import { spawn, execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { createSessionClient, readRendezvous } from "../dist/session.js";
import { createRecordingView, waitFor } from "./recording-view.mjs";
import { stopServer } from "./server-process.mjs";

// A focus whose grid differs from the PTY makes the worker emit a resize that requires a new
// baseline, so the client recovers right after the grant. The server keeps this subscription as
// the holder across that recovery; the client must too, without asking for focus again.
const cli = resolve(import.meta.dirname, "../dist/main.js");
const encoder = new TextEncoder();

let fixture;

beforeEach(async () => {
  // Realpath the temp root: on macOS /var is a symlink and the server refuses a rendezvous
  // reached through a symlinked ancestor.
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

test("input sent right after a focus that resizes the PTY reaches it after the baseline recovery", async () => {
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
    'printf "loop-ready\\n"; while read line; do printf "echo:%s\\n" "$line"; done',
  );
  const client = createSessionClient(fixture.record);
  fixture.clients.push(client);
  expect((await client.connect()).ok).toBe(true);
  const recording = createRecordingView({ cols: 100, rows: 30 });
  const opened = client.openTerminal({
    run,
    viewId: "focus-resize-view",
    view: recording.view,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  expect(opened.ok).toBe(true);
  const controller = opened.value;
  expect(await controller.attach()).toMatchObject({ ok: true });
  await waitFor("the run's first output", () => recording.text().includes("loop-ready"));
  expect(controller.snapshot().appliedGeometry?.geometry).toEqual({ cols: 80, rows: 24 });

  expect(controller.setInputTarget(true, true)).toMatchObject({ ok: true });
  const focus = await controller.requestFocus();
  expect(focus).toMatchObject({ ok: true, value: { epoch: 1 } });
  // requestFocus resolves only once the recovery its own resize triggered has reinstated the
  // grant, so the controller is ready with that epoch at the larger grid.
  expect(controller.snapshot()).toMatchObject({
    phase: "ready",
    inputReady: true,
    controlEpoch: 1,
    appliedGeometry: { geometry: { cols: 100, rows: 30 } },
  });

  const sent = await controller.sendInput({ source: "keyboard", bytes: encoder.encode("x\r") });
  expect(sent).toMatchObject({ ok: true, value: { unknownBytes: 0, notSentBytes: 0 } });
  await waitFor("the echo", () => recording.text().includes("echo:x"));
  expect(controller.snapshot()).toMatchObject({ phase: "ready", controlEpoch: 1 });
});
