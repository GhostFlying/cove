import assert from "node:assert/strict";
import { test } from "vitest";
import { M0_LIMITS, validateEffectiveBudgets } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import { RPC_METHODS } from "@cove/protocol/rpc";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { WorkerPool } from "../../dist/terminal/worker-pool.js";
import { RunRegistry } from "../../dist/terminal/run-registry.js";
import { LocalRuntime } from "../../dist/terminal/local-runtime.js";
import {
  WorkerPipeSession,
  SESSION_CONTROL_RESERVE,
} from "../../dist/terminal/worker-pipe-session.js";
import { PreviewCollector, publishPreview } from "../../dist/terminal/preview-transfer.js";
import { TerminalConnectionDelivery } from "../../dist/terminal/terminal-connection-delivery.js";
import { TerminalCommandService } from "../../dist/terminal/terminal-command-service.js";
import { ControlArbiter } from "../../dist/terminal/control-arbiter.js";
import {
  carrier,
  clocks,
  codec,
  copy,
  joinBytes,
  pipeBytes,
  recordRow,
  turns,
  utf8,
  decodeBytes,
} from "./preview-byte-harness.mjs";

const geometry = { cols: 80, rows: 24 };
const sample = utf8("\u001b[31m预览\u001b[0m");
function fixture(options = {}) {
  const budget = { ...M0_LIMITS, ...options.budgets };
  assert.ok(validateEffectiveBudgets(budget));
  const clock = clocks();
  const workers = options.workers ?? 1;
  const account = new RuntimeRetainedBytes(budget.runtimeBytes, workers * SESSION_CONTROL_RESERVE);
  const composition = new RuntimeComposition("qa-server", "qa-instance", budget, account);
  const pool = new WorkerPool(composition, workers, budget.maxRuns);
  const registry = new RunRegistry(composition);
  const services = [];
  const runtime = new LocalRuntime(
    pool,
    registry,
    utf8,
    (result) => services.some((service) => service.handoff(result)),
    {
      now: clock.now,
      wallNow: clock.wallNow,
      cadenceMs: 100,
      staggerMs: 5,
      expiryMs: 50,
      waiterLimit: 3,
      identityLimit: 256,
      ...options.policy,
    },
  );
  const observedCommands = [];
  const pipeReads = [];
  const ledgerSamples = [];
  const read = (session, bytes) => {
    pipeReads.push(Buffer.from(bytes).toString("base64"));
    ledgerSamples.push(account.snapshot());
    const consumed = session.receive(bytes);
    ledgerSamples.push(account.snapshot());
    return consumed;
  };
  const sessions = [];
  const ports = [];
  const readers = [];
  const deliveries = [];
  const extras = [];
  for (let i = 0; i < workers; i++) {
    const worker = {
      serverId: "qa-server",
      relayInstanceId: "qa-instance",
      workerId: "worker" + i,
      workerIncarnationId: "incarnation1",
    };
    const port = carrier({
      onWrite: (entry) =>
        observedCommands.push(...decodeBytes(entry.bytes).map((frame) => frame.metadata)),
    });
    const session = new WorkerPipeSession({
      worker,
      composition,
      buildVersion: "qa",
      transport: port,
      codec,
      now: clock.now,
      timeoutMs: 1000,
      identityLimit: 4096,
      contactLost: (ref) => registry.contactLost(ref),
    });
    assert.equal(session.start(), true);
    read(
      session,
      pipeBytes({
        type: "ready",
        worker,
        pipeVersion: 2,
        buildVersion: "qa",
        effectiveBudgets: budget,
      }),
    );
    assert.equal(runtime.addWorker(session), true);
    sessions.push(session);
    ports.push(port);
  }
  const runs = [];
  const status = (run, seq = 1, patch = {}) => ({
    run,
    status: "live",
    geometry,
    controlEpoch: 0,
    controlHolder: null,
    receivedSeq: seq,
    parsedSeq: seq,
    recovery: "ready",
    exitCode: null,
    signal: null,
    ...patch,
  });
  const f = {
    budget,
    clock,
    account,
    composition,
    pool,
    registry,
    runtime,
    sessions,
    ports,
    readers,
    deliveries,
    extras,
    runs,
    status,
    add(id = "run" + runs.length) {
      const run = { serverId: "qa-server", relayInstanceId: "qa-instance", runId: id };
      const worker = runtime.reserveRun(run, geometry);
      if (!worker) return null;
      runs.push(run);
      assert.equal(registry.observe(worker, status(run)), true);
      return run;
    },
    placement(run) {
      return pool.get(run);
    },
    commands() {
      return observedCommands.filter((m) => m.type !== "hello");
    },
    latest(run, type) {
      return f
        .commands()
        .filter((m) => m.type === type && m.run.runId === run.runId)
        .at(-1);
    },
    send(run, metadata, payload) {
      return read(f.placement(run).session, pipeBytes(metadata, payload));
    },
    result(command, fields = {}) {
      return {
        type: "result",
        worker: command.worker,
        run: command.run,
        requestId: command.requestId,
        commandType: command.type,
        outcome: "accepted",
        ...fields,
      };
    },
    async begin(run, seq = 2, patch = {}) {
      const promise = runtime.previews.refresh(run);
      await turns();
      const command = f.latest(run, "status");
      assert.ok(command);
      f.send(run, f.result(command, { runStatus: status(run, seq, patch) }));
      await turns();
      return { promise, command: f.latest(run, "preview-refresh") };
    },
    frames(run, command, vt = sample, version = 2) {
      const common = { run: copy(run), previewId: "transfer-" + command.requestId, version };
      const event = (terminal, payload = new Uint8Array()) => [
        { type: "terminal-event", worker: command.worker, run: copy(run), terminal },
        payload,
      ];
      return [
        event({
          type: "preview-start",
          ...common,
          atSeq: version,
          geometry,
          generatedAtMs: 900,
          vtBytes: vt.length,
          chunkCount: 1,
        }),
        event({ type: "preview-chunk", ...common, ordinal: 0 }, vt),
        event({ type: "preview-end", ...common, totalBytes: vt.length, atSeq: version }),
        [f.result(command, { previewVersion: version }), new Uint8Array()],
      ];
    },
    feed(run, frames, mode = "separate") {
      const bytes = frames.map(([m, b]) => pipeBytes(m, b));
      const session = f.placement(run).session;
      if (mode === "coalesced") read(session, joinBytes(bytes));
      else if (mode === "split")
        for (const raw of bytes) {
          read(session, raw.slice(0, 7));
          read(session, raw.slice(7, 19));
          read(session, raw.slice(19));
        }
      else for (const raw of bytes) read(session, raw);
    },
    async seed(run, vt = sample, version = 1, generatedAtMs = 900) {
      const job = await f.begin(run, version);
      assert.ok(job.command);
      const frames = f.frames(run, job.command, vt, version);
      frames[0][0].terminal.generatedAtMs = generatedAtMs;
      f.feed(run, frames);
      assert.deepEqual(await job.promise, { ok: true });
      await turns();
    },
    picture(run) {
      const reader = runtime.previews.cache.acquire(run);
      if (!reader) return null;
      const result = { ...reader.picture, vt: Array.from(reader.picture.vt) };
      reader.release();
      return result;
    },
    hold(run) {
      const reader = runtime.previews.cache.acquire(run);
      assert.ok(reader);
      readers.push(reader);
      return reader;
    },
    delivery(port = carrier(), id = "connection" + deliveries.length) {
      const delivery = new TerminalConnectionDelivery(composition, {
        connection: { connectionId: id, generation: 1 },
        transport: port,
        encodeUtf8: utf8,
        itemLimit: 32,
      });
      deliveries.push({ delivery, port });
      return { delivery, port };
    },
    service(port = carrier(), id, requestLimit = 256) {
      if (!f.arbiter) {
        f.arbiter = new ControlArbiter(runtime);
        extras.push(() => f.arbiter.dispose());
      }
      const { delivery } = f.delivery(port, id);
      let sequence = 0;
      const service = new TerminalCommandService(composition, runtime, delivery, f.arbiter, {
        createOpaqueId: () => "external" + ++sequence,
        now: clock.now,
        identityLimit: 256,
        requestLimit,
      });
      services.push(service);
      extras.push(() => service.close());
      return { service, delivery, port };
    },
    async installed(route, run = runs[0]) {
      const command = {
        type: "attach",
        requestId: "attach-" + route.delivery.connection.connectionId,
        run,
        connection: route.delivery.connection,
        viewId: "view",
        profile: "pragmatic-logical-grid-v1",
        encoding: "vt-checkpoint-tail-v1",
        resume: {
          appliedSeq: 1,
          profile: "pragmatic-logical-grid-v1",
          encoding: "vt-checkpoint-tail-v1",
          geometry,
        },
      };
      const pending = route.service.handle(command);
      await turns();
      const emitted = f.latest(run, "subscribe");
      assert.ok(emitted);
      f.send(run, f.result(emitted, { recoveryMode: "replay", atSeq: 1 }));
      const reply = await pending;
      assert.equal(reply.type, "attach-result");
      return reply.subscription;
    },
    effects() {
      return {
        rawPipeReadsBase64: pipeReads,
        ledgerSamples,
        observedPeakTotal: Math.max(0, ...ledgerSamples.map((s) => s.total)),
        externalBytesBase64: deliveries.map(({ port }) =>
          port.writes.map((w) => Buffer.from(w.bytes).toString("base64")),
        ),
        commands: f.commands(),
        pictures: runs.map((run) => ({ run, picture: f.picture(run) })),
        ledger: account.snapshot(),
        preview: runtime.previews.snapshot(),
        pipes: sessions.map((s) => ({ closed: s.closed, ...s.snapshot() })),
      };
    },
    async dispose() {
      for (const cleanup of extras) cleanup();
      runtime.dispose();
      for (const { delivery, port } of deliveries) {
        delivery.close();
        port.settle();
        delivery.transportReleased();
      }
      for (const session of sessions) {
        session.loseContact();
        session.transportReleased();
      }
      for (const reader of readers) {
        reader.release();
        reader.release();
      }
      registry.dispose();
      pool.dispose();
      await turns();
      assert.equal(
        account.snapshot().total,
        0,
        "all actually released QA owners must return the common ledger to zero",
      );
    },
  };
  for (let i = 0; i < (options.runs ?? 1); i++) assert.ok(f.add());
  return f;
}
function unchangedBytes(before, after) {
  assert.ok(after);
  assert.deepEqual(after.vt, before.vt);
  assert.equal(after.version, before.version);
  assert.equal(after.generatedAtMs, before.generatedAtMs);
}
function noPreviewEffects(f, start = 0) {
  assert.ok(
    f
      .commands()
      .slice(start)
      .every((m) => ["status", "preview-refresh"].includes(m.type)),
  );
}
function completeEffect(effect) {
  assert.ok(
    effect.end &&
      effect.result &&
      effect.commitPosition >= effect.resultPosition &&
      effect.commitPosition >= effect.endPosition,
    "premature cache publication",
  );
}
function unchangedEffect(effect) {
  assert.ok(
    effect.owned && effect.currentProof,
    "fabricated unchanged without owned picture/current proof",
  );
}
function lifetimeEffect(effect) {
  assert.ok(!(effect.held && effect.debt === 0), "premature physical release");
  assert.equal(effect.lateMutation, false, "late mutation");
  assert.equal(effect.resurrected, false, "closed route resurrection");
}
async function rows(prefix, definitions) {
  const failures = [];
  for (const [suffix, body] of definitions) {
    const id = prefix + "/" + suffix;
    let f;
    let effect;
    try {
      f = body.fixture?.() ?? fixture(body.options);
      await body.run(f);
      effect = f.effects();
      await f.dispose();
      recordRow(id, "passed", { ...effect, finalLedger: f.account.snapshot() });
    } catch (error) {
      effect ??= f?.effects();
      try {
        await f?.dispose();
      } catch (cleanup) {
        effect = { ...effect, cleanupFailure: String(cleanup) };
      }
      recordRow(id, "failed", {
        ...effect,
        finalLedger: f?.account.snapshot(),
        error: String(error),
        stack: error.stack,
      });
      failures.push(id + ": " + error.message);
    }
  }
  assert.deepEqual(failures, [], "independent semantic rows failed");
}
const body = (run, options) => ({ run, options });
const valid = async (f, mode = "separate") => {
  const run = f.runs[0];
  const job = await f.begin(run);
  assert.ok(job.command);
  const frames = f.frames(run, job.command);
  let commitPosition = 0;
  if (mode === "separate") {
    for (let position = 0; position < frames.length; position++) {
      f.feed(run, [frames[position]]);
      if (!commitPosition && f.runtime.previews.cache.getRecord(run).preview.version === 2)
        commitPosition = position + 1;
    }
  } else {
    f.feed(run, frames, mode);
    if (f.runtime.previews.cache.getRecord(run).preview.version === 2) commitPosition = 4;
  }
  f.commitObservation = {
    end: true,
    result: true,
    endPosition: 3,
    resultPosition: 4,
    commitPosition,
  };
  completeEffect(f.commitObservation);
  assert.deepEqual(await job.promise, { ok: true });
  assert.deepEqual(f.picture(run).vt, Array.from(sample));
  noPreviewEffects(f);
};

