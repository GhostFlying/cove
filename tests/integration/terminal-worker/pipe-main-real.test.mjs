import { expect, test, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  let start;
  let primary;
  let result;
  const cleanupErrors = [];
  try {
    h.send(hello);
    expect((await h.wait((m) => m.type === "ready", "ready")).metadata.pipeVersion).toBe(2);
    result = await body({
      h,
      temp,
      nonce,
      startPty: async () => {
        start = await receipt(join(temp, "start.json"), "PTY start receipt");
        expect(start).toMatchObject({ nonce });
        expect(psIdentity(start.pid)).toContain(nonce);
        return start;
      },
    });
  } catch (error) {
    primary = error;
  } finally {
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
    const last = command("status", target);
    h.send(last);
    const lastStatus = (await response(h, last)).metadata.runStatus;
    expect(lastStatus.status).toBe("exited");
    expect(lastStatus.exitCode).toBe(23);
    expect(await until(() => !psIdentity(start.pid), 8000, "PTY leader exit")).toBe(true);
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
