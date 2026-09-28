import { expect, test, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_APPEARANCE } from "../../../packages/protocol/dist/profile.js";
import {
  childPipe,
  command,
  fixture,
  geometry,
  hello,
  installedBin,
  psIdentity,
  receipt,
  repo,
  run,
  spawnCommand,
  stopPtyIfOwned,
  stopVerified,
  subscription,
  until,
  workerExecIdentity,
} from "./pipe-harness.mjs";

let delivery;
beforeAll(() => {
  delivery = installedBin();
});
afterAll(() => delivery?.cleanup());

async function withWorker(label, body) {
  const temp = mkdtempSync(join(tmpdir(), `cove-qual-${label}-`));
  const nonce = `${label}-${process.pid}-${Date.now()}`;
  const h = childPipe(delivery.bin, nonce);
  const evidenceRoot = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  const evidencePath = evidenceRoot ? join(evidenceRoot, nonce) : undefined;
  if (evidencePath) mkdirSync(evidencePath, { recursive: true });
  let start;
  let startIdentity;
  let execIdentity;
  let primary;
  let result;
  const cleanupErrors = [];
  const preserve = (stage) => {
    if (!evidencePath) return;
    for (const name of ["start.json", "finish.json", "initial-emission.json"]) {
      const source = join(temp, name);
      if (existsSync(source)) copyFileSync(source, join(evidencePath, name));
    }
    writeFileSync(
      join(evidencePath, `${stage}.json`),
      JSON.stringify(
        {
          nonce,
          workerPid: h.child.pid,
          workerInitialIdentity: h.identity,
          workerExecIdentity: execIdentity ?? null,
          workerCurrentIdentity: psIdentity(h.child.pid),
          workerExitCode: h.child.exitCode,
          workerSignalCode: h.child.signalCode,
          ptyStart: start ?? null,
          ptyStartIdentity: startIdentity ?? null,
          ptyCurrentIdentity: start ? psIdentity(start.pid) : null,
          returnedFrames: h.frames.map(({ metadata, payload, kind }) => ({
            metadata,
            payloadHex: payload.toString("hex"),
            kind,
          })),
          stdoutChunkSizes: h.rawSizes,
          stderrHex: Buffer.concat(h.stderr).toString("hex"),
        },
        null,
        2,
      ) + "\n",
    );
  };
  try {
    h.send(hello);
    expect((await h.wait((m) => m.type === "ready", "ready")).metadata.pipeVersion).toBe(2);
    execIdentity = workerExecIdentity(h);
    preserve("ready");
    result = await body({
      h,
      temp,
      nonce,
      startPty: async () => {
        start = await receipt(join(temp, "start.json"), "PTY start receipt");
        expect(start).toMatchObject({ nonce });
        startIdentity = psIdentity(start.pid);
        expect(startIdentity).toContain(nonce);
        return start;
      },
    });
  } catch (error) {
    primary = error;
  } finally {
    try {
      preserve("before-cleanup");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await stopVerified(h);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await stopPtyIfOwned(start, nonce);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      preserve("after-cleanup");
    } catch (error) {
      cleanupErrors.push(error);
    }
    rmSync(temp, { recursive: true, force: true });
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanupErrors],
      "qualification and/or owned cleanup failed",
    );
  if (primary) throw primary;
  return result;
}

const response = (h, sent) =>
  h.wait((m) => m.requestId === sent.requestId, `${sent.type} response`);
const orphanParent = new URL("./fixtures/orphan-parent.mjs", import.meta.url);

