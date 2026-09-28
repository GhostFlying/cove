import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { WriteStream } from "node:fs";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { waitFifoReaderHandshake, withOwnedFifoReader } from "./fifo-reader-ownership.mjs";
import { createPipeDecoder } from "../../../packages/protocol/dist/pipe.js";
import { domainError } from "../../../packages/protocol/dist/errors.js";
import { command, encode, hello, installedBin, receipt, run, until } from "./pipe-harness.mjs";

test("a held-open OS stdout pipe blocks dequeue and later drains FIFO replies", async () => {
  const delivery = installedBin();
  const publicFile = join(delivery.consumerRoot, "physical-stall-public.mjs");
  writeFileSync(publicFile, 'export { runWorkerPipe } from "@cove/terminal-worker/pipe";\n');
  const { runWorkerPipe } = await import(pathToFileURL(publicFile).href);
  const temp = mkdtempSync(join(tmpdir(), "cove-qual-os-fifo-"));
  const nonce = `os-fifo-${process.pid}-${Date.now()}`;
  const fifoPath = join(temp, "reader.fifo");
  const receiptPath = join(temp, "drain.json");
  const evidenceRoot = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  const evidencePath = evidenceRoot ? join(evidenceRoot, nonce) : undefined;
  if (evidencePath) mkdirSync(evidencePath, { recursive: true });
  let primary;
  const cleanupErrors = [];
  try {
    execFileSync("/usr/bin/mkfifo", [fifoPath], { timeout: 5000 });
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    delivery.cleanup();
    throw error;
  }
  let reader;
  let readerExit;
  let stderr = [];
  const writerErrors = [];
  const writes = [];
  const ingress = new PassThrough();
  let armed = false;
  let pipe;
  let firstFalse;
  let resolveFalse;
  const actualFalse = new Promise((resolve) => {
    resolveFalse = resolve;
  });
  class ObservedFifoWriter extends WriteStream {
    write(bytes, ...args) {
      const accepted = super.write(bytes, ...args);
      writes.push({ bytes: bytes.length, accepted, armed });
      if (armed && !accepted) {
        firstFalse ??= pipe.snapshot();
        // Endpoint completion microtasks enqueue the next reply before OS drain can run.
        queueMicrotask(() => queueMicrotask(() => resolveFalse(pipe.snapshot())));
      }
      return accepted;
    }
  }
  let writer;
  const pending = [];
  const target = run("physical-stall");
  let observedClose;
  let initialIdentity;
  let held;
  let readySettled;
  let blocked;
  let stoppedDequeue;
  let drained;
  let childReceipt;
  let evidenceFailed = false;
  const preserve = (stage, { owner, primary, cleanupErrors }) => {
    if (!evidencePath) return;
    try {
      if (existsSync(receiptPath)) copyFileSync(receiptPath, join(evidencePath, "drain.json"));
      writeFileSync(
        join(evidencePath, `${stage}.json`),
        JSON.stringify(
          {
            nonce,
            readerPid: owner?.child.pid ?? null,
            readerStage: owner?.stage ?? "not-spawned",
            firstObservation: owner?.firstObservation ?? null,
            initialIdentity: owner?.initialObservation ?? null,
            currentIdentity: owner?.child.pid ? owner.observe(owner) : null,
            cleanupVerdict: owner?.cleanupVerdict ?? null,
            readerErrors: owner?.errors ?? [],
            writerErrors,
            cleanupErrors: cleanupErrors.map((error) => ({
              name: error.name,
              message: error.message,
            })),
            held,
            readySettled,
            blocked,
            stoppedDequeue,
            firstFalse,
            drained,
            writes,
            observedClose,
            childReceipt: childReceipt && { total: childReceipt.total, pid: childReceipt.pid },
            requests: pending.map((item) => item.requestId),
            pipe: pipe?.snapshot() ?? null,
            stderr: Buffer.concat(stderr).toString("utf8"),
            failure: primary && { name: primary.name, message: primary.message },
          },
          null,
          2,
        ) + "\n",
      );
    } catch (error) {
      evidenceFailed = true;
      throw error;
    }
  };
  try {
    await withOwnedFifoReader({
      entry: new URL("./fixtures/fifo-reader.mjs", import.meta.url).pathname,
      args: [nonce, fifoPath, receiptPath],
      nonce,
      preserve,
      cleanupResources: async () => {
        try {
          if (pipe) await pipe.shutdown("physical-stall-finally");
        } finally {
          writer?.destroy();
          ingress.destroy();
        }
      },
      setup: async (owner) => {
        reader = owner.child;
        readerExit = owner.exit;
        stderr = owner.stderr;
        initialIdentity = owner.initialObservation;
        writer = new ObservedFifoWriter(fifoPath, { highWaterMark: 128 });
        owner.stage = "writer-created";
        writer.on("error", (error) =>
          writerErrors.push({ name: error.name, message: error.message }),
        );
        writer.on("drain", () => writes.push({ event: "drain", armed }));
        pipe = runWorkerPipe(ingress, writer, {
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
        owner.stage = "endpoint-created";
        void pipe.closed.then(
          (value) => {
            observedClose = value;
          },
          (error) => writerErrors.push({ name: error.name, message: error.message }),
        );
        held = await waitFifoReaderHandshake(owner);
        owner.stage = "handshake";
        expect(held).toMatchObject({ nonce, pid: reader.pid, state: "fifo-open-unread" });
        expect(initialIdentity).toMatchObject({ kind: "owned", pid: reader.pid });
        ingress.write(encode(hello));
        readySettled = await until(
          () => {
            const snap = pipe.snapshot();
            return snap.state === "ready" && !snap.blocked && snap.transportBytes === 0
              ? snap
              : null;
          },
          8000,
          "ready frame settled on OS FIFO",
        );
        expect(writes.some((item) => item.accepted === false && item.armed === false)).toBe(true);
        preserve("ready-settled", { owner, cleanupErrors: [] });
        armed = true;
        const first = [command("preview-refresh", target), command("preview-refresh", target)];
        pending.push(...first);
        ingress.write(Buffer.concat(first.map((item) => encode(item))));
        blocked = await Promise.race([
          actualFalse,
          new Promise((_, reject) =>
            setTimeout(() => reject(Error("real write(false) timeout")), 8000),
          ),
        ]);
        stoppedDequeue = pipe.snapshot();
        expect(blocked.state).toBe("ready");
        expect(blocked.blocked).toBe(true);
        expect(blocked.transportBytes).toBeGreaterThan(0);
        expect(blocked.transportBytes).toBe(firstFalse.transportBytes);
        expect(blocked.queuedBytes).toBeGreaterThan(firstFalse.queuedBytes);
        expect(blocked.responseItems).toBeGreaterThanOrEqual(2);
        expect(writes.some((item) => item.armed && item.accepted === false)).toBe(true);
        expect(stoppedDequeue.transportBytes).toBe(blocked.transportBytes);
        expect(stoppedDequeue.queuedBytes).toBeGreaterThanOrEqual(blocked.queuedBytes);
        expect(writes.at(-1)?.event).not.toBe("drain");
        expect(blocked.peakAccountedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        preserve("blocked-before-drain", { owner, cleanupErrors: [] });
        reader.send("drain");
        for (let index = first.length; index < 320; index += 32) {
          const batch = Array.from({ length: Math.min(32, 320 - index) }, () =>
            command("preview-refresh", target),
          );
          pending.push(...batch);
          ingress.write(Buffer.concat(batch.map((item) => encode(item))));
          await until(
            () => pipe.snapshot().outstandingRequests <= 32,
            8000,
            "bounded FIFO request batch",
          );
        }
        drained = await until(
          () => {
            const snap = pipe.snapshot();
            return !snap.blocked &&
              snap.outstandingRequests === 0 &&
              snap.responseItems === 0 &&
              snap.transportBytes === 0 &&
              snap.ordinaryAccountedBytes === 0
              ? snap
              : null;
          },
          8000,
          "physical FIFO drain and response retirement",
        );
        const closed = await pipe.shutdown("physical-stall-complete");
        expect(closed).toMatchObject({ disposalUnverifiable: false, uncertainRequestIds: [] });
        expect(await until(() => writer.closed, 5000, "OS FIFO writer close")).toBe(true);
        childReceipt = await receipt(receiptPath, "same FIFO reader drain receipt");
        expect(childReceipt).toMatchObject({ nonce, pid: reader.pid });
        expect(await readerExit).toEqual({ code: 0, signal: null });
        expect(writerErrors).toEqual([]);
        const decoder = createPipeDecoder();
        const raw = Buffer.from(childReceipt.hex, "hex");
        expect(raw.length).toBe(childReceipt.total);
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
        expect(new Set(replies.slice(1).map((item) => item.requestId)).size).toBe(pending.length);
        preserve("after-drain", { owner, cleanupErrors: [] });
      },
    });
  } catch (error) {
    primary = error;
  } finally {
    if (evidenceFailed) cleanupErrors.push(Error(`evidence collection failed; retained ${temp}`));
    try {
      if (!evidenceFailed) rmSync(temp, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      delivery.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanupErrors],
      "temporary cleanup failed",
    );
  if (primary) throw primary;
});
