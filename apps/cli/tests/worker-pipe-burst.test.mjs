import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { createSessionClient, readRendezvous } from "../dist/session.js";
import { createRecordingView, waitFor } from "./recording-view.mjs";
import { stopServer } from "./server-process.mjs";

// Regression for a worker pipe read that carried more frames than one decoder slice: the
// server treated the decoder's budget remainder as a protocol fault and lost contact with the
// worker, so every later operation on the run failed with WORKER_UNAVAILABLE.
const cli = resolve(import.meta.dirname, "../dist/main.js");
const encoder = new TextEncoder();
const FLOOD_LINES = 20_000;
const PAD = "x".repeat(60);

let fixture;

beforeEach(async () => {
  // Realpath the temp root: macOS /var is a symlink and the server refuses a symlinked
  // rendezvous ancestor. HOME points at the temp directory so ~/.cove is never touched.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cove-burst-")));
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

async function attach(run, viewId) {
  const client = createSessionClient(fixture.record);
  fixture.clients.push(client);
  expect((await client.connect()).ok).toBe(true);
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

async function type(controller, text) {
  const sent = await controller.sendInput({ source: "keyboard", bytes: encoder.encode(text) });
  expect(sent).toMatchObject({ ok: true, value: { unknownBytes: 0, notSentBytes: 0 } });
}

// Not anchored at a line start: the first flood line can directly follow the attach
// baseline's cursor-positioning escape rather than a newline.
function floodLines(text) {
  return text.match(/flood-\d{6}-x{60}(?=\r)/g) ?? [];
}

const floodPart = (from, to) =>
  `awk 'BEGIN{for(i=${from};i<=${to};i++)printf "flood-%06d-${PAD}\\n",i}' | cat`;

test("a worker output burst beyond one decoder slice keeps both clients and every byte", async () => {
  // Each typed line runs in the shell, so the flood command and the mid-flood lines reach the
  // PTY as genuine operator input. Echo is off so typed bytes never interleave with (and split)
  // a flood line in the recorded output.
  const run = await coveJson(
    "terminal",
    "create",
    "--cwd",
    fixture.directory,
    "--",
    "/bin/sh",
    "-c",
    'stty -echo; printf "loop-ready\\n"; while IFS= read -r line; do eval "$line"; done',
  );
  const holder = await attach(run, "burst-holder");
  const viewer = await attach(run, "burst-viewer");
  await waitFor("the holder's first output", () => holder.recording.text().includes("loop-ready"));
  await waitFor("the viewer's first output", () => viewer.recording.text().includes("loop-ready"));

  holder.controller.setInputTarget(true, true);
  expect(await holder.controller.requestFocus()).toMatchObject({ ok: true });
  // The producer prints half the flood (about 0.8 MB), then blocks on a FIFO only this test
  // writes before printing the rest. The barrier guarantees the flood is still unfinished
  // when the holder types, instead of racing a producer that may already have finished.
  const half = FLOOD_LINES / 2;
  const gate = join(fixture.directory, "flood-gate");
  execFileSync("mkfifo", [gate]);
  await type(
    holder.controller,
    `${floodPart(1, half)}; IFS= read -r token < '${gate}'; printf "gate:%s\\n" "$token"; ${floodPart(half + 1, FLOOD_LINES)}\r`,
  );
  await waitFor("the flood to start", () => floodLines(holder.recording.text()).length > 0);
  // Typed while the first half prints; the shell runs these lines after the flood command.
  await type(holder.controller, 'printf "typed-%s\\n" one\r');
  await type(holder.controller, 'printf "typed-%s\\n" two\r');
  await waitFor(
    "the first half of the flood",
    () => floodLines(holder.recording.text()).length >= half,
    30_000,
  );
  expect(floodLines(holder.recording.text())).toHaveLength(half);
  // Opening the FIFO for writing completes once the blocked producer is reading it.
  await writeFile(gate, "go\n");

  for (const { recording } of [holder, viewer]) {
    await waitFor(
      "both typed lines after the flood",
      () => /^typed-two\r/m.test(recording.text()),
      30_000,
    );
    const text = recording.text();
    const lines = floodLines(text);
    expect(lines).toHaveLength(FLOOD_LINES);
    lines.forEach((line, index) =>
      expect(line.slice(0, 12)).toBe(`flood-${String(index + 1).padStart(6, "0")}`),
    );
    const released = text.search(/^gate:go\r/m);
    expect(text.indexOf(lines[half - 1])).toBeLessThan(released);
    expect(released).toBeLessThan(text.indexOf(lines[half]));
    expect(text.indexOf(lines.at(-1))).toBeLessThan(text.search(/^typed-one\r/m));
    expect(text.search(/^typed-one\r/m)).toBeLessThan(text.search(/^typed-two\r/m));
  }

  // Contact with the worker survived: control, acknowledgement and detach still succeed.
  await type(holder.controller, 'printf "after-%s\\n" burst\r');
  await waitFor("post-burst output", () => /^after-burst\r/m.test(viewer.recording.text()));
  expect(await coveJson("terminal", "get", run.runId)).toMatchObject({ status: "live" });
  for (const { controller } of [holder, viewer]) {
    expect(controller.snapshot().execution.status).not.toBe("exited");
    expect(await controller.detach()).toMatchObject({ ok: true });
  }
}, 90_000);