test("C-01 commits only complete result-last transfer", async () => {
  await rows("C-01", [
    ["V1", body((f) => valid(f))],
    ["V2", body((f) => valid(f, "split"))],
    ...["M1", "M2"].map((id) => [
      id,
      body(async (f) => {
        const run = f.runs[0];
        const job = await f.begin(run);
        const frames = f.frames(run, job.command);
        const count = id === "M1" ? 3 : 1;
        f.feed(run, frames.slice(0, count));
        assert.equal(f.picture(run), null);
        f.feed(run, frames.slice(count));
        assert.deepEqual(await job.promise, { ok: true });
        assert.deepEqual(f.picture(run).vt, Array.from(sample));
      }),
    ]),
  ]);
});

test("C-02 rejects foreign complete preview identities", async () => {
  const defs = [
    [
      "V1",
      body(async (f) => {
        await f.seed(f.runs[0]);
        await valid(f);
      }),
    ],
  ];
  for (let i = 1; i <= 8; i++)
    defs.push([
      "M" + i,
      body(async (f) => {
        const run = f.runs[0];
        await f.seed(run);
        const old = f.picture(run);
        const job = await f.begin(run);
        const frames = f.frames(run, job.command);
        if (i <= 5) {
          const target = frames[0][0];
          if (i === 1) {
            target.run.runId = "foreign";
            target.terminal.run.runId = "foreign";
          }
          if (i === 2 || i === 3) {
            const key = i === 2 ? "serverId" : "relayInstanceId";
            target.run[key] = "foreign";
            target.terminal.run[key] = "foreign";
            target.worker = { ...target.worker, [key]: "foreign" };
          }
          if (i === 4) target.worker = { ...target.worker, workerId: "foreign" };
          if (i === 5) target.worker = { ...target.worker, workerIncarnationId: "incarnation2" };
        } else if (i === 6) frames[3][0].requestId = "foreign";
        else if (i === 7) frames[1][0].terminal.previewId = "foreign";
        else frames[1][0].terminal.version++;
        f.feed(run, frames);
        const result = await job.promise;
        assert.equal(result.ok, false);
        unchangedBytes(old, f.picture(run));
        assert.equal(f.sessions[0].closed, i <= 6);
        noPreviewEffects(f);
      }),
    ]);
  await rows("C-02", defs);
});

