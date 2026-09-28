import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { createPipeDecoder } from "../../../packages/protocol/dist/pipe.js";
import { domainError } from "../../../packages/protocol/dist/errors.js";
import {
  command,
  encode,
  hello,
  installedBin,
  psIdentity,
  receipt,
  run,
  until,
} from "./pipe-harness.mjs";

test("a held-open OS stdout pipe blocks dequeue and later drains FIFO replies", async () => {
  const delivery = installedBin();
  const publicFile = join(delivery.consumerRoot, "physical-stall-public.mjs");
  writeFileSync(publicFile, 'export { runWorkerPipe } from "@cove/terminal-worker/pipe";\n');
  const { runWorkerPipe } = await import(pathToFileURL(publicFile).href);
  const temp = mkdtempSync(join(tmpdir(), "cove-qual-os-pipe-"));
  const nonce = `os-pipe-${process.pid}-${Date.now()}`;
  const receiptPath = join(temp, "drain.json");
  const evidenceRoot = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  const evidencePath = evidenceRoot ? join(evidenceRoot, nonce) : undefined;
  if (evidencePath) mkdirSync(evidencePath, { recursive: true });
  const reader = spawn(
    process.execPath,
    [new URL("./fixtures/stalled-pipe-reader.mjs", import.meta.url).pathname, nonce, receiptPath],
    { stdio: ["pipe", "ignore", "pipe", "ipc"] },
  );
  const stderr = [];
  reader.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const readerExit = new Promise((resolve) =>
    reader.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const ingress = new PassThrough();
  const pending = [];
  const target = run("physical-stall");
  const pipe = runWorkerPipe(ingress, reader.stdin, {
    buildVersion: "physical-stall-qualification",
    createExecution: () => ({
      execute: async (request) => ({
        type: "error",
        worker: request.worker,
        run: request.run,
        requestId: request.requestId,
        commandType: request.type,
        error: domainError("CAPABILITY_UNAVAILABLE"),
      }),
      snapshot: () => ({}),
      shutdown: async () => [],
    }),
  });
  let initialIdentity;
  let held;
  let blocked;
  let drained;
  let childReceipt;
  let primary;
  const cleanupErrors = [];
  const preserve = (stage) => {
    if (!evidencePath) return;
    if (existsSync(receiptPath)) copyFileSync(receiptPath, join(evidencePath, "drain.json"));
    writeFileSync(
      join(evidencePath, `${stage}.json`),
      JSON.stringify(
        {
          nonce,
          readerPid: reader.pid,
          initialIdentity,
          currentIdentity: psIdentity(reader.pid),
          held,
          blocked,
          drained,
          childReceipt: childReceipt && { total: childReceipt.total, pid: childReceipt.pid },
          requests: pending.map((item) => item.requestId),
          pipe: pipe.snapshot(),
          stderr: Buffer.concat(stderr).toString("utf8"),
        },
        null,
        2,
      ) + "\n",
    );
  };
  try {
    held = await Promise.race([
      new Promise((resolve) => reader.once("message", resolve)),
      new Promise((_, reject) => setTimeout(() => reject(Error("reader ready timeout")), 8000)),
    ]);
    initialIdentity = psIdentity(reader.pid);
    expect(held).toMatchObject({ nonce, pid: reader.pid, state: "held-open-unread" });
    expect(initialIdentity).toContain(nonce);
    ingress.write(encode(hello));
    for (let index = 0; index < 200; index++) {
      const request = command("preview-refresh", target);
      pending.push(request);
      ingress.write(encode(request));
    }
    blocked = await until(
      () => {
        const snap = pipe.snapshot();
        return snap.blocked && snap.transportBytes > 0 && snap.responseItems > 0 ? snap : null;
      },
      8000,
      "physical writer blocked with retained responses",
    );
    expect(blocked.peakAccountedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    preserve("blocked-before-drain");
    reader.send("drain");
    drained = await until(
      () => {
        const snap = pipe.snapshot();
        return !snap.blocked && snap.outstandingRequests === 0 && snap.responseItems === 0
          ? snap
          : null;
      },
      8000,
      "physical drain and response retirement",
    );
    const closed = await pipe.shutdown("physical-stall-complete");
    expect(closed.disposalUnverifiable).toBe(false);
    childReceipt = await receipt(receiptPath, "OS pipe reader drain receipt");
    expect(childReceipt).toMatchObject({ nonce, pid: reader.pid });
    expect(await readerExit).toEqual({ code: 0, signal: null });
    const decoder = createPipeDecoder();
    const raw = Buffer.from(childReceipt.hex, "hex");
    const replies = [];
    for (let offset = 0; offset < raw.length;) {
      const result = decoder.read(raw.subarray(offset));
      expect(result.status).not.toBe("error");
      expect(result.consumedBytes).toBeGreaterThan(0);
      offset += result.consumedBytes;
      replies.push(
        ...result.frames.map((frame) => JSON.parse(Buffer.from(frame.metadata).toString())),
      );
    }
    expect(replies[0].type).toBe("ready");
    expect(replies.slice(1).map((item) => item.requestId)).toEqual(
      pending.map((item) => item.requestId),
    );
    expect(new Set(replies.slice(1).map((item) => item.requestId)).size).toBe(200);
    preserve("after-drain");
  } catch (error) {
    primary = error;
  } finally {
    try {
      preserve("before-cleanup");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await pipe.shutdown("physical-stall-finally");
      const current = psIdentity(reader.pid);
      if (current && current !== initialIdentity)
        cleanupErrors.push(Error(`reader identity drift: ${current}`));
      else if (current) {
        reader.kill("SIGTERM");
        await until(() => !psIdentity(reader.pid), 5000, "owned reader exit");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      preserve("after-cleanup");
    } catch (error) {
      cleanupErrors.push(error);
    }
    rmSync(temp, { recursive: true, force: true });
    delivery.cleanup();
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanupErrors],
      "OS pipe cleanup failed",
    );
  if (primary) throw primary;
});