test("compiled public main correlates real PTY bytes, query reply, control, input and exit23", async () => {
  await withWorker("canonical", async ({ h, temp, nonce, startPty }) => {
    const target = run("canonical");
    const spawn = spawnCommand(
      target,
      process.execPath,
      [fixture, "interactive", nonce, temp],
      repo,
    );
    h.send(spawn.metadata, spawn.payload);
    expect((await response(h, spawn.metadata)).metadata).toMatchObject({
      commandType: "spawn",
      outcome: "accepted",
      atSeq: 0,
    });
    const start = await startPty();
    expect(start.windowSize).toBe("24 80");
    const initialEmission = await receipt(join(temp, "initial-emission.json"));
    expect(initialEmission).toMatchObject({
      nonce,
      pid: start.pid,
      ok: true,
      length: 7,
      hex: "410080ffe282ac",
    });

    const control = command("set-control", target, {
      expectedEpoch: 0,
      nextEpoch: 1,
      holder: {
        connection: subscription(target).connection,
        viewId: "view",
        subscriptionId: "subscription",
      },
      geometry,
    });
    h.send(control);
    const controlReply = (await response(h, control)).metadata;
    expect(controlReply).toMatchObject({
      commandType: "set-control",
      outcome: "accepted",
    });
    const resize = command("resize", target, {
      subscription: subscription(target),
      epoch: 1,
      geometry: { cols: 90, rows: 30 },
    });
    h.send(resize);
    expect((await response(h, resize)).metadata).toMatchObject({
      commandType: "resize",
      outcome: "accepted",
    });
    const appearance = command("appearance", target, {
      subscription: subscription(target),
      epoch: 1,
      appearance: DEFAULT_APPEARANCE,
    });
    h.send(appearance);
    expect((await response(h, appearance)).metadata).toMatchObject({
      commandType: "appearance",
      outcome: "accepted",
    });
    const status = command("status", target);
    h.send(status);
    expect((await response(h, status)).metadata.runStatus).toMatchObject({
      status: "live",
      controlEpoch: 1,
      geometry: { cols: 90, rows: 30 },
    });

    const input = command("input", target, {
      subscription: subscription(target),
      epoch: 1,
      inputSeq: 1,
    });
    const raw = Buffer.from([0x00, 0x80, 0xff, 0xe2, 0x82, 0xac, 0x51]);
    h.send(input, raw);
    expect((await response(h, input)).metadata).toMatchObject({
      commandType: "input",
      outcome: "accepted",
      inputSeq: 1,
      writtenBytes: raw.length,
    });
    const finish = await receipt(join(temp, "finish.json"), "PTY input+query receipt");
    expect(finish).toMatchObject({ nonce, pid: start.pid });
    expect(finish.reply).toBeGreaterThanOrEqual(0);
    expect(finish.input).toBeGreaterThanOrEqual(0);
    expect(finish.windowSizeAfter).toBe("30 90");
    expect(await until(() => !psIdentity(start.pid), 8000, "PTY leader exit")).toBe(true);
    let lastStatus;
    const deadline = performance.now() + 8000;
    do {
      const last = command("status", target);
      h.send(last);
      lastStatus = (await response(h, last)).metadata.runStatus;
      if (lastStatus.status === "exited") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    expect(lastStatus.status).toBe("exited");
    expect(lastStatus.exitCode).toBe(23);
    h.child.stdin.end();
    expect(await h.exit).toEqual({ code: 0, signal: null });
  });
});

test("compiled public main reports a live run and disposes it on EOF", async () => {
  await withWorker("isolation", async ({ h, temp, nonce, startPty }) => {
    const target = run("hold");
    const spawn = spawnCommand(target, process.execPath, [fixture, "hold", nonce, temp], repo);
    h.send(spawn.metadata, spawn.payload);
    expect((await response(h, spawn.metadata)).metadata.outcome).toBe("accepted");
    const start = await startPty();
    const status = command("status", target);
    h.send(status);
    const statusReply = (await response(h, status)).metadata;
    expect(statusReply).toMatchObject({
      type: "result",
      runStatus: { status: "live" },
    });
    h.child.stdin.end();
    expect(await h.exit).toEqual({ code: 0, signal: null });
    expect(await until(() => !psIdentity(start.pid), 8000, "PTY disposal on EOF")).toBe(true);
  });
});

test("compiled public main releases owned PTY on SIGTERM", async () => {
  await withWorker("sigterm", async ({ h, temp, nonce, startPty }) => {
    const target = run("hold");
    const spawn = spawnCommand(target, process.execPath, [fixture, "hold", nonce, temp], repo);
    h.send(spawn.metadata, spawn.payload);
    expect((await response(h, spawn.metadata)).metadata.outcome).toBe("accepted");
    const start = await startPty();
    expect(psIdentity(h.child.pid)).toContain("/packages/terminal-worker/dist/src/main.js");
    h.child.kill("SIGTERM");
    expect(await h.exit).toEqual({ code: 0, signal: null });
    expect(await until(() => !psIdentity(start.pid), 8000, "PTY disposal on SIGTERM")).toBe(true);
  });
});

test("forced worker death leaves only independently observed PTY cleanup", async () => {
  await withWorker("forced-death", async ({ h, temp, nonce, startPty }) => {
    const target = run("hold");
    const spawn = spawnCommand(target, process.execPath, [fixture, "hold", nonce, temp], repo);
    h.send(spawn.metadata, spawn.payload);
    expect((await response(h, spawn.metadata)).metadata.outcome).toBe("accepted");
    await startPty();
    expect(workerExecIdentity(h)).toContain("/packages/terminal-worker/dist/src/main.js");
    h.child.kill("SIGKILL");
    expect(await h.exit).toEqual({ code: null, signal: "SIGKILL" });
  });
});

test("compiled public main disposes an owned PTY when its stdout reader closes", async () => {
  await withWorker("stdout-close", async ({ h, temp, nonce, startPty }) => {
    const target = run("hold");
    const spawn = spawnCommand(target, process.execPath, [fixture, "hold", nonce, temp], repo);
    h.send(spawn.metadata, spawn.payload);
    expect((await response(h, spawn.metadata)).metadata.outcome).toBe("accepted");
    const start = await startPty();
    h.child.stdout.destroy();
    const status = command("status", target);
    h.send(status);
    const exited = await Promise.race([
      h.exit,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("worker stdout-close exit timeout")), 8000),
      ),
    ]);
    expect(exited.code).toBe(1);
    const stderr = await until(
      () => {
        const value = Buffer.concat(h.stderr).toString("utf8");
        return value.includes("worker-shutdown reason=") ? value : null;
      },
      8000,
      "bounded stdout-close shutdown diagnostic",
    );
    expect(stderr).toMatch(
      /^worker-shutdown reason=stdout-(?:write-failed|error|close) disposal-complete=1 disposal-uncertain=0\n$/,
    );
    expect(stderr).not.toMatch(/Unhandled 'error' event|Error: write EPIPE|uncaughtException/);
    expect(await until(() => !psIdentity(start.pid), 8000, "PTY disposal on stdout close")).toBe(
      true,
    );
  });
});