test("C-03 preserves last picture after partial or invalid transfer", async () => {
  const defs = [
    [
      "V1",
      body(async (f) => {
        await f.seed(f.runs[0]);
        await valid(f);
      }),
    ],
  ];
  for (let i = 1; i <= 14; i++)
    defs.push([
      "M" + i,
      body(async (f) => {
        const run = f.runs[0];
        await f.seed(run);
        const old = f.picture(run);
        let subscription;
        if (i === 10) {
          subscription = {
            run,
            connection: { connectionId: "active", generation: 1 },
            viewId: "view",
            subscriptionId: "sub",
          };
          const command = {
            type: "subscribe",
            worker: f.placement(run).worker,
            run,
            requestId: "install-sub",
            subscription,
            atSeq: 1,
          };
          const result = f.sessions[0].request(command, undefined, () => true);
          f.send(run, f.result(command, { recoveryMode: "replay", atSeq: 1 }));
          assert.equal((await result).outcome, "accepted");
        }
        const job = await f.begin(run);
        const frames = f.frames(run, job.command);
        if (i <= 3) frames.splice(i - 1, 1);
        if (i === 4) frames.splice(2, 0, copy(frames[1]));
        if (i === 5) frames[1][0].terminal.ordinal = 1;
        if (i === 6) frames[0][0].terminal.vtBytes++;
        if (i === 7) frames[1][1] = sample.slice(0, -1);
        if (i === 8) frames[2][0].terminal.totalBytes++;
        if (i === 9) frames[2][0].terminal.atSeq++;
        if (i === 10) frames[0][0].subscription = subscription;
        if (i === 11) frames.splice(1, 0, copy(frames[0]));
        if (i === 12) frames.splice(3, 0, copy(frames[2]));
        if (i === 13) frames[3][0].previewVersion++;
        if (i === 14) frames[0][0].terminal.chunkCount = 2;
        f.feed(run, frames);
        assert.equal((await job.promise).ok, false);
        unchangedBytes(old, f.picture(run));
        assert.equal(f.sessions[0].closed, [5, 10, 14].includes(i));
      }),
    ]);
  await rows("C-03", defs);
});

