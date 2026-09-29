import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { WriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { domainError } from "../../../packages/protocol/dist/errors.js";
import { waitFifoReaderHandshake, withOwnedFifoReader } from "./fifo-reader-ownership.mjs";
import {
  budgets,
  command,
  encode,
  hello,
  installedBin,
  psIdentity,
  receipt,
  repo,
  run,
  spawnCommand,
  subscription,
  until,
  worker,
} from "./pipe-harness.mjs";
import { nearestRank, summarizeTimingTrace } from "./worker-timing-trace.mjs";
import { createDrainEpochTracker } from "./worker-timing-drain.mjs";

const childEntry = new URL("./fixtures/timing-exchange-child.mjs", import.meta.url).pathname;
const fifoEntry = new URL("./fixtures/fifo-reader.mjs", import.meta.url).pathname;
const cycles = 4;
const exchanges = 8;
const clock = `hrtime-bigint-process-${process.pid}`;
const os = process.platform;
const trace = [];
const maxTracePoints = 512;

function pointAt(tick, boundary, phase, runId, sampleId, detail = {}, outcome) {
  if (trace.length >= maxTracePoints) throw Error("bounded timing trace exhausted");
  const value = {
    boundary,
    phase,
    runId,
    sampleId,
    os,
    pid: process.pid,
    clock,
    unit: "nanoseconds",
    tick: tick.toString(),
    detail,
    ...(outcome && { outcome }),
  };
  trace.push(value);
  return value;
}

function point(boundary, phase, runId, sampleId, detail = {}, outcome) {
  return pointAt(process.hrtime.bigint(), boundary, phase, runId, sampleId, detail, outcome);
}

function preserve(name, value) {
  const root = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  if (!root) return;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
}

async function ownedAbsent(start, nonce) {
  if (!start) return;
  const current = psIdentity(start.pid);
  if (!current) return;
  if (!current.includes(childEntry) || !current.includes(nonce))
    throw Error(`measurement child ownership uncertain: ${current}`);
  process.kill(start.pid, "SIGHUP");
  await until(() => !psIdentity(start.pid), 5000, "measurement child absence");
}

test("pure timing joins preserve uncertainty and nearest-rank finite quantiles", () => {
  expect(nearestRank([1n, 3n, 8n, 13n], 0.5)).toBe("3");
  expect(nearestRank([1n, 3n, 8n, 13n], 0.95)).toBe("13");
  const sample = (phase, sampleId, tick, change = {}) => ({
    boundary: "native-delivery-to-fact",
    phase,
    runId: "r",
    sampleId,
    os: "test-os",
    pid: 1,
    clock: "one-process",
    tick,
    detail:
      phase === "start"
        ? { begin: 0, end: 1, bytes: 1, digest: "0".repeat(64) }
        : { intervalEnd: 1, parsedBytes: 1, finalFactSeq: 1 },
    ...change,
  });
  const pairs = [
    sample("start", "a", "10"),
    sample("end", "a", "13"),
    sample("start", "b", "20"),
    sample("end", "b", "28"),
    sample("start", "c", "30"),
    sample("outcome", "c", "34", { outcome: "unresolved" }),
  ];
  expect(summarizeTimingTrace(pairs)[0]).toMatchObject({
    count: 2,
    nonSuccessCount: 1,
    p50Ns: "3",
    p95Ns: "8",
    p99Ns: "8",
    maxNs: "8",
  });
  expect(() => summarizeTimingTrace([...pairs, sample("end", "a", "15")])).toThrow("duplicate");
  expect(() =>
    summarizeTimingTrace([sample("start", "a", "10"), sample("end", "b", "13")]),
  ).toThrow("missing");
  expect(() =>
    summarizeTimingTrace([
      sample("start", "a", "10"),
      sample("end", "a", "13", { clock: "other" }),
    ]),
  ).toThrow("clock");
  expect(() => summarizeTimingTrace([sample("start", "a", "10"), sample("end", "a", "9")])).toThrow(
    "negative",
  );
});

test("controlled asynchronous settlement and unresolved cleanup remain distinct outcomes", async () => {
  const controlled = [];
  const base = (boundary, phase, id, tick, detail, outcome) => ({
    boundary,
    phase,
    runId: "controlled",
    sampleId: id,
    os: "test-os",
    pid: 1,
    clock: "controlled-one-process",
    tick,
    detail,
    ...(outcome && { outcome }),
  });
  let nextTicket = 1;
  const fakeSubmit = (bytes, callback, fails) => {
    const ticket = nextTicket++;
    setImmediate(() =>
      callback(
        fails
          ? {
              kind: "unknown",
              ticket,
              status: "error",
              originalBytes: bytes.length,
              writtenBytes: 0,
              remainingBytes: bytes.length,
            }
          : {
              kind: "written",
              ticket,
              status: "written",
              originalBytes: bytes.length,
              writtenBytes: bytes.length,
              remainingBytes: 0,
            },
      ),
    );
    return { kind: "accepted", ticket, byteLength: bytes.length, origin: "user" };
  };
  for (const fails of [false, true]) {
    const id = fails ? "failed" : "written";
    let settle;
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    const bytes = Buffer.from("x");
    const start = base("native-submit-to-settlement", "start", id, "10", {
      length: bytes.length,
      admission: null,
    });
    controlled.push(start);
    start.detail.admission = fakeSubmit(
      bytes,
      (result) => {
        controlled.push(
          base(
            "native-submit-to-settlement",
            result.kind === "written" ? "end" : "outcome",
            id,
            "20",
            { settlement: result },
            result.kind === "written" ? undefined : "settlement-unknown",
          ),
        );
        settle();
      },
      fails,
    );
    await done;
  }
  controlled.push(base("stop-to-owner-release", "start", "unresolved", "30", { action: "stop" }));
  controlled.push(
    base(
      "stop-to-owner-release",
      "outcome",
      "unresolved",
      "40",
      { writer: "pending" },
      "unresolved",
    ),
  );
  const summary = summarizeTimingTrace(controlled);
  expect(summary.find((item) => item.boundary === "native-submit-to-settlement")).toMatchObject({
    count: 1,
    nonSuccessCount: 1,
  });
  expect(summary.find((item) => item.boundary === "stop-to-owner-release")).toMatchObject({
    count: 0,
    nonSuccessCount: 1,
  });
});

test("the shared drain tracker samples after production and keeps an immediate reblock distinct", async () => {
  const writer = new EventEmitter();
  const calls = [];
  let blocked = true;
  let reblock = false;
  let tick = 0n;
  const tracker = createDrainEpochTracker({
    now: () => ++tick,
    snapshot: () => ({ blocked }),
    onStart: (time, epoch) => calls.push({ phase: "start", time, epoch }),
    onEnd: (time, epoch) => calls.push({ phase: "end", time, epoch }),
  });
  tracker.arm();
  tracker.noteWriteReturn(false);
  tracker.attachBefore(writer);
  writer.on("drain", () => {
    blocked = false;
    if (reblock) {
      blocked = true;
      tracker.noteWriteReturn(false);
    }
  });
  tracker.attachAfter(writer);
  await new Promise((resolve) => setImmediate(resolve));
  expect(tracker.current.blockedSnapshot.blocked).toBe(true);
  writer.emit("drain");
  expect(calls.at(-1)).toMatchObject({
    phase: "end",
    epoch: { after: { blocked: false }, reblockedBy: null },
  });
  blocked = true;
  tracker.noteWriteReturn(false);
  const old = tracker.current.sampleId;
  reblock = true;
  writer.emit("drain");
  expect(tracker.lastDrained.sampleId).toBe(old);
  expect(tracker.lastDrained.after.blocked).toBe(true);
  expect(tracker.lastDrained.reblockedBy).toBe(tracker.current.sampleId);
  expect(tracker.lastDrained.reblockedBy).not.toBe(old);
  expect(calls.at(-1).time).toBeLessThan(tick);
});

test("four sequential owned PTYs measure native delivery, user settlement and closure", async () => {
  const delivery = installedBin();
  const publicFile = join(delivery.consumerRoot, "timing-public.mjs");
  writeFileSync(
    publicFile,
    'export { createWorkerExecution } from "@cove/terminal-worker/execution";\nexport { createNativePtyFactory } from "@cove/terminal-worker/native-adapter";\n',
  );
  const { createWorkerExecution, createNativePtyFactory } = await import(
    pathToFileURL(publicFile).href
  );
  const cyclesEvidence = [];
  let primary;
  try {
    for (let cycle = 0; cycle < cycles; cycle++) {
      const nonce = randomUUID();
      const dir = mkdtempSync(join(tmpdir(), "cove-worker-timing-"));
      const target = run(`timing-${cycle}-${nonce}`);
      const outputParts = [];
      const nativeParts = [];
      const faults = [];
      const deliveries = [];
      const settlements = [];
      let delivered = 0;
      let parsed = 0;
      let observerExitTick;
      let writerCloseTick;
      let start;
      let finish;
      let shutdown;
      let cycleError;
      const native = createNativePtyFactory({
        maxOwners: 1,
        aggregateInputBytes: budgets.workerBytes,
        aggregateInputTasks: budgets.pendingWorkerCommands,
        perPtyInputBytes: Math.min(budgets.inputQueueBytes, 65_536),
        perPtyInputTasks: budgets.pendingWorkerCommands,
        earlyOutputBytes: budgets.parseHardBytes,
      });
      const factory = {
        retainedBytesAccounting: "participating",
        snapshot: () => native.snapshot(),
        spawn(spec, observer) {
          const result = native.spawn(spec, {
            ...observer,
            onData(bytes) {
              const deliveryTick = process.hrtime.bigint();
              const sampleId = `${target.runId}:delivery:${deliveries.length}`;
              const begin = delivered;
              delivered += bytes.length;
              const part = Buffer.from(bytes);
              nativeParts.push(part);
              const interval = {
                sampleId,
                begin,
                end: delivered,
                bytes: bytes.length,
                digest: createHash("sha256").update(part).digest("hex"),
                completed: false,
              };
              deliveries.push(interval);
              pointAt(
                deliveryTick,
                "native-delivery-to-fact",
                "start",
                target.runId,
                sampleId,
                interval,
              );
              observer.onData(bytes);
            },
            onExit(exit) {
              observerExitTick = process.hrtime.bigint();
              observer.onExit(exit);
            },
          });
          if (result.kind !== "created") return result;
          void result.pty.writerCompletion.then(() => {
            writerCloseTick = process.hrtime.bigint();
          });
          const pty = new Proxy(result.pty, {
            get(nativePty, key) {
              if (key === "submit")
                return (bytes, callback) => {
                  const sampleId = `${target.runId}:input:${settlements.length}`;
                  const item = {
                    sampleId,
                    length: bytes.length,
                    digest: createHash("sha256").update(bytes).digest("hex"),
                  };
                  settlements.push(item);
                  const entry = point(
                    "native-submit-to-settlement",
                    "start",
                    target.runId,
                    sampleId,
                    item,
                  );
                  const admission = nativePty.submit(bytes, (settled) => {
                    const settlementTick = process.hrtime.bigint();
                    pointAt(
                      settlementTick,
                      "native-submit-to-settlement",
                      settled.kind === "written" && settled.writtenBytes === bytes.length
                        ? "end"
                        : "outcome",
                      target.runId,
                      sampleId,
                      { settlement: settled },
                      settled.kind === "written" && settled.writtenBytes === bytes.length
                        ? undefined
                        : "settlement-unknown",
                    );
                    callback(settled);
                  });
                  item.admission = admission;
                  item.admissionReturnTick = process.hrtime.bigint().toString();
                  entry.detail.admissionReturnTick = item.admissionReturnTick;
                  if (admission.kind !== "accepted")
                    throw Error(`native input was not accepted: ${admission.kind}`);
                  return admission;
                };
              const value = nativePty[key];
              return typeof value === "function" ? value.bind(nativePty) : value;
            },
          });
          return { kind: "created", pty };
        },
      };
      const execution = createWorkerExecution({
        worker,
        effectiveBudgets: budgets,
        factory,
        onFault: (fault) => faults.push(fault),
        onFact: (fact) => {
          const factTick = process.hrtime.bigint();
          if (fact.event.type !== "output" || !fact.bytes) return;
          const bytes = Buffer.from(fact.bytes);
          outputParts.push(bytes);
          parsed += bytes.length;
          for (const interval of deliveries) {
            if (interval.completed || parsed < interval.end) continue;
            interval.completed = true;
            pointAt(factTick, "native-delivery-to-fact", "end", target.runId, interval.sampleId, {
              finalFactSeq: fact.event.seq,
              parsedBytes: parsed,
              intervalEnd: interval.end,
            });
          }
        },
      });
      const getOutput = () => Buffer.concat(outputParts).toString("utf8");
      try {
        const spawn = spawnCommand(target, process.execPath, [childEntry, nonce, dir], repo);
        expect(await execution.execute(spawn.metadata, spawn.payload)).toMatchObject({
          type: "result",
          outcome: "accepted",
        });
        start = await receipt(join(dir, "start.json"), "timing child start");
        expect(start).toMatchObject({ nonce });
        expect(psIdentity(start.pid)).toContain(nonce);
        const control = command("set-control", target, {
          expectedEpoch: 0,
          nextEpoch: 1,
          holder: {
            connection: subscription(target).connection,
            viewId: "view",
            subscriptionId: "subscription",
          },
          geometry: { cols: 80, rows: 24 },
        });
        expect(await execution.execute(control)).toMatchObject({
          type: "result",
          outcome: "accepted",
        });
        for (let index = 0; index < exchanges; index++) {
          await until(
            () => getOutput().includes(`OUT:${nonce}:${index}\n`),
            8000,
            `output ${index}`,
          );
          const payload = Buffer.from(`IN:${nonce}:${index}\n`);
          const input = command("input", target, {
            subscription: subscription(target),
            epoch: 1,
            inputSeq: index + 1,
          });
          expect(await execution.execute(input, payload)).toMatchObject({
            type: "result",
            outcome: "accepted",
            writtenBytes: payload.length,
          });
        }
        finish = await receipt(join(dir, "finish.json"), "eight input effects");
        expect(finish).toMatchObject({
          nonce,
          pid: start.pid,
          exchanges,
          bytes: settlements.reduce((sum, item) => sum + item.length, 0),
        });
        expect(finish.sha256).toBe(
          createHash("sha256")
            .update(
              Buffer.concat(
                Array.from({ length: exchanges }, (_, index) =>
                  Buffer.from(`IN:${nonce}:${index}\n`),
                ),
              ),
            )
            .digest("hex"),
        );
        expect(Buffer.concat(nativeParts)).toEqual(Buffer.concat(outputParts));
        expect(deliveries.every((interval) => interval.completed)).toBe(true);
        expect(settlements).toHaveLength(exchanges);
        expect(faults).toEqual([]);
        const sampleId = `${target.runId}:stop`;
        point("stop-to-owner-release", "start", target.runId, sampleId, {
          action: "execution.shutdown",
        });
        shutdown = await execution.shutdown("timing-measurement");
        await Promise.resolve();
        const closed =
          shutdown.length === 1 &&
          shutdown[0].ownershipEvidence === "closure-proven" &&
          shutdown[0].writer.kind === "closed" &&
          shutdown[0].leader.kind === "exit-observed" &&
          observerExitTick &&
          writerCloseTick &&
          native.snapshot().owners === 0;
        if (closed) {
          const later = observerExitTick > writerCloseTick ? observerExitTick : writerCloseTick;
          trace.push({
            boundary: "stop-to-owner-release",
            phase: "end",
            runId: target.runId,
            sampleId,
            os,
            pid: process.pid,
            clock,
            unit: "nanoseconds",
            tick: later.toString(),
            detail: {
              observerExitTick: observerExitTick.toString(),
              writerCloseTick: writerCloseTick.toString(),
              receipt: shutdown[0],
            },
          });
        } else {
          point(
            "stop-to-owner-release",
            "outcome",
            target.runId,
            sampleId,
            {
              shutdown,
              observerExitTick: observerExitTick?.toString(),
              writerCloseTick: writerCloseTick?.toString(),
              factory: native.snapshot(),
            },
            "closure-uncertain",
          );
          throw Error("owned timing cleanup is not closure-proven");
        }
        await until(() => !psIdentity(start.pid), 5000, "timing PTY leader absence");
      } catch (error) {
        cycleError = error;
      } finally {
        preserve(`timing-pty-${cycle}-${nonce}-before-cleanup`, {
          clock,
          os,
          nonce,
          start,
          finish,
          nativeBytes: nativeParts.map((part) => part.toString("hex")),
          parsedBytes: outputParts.map((part) => part.toString("hex")),
          deliveries,
          settlements,
          faults,
          shutdown,
          factory: native.snapshot(),
          trace: trace.filter((item) => item.runId === target.runId),
          primary: cycleError && { name: cycleError.name, message: cycleError.message },
        });
        if (!shutdown) {
          try {
            shutdown = await execution.shutdown("timing-finally");
          } catch (error) {
            cycleError = new AggregateError([...(cycleError ? [cycleError] : []), error]);
          }
        }
        try {
          await ownedAbsent(start, nonce);
        } catch (error) {
          cycleError = new AggregateError([...(cycleError ? [cycleError] : []), error]);
        }
        preserve(`timing-pty-${cycle}-${nonce}-after-cleanup`, {
          nonce,
          start,
          shutdown,
          factory: native.snapshot(),
          currentIdentity: start && psIdentity(start.pid),
          primary: cycleError && { name: cycleError.name, message: cycleError.message },
        });
        if (!cycleError) rmSync(dir, { recursive: true, force: true });
      }
      cyclesEvidence.push({
        cycle,
        nonce,
        start,
        finish,
        deliveries: deliveries.length,
        settlements: settlements.length,
        shutdown,
      });
      if (cycleError) throw cycleError;
    }
    const summary = summarizeTimingTrace(
      trace.filter((item) => item.boundary !== "pipe-block-to-drain"),
    );
    expect(
      summary.find((item) => item.boundary === "native-delivery-to-fact")?.count,
    ).toBeGreaterThanOrEqual(cycles);
    expect(summary.find((item) => item.boundary === "native-submit-to-settlement")?.count).toBe(
      cycles * exchanges,
    );
    expect(summary.find((item) => item.boundary === "stop-to-owner-release")?.count).toBe(cycles);
  } catch (error) {
    primary = error;
  } finally {
    preserve("timing-pty-summary", {
      clock,
      os,
      cyclesEvidence,
      trace,
      primary: primary && { name: primary.name, message: primary.message },
      ...(primary
        ? {}
        : {
            summary: summarizeTimingTrace(
              trace.filter((item) => item.boundary !== "pipe-block-to-drain"),
            ),
          }),
    });
    delivery.cleanup();
  }
  if (primary) throw primary;
});

test("four held-open OS FIFO epochs measure actual write(false) to drain", async () => {
  const delivery = installedBin();
  const publicFile = join(delivery.consumerRoot, "timing-pipe-public.mjs");
  writeFileSync(publicFile, 'export { runWorkerPipe } from "@cove/terminal-worker/pipe";\n');
  const { runWorkerPipe } = await import(pathToFileURL(publicFile).href);
  const fifoEvidence = [];
  let primary;
  try {
    for (let cycle = 0; cycle < cycles; cycle++) {
      const nonce = randomUUID();
      const dir = mkdtempSync(join(tmpdir(), "cove-timing-fifo-"));
      const fifoPath = join(dir, "reader.fifo");
      const receiptPath = join(dir, "reader.json");
      execFileSync("/usr/bin/mkfifo", [fifoPath], { timeout: 5000 });
      const runId = `pipe-${cycle}-${nonce}`;
      const ingress = new PassThrough();
      let pipe;
      let writer;
      let blocked;
      let drained;
      let readerReceipt;
      let readerIdentity;
      let released = false;
      const tracker = createDrainEpochTracker({
        now: () => process.hrtime.bigint(),
        snapshot: () => pipe.snapshot(),
        onStart: (tick, epoch) =>
          pointAt(tick, "pipe-block-to-drain", "start", runId, epoch.sampleId, epoch),
        onEnd: (tick, epoch) => {
          epoch.readerHeldAtDrain = !released;
          pointAt(tick, "pipe-block-to-drain", "end", runId, epoch.sampleId, epoch);
          drained = epoch;
        },
      });
      const epochs = tracker.epochs;
      let cycleError;
      class ObservedWriter extends WriteStream {
        write(bytes, ...args) {
          const accepted = super.write(bytes, ...args);
          tracker.noteWriteReturn(accepted, { bytes: bytes.length, readerIdentity });
          return accepted;
        }
      }
      try {
        const result = await withOwnedFifoReader({
          entry: fifoEntry,
          args: [nonce, fifoPath, receiptPath],
          nonce,
          preserve(stage, { owner, primary: ownerError, cleanupErrors }) {
            preserve(`timing-fifo-${cycle}-${nonce}-${stage}`, {
              clock,
              os,
              nonce,
              runId,
              readerIdentity: owner?.initialObservation,
              currentReader: owner && owner.observe(owner),
              ownerVerdict: owner?.cleanupVerdict,
              held: blocked,
              drained,
              readerReceipt,
              epochs,
              trace: trace.filter((item) => item.runId === runId),
              ownerError: ownerError && { message: ownerError.message },
              cleanupErrors: cleanupErrors.map((error) => error.message),
            });
          },
          cleanupResources: async () => {
            try {
              if (pipe) await pipe.shutdown("timing-fifo-finally");
            } finally {
              writer?.destroy();
              ingress.destroy();
            }
          },
          setup: async (owner) => {
            readerIdentity = owner.initialObservation;
            writer = new ObservedWriter(fifoPath, { highWaterMark: 128 });
            tracker.attachBefore(writer);
            pipe = runWorkerPipe(ingress, writer, {
              buildVersion: "timing-fifo",
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
            tracker.attachAfter(writer);
            expect(await waitFifoReaderHandshake(owner)).toMatchObject({
              nonce,
              pid: owner.child.pid,
              state: "fifo-open-unread",
            });
            ingress.write(encode(hello));
            await until(
              () =>
                pipe.snapshot().state === "ready" &&
                !pipe.snapshot().blocked &&
                pipe.snapshot().transportBytes === 0,
              8000,
              "FIFO ready",
            );
            tracker.arm();
            const requests = Array.from({ length: 320 }, () =>
              command("preview-refresh", run(runId)),
            );
            for (let offset = 0; offset < requests.length; offset += 32) {
              ingress.write(
                Buffer.concat(requests.slice(offset, offset + 32).map((item) => encode(item))),
              );
              await until(
                () => pipe.snapshot().outstandingRequests <= 32,
                8000,
                "bounded FIFO batch",
              );
            }
            blocked = pipe.snapshot();
            expect(tracker.current).toBeDefined();
            expect(blocked).toMatchObject({ state: "ready", blocked: true });
            expect(blocked.transportBytes).toBeGreaterThan(0);
            const heldEpoch = tracker.current;
            released = true;
            owner.child.send("drain");
            await until(() => heldEpoch.after && heldEpoch, 8000, "actual FIFO drain event");
            await until(
              () => {
                const snap = pipe.snapshot();
                return !snap.blocked && snap.outstandingRequests === 0 && snap.transportBytes === 0;
              },
              8000,
              "FIFO response settlement",
            );
            tracker.disarm();
            const closed = await pipe.shutdown("timing-fifo-complete");
            expect(closed).toMatchObject({ disposalUnverifiable: false, uncertainRequestIds: [] });
            await until(() => writer.closed, 5000, "FIFO writer close");
            readerReceipt = await receipt(receiptPath, "same-reader bytes");
            expect(readerReceipt).toMatchObject({ nonce, pid: owner.child.pid });
            expect(await owner.exit).toEqual({ code: 0, signal: null });
            expect(
              heldEpoch.reblockedBy === null || heldEpoch.reblockedBy !== heldEpoch.sampleId,
            ).toBe(true);
            return {
              nonce,
              runId,
              readerPid: owner.child.pid,
              blocked,
              drained,
              readerReceipt,
              epochs,
            };
          },
        });
        fifoEvidence.push(result);
      } catch (error) {
        cycleError = error;
      } finally {
        preserve(`timing-fifo-${cycle}-${nonce}`, {
          nonce,
          runId,
          blocked,
          drained,
          readerReceipt,
          epochs,
          trace: trace.filter((item) => item.runId === runId),
          primary: cycleError && { name: cycleError.name, message: cycleError.message },
        });
        if (!cycleError) rmSync(dir, { recursive: true, force: true });
      }
      if (cycleError) throw cycleError;
    }
    const summary = summarizeTimingTrace(
      trace.filter((item) => item.boundary === "pipe-block-to-drain"),
    );
    expect(summary[0].count).toBeGreaterThanOrEqual(cycles);
  } catch (error) {
    primary = error;
  } finally {
    preserve("timing-fifo-summary", {
      clock,
      os,
      fifoEvidence,
      trace: trace.filter((item) => item.boundary === "pipe-block-to-drain"),
      primary: primary && { name: primary.name, message: primary.message },
      ...(primary
        ? {}
        : {
            summary: summarizeTimingTrace(
              trace.filter((item) => item.boundary === "pipe-block-to-drain"),
            ),
          }),
    });
    delivery.cleanup();
  }
  if (primary) throw primary;
});
