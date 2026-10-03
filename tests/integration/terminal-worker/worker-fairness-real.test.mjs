import { expect, test } from "vitest";
import { installPublicSubscription } from "./worker-subscription-installation.mjs";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { createPipeDecoder, validatePipeFrame } from "../../../packages/protocol/dist/pipe.js";
import {
  budgets,
  command,
  encode,
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
  subscription,
  until,
} from "./pipe-harness.mjs";

test("two real PTYs retain bounded bulk progress while interactive query and control complete", async () => {
  const delivery = installedBin();
  const publicFile = join(delivery.consumerRoot, "qualification-public.mjs");
  writeFileSync(
    publicFile,
    'export { runWorkerPipe } from "@cove/terminal-worker/pipe";\nexport { createWorkerExecution } from "@cove/terminal-worker/execution";\nexport { createNativePtyFactory } from "@cove/terminal-worker/native-adapter";\n',
  );
  const { runWorkerPipe, createWorkerExecution, createNativePtyFactory } = await import(
    pathToFileURL(publicFile).href
  );
  const temp = mkdtempSync(join(tmpdir(), "cove-qual-fairness-"));
  const bulkDir = join(temp, "bulk");
  const interactiveDir = join(temp, "interactive");
  mkdirSync(bulkDir);
  mkdirSync(interactiveDir);
  const bulkNonce = `bulk-${process.pid}-${Date.now()}`;
  const interactiveNonce = `interactive-${process.pid}-${Date.now()}`;
  const ackPath = join(temp, "bulk-ack.sock");
  const evidenceRoot = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  const evidencePath = evidenceRoot ? join(evidenceRoot, `fairness-${bulkNonce}`) : undefined;
  if (evidencePath) mkdirSync(evidencePath, { recursive: true });
  const ingress = new PassThrough();
  const egress = new PassThrough();
  const decoder = createPipeDecoder();
  const messages = [];
  let collectInstallationBytes = true;
  const facts = [];
  const faults = [];
  const flow = [];
  const callbacks = [];
  const ackEvents = [];
  const ackErrors = [];
  let ackSocket;
  let ackHello;
  let ackInput = "";
  let ackSeq = 0;
  let ackPendingBytes = 0;
  const ackServer = createServer((socket) => {
    if (ackSocket) {
      socket.destroy();
      ackErrors.push("second-control-peer");
      return;
    }
    ackSocket = socket;
    socket.on("error", (error) => ackErrors.push(`control-socket:${error.code ?? error.message}`));
    socket.on("data", (chunk) => {
      ackInput += chunk.toString("utf8");
      if (ackInput.length > 4096) {
        ackErrors.push("control-frame-overflow");
        socket.destroy();
        return;
      }
      while (ackInput.includes("\n")) {
        const index = ackInput.indexOf("\n");
        let frame;
        try {
          frame = JSON.parse(ackInput.slice(0, index));
        } catch {
          ackErrors.push("invalid-control-frame");
          socket.destroy();
          return;
        }
        ackInput = ackInput.slice(index + 1);
        if (
          ackHello ||
          frame.type !== "hello" ||
          frame.nonce !== bulkNonce ||
          !Number.isInteger(frame.pid) ||
          !psIdentity(frame.pid)?.includes(bulkNonce)
        ) {
          ackErrors.push("control-peer-identity");
          socket.destroy();
          return;
        }
        ackHello = frame;
        ackEvents.push({ type: "hello", nonce: frame.nonce, pid: frame.pid });
        socket.write(`${JSON.stringify({ type: "start", nonce: bulkNonce })}\n`);
      }
    });
  });
  ackServer.on("error", (error) => ackErrors.push(`control-server:${error.code ?? error.message}`));
  const bulkDigest = createHash("sha256");
  const interactiveRaw = [];
  const native = createNativePtyFactory({
    maxOwners: budgets.maxRuns,
    aggregateInputBytes: budgets.workerBytes,
    aggregateInputTasks: budgets.pendingWorkerCommands,
    perPtyInputBytes: Math.min(budgets.inputQueueBytes, 65_536, budgets.workerBytes),
    perPtyInputTasks: budgets.pendingWorkerCommands,
    earlyOutputBytes: budgets.parseHardBytes,
  });
  const factory = {
    retainedBytesAccounting: "participating",
    snapshot: () => native.snapshot(),
    spawn(spec, observer) {
      const label = spec.args.includes(bulkNonce) ? "bulk" : "interactive";
      const created = native.spawn(spec, {
        ...observer,
        onData(bytes) {
          observer.onData(bytes);
          callbacks.push({ label, bytes: bytes.length });
          if (label !== "bulk") return;
          if (ackSeq >= 768) {
            ackErrors.push("native-output-after-final-ack");
            return;
          }
          if (
            !ackHello ||
            !ackSocket ||
            ackErrors.length ||
            !Buffer.from(bytes).every((byte) => byte === 0x42)
          ) {
            ackErrors.push("native-callback-outside-owned-chunk");
            return;
          }
          ackPendingBytes += bytes.length;
          if (ackPendingBytes > 1024) {
            ackErrors.push("native-callback-crossed-unacknowledged-chunk");
            return;
          }
          if (ackPendingBytes === 1024) {
            ackEvents.push({ type: "ack", nonce: bulkNonce, seq: ackSeq, bytes: ackPendingBytes });
            ackSocket.write(`${JSON.stringify({ type: "ack", nonce: bulkNonce, seq: ackSeq })}\n`);
            ackSeq++;
            ackPendingBytes = 0;
          }
        },
      });
      if (created.kind !== "created") return created;
      const pty = new Proxy(created.pty, {
        get(target, key) {
          if (key === "pause" || key === "resume")
            return () => {
              const before = execution
                ?.snapshot()
                .sessions.find((item) => item.run.runId === label);
              target[key]();
              flow.push({
                label,
                kind: key,
                snapshot: before?.snapshot ?? null,
                parsedBytes: facts
                  .filter((fact) => fact.runId === label && fact.type === "output")
                  .reduce((sum, fact) => sum + fact.bytes, 0),
              });
            };
          const value = target[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return { kind: "created", pty };
    },
  };
  let execution;
  let bulkStart;
  let interactiveStart;
  let bulkIdentity;
  let interactiveIdentity;
  let closed;
  let primary;
  const cleanupErrors = [];
  const metrics = {
    rssStart: process.memoryUsage().rss,
    rssPeak: process.memoryUsage().rss,
    maxEventLoopLagMs: 0,
  };
  let previousTick = performance.now();
  const sampler = setInterval(() => {
    const now = performance.now();
    metrics.maxEventLoopLagMs = Math.max(metrics.maxEventLoopLagMs, now - previousTick - 10);
    metrics.rssPeak = Math.max(metrics.rssPeak, process.memoryUsage().rss);
    previousTick = now;
  }, 10);
  egress.on("data", (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      const read = decoder.read(chunk.subarray(offset));
      if (read.status === "error" || read.consumedBytes <= 0)
        throw Error(`fairness frame decode: ${read.error?.code}`);
      offset += read.consumedBytes;
      for (const item of read.frames) {
        const metadata = JSON.parse(Buffer.from(item.metadata).toString("utf8"));
        if (!validatePipeFrame(item, metadata).ok) throw Error("fairness frame metadata invalid");
        messages.push({
          metadata,
          payloadHex: Buffer.from(item.payload).toString("hex"),
          ...(collectInstallationBytes && metadata.terminal?.type === "baseline-chunk"
            ? { payload: Uint8Array.from(item.payload) }
            : {}),
        });
      }
    }
  });
  const pipe = runWorkerPipe(ingress, egress, {
    buildVersion: "fairness-qualification",
    onFault: (fault) => faults.push(fault),
    onFact: ({ event, bytes }) => {
      if (event.type === "output" && bytes) {
        if (event.run.runId === "bulk") bulkDigest.update(bytes);
        else interactiveRaw.push(Buffer.from(bytes));
      }
      facts.push({
        runId: event.run.runId,
        type: event.type,
        seq: event.seq,
        bytes: bytes?.length ?? 0,
      });
    },
    createExecution(options) {
      execution = createWorkerExecution({ ...options, factory });
      return execution;
    },
  });
  const send = async (metadata, payload) => {
    ingress.write(encode(metadata, payload));
    return (
      await until(
        () => messages.find((item) => item.metadata.requestId === metadata.requestId),
        8000,
        `${metadata.type} reply`,
      )
    ).metadata;
  };
  const preserve = (stage) => {
    if (!evidencePath) return;
    for (const [label, dir] of [
      ["bulk", bulkDir],
      ["interactive", interactiveDir],
    ])
      for (const name of [
        "start.json",
        "stall.json",
        "finish.json",
        "emission-failure.json",
        "initial-emission.json",
      ]) {
        const source = join(dir, name);
        if (existsSync(source)) copyFileSync(source, join(evidencePath, `${label}-${name}`));
      }
    writeFileSync(
      join(evidencePath, `${stage}.json`),
      JSON.stringify(
        {
          bulkNonce,
          interactiveNonce,
          bulkStart,
          interactiveStart,
          bulkIdentity,
          interactiveIdentity,
          bulkCurrentIdentity: bulkStart ? psIdentity(bulkStart.pid) : null,
          interactiveCurrentIdentity: interactiveStart ? psIdentity(interactiveStart.pid) : null,
          messages,
          facts,
          faults,
          flow,
          callbacks,
          ackHello,
          ackEvents,
          ackErrors,
          ackSeq,
          ackPendingBytes,
          interactiveRawHex: Buffer.concat(interactiveRaw).toString("hex"),
          metrics,
          pipe: pipe.snapshot(),
          execution: execution?.snapshot(),
          closed,
        },
        null,
        2,
      ) + "\n",
    );
  };
  const cleanupOwned = async (start, nonce, identity) => {
    if (!start) return;
    const current = psIdentity(start.pid);
    if (current && current !== identity) throw Error(`PTY identity drift: ${current}`);
    await stopPtyIfOwned(start, nonce);
  };
  try {
    await new Promise((resolve, reject) => {
      ackServer.once("error", reject);
      ackServer.listen(ackPath, resolve);
    });
    ingress.write(encode(hello));
    const ready = await until(
      () => messages.find((item) => item.metadata.type === "ready"),
      8000,
      "fairness ready",
    );
    expect(ready.metadata.pipeVersion).toBe(2);
    const bulkRun = run("bulk");
    const bulkSpawn = spawnCommand(
      bulkRun,
      process.execPath,
      [fixture, "bulk", bulkNonce, bulkDir, ackPath],
      repo,
    );
    expect((await send(bulkSpawn.metadata, bulkSpawn.payload)).outcome).toBe("accepted");
    bulkStart = await receipt(join(bulkDir, "start.json"));
    expect(await until(() => ackHello, 8000, "owned bulk acknowledgement peer")).toMatchObject({
      nonce: bulkNonce,
      pid: bulkStart.pid,
    });
    bulkIdentity = psIdentity(bulkStart.pid);
    expect(bulkStart.nonce).toBe(bulkNonce);
    expect(bulkIdentity).toContain(bulkNonce);
    const stall = await receipt(join(bulkDir, "stall.json"), "bulk stall");
    expect(stall.scheduled).toBe(64 * 1024);
    const duringStall = {
      pipe: pipe.snapshot(),
      execution: execution.snapshot(),
      rss: process.memoryUsage().rss,
    };
    preserve("bulk-stall");
    egress.pause();
    const pausedStatus = command("status", bulkRun);
    ingress.write(encode(pausedStatus));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const noConsumerSnapshot = pipe.snapshot();
    expect(noConsumerSnapshot.peakAccountedBytes).toBeLessThanOrEqual(budgets.pipeQueuedBytes);
    egress.resume();
    const pausedReply = await until(
      () => messages.find((item) => item.metadata.requestId === pausedStatus.requestId),
      8000,
      "paused-reader status reply",
    );
    expect(pausedReply.metadata.runStatus.status).toBe("live");
    metrics.noConsumerSnapshot = noConsumerSnapshot;

    const interactiveRun = run("interactive");
    const secondStartTime = performance.now();
    const interactiveSpawn = spawnCommand(
      interactiveRun,
      process.execPath,
      [fixture, "interactive", interactiveNonce, interactiveDir],
      repo,
    );
    expect((await send(interactiveSpawn.metadata, interactiveSpawn.payload)).outcome).toBe(
      "accepted",
    );
    interactiveStart = await receipt(join(interactiveDir, "start.json"));
    const initialEmission = await receipt(join(interactiveDir, "initial-emission.json"));
    expect(initialEmission).toMatchObject({
      nonce: interactiveNonce,
      pid: interactiveStart.pid,
      ok: true,
      length: 7,
      hex: "410080ffe282ac",
    });
    interactiveIdentity = psIdentity(interactiveStart.pid);
    expect(interactiveStart.nonce).toBe(interactiveNonce);
    expect(interactiveIdentity).toContain(interactiveNonce);
    const holder = subscription(interactiveRun);
    const installation = await installPublicSubscription({
      subscription: holder,
      command,
      frames: messages,
      send,
    }).finally(() => {
      collectInstallationBytes = false;
      for (const frame of messages) delete frame.payload;
    });
    expect(installation.marker.atSeq).toBe(installation.descriptor.atSeq);
    expect(installation.ack.outcome).toBe("accepted");
    const markerIndex = messages.findIndex(
      (frame) =>
        frame.metadata.type === "result" &&
        frame.metadata.requestId === installation.marker.requestId,
    );
    const startIndex = messages.findIndex(
      (frame) =>
        frame.metadata.terminal?.type === "baseline-start" &&
        frame.metadata.terminal.descriptor.baselineId === installation.descriptor.baselineId,
    );
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(markerIndex);
    const control = command("set-control", interactiveRun, {
      expectedEpoch: 0,
      nextEpoch: 1,
      holder: {
        connection: holder.connection,
        viewId: holder.viewId,
        subscriptionId: holder.subscriptionId,
      },
      geometry,
    });
    expect((await send(control)).outcome).toBe("accepted");
    const input = command("input", interactiveRun, { subscription: holder, epoch: 1, inputSeq: 1 });
    const inputBytes = Buffer.from([0, 0x80, 0xff, 0xe2, 0x82, 0xac, 0x51]);
    const written = await send(input, inputBytes);
    expect(written).toMatchObject({ outcome: "accepted", inputSeq: 1, writtenBytes: 7 });
    const finished = await receipt(join(interactiveDir, "finish.json"), "interactive finish");
    const interactiveLatencyMs = performance.now() - secondStartTime;
    expect(finished.receivedHex).toContain("1b5b306e0080ffe282ac51");
    expect(existsSync(join(bulkDir, "finish.json"))).toBe(false);
    expect(psIdentity(bulkStart.pid)).toBe(bulkIdentity);
    preserve("interactive-before-bulk-finish");

    const bulkFinish = await receipt(join(bulkDir, "finish.json"), "bulk finish");
    expect(bulkFinish).toMatchObject({
      nonce: bulkNonce,
      pid: bulkStart.pid,
      scheduled: 768 * 1024,
      emitted: 768 * 1024,
      callbackError: null,
      acknowledged: 768,
      chunks: 768,
    });
    await until(
      () =>
        facts
          .filter((fact) => fact.runId === "bulk" && fact.type === "output")
          .reduce((sum, fact) => sum + fact.bytes, 0) >=
        768 * 1024,
      8000,
      "bulk parsed output",
    );
    const bulkOutput = facts.filter((fact) => fact.runId === "bulk" && fact.type === "output");
    expect(bulkOutput.reduce((sum, fact) => sum + fact.bytes, 0)).toBe(768 * 1024);
    expect(bulkDigest.digest("hex")).toBe(bulkFinish.sha256);
    expect(Buffer.concat(interactiveRaw).subarray(0, 7).toString("hex")).toBe("410080ffe282ac");
    expect(callbacks.filter((item) => item.label === "bulk").length).toBeGreaterThanOrEqual(768);
    expect(ackErrors).toEqual([]);
    expect(ackSeq).toBe(768);
    expect(ackPendingBytes).toBe(0);
    expect(flow.some((item) => item.label === "bulk" && item.kind === "pause")).toBe(true);
    expect(flow.some((item) => item.label === "bulk" && item.kind === "resume")).toBe(true);
    const itemPauses = flow.filter((item) => item.label === "bulk" && item.kind === "pause");
    expect(
      itemPauses.some(
        (item) =>
          item.snapshot &&
          item.snapshot.queuedItems >= 192 &&
          item.snapshot.queuedItems < 256 &&
          item.snapshot.queuedBytes < budgets.parseHighBytes,
      ),
    ).toBe(true);
    const itemResumes = flow.filter((item) => item.label === "bulk" && item.kind === "resume");
    expect(
      itemResumes.every(
        (item) =>
          item.snapshot &&
          item.snapshot.queuedItems <= 64 &&
          item.snapshot.queuedBytes <= budgets.parseLowBytes,
      ),
    ).toBe(true);
    expect(
      itemResumes.some((resume) =>
        itemPauses.some((pause) => resume.parsedBytes > pause.parsedBytes),
      ),
    ).toBe(true);
    for (const id of ["bulk", "interactive"]) {
      const ordered = facts.filter((fact) => fact.runId === id).map((fact) => fact.seq);
      expect(ordered).toEqual([...new Set(ordered)].sort((a, b) => a - b));
    }
    const bulkStatus = command("status", bulkRun);
    expect((await send(bulkStatus)).runStatus.status).toBe("live");
    expect(await until(() => !psIdentity(interactiveStart.pid), 8000, "interactive exit")).toBe(
      true,
    );
    let secondStatus;
    const peerDeadline = performance.now() + 8000;
    do {
      const interactiveStatus = command("status", interactiveRun);
      secondStatus = await send(interactiveStatus);
      if (secondStatus.runStatus.status === "exited") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (performance.now() < peerDeadline);
    expect(secondStatus.runStatus).toMatchObject({ status: "exited", exitCode: 23 });
    const bounded = {
      pipe: pipe.snapshot(),
      execution: execution.snapshot(),
      interactiveLatencyMs,
    };
    expect(faults).toEqual([]);
    expect(bounded.pipe.peakAccountedBytes).toBeLessThanOrEqual(budgets.pipeQueuedBytes);
    expect(bounded.execution.peakAccountedBytes).toBeLessThanOrEqual(budgets.workerBytes);
    for (const item of bounded.execution.sessions)
      expect(item.snapshot.peakQueuedBytes).toBeLessThanOrEqual(budgets.parseHardBytes);
    metrics.rssEnd = process.memoryUsage().rss;
    metrics.interactiveLatencyMs = interactiveLatencyMs;
    metrics.interactiveLatencyAttribution =
      "interactive spawn-to-finish receipt including legal subscription installation";
    metrics.bulkParsedBytes = bulkOutput.reduce((sum, fact) => sum + fact.bytes, 0);
    metrics.duringStall = duringStall;
    metrics.bounded = bounded;
    const stop = command("stop", bulkRun, { operationId: "stop-bulk" });
    expect((await send(stop)).outcome).toBe("accepted");
    expect(await until(() => !psIdentity(bulkStart.pid), 8000, "bulk PTY exit")).toBe(true);
    expect(await until(() => !psIdentity(interactiveStart.pid), 8000, "interactive PTY exit")).toBe(
      true,
    );
  } catch (error) {
    primary = error;
  } finally {
    clearInterval(sampler);
    try {
      preserve("before-cleanup");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      closed = await pipe.shutdown("fairness-qualification-end");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      ackSocket?.destroy();
      if (ackServer.listening) await new Promise((resolve) => ackServer.close(resolve));
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await cleanupOwned(bulkStart, bulkNonce, bulkIdentity);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await cleanupOwned(interactiveStart, interactiveNonce, interactiveIdentity);
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
      "fairness owned cleanup uncertain",
    );
  if (primary) throw primary;
});