test("C-04 seals at actual coalesced result position", async () => {
  const defs = [
    ["V1", body((f) => valid(f))],
    [
      "V2",
      body(async (f) => {
        const job = await f.begin(f.runs[0]);
        const frames = f.frames(f.runs[0], job.command);
        f.feed(f.runs[0], frames.slice(0, 2));
        f.feed(f.runs[0], frames.slice(2), "coalesced");
        assert.equal((await job.promise).ok, true);
      }),
    ],
    ["V3", body((f) => valid(f, "coalesced"))],
  ];
  for (let i = 1; i <= 4; i++)
    defs.push([
      "M" + i,
      body(async (f) => {
        const run = f.runs[0];
        await f.seed(run);
        const old = f.picture(run);
        const job = await f.begin(run);
        const frames = f.frames(run, job.command);
        if (i === 1) {
          f.feed(run, frames.slice(0, 2));
          f.feed(run, [frames[3], frames[2]], "coalesced");
        }
        if (i === 2) f.feed(run, [frames[3], ...frames.slice(0, 3)], "coalesced");
        if (i === 3) {
          const appended = f.frames(run, job.command, utf8("late"), 3).slice(0, 3);
          appended.forEach(([m]) => (m.terminal.previewId += ".late"));
          f.feed(run, [...frames, ...appended], "coalesced");
        }
        if (i === 4) {
          f.feed(run, [frames[0], frames[1], frames[3]]);
          await turns();
          f.feed(run, [frames[2]]);
        }
        assert.equal((await job.promise).ok, i === 3);
        if (i !== 3) unchangedBytes(old, f.picture(run));
        else assert.deepEqual(f.picture(run).vt, Array.from(sample));
      }),
    ]);
  await rows("C-04", defs);
});

test("C-05 reuses unchanged picture with current status proof", async () => {
  const defs = [];
  for (const id of ["V1", "V2", "M1", "M2", "M3", "M4", "M5", "M6"])
    defs.push([
      id,
      body(async (f) => {
        const run = f.runs[0];
        await f.seed(run, sample, 1, id === "M6" ? 900000000 : 900);
        const old = f.picture(run);
        const count = f.commands().length;
        f.clock.set(10, id === "M5" ? 500 : 1200);
        if (id === "V2") {
          const command = {
            type: "preview-refresh",
            worker: f.placement(run).worker,
            run,
            requestId: "unchanged-direct",
            knownVersion: 1,
          };
          const collector = new PreviewCollector(
            f.runtime.previews.cache,
            run,
            command.worker,
            command.requestId,
            f.status(run),
            () => true,
            () => true,
          );
          let accepted;
          const promise = f.runtime.requestPreviewSealed(command, (result) => {
            accepted = collector.seal(result, 1200);
          });
          f.send(run, f.result(command, { previewVersion: 1 }));
          await promise;
          assert.equal(accepted, true);
          collector.dispose();
        } else {
          const promise = f.runtime.previews.refresh(run);
          await turns();
          const statusCommand = f.latest(run, "status");
          if (id === "M3") {
            assert.equal(f.commands().length, count + 1);
            assert.equal(f.picture(run).checkedAtMs, old.checkedAtMs);
            f.clock.set(60);
            f.runtime.tickPreviews();
            assert.equal((await promise).ok, false);
            f.sessions[0].loseContact();
          } else {
            const changed = ["M1", "M2", "M4"].includes(id);
            const patch = id === "M4" ? { geometry: { cols: 81, rows: 24 } } : {};
            f.send(
              run,
              f.result(statusCommand, { runStatus: f.status(run, changed ? 2 : 1, patch) }),
            );
            await turns();
            if (changed) {
              assert.equal(f.commands().length, count + 2);
              const preview = f.latest(run, "preview-refresh");
              f.send(run, f.result(preview, { previewVersion: id === "M2" ? 3 : 1 }));
              assert.equal((await promise).ok, false);
            } else {
              assert.equal((await promise).ok, true);
              assert.equal(f.commands().length, count + 1);
              assert.equal(f.picture(run).checkedAtMs, id === "M5" ? 500 : 1200);
            }
          }
        }
        unchangedBytes(old, f.picture(run));
        noPreviewEffects(f);
        if (id === "V1" || id === "V2")
          unchangedEffect({
            owned: !!f.picture(run),
            currentProof: f.registry.get(run).status.parsedSeq === 1,
          });
        if (id === "M6") assert.equal(f.picture(run).generatedAtMs, 900000000);
      }),
    ]);
  await rows("C-05", defs);
});

test("C-06 never reports unchanged without owned bytes", async () => {
  const defs = [];
  for (const id of ["V1", "M1", "M2", "M3", "M4"])
    defs.push([
      id,
      body(async (f) => {
        const run = f.runs[0];
        if (id === "M2") {
          const failed = await f.begin(run);
          f.feed(run, [f.frames(run, failed.command)[3]]);
          assert.equal((await failed.promise).ok, false);
          await turns();
        }
        if (id === "M3" || id === "M4") {
          await f.seed(run, sample, 7);
          if (id === "M3") f.runtime.previews.cache.dispose();
        }
        const route = f.service();
        const pending = route.service.handle({
          type: "preview",
          requestId: "caller-hint",
          run,
          knownVersion: id === "M4" ? 8 : 7,
        });
        await turns();
        const statusCommand = f.latest(run, "status");
        f.send(run, f.result(statusCommand, { runStatus: f.status(run, 7) }));
        await turns();
        if (id !== "M4") {
          const command = f.latest(run, "preview-refresh");
          assert.ok(command);
          assert.equal(command.knownVersion, undefined);
          if (id === "V1") f.feed(run, f.frames(run, command, sample, 7));
          else f.send(run, f.result(command, { previewVersion: 7 }));
        }
        const result = await pending;
        if (id === "V1") {
          assert.equal(result.type, "preview-result");
          assert.equal(
            result.status,
            "transfer",
            "fresh caller hint cannot replace a full transfer after obtaining its first owned picture",
          );
        } else {
          assert.equal(result.type, "error");
          if (id !== "M4") assert.equal(f.picture(run), null);
          else assert.equal(result.error.kind, "RESYNC_REQUIRED");
        }
        noPreviewEffects(f);
      }),
    ]);
  await rows("C-06", defs);
});

async function drive(f, heldRun) {
  const answered = new Set();
  for (let tick = 0; tick < 9; tick++) {
    f.clock.set(tick * 5);
    f.runtime.tickPreviews();
    await turns();
    for (const command of f.commands()) {
      if (answered.has(command.requestId)) continue;
      if (command.type === "status") {
        answered.add(command.requestId);
        f.send(command.run, f.result(command, { runStatus: f.status(command.run, 2) }));
      }
    }
    await turns();
    for (const command of f.commands())
      if (
        command.type === "preview-refresh" &&
        !answered.has(command.requestId) &&
        command.run.runId !== heldRun?.runId
      ) {
        answered.add(command.requestId);
        f.feed(command.run, f.frames(command.run, command, utf8(command.run.runId), 2));
      }
    await turns();
    assert.ok(f.runtime.previews.snapshot().active <= f.budget.previewRefreshes);
  }
}

