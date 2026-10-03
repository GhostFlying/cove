import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { createPipeDecoder, encodePipeFrame, validatePipeFrame } from "@cove/protocol/pipe";
import { validateBaselineTransfer } from "@cove/protocol/terminal";
import { WorkerRetainedBytes } from "../../../packages/terminal-worker/dist/src/worker-retained-bytes.js";

const utf8 = (text) => new TextEncoder().encode(text);
const sameRef = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const turn = () => new Promise((resolve) => setImmediate(resolve));

export function createInstallationDelivery(effectiveBudgets) {
  const account = new WorkerRetainedBytes(
    effectiveBudgets.pipeQueuedBytes,
    effectiveBudgets.reservedControlBytes,
  );
  const decoder = createPipeDecoder();
  const frames = [];
  const copies = [];
  const callbacks = new Set();
  let capture = true;
  let capacity;
  let handed = 0;
  let settled = 0;
  const stream = new Writable({
    highWaterMark: effectiveBudgets.pipeQueuedBytes,
    write(raw, _encoding, done) {
      const result = decoder.read(raw);
      assert.notEqual(result.status, "error");
      for (const frame of result.frames) {
        const metadata = JSON.parse(Buffer.from(frame.metadata).toString());
        assert(validatePipeFrame(frame, metadata).ok);
        if (capture) {
          assert(
            frames.length < effectiveBudgets.baselineChunks + effectiveBudgets.postNEvents + 4,
          );
          const lease = account.reserve("worker", raw.length);
          assert(lease, "bounded decoded setup backing");
          copies.push(lease);
          frames.push({ metadata, payload: Uint8Array.from(frame.payload) });
        }
      }
      done();
    },
  });
  return {
    account,
    frames,
    bind(execution) {
      capacity = () => execution.deliveryCapacity();
    },
    enqueue(metadata, payload) {
      const encoded = encodePipeFrame(3, utf8(JSON.stringify(metadata)), payload);
      assert(encoded.ok);
      const lease = account.reserve("worker", encoded.value.length);
      if (!lease) return false;
      handed++;
      const owner = { lease };
      callbacks.add(owner);
      stream.write(encoded.value, () => {
        assert(callbacks.delete(owner));
        lease.release();
        settled++;
        capacity?.();
      });
      return encoded.value.length;
    },
    cancelUnsent() {},
    finishSetup() {
      capture = false;
      frames.length = 0;
      copies.splice(0).forEach((lease) => lease.release());
    },
    snapshot() {
      return {
        ledger: account.snapshot(),
        callbacks: callbacks.size,
        handed,
        settled,
        capturedFrames: frames.length,
      };
    },
    async close() {
      this.finishSetup();
      stream.end();
      await new Promise((resolve, reject) => {
        if (stream.writableFinished) return resolve();
        stream.once("finish", resolve);
        stream.once("error", reject);
      });
      assert.equal(callbacks.size, 0);
      assert.equal(account.snapshot().workerBytes, 0);
    },
  };
}

export async function installPublicSubscription({
  subscription,
  command,
  frames,
  send,
  execution,
  delivery,
  timeoutMs = 8000,
}) {
  const issue =
    send ??
    (async (metadata) => {
      const result = await execution.execute(metadata);
      execution.markerEnqueued(metadata, result);
      execution.responseSettled(metadata.requestId);
      return result;
    });
  const observed = frames ?? delivery.frames;
  const cursor = observed.length;
  const subscribe = command("subscribe", subscription.run, { subscription, atSeq: 0 });
  const marker = await issue(subscribe);
  assert.equal(marker.outcome, "accepted");
  let lastParsed = -1;
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const current = observed
      .slice(cursor)
      .filter((frame) => sameRef(frame.metadata.subscription, subscription));
    const start = current.find((frame) => frame.metadata.terminal?.type === "baseline-start");
    if (!start) {
      await turn();
      continue;
    }
    const descriptor = start.metadata.terminal.descriptor;
    const chunks = current.filter(
      (frame) =>
        frame.metadata.terminal?.type === "baseline-chunk" &&
        frame.metadata.terminal.baselineId === descriptor.baselineId,
    );
    if (chunks.length && chunks.at(-1).metadata.terminal.ordinal > lastParsed) {
      lastParsed = chunks.at(-1).metadata.terminal.ordinal;
      const progress = await issue(
        command("baseline-progress", subscription.run, {
          subscription,
          baselineId: descriptor.baselineId,
          lastParsedOrdinal: lastParsed,
        }),
      );
      assert.equal(progress.outcome, "accepted");
    }
    const end = current.find(
      (frame) =>
        frame.metadata.terminal?.type === "baseline-end" &&
        frame.metadata.terminal.baselineId === descriptor.baselineId,
    );
    if (!end) {
      await turn();
      continue;
    }
    assert(
      validateBaselineTransfer(
        descriptor,
        chunks.map((frame) => ({ metadata: frame.metadata.terminal, payload: frame.payload })),
        end.metadata.terminal,
      ),
    );
    assert.equal(descriptor.atSeq, marker.atSeq);
    const ack = await issue(
      command("applied-ack", subscription.run, { subscription, appliedSeq: marker.atSeq }),
    );
    assert.equal(ack.outcome, "accepted");
    delivery?.finishSetup();
    await turn();
    return { marker, descriptor, parsedChunks: chunks.length, ack };
  }
  assert.fail("legal public subscription installation did not complete before existing workload");
}
