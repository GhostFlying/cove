import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  WriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { domainError } from "../../../packages/protocol/dist/errors.js";
import { createPipeDecoder, validatePipeFrame } from "../../../packages/protocol/dist/pipe.js";
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
import { publishTimingReceipt } from "./fixtures/timing-receipt-publication.mjs";
import { createObservedShutdown, createObservedSubmit } from "./worker-timing-ownership.mjs";
import { finalizeTimingCycle, finalizeTimingRun } from "./worker-timing-finalizers.mjs";
import {
  FIFO_REQUESTS_PER_CYCLE,
  MAX_TIMING_OUTPUT_BYTES,
  MAX_TIMING_TRACE_POINTS,
  TIMING_CYCLES,
  TIMING_EXCHANGES,
} from "./worker-timing-bounds.mjs";

const childEntry = new URL("./fixtures/timing-exchange-child.mjs", import.meta.url).pathname;
const fifoEntry = new URL("./fixtures/fifo-reader.mjs", import.meta.url).pathname;
const cycles = TIMING_CYCLES;
const exchanges = TIMING_EXCHANGES;
const clock = `hrtime-bigint-process-${process.pid}`;
const os = process.platform;
const trace = [];

function pointAt(tick, boundary, phase, runId, sampleId, detail = {}, outcome) {
  if (trace.length >= MAX_TIMING_TRACE_POINTS) throw Error("bounded timing trace exhausted");
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

function preserve(name, value) {
  const root = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  if (!root) return;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
}

function decodeSameReaderFrames(rawHex, reportedBytes) {
  if (typeof rawHex !== "string" || rawHex.length % 2 || !/^[0-9a-f]*$/.test(rawHex))
    throw Error("same-reader raw bytes malformed");
  const raw = Buffer.from(rawHex, "hex");
  if (raw.length !== reportedBytes) throw Error("same-reader byte count mismatch");
  const decoder = createPipeDecoder();
  const frames = [];
  for (let offset = 0; offset < raw.length;) {
    const read = decoder.read(raw.subarray(offset));
    if (read.status === "error" || read.consumedBytes <= 0)
      throw Error(`same-reader frame decode: ${read.error?.code ?? read.status}`);
    offset += read.consumedBytes;
    for (const frame of read.frames) {
      const metadata = JSON.parse(Buffer.from(frame.metadata).toString("utf8"));
      if (!validatePipeFrame(frame, metadata).ok) throw Error("same-reader frame invalid");
      frames.push(metadata);
    }
  }
  if (!decoder.finish().ok) throw Error("same-reader truncated frame");
  return frames;
}

function expectedPtyOutput(nonce, count, lineEnding) {
  return Buffer.from(
    Array.from({ length: count }, (_, index) => `OUT:${nonce}:${index}${lineEnding}`).join(""),
  );
}

function matchingPtyLineEnding(actual, nonce, count, selected) {
  const endings = selected ? [selected] : ["\r\n", "\n"];
  return endings.find((ending) => actual.equals(expectedPtyOutput(nonce, count, ending)));
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

test("timing receipts expose complete JSON only after same-directory publication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cove-timing-publication-"));
  const path = join(dir, "start.json");
  const first = { nonce: randomUUID(), pid: process.pid, ppid: process.ppid };
  const next = { ...first, nonce: randomUUID() };
  try {
    publishTimingReceipt(path, first, (descriptor, serialized) => {
      const partial = serialized.slice(0, 1);
      writeFileSync(descriptor, partial);
      const [temporary] = readdirSync(dir);
      expect(readdirSync(dir)).toHaveLength(1);
      expect(temporary).toMatch(/^\.start\.json-.*\.tmp$/);
      expect(readFileSync(join(dir, temporary), "utf8")).toBe(partial);
      expect(() => readFileSync(path, "utf8")).toThrow(/ENOENT/);
      writeFileSync(descriptor, serialized.slice(partial.length));
      expect(readFileSync(join(dir, temporary), "utf8")).toBe(serialized);
      expect(() => readFileSync(path, "utf8")).toThrow(/ENOENT/);
    });
    expect(await receipt(path, "complete timing start publication")).toEqual(first);
    expect(readdirSync(dir)).toEqual(["start.json"]);
    publishTimingReceipt(path, next, (descriptor, serialized) => {
      writeFileSync(descriptor, serialized.slice(0, 1));
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(first);
      writeFileSync(descriptor, serialized.slice(1));
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(first);
    });
    expect(await receipt(path, "complete timing replacement publication")).toEqual(next);
    expect(readdirSync(dir)).toEqual(["start.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed timing receipt publication preserves prior bytes and cleans owned temporary files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cove-timing-publication-failure-"));
  const path = join(dir, "finish.json");
  const previous = { nonce: randomUUID(), pid: process.pid, exchanges: 8 };
  const failure = Error("staged timing receipt write failed");
  let failedDescriptor;
  try {
    publishTimingReceipt(path, previous);
    const original = readFileSync(path);
    expect(() =>
      publishTimingReceipt(path, { ...previous, nonce: randomUUID() }, (descriptor) => {
        failedDescriptor = descriptor;
        writeFileSync(descriptor, "{");
        expect(readFileSync(path)).toEqual(original);
        throw failure;
      }),
    ).toThrow(failure);
    expect(() => writeFileSync(failedDescriptor, "unexpected open descriptor")).toThrow(/EBADF/);
    expect(readFileSync(path)).toEqual(original);
    expect(await receipt(path, "prior timing receipt after failed publication")).toEqual(previous);
    expect(readdirSync(dir)).toEqual(["finish.json"]);
    const blocked = join(dir, "blocked.json");
    mkdirSync(blocked);
    expect(() => publishTimingReceipt(blocked, previous)).toThrow(
      /EISDIR|ENOTEMPTY|EEXIST|EPERM|EACCES/,
    );
    expect(readdirSync(blocked)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["blocked.json", "finish.json"]);
    expect(readFileSync(path)).toEqual(original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed completed timing receipts remain strict parse failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cove-timing-publication-malformed-"));
  const path = join(dir, "start.json");
  try {
    writeFileSync(path, '{"nonce":');
    await expect(receipt(path, "malformed completed timing receipt")).rejects.toBeInstanceOf(
      SyntaxError,
    );
    expect(readFileSync(path, "utf8")).toBe('{"nonce":');
    expect(readdirSync(dir)).toEqual(["start.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("the declared trace bound admits one native callback per emitted byte", () => {
  expect(MAX_TIMING_OUTPUT_BYTES).toBe(1408);
  expect(matchingPtyLineEnding(Buffer.from("OUT:n:0\r\n"), "n", 1)).toBe("\r\n");
  expect(matchingPtyLineEnding(Buffer.from("OUT:n:0\n"), "n", 1)).toBe("\n");
  expect(matchingPtyLineEnding(Buffer.from("OUT:n:0\r\n"), "n", 1, "\n")).toBeUndefined();
  expect(matchingPtyLineEnding(Buffer.from("OUT:n:0\r\nextra"), "n", 1)).toBeUndefined();
  const maximallySplit = [];
  for (let index = 0; index < MAX_TIMING_OUTPUT_BYTES; index++) {
    const sampleId = `fragment:${index}`;
    const base = {
      boundary: "native-delivery-to-fact",
      runId: "max-fragmentation",
      sampleId,
      os: "test-os",
      pid: 1,
      clock: "one-process",
    };
    maximallySplit.push({
      ...base,
      phase: "start",
      tick: String(index * 2),
      detail: { begin: index, end: index + 1, bytes: 1, digest: "0".repeat(64) },
    });
    maximallySplit.push({
      ...base,
      phase: "end",
      tick: String(index * 2 + 1),
      detail: { intervalEnd: index + 1, parsedBytes: index + 1, finalFactSeq: index + 1 },
    });
  }
  const summary = summarizeTimingTrace(maximallySplit);
  expect(summary).toMatchObject([
    { count: MAX_TIMING_OUTPUT_BYTES, p50Ns: "1", p95Ns: "1", p99Ns: "1", maxNs: "1" },
  ]);
  expect(MAX_TIMING_TRACE_POINTS).toBeGreaterThan(maximallySplit.length);
});

test("shared native and shutdown observers retain rejected, late and uncertain outcomes", async () => {
  const controlled = [];
  let clockTick = 0n;
  let mode = "written";
  let nextTicket = 1;
  let pendingCallback;
  let latestAdmission;
  const now = () => ++clockTick;
  const append = (boundary, phase, sampleId, tick, detail, outcome) =>
    controlled.push({
      boundary,
      phase,
      runId: "controlled",
      sampleId,
      os: "test-os",
      pid: 1,
      clock: "controlled-one-process",
      tick: tick.toString(),
      detail,
      ...(outcome && { outcome }),
    });
  const observed = createObservedSubmit({
    submit(bytes, callback) {
      if (mode === "rejected" || mode === "unknown")
        return (latestAdmission = { kind: mode, reason: "controlled" });
      const ticket = nextTicket++;
      latestAdmission = { kind: "accepted", ticket, byteLength: bytes.length, origin: "user" };
      if (mode === "pending") pendingCallback = callback;
      else
        setImmediate(() =>
          callback(
            mode === "written"
              ? { kind: "written", ticket, writtenBytes: bytes.length }
              : {
                  kind: "unknown",
                  ticket,
                  status: "error",
                  originalBytes: bytes.length,
                  writtenBytes: 0,
                  remainingBytes: bytes.length,
                },
          ),
        );
      return latestAdmission;
    },
    now,
    makeId: (index) => `input:${index}`,
    describeBytes: () => ({ digest: "0".repeat(64) }),
    onStart: (tick, item) =>
      append("native-submit-to-settlement", "start", item.sampleId, tick, item),
    onTerminal: (tick, item, phase, detail, outcome) =>
      append("native-submit-to-settlement", phase, item.sampleId, tick, detail, outcome),
  });
  for (const nextMode of ["written", "failed", "rejected", "unknown", "pending"]) {
    mode = nextMode;
    let settled;
    const done = new Promise((resolve) => {
      settled = resolve;
    });
    const returned = observed.invoke(Buffer.from("x"), () => settled());
    expect(returned).toBe(latestAdmission);
    if (nextMode === "written" || nextMode === "failed") await done;
    const item = observed.records.at(-1);
    observed.observePublicResult(
      item,
      nextMode === "pending"
        ? { type: "error", error: { kind: "RESULT_UNKNOWN" } }
        : { type: "result", outcome: "accepted" },
    );
  }
  const terminalCount = controlled.filter((item) => item.phase !== "start").length;
  pendingCallback({ kind: "written", ticket: latestAdmission.ticket, writtenBytes: 1 });
  expect(controlled.filter((item) => item.phase !== "start")).toHaveLength(terminalCount);
  expect(observed.records.at(-1).lateSettlements).toHaveLength(1);

  const receipt = {
    ownershipEvidence: "closure-proven",
    writer: { kind: "closed" },
    leader: { kind: "exit-observed" },
  };
  const shutdownControl = (sampleId, shutdown, ownerFacts) => {
    let start;
    return createObservedShutdown({
      shutdown,
      now,
      ownerFacts,
      onStart: (tick, detail) => {
        start = { action: "execution.shutdown", ...detail };
        append("stop-to-owner-release", "start", sampleId, tick, start);
      },
      onReturn: (tick, detail) => {
        start.returnTick = tick.toString();
        start.returnResult = detail;
      },
      onTerminal: (tick, phase, detail, outcome) =>
        append("stop-to-owner-release", phase, sampleId, tick, detail, outcome),
    });
  };
  const closed = shutdownControl(
    "closed",
    () => Promise.resolve([receipt]),
    () => ({ observerExitTick: now(), writerCloseTick: now(), owners: 0 }),
  );
  await closed.run("normal");
  expect(closed.result.kind).toBe("closure-proven");
  const unresolved = shutdownControl(
    "unresolved",
    () => Promise.resolve([]),
    () => ({ observerExitTick: undefined, writerCloseTick: undefined, owners: 1 }),
  );
  await unresolved.run("timing-finally");
  expect(unresolved.result.kind).toBe("closure-uncertain");
  const rejected = shutdownControl(
    "rejected",
    () => Promise.reject(Error("controlled failure")),
    () => ({ observerExitTick: undefined, writerCloseTick: undefined, owners: 1 }),
  );
  await expect(rejected.run("timing-finally")).rejects.toThrow("controlled failure");
  const summary = summarizeTimingTrace(controlled);
  expect(summary.find((item) => item.boundary === "native-submit-to-settlement")).toMatchObject({
    count: 1,
    nonSuccessCount: 4,
  });
  expect(summary.find((item) => item.boundary === "stop-to-owner-release")).toMatchObject({
    count: 1,
    nonSuccessCount: 2,
  });
  expect(
    controlled
      .filter((item) => item.phase === "start" && item.boundary === "stop-to-owner-release")
      .every((item) => item.detail.returnTick),
  ).toBe(true);
});

test("actual timing finalizers keep primary causes and attempt independent cleanup", () => {
  const primary = Error("primary");
  const evidence = Error("evidence");
  const cleanup = Error("cleanup");
  const calls = [];
  const result = finalizeTimingRun({
    primary,
    preserveEvidence: () => {
      calls.push("preserve");
      throw evidence;
    },
    cleanupDelivery: () => {
      calls.push("delivery-cleanup");
      throw cleanup;
    },
  });
  expect(calls).toEqual(["preserve", "delivery-cleanup"]);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.errors).toEqual([primary, evidence, cleanup]);

  calls.length = 0;
  const writeFailure = finalizeTimingRun({
    preserveEvidence: () => {
      calls.push("preserve");
      throw evidence;
    },
    cleanupDelivery: () => calls.push("delivery-cleanup"),
  });
  expect(calls).toEqual(["preserve", "delivery-cleanup"]);
  expect(writeFailure).toBe(evidence);

  calls.length = 0;
  const retained = finalizeTimingCycle({
    primary,
    preserveEvidence: () => {
      calls.push("preserve");
      throw evidence;
    },
    cleanupDirectory: () => calls.push("directory-cleanup"),
  });
  expect(calls).toEqual(["preserve"]);
  expect(retained.errors).toEqual([primary, evidence]);

  calls.length = 0;
  const retainedOnWriteFailure = finalizeTimingCycle({
    preserveEvidence: () => {
      calls.push("preserve");
      throw evidence;
    },
    cleanupDirectory: () => calls.push("directory-cleanup"),
  });
  expect(calls).toEqual(["preserve"]);
  expect(retainedOnWriteFailure).toBe(evidence);

  calls.length = 0;
  const failedRemoval = finalizeTimingCycle({
    preserveEvidence: () => calls.push("preserve"),
    cleanupDirectory: () => {
      calls.push("directory-cleanup");
      throw cleanup;
    },
  });
  expect(calls).toEqual(["preserve", "directory-cleanup"]);
  expect(failedRemoval).toBe(cleanup);
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
      let outputLineEnding;
      let shutdown;
      let observedSubmit;
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
          observedSubmit = createObservedSubmit({
            submit: (bytes, callback) => result.pty.submit(bytes, callback),
            now: () => process.hrtime.bigint(),
            makeId: (index) => `${target.runId}:input:${index}`,
            describeBytes: (bytes) => ({
              digest: createHash("sha256").update(bytes).digest("hex"),
            }),
            onStart: (tick, item) => {
              settlements.push(item);
              pointAt(
                tick,
                "native-submit-to-settlement",
                "start",
                target.runId,
                item.sampleId,
                item,
              );
            },
            onTerminal: (tick, item, phase, detail, outcome) =>
              pointAt(
                tick,
                "native-submit-to-settlement",
                phase,
                target.runId,
                item.sampleId,
                detail,
                outcome,
              ),
          });
          const pty = new Proxy(result.pty, {
            get(nativePty, key) {
              if (key === "submit") return observedSubmit.invoke;
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
      const stopSampleId = `${target.runId}:stop`;
      let stopStart;
      const observedShutdown = createObservedShutdown({
        shutdown: (reason) => execution.shutdown(reason),
        now: () => process.hrtime.bigint(),
        onStart: (tick, detail) => {
          stopStart = pointAt(tick, "stop-to-owner-release", "start", target.runId, stopSampleId, {
            action: "execution.shutdown",
            ...detail,
          });
        },
        onReturn: (tick, detail) => {
          stopStart.detail.returnTick = tick.toString();
          stopStart.detail.returnResult = detail;
        },
        onTerminal: (tick, phase, detail, outcome) =>
          pointAt(
            tick,
            "stop-to-owner-release",
            phase,
            target.runId,
            stopSampleId,
            detail,
            outcome,
          ),
        ownerFacts: () => ({
          observerExitTick,
          writerCloseTick,
          owners: native.snapshot().owners,
        }),
      });
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
            () => {
              const actual = Buffer.concat(outputParts);
              const matched = matchingPtyLineEnding(actual, nonce, index + 1, outputLineEnding);
              if (!matched) return false;
              outputLineEnding = matched;
              return true;
            },
            8000,
            `output ${index}`,
          );
          const payload = Buffer.from(`IN:${nonce}:${index}\n`);
          const input = command("input", target, {
            subscription: subscription(target),
            epoch: 1,
            inputSeq: index + 1,
          });
          const beforeInput = settlements.length;
          let inputResult;
          try {
            inputResult = await execution.execute(input, payload);
          } finally {
            observedSubmit?.observePublicResult(
              settlements[beforeInput],
              inputResult ?? { kind: "public-execute-threw" },
            );
          }
          expect(inputResult).toMatchObject({
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
        expect(Buffer.concat(outputParts)).toEqual(
          expectedPtyOutput(nonce, exchanges, outputLineEnding),
        );
        expect(Buffer.concat(nativeParts)).toEqual(Buffer.concat(outputParts));
        expect(deliveries.every((interval) => interval.completed)).toBe(true);
        expect(settlements).toHaveLength(exchanges);
        expect(faults).toEqual([]);
        shutdown = await observedShutdown.run("timing-measurement");
        if (observedShutdown.result?.kind !== "closure-proven")
          throw Error("owned timing cleanup is not closure-proven");
        await until(() => !psIdentity(start.pid), 5000, "timing PTY leader absence");
      } catch (error) {
        cycleError = error;
      } finally {
        try {
          preserve(`timing-pty-${cycle}-${nonce}-before-cleanup`, {
            clock,
            os,
            nonce,
            start,
            finish,
            outputLineEnding,
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
        } catch (error) {
          cycleError = new AggregateError([...(cycleError ? [cycleError] : []), error]);
        }
        if (!observedShutdown.attempted) {
          try {
            shutdown = await observedShutdown.run("timing-finally");
          } catch (error) {
            cycleError = new AggregateError([...(cycleError ? [cycleError] : []), error]);
          }
        }
        try {
          await ownedAbsent(start, nonce);
        } catch (error) {
          cycleError = new AggregateError([...(cycleError ? [cycleError] : []), error]);
        }
        try {
          preserve(`timing-pty-${cycle}-${nonce}-after-cleanup`, {
            nonce,
            start,
            shutdown,
            outputLineEnding,
            factory: native.snapshot(),
            currentIdentity: start && psIdentity(start.pid),
            primary: cycleError && { name: cycleError.name, message: cycleError.message },
          });
        } catch (error) {
          cycleError = new AggregateError([...(cycleError ? [cycleError] : []), error]);
        }
        if (!cycleError) rmSync(dir, { recursive: true, force: true });
      }
      cyclesEvidence.push({
        cycle,
        nonce,
        start,
        finish,
        outputLineEnding,
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
    primary = finalizeTimingRun({
      primary,
      preserveEvidence: () =>
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
        }),
      cleanupDelivery: () => delivery.cleanup(),
    });
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
      let expectedRequestIds = [];
      let decodedResponses = [];
      let ingressedRequests = 0;
      let heldEpoch;
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
              expectedRequestIds,
              decodedResponses,
              ingressedRequests,
              heldEpochId: heldEpoch?.sampleId,
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
            const requests = Array.from({ length: FIFO_REQUESTS_PER_CYCLE }, () =>
              command("preview-refresh", run(runId)),
            );
            expectedRequestIds = requests.map((item) => item.requestId);
            expect(new Set(expectedRequestIds).size).toBe(FIFO_REQUESTS_PER_CYCLE);
            for (let offset = 0; offset < requests.length; offset += 32) {
              const batch = requests.slice(offset, offset + 32);
              ingress.write(Buffer.concat(batch.map((item) => encode(item))));
              ingressedRequests += batch.length;
              const next = await until(
                () => {
                  const snapshot = pipe.snapshot();
                  const epoch = tracker.current;
                  if (
                    snapshot.state === "ready" &&
                    snapshot.blocked &&
                    snapshot.transportBytes > 0 &&
                    epoch
                  ) {
                    blocked = snapshot;
                    heldEpoch = epoch;
                    // Release in the same observation so the selected epoch cannot retire first.
                    released = true;
                    owner.child.send("drain");
                    return "reader-released";
                  }
                  if (!snapshot.blocked && snapshot.outstandingRequests <= 32) return "next-batch";
                  return false;
                },
                8000,
                "held FIFO block or bounded batch",
              );
              if (next === "reader-released") break;
            }
            expect(heldEpoch).toBeDefined();
            expect(blocked).toMatchObject({ state: "ready", blocked: true });
            expect(blocked.transportBytes).toBeGreaterThan(0);
            await until(() => heldEpoch.after && heldEpoch, 8000, "actual FIFO drain event");
            expect(heldEpoch.readerHeldAtDrain).toBe(false);
            for (let offset = ingressedRequests; offset < requests.length; offset += 32) {
              await until(
                () => pipe.snapshot().outstandingRequests <= 32,
                8000,
                "draining FIFO batch budget",
              );
              const batch = requests.slice(offset, offset + 32);
              ingress.write(Buffer.concat(batch.map((item) => encode(item))));
              ingressedRequests += batch.length;
            }
            expect(ingressedRequests).toBe(FIFO_REQUESTS_PER_CYCLE);
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
            decodedResponses = decodeSameReaderFrames(readerReceipt.hex, readerReceipt.total);
            expect(decodedResponses).toHaveLength(FIFO_REQUESTS_PER_CYCLE + 1);
            expect(decodedResponses[0]).toMatchObject({ type: "ready" });
            const responses = decodedResponses.slice(1);
            expect(
              responses.every(
                (item) => item.type === "error" && item.commandType === "preview-refresh",
              ),
            ).toBe(true);
            expect(responses.map((item) => item.requestId)).toEqual(expectedRequestIds);
            expect(new Set(responses.map((item) => item.requestId)).size).toBe(
              FIFO_REQUESTS_PER_CYCLE,
            );
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
              expectedRequestIds,
              decodedResponses,
              ingressedRequests,
              heldEpochId: heldEpoch.sampleId,
              epochs,
            };
          },
        });
        fifoEvidence.push(result);
      } catch (error) {
        cycleError = error;
      } finally {
        cycleError = finalizeTimingCycle({
          primary: cycleError,
          preserveEvidence: () =>
            preserve(`timing-fifo-${cycle}-${nonce}`, {
              nonce,
              runId,
              blocked,
              drained,
              readerReceipt,
              expectedRequestIds,
              decodedResponses,
              ingressedRequests,
              heldEpochId: heldEpoch?.sampleId,
              epochs,
              trace: trace.filter((item) => item.runId === runId),
              primary: cycleError && { name: cycleError.name, message: cycleError.message },
            }),
          cleanupDirectory: () => rmSync(dir, { recursive: true, force: true }),
        });
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
    primary = finalizeTimingRun({
      primary,
      preserveEvidence: () =>
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
        }),
      cleanupDelivery: () => delivery.cleanup(),
    });
  }
  if (primary) throw primary;
});