test("C-07 refreshes active hidden and never-subscribed runs fairly", async () => {
  const options = { runs: 3, workers: 3 };
  const defs = [];
  for (const id of ["V1", "V2", "M1", "M2", "M3", "M4"])
    defs.push([
      id,
      body(async (f) => {
        const route = f.service();
        const subscription = await f.installed(route);
        const hidden = f.service();
        await f.installed(hidden, f.runs[1]);
        hidden.service.close();
        await turns();
        const teardown = f.latest(f.runs[1], "unsubscribe");
        if (teardown) f.send(f.runs[1], f.result(teardown));
        await turns();
        f.runtime.previews.snapshot();
        const start = f.commands().length;
        if (id === "V2") {
          const before = f.account.snapshot().total;
          f.runtime.previews.cache.list({ limit: 3 });
          f.runtime.previews.cache.getRecord(f.runs[2]);
          assert.equal(f.commands().length, start);
          assert.equal(f.account.snapshot().total, before);
          return;
        }
        if (id === "M3") {
          f.clock.set(0, 500000);
          f.runtime.tickPreviews();
          await turns();
          const count = f.commands().length;
          f.clock.set(0, 900000);
          f.runtime.tickPreviews();
          await turns();
          assert.equal(f.commands().length, count);
        } else {
          if (id === "M2") {
            const run = f.runs[0];
            f.feed(run, [
              [
                {
                  type: "terminal-event",
                  worker: f.placement(run).worker,
                  run,
                  subscription,
                  terminal: { type: "output", run, seq: 2 },
                },
                utf8("active-output"),
              ],
            ]);
          }
          await drive(f, id === "M1" ? f.runs[0] : undefined);
          for (const run of f.runs.slice(id === "M1" ? 1 : 0)) {
            assert.equal(f.picture(run).version, 2);
            assert.deepEqual(f.picture(run).vt, Array.from(utf8(run.runId)));
          }
          if (id === "M4") {
            const count = f.runtime.previews.snapshot();
            for (let i = 0; i < 20; i++) f.runtime.tickPreviews();
            assert.deepEqual(f.runtime.previews.snapshot(), count);
          }
        }
        noPreviewEffects(f, start);
      }, options),
    ]);
  await rows("C-07", defs);
});

test("C-08 bounds jobs waiters and same-run concurrency", async () => {
  const lower = {
    runs: 3,
    workers: 2,
    budgets: {
      maxRuns: 3,
      listPage: 3,
      previewBytesPerRun: 32,
      previewGlobalBytes: 96,
      previewRefreshes: 2,
    },
  };
  const defs = [];
  for (const id of ["V1", "V2", "M1", "M2", "M3", "M4", "M5"])
    defs.push([
      id,
      body(
        async (f) => {
          if (["V1", "V2", "M1"].includes(id)) {
            const count = f.budget.previewRefreshes;
            const requests = f.runs.slice(0, count).map((run) => f.runtime.previews.request(run));
            assert.equal(f.runtime.previews.snapshot().active, count);
            if (id === "M1") {
              assert.equal((await f.runtime.previews.refresh(f.runs[4])).ok, false);
              assert.equal(f.runtime.previews.snapshot().active, 4);
            }
            for (const request of requests) request.cancel();
            await turns();
            f.sessions.forEach((s) => s.loseContact());
            return;
          }
          const run = f.runs[0];
          if (id === "M2" || id === "M3" || id === "M5") {
            let reentrant;
            if (id === "M5")
              f.clock.hook(() => {
                reentrant = f.runtime.previews.request(run);
              });
            const a = f.runtime.previews.request(run);
            const b = f.runtime.previews.request(run);
            const c = reentrant ?? f.runtime.previews.request(run);
            assert.equal(f.runtime.previews.snapshot().active, 1);
            assert.equal(f.runtime.previews.snapshot().waiters, 3);
            if (id === "M3") assert.equal((await f.runtime.previews.refresh(run)).ok, false);
            if (id === "M5") {
              f.runtime.tickPreviews();
              f.runtime.tickPreviews();
              assert.equal(f.runtime.previews.snapshot().waiters, 3);
            }
            await turns();
            const command = f.latest(run, "status");
            f.send(run, f.result(command, { runStatus: f.status(run, 2) }));
            await turns();
            const preview = f.latest(run, "preview-refresh");
            assert.equal(
              f.commands().filter((m) => m.type === "preview-refresh" && m.run.runId === run.runId)
                .length,
              1,
            );
            f.feed(run, f.frames(run, preview));
            assert.ok((await a.promise).ok && (await b.promise).ok && (await c.promise).ok);
          } else {
            const job = await f.begin(run);
            const other = f.runs[1];
            const healthy = await f.begin(other);
            f.feed(other, f.frames(other, healthy.command));
            assert.equal((await healthy.promise).ok, true);
            const command = {
              type: "status",
              worker: f.placement(run).worker,
              run,
              requestId: "independent-status",
            };
            const statusPromise = f.runtime.getStatus(command);
            f.send(run, f.result(command, { runStatus: f.status(run, 2) }));
            assert.equal((await statusPromise).outcome, "accepted");
            f.feed(run, f.frames(run, job.command));
            assert.equal((await job.promise).ok, true);
            await turns();
            const held = carrier({ hold: true });
            const publication = f.service(held);
            const pending = publication.service.handle({ type: "preview", requestId: "slow", run });
            await turns();
            const statusCommand = f.latest(run, "status");
            f.send(run, f.result(statusCommand, { runStatus: f.status(run, 2) }));
            assert.equal((await pending).type, "preview-result");
            assert.ok(publication.delivery.snapshot().physicalBytes > 0);
            held.settle();
          }
        },
        ["V1", "M1"].includes(id) ? { runs: 5, workers: 4 } : lower,
      ),
    ]);
  await rows("C-08", defs);
});