test("compiled public main disposes an owned PTY after its parent process disappears", async () => {
  const temp = mkdtempSync(join(tmpdir(), "cove-qual-parent-loss-"));
  const nonce = `parent-loss-${process.pid}-${Date.now()}`;
  const evidenceRoot = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  const evidencePath = evidenceRoot ? join(evidenceRoot, nonce) : undefined;
  if (evidencePath) mkdirSync(evidencePath, { recursive: true });
  const launcher = spawn(process.execPath, [orphanParent.pathname, delivery.bin, nonce, temp], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const launcherStderr = [];
  launcher.stderr.on("data", (bytes) => launcherStderr.push(Buffer.from(bytes)));
  launcher.stdout.resume();
  let launch;
  let primary;
  const cleanupErrors = [];
  const preserve = (stage) => {
    if (!evidencePath) return;
    for (const name of ["start.json", "launch.json", "launcher-failure.json"]) {
      const source = join(temp, name);
      if (existsSync(source)) copyFileSync(source, join(evidencePath, name));
    }
    writeFileSync(
      join(evidencePath, `${stage}.json`),
      JSON.stringify(
        {
          nonce,
          launcherPid: launcher.pid,
          launcherExitCode: launcher.exitCode,
          launcherStderrHex: Buffer.concat(launcherStderr).toString("hex"),
          workerPid: launch?.workerPid ?? null,
          workerCurrentIdentity: launch ? psIdentity(launch.workerPid) : null,
          ptyPid: launch?.ptyStart.pid ?? null,
          ptyCurrentIdentity: launch ? psIdentity(launch.ptyStart.pid) : null,
        },
        null,
        2,
      ) + "\n",
    );
  };
  const cleanupOwned = async () => {
    if (!launch) return;
    const current = psIdentity(launch.workerPid);
    if (current) {
      if (current !== launch.workerExecIdentity)
        throw Error(`orphan worker owner uncertain: ${current}`);
      process.kill(launch.workerPid, "SIGTERM");
      await until(() => !psIdentity(launch.workerPid), 5000, "owned orphan worker cleanup");
    }
    await stopPtyIfOwned(launch.ptyStart, nonce);
  };
  try {
    const exit = await Promise.race([
      new Promise((resolve) => launcher.once("exit", (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) => setTimeout(() => reject(Error("launcher exit timeout")), 8000)),
    ]);
    expect(exit).toEqual({ code: 0, signal: null });
    launch = await receipt(join(temp, "launch.json"), "orphan launch receipt");
    expect(launch.nonce).toBe(nonce);
    expect(launch.ptyStart.nonce).toBe(nonce);
    preserve("parent-exited");
    expect(await until(() => !psIdentity(launch.workerPid), 8000, "orphan worker exit")).toBe(true);
    expect(await until(() => !psIdentity(launch.ptyStart.pid), 8000, "orphan PTY exit")).toBe(true);
  } catch (error) {
    primary = error;
  } finally {
    try {
      preserve("before-cleanup");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await cleanupOwned();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      preserve("after-cleanup");
    } catch (error) {
      cleanupErrors.push(error);
    }
    rmSync(temp, { recursive: true, force: true });
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanupErrors],
      "orphan cleanup uncertain",
    );
  if (primary) throw primary;
});