test("C-09 exchanges cache while retaining old physical ownership", async () => {
  const defs = [];
  for (const id of ["V1", "V2", "M1", "M2", "M3", "M4", "M5", "M6"])
    defs.push([
      id,
      body(async (f) => {
        const run = f.runs[0];
        const oldBytes = utf8("old-picture");
        const nextBytes = utf8("new-picture");
        await f.seed(run, oldBytes);
        const old = f.picture(run);
        const reader = f.hold(run);
        let route;
        if (["V2", "M3", "M4", "M6"].includes(id)) {
          route = f.delivery(carrier({ hold: true, writable: id !== "M6" }));
          assert.ok(
            publishPreview(route.delivery, reader, "old-send", undefined, "external-old", {
              route: "old",
              attempt: 1,
              current: () => !route.delivery.closed,
            }),
          );
        }
        const job = await f.begin(run);
        const frames = f.frames(run, job.command, nextBytes);
        let pressure;
        if (id === "M1") {
          const snap = f.account.snapshot();
          pressure = f.account.reserve(snap.limit - snap.controlReserve - snap.ordinary);
          assert.ok(pressure);
        }
        f.feed(run, frames);
        const outcome = await job.promise;
        if (pressure) {
          assert.equal(outcome.ok, false);
          pressure.release();
          unchangedBytes(old, f.picture(run));
        } else {
          assert.equal(outcome.ok, true);
          assert.deepEqual(f.picture(run).vt, Array.from(nextBytes));
        }
        assert.deepEqual(Array.from(reader.picture.vt), Array.from(oldBytes));
        lifetimeEffect({
          held: true,
          debt: f.account.snapshot().total,
          lateMutation: !reader.picture.vt.every((b, i) => b === oldBytes[i]),
          resurrected: false,
        });
        if (id === "M5") {
          nextBytes.fill(88);
          assert.deepEqual(f.picture(run).vt, Array.from(utf8("new-picture")));
        }
        const debt = f.account.snapshot().total;
        if (id === "M2") {
          reader.release();
          const once = f.account.snapshot().total;
          reader.release();
          assert.equal(f.account.snapshot().total, once);
          assert.ok(once < debt);
        }
        if (route) {
          if (id === "M3" || id === "M4") {
            const physical = route.delivery.snapshot().physicalBytes;
            route.delivery.close();
            assert.equal(route.delivery.snapshot().physicalBytes, physical);
            assert.ok(physical > 0);
          }
          if (id === "M6") {
            assert.equal(route.port.writes.length, 1);
            route.delivery.drain();
            assert.ok(route.port.writes.length > 1);
          }
          const recorded = route.port.writes.map((w) => Array.from(w.bytes));
          route.port.settle();
          if (id === "M4") {
            const total = f.account.snapshot().total;
            route.port.settle();
            assert.equal(f.account.snapshot().total, total);
          }
          assert.deepEqual(
            route.port.writes.map((w) => Array.from(w.bytes)),
            recorded,
          );
        }
      }),
    ]);
  await rows("C-09", defs);
});

test("C-10 enforces feasible preview and runtime budget boundaries", async () => {
  const lower = {
    runs: 3,
    budgets: { maxRuns: 3, listPage: 3, previewBytesPerRun: 32, previewGlobalBytes: 96 },
  };
  const defs = [];
  for (const id of ["V1", "V2", "V3", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"])
    defs.push([
      id,
      body(
        async (f) => {
          if (id === "M7") {
            assert.equal(validateEffectiveBudgets({ ...f.budget, previewGlobalBytes: 95 }), null);
            return;
          }
          if (id === "M8") {
            const route = f.service(carrier(), "bounded", 2);
            const run = f.runs[0];
            const first = route.service.handle({ type: "preview", run, requestId: "one" });
            const second = route.service.handle({ type: "preview", run, requestId: "two" });
            assert.equal(route.service.snapshot().identities, 2);
            const third = await route.service.handle({ type: "preview", run, requestId: "three" });
            assert.equal(third.type, "error");
            assert.equal(third.error.kind, "BUSY");
            route.service.close();
            await first;
            await second;
            return;
          }
          if (id === "V1" || id === "V2") {
            await f.seed(f.runs[0], new Uint8Array(id === "V1" ? 65536 : 32).fill(65));
            assert.equal(f.picture(f.runs[0]).vt.length, id === "V1" ? 65536 : 32);
            return;
          }
          if (["V3", "M2", "M3"].includes(id)) {
            for (const run of f.runs) await f.seed(run, new Uint8Array(32).fill(65));
            assert.equal(f.runtime.previews.cache.snapshot().committedBytes, 96);
            if (id === "M2") assert.equal(f.add("fourth"), null);
            if (id === "M3") {
              const reader = f.hold(f.runs[0]);
              const before = f.account.snapshot().total;
              const job = await f.begin(f.runs[0]);
              f.feed(f.runs[0], f.frames(f.runs[0], job.command, new Uint8Array(32).fill(66)));
              assert.equal((await job.promise).ok, true);
              assert.equal(f.runtime.previews.cache.snapshot().committedBytes, 96);
              assert.ok(f.account.snapshot().total > before);
              assert.equal(reader.picture.vt[0], 65);
            }
            return;
          }
          const run = f.runs[0];
          await f.seed(run, new Uint8Array(32).fill(65));
          const old = f.picture(run);
          const job = await f.begin(run);
          const frames = f.frames(run, job.command, new Uint8Array(id === "M1" ? 33 : 32).fill(66));
          if (id === "M1") {
            f.feed(run, frames);
            assert.equal((await job.promise).ok, false);
            assert.equal(f.sessions[0].closed, false);
            unchangedBytes(old, f.picture(run));
            return;
          }
          const snap = f.account.snapshot();
          const free = snap.limit - snap.controlReserve - snap.ordinary;
          if (id === "M4") {
            const bytes = pipeBytes(frames[1][0], frames[1][1]);
            const backing = new Uint8Array(256 * 1024);
            backing.set(bytes, 3);
            const lease = f.account.reserve(free - 100);
            assert.ok(lease);
            f.feed(run, [frames[0]]);
            f.sessions[0].receive(backing.subarray(3, 3 + bytes.length));
            f.feed(run, frames.slice(2));
            assert.equal((await job.promise).ok, false);
            lease.release();
            unchangedBytes(old, f.picture(run));
          }
          if (id === "M5") {
            const lease = f.account.reserve(free - 32 - 256);
            assert.ok(lease);
            const exact = f.account.reserve(32 + 256);
            assert.ok(exact);
            exact.release();
            const plus = f.account.reserve(1);
            assert.ok(plus);
            assert.equal(f.account.reserve(32 + 256), null);
            plus.release();
            lease.release();
            f.feed(run, frames);
            assert.equal((await job.promise).ok, true);
          }
          if (id === "M6") {
            const lease = f.account.reserve(free);
            assert.ok(lease);
            f.feed(run, frames);
            assert.equal((await job.promise).ok, false);
            const control = f.account.reserve(512, true);
            assert.ok(control);
            control.release();
            const command = {
              type: "status",
              worker: f.placement(run).worker,
              run,
              requestId: "pressure-status",
            };
            const pending = f.runtime.getStatus(command);
            f.send(run, f.result(command, { runStatus: f.status(run, 2) }));
            assert.equal((await pending).outcome, "accepted");
            lease.release();
            unchangedBytes(old, f.picture(run));
          }
        },
        id === "V1" ? {} : lower,
      ),
    ]);
  await rows("C-10", defs);
});

test("C-11 fences timeout disposal and replaced incarnation", async () => {
  const defs = [];
  for (const id of ["V1", "V2", ...Array.from({ length: 17 }, (_, n) => "M" + (n + 1))])
    defs.push([
      id,
      body(async (f) => {
        const run = f.runs[0];
        await f.seed(run);
        const old = f.picture(run);
        if (["M8", "M9", "M10", "M14", "M15"].includes(id)) {
          const reader = f.hold(run);
          const port = carrier({ hold: true });
          const route = f.delivery(port);
          const fence = {
            route: "preview-test",
            attempt: 1,
            current: () => !route.delivery.closed,
          };
          if (id === "M8") {
            route.delivery.close();
            assert.equal(
              publishPreview(route.delivery, reader, "closed", undefined, "closed-preview", fence),
              null,
            );
            assert.equal(port.writes.length, 0);
          } else {
            if (id === "M14")
              port.write = (bytes, callback) => {
                port.writes.push({ bytes: new Uint8Array(bytes), callback });
                route.delivery.close();
                return true;
              };
            publishPreview(route.delivery, reader, "held", undefined, "held-preview", fence);
            const physical = route.delivery.snapshot().physicalBytes;
            route.delivery.close();
            assert.equal(route.delivery.snapshot().physicalBytes, physical);
            assert.ok(physical > 0);
            if (id === "M15") {
              f.runtime.previews.dispose();
              f.runtime.previews.dispose();
              assert.ok(f.account.snapshot().total > 0);
              assert.deepEqual(Array.from(reader.picture.vt), old.vt);
            }
            port.settle();
            const total = f.account.snapshot().total;
            port.settle();
            assert.equal(f.account.snapshot().total, total);
            assert.equal(route.delivery.closed, true);
          }
          return;
        }
        if (["M7", "M16", "M17"].includes(id)) {
          const promise = f.runtime.previews.refresh(run);
          await turns();
          const command = f.latest(run, "status");
          const reply =
            id === "M7"
              ? {
                  type: "error",
                  worker: command.worker,
                  run,
                  requestId: command.requestId,
                  commandType: "status",
                  error: domainError("WORKER_UNAVAILABLE"),
                }
              : f.result(command, { outcome: id === "M16" ? "rejected" : "unknown" });
          f.send(run, reply);
          assert.equal((await promise).ok, false);
          if (id === "M7") f.sessions[0].loseContact();
          unchangedBytes(old, f.picture(run));
          return;
        }
        const job = await f.begin(run);
        const frames = f.frames(run, job.command);
        if (id === "M1" || id === "M2" || id === "M3" || id === "M12") {
          f.clock.set(50);
          if (id === "M3") {
            f.feed(run, frames);
            assert.equal(
              (await job.promise).ok,
              true,
              "valid result at equal timestamp must seal before a later expiry callback",
            );
            f.runtime.tickPreviews();
          } else {
            f.runtime.tickPreviews();
            assert.equal((await job.promise).ok, false);
            if (id === "M12") {
              assert.equal((await f.runtime.previews.refresh(run)).ok, false);
              assert.equal(f.runtime.previews.snapshot().active, 1);
              f.feed(run, frames.slice(0, 3));
              unchangedBytes(old, f.picture(run));
            }
            f.feed(run, frames);
            unchangedBytes(old, f.picture(run));
          }
        } else if (["M4", "M5", "M6"].includes(id)) {
          const result =
            id === "M4"
              ? {
                  type: "error",
                  worker: job.command.worker,
                  run,
                  requestId: job.command.requestId,
                  commandType: "preview-refresh",
                  error: domainError("INPUT_REJECTED"),
                }
              : f.result(job.command, { outcome: id === "M5" ? "rejected" : "unknown" });
          f.feed(run, [[result, new Uint8Array()]]);
          const outcome = await job.promise;
          assert.equal(outcome.ok, false);
          assert.equal(
            outcome.error.kind,
            id === "M4"
              ? "INPUT_REJECTED"
              : id === "M6"
                ? "RESULT_UNKNOWN"
                : "RECOVERY_UNAVAILABLE",
          );
          unchangedBytes(old, f.picture(run));
        } else if (id === "M11") {
          f.sessions[0].loseContact();
          const foreign = copy(frames);
          foreign.forEach(([m]) => (m.worker.workerIncarnationId = "new-incarnation"));
          f.feed(run, foreign);
          f.feed(run, frames);
          assert.equal((await job.promise).ok, false);
          unchangedBytes(old, f.picture(run));
        } else if (id === "M13") {
          assert.equal(
            f.registry.observe(
              job.command.worker,
              f.status(run, 2, { status: "exited", exitCode: 0 }),
            ),
            true,
          );
          assert.equal(f.registry.observe(job.command.worker, f.status(run, 2)), false);
          f.feed(run, frames);
          await job.promise;
          assert.equal(f.registry.get(run).status.status, "exited");
          unchangedBytes(old, f.picture(run));
        } else {
          f.clock.set(id === "V1" ? 49 : 0);
          f.feed(run, frames);
          assert.equal((await job.promise).ok, true);
          f.clock.set(51);
          f.runtime.tickPreviews();
          assert.equal(f.picture(run).version, 2);
        }
      }),
    ]);
  await rows("C-11", defs);
});

test("C-12 produces bounded truthful paginated records", async () => {
  const options = {
    runs: 5,
    budgets: { maxRuns: 5, listPage: 2, previewBytesPerRun: 32, previewGlobalBytes: 160 },
  };
  const defs = [];
  for (const id of ["V1", "V2", "M1", "M2", "M3", "M4", "M5", "M6"])
    defs.push([
      id,
      body(async (f) => {
        const cache = f.runtime.previews.cache;
        const run = f.runs[0];
        if (id === "V2") {
          f.registry.contactLost(f.placement(run).worker);
          const record = cache.getRecord(run);
          assert.equal(record.status, "unverifiable");
          assert.deepEqual(record.preview, {
            version: null,
            generatedAtMs: null,
            checkedAtMs: null,
            stale: true,
            byteLength: 0,
          });
          return;
        }
        await f.seed(run);
        const old = cache.getRecord(run);
        if (id === "M1") {
          const job = await f.begin(run);
          f.send(run, f.result(job.command, { outcome: "rejected" }));
          assert.equal((await job.promise).ok, false);
          const record = cache.getRecord(run);
          assert.equal(record.preview.stale, true);
          assert.equal(record.preview.version, old.preview.version);
          assert.equal(record.preview.byteLength, old.preview.byteLength);
        }
        if (id === "M2" || id === "M3")
          assert.equal(
            cache.getRecord({ ...run, [id === "M2" ? "serverId" : "relayInstanceId"]: "foreign" }),
            null,
          );
        if (id === "M4") {
          const geometryNow = { cols: 81, rows: 24 };
          f.registry.observe(
            f.placement(run).worker,
            f.status(run, 2, {
              status: "exited",
              exitCode: 0,
              controlEpoch: 3,
              geometry: geometryNow,
            }),
          );
          const record = cache.getRecord(run);
          assert.equal(record.status, "exited");
          assert.equal(record.controlEpoch, 3);
          assert.deepEqual(record.geometry, geometryNow);
          assert.equal(record.preview.version, 1);
        }
        const commandCount = f.commands().length;
        const bytes = f.account.snapshot().total;
        const ids = [];
        let afterRunId;
        let last;
        for (let i = 0; i < 4; i++) {
          const page = cache.list({ limit: 2, ...(afterRunId ? { afterRunId } : {}) });
          assert.ok(RPC_METHODS["terminal.list"].result.safeParse(page).success);
          assert.ok(page.runs.length <= 2);
          for (const record of page.runs) {
            assert.ok(RPC_METHODS["terminal.get"].result.safeParse({ record }).success);
            ids.push(record.run.runId);
          }
          last = page.runs.at(-1)?.run.runId;
          afterRunId = page.nextAfterRunId;
          if (!afterRunId) break;
        }
        assert.equal(ids.length, 5);
        assert.equal(new Set(ids).size, 5);
        if (id === "M6") {
          assert.deepEqual(cache.list({ limit: 2, afterRunId: last }), { runs: [] });
        }
        if (id === "M5")
          for (let i = 0; i < 20; i++) {
            cache.list({ limit: 2 });
            cache.getRecord(run);
          }
        assert.equal(f.commands().length, commandCount);
        assert.equal(f.account.snapshot().total, bytes);
      }, options),
    ]);
  await rows("C-12", defs);
});

test("NC-01 oracle rejects premature cache publication", async () => {
  const defs = [
    [
      "V1",
      body(async (f) => {
        await valid(f);
        completeEffect(f.commitObservation);
      }),
    ],
    [
      "M1",
      body(async (f) => {
        await valid(f);
        assert.throws(
          () =>
            completeEffect({
              ...f.commitObservation,
              end: false,
              result: false,
              commitPosition: 2,
            }),
          /premature cache publication/,
        );
      }),
    ],
    [
      "M2",
      body(async (f) => {
        await valid(f);
        assert.throws(
          () => completeEffect({ ...f.commitObservation, result: false, commitPosition: 3 }),
          /premature cache publication/,
        );
      }),
    ],
  ];
  await rows("NC-01", defs);
});

test("NC-02 oracle rejects fabricated unchanged success", async () => {
  await rows("NC-02", [
    [
      "V1",
      body(async (f) => {
        await f.seed(f.runs[0]);
        unchangedEffect({
          owned: !!f.picture(f.runs[0]),
          currentProof: f.registry.get(f.runs[0]).status.parsedSeq === 1,
        });
      }),
    ],
    [
      "M1",
      body(async (f) => {
        assert.equal(f.picture(f.runs[0]), null);
        assert.throws(
          () => unchangedEffect({ owned: false, currentProof: true }),
          /fabricated unchanged/,
        );
      }),
    ],
    [
      "M2",
      body(async (f) => {
        await f.seed(f.runs[0]);
        assert.throws(
          () => unchangedEffect({ owned: true, currentProof: false }),
          /fabricated unchanged/,
        );
      }),
    ],
  ]);
});

test("NC-03 oracle rejects premature physical release and late mutation", async () => {
  const defs = [];
  for (const id of ["V1", "M1", "M2", "M3"])
    defs.push([
      id,
      body(async (f) => {
        await f.seed(f.runs[0]);
        const reader = f.hold(f.runs[0]);
        f.runtime.previews.cache.dispose();
        const effect = {
          held: true,
          debt: f.account.snapshot().total,
          lateMutation: false,
          resurrected: false,
        };
        lifetimeEffect(effect);
        assert.ok(reader.picture.vt.length > 0);
        if (id === "M1")
          assert.throws(() => lifetimeEffect({ ...effect, debt: 0 }), /premature physical release/);
        if (id === "M2")
          assert.throws(() => lifetimeEffect({ ...effect, lateMutation: true }), /late mutation/);
        if (id === "M3")
          assert.throws(
            () => lifetimeEffect({ ...effect, resurrected: true }),
            /closed route resurrection/,
          );
      }),
    ]);
  await rows("NC-03", defs);
});
