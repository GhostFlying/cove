import { expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { queryBytes, expectedLiveReplies } from "../../fixtures/terminal/engine/recovery-cases.mjs";
import {
  budgets,
  command,
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

const childEntry = new URL("./fixtures/query-paste-child.mjs", import.meta.url).pathname;
const reply = Buffer.from("\u001b[0n");

function preserve(name, value) {
  const root = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  if (!root) return;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
}

function recordingPeer() {
  const state = { observer: null, replies: [], exits: [], faults: [] };
  const adapter = {
    pid: 71,
    writerCompletion: Promise.resolve({ kind: "closed" }),
    submit() {
      throw Error("unexpected user input");
    },
    automaticOutputSink(value) {
      state.replies.push({
        kind: value.kind,
        atSeq: value.atSeq,
        hex: Buffer.from(value.bytes).toString("hex"),
      });
    },
    resize() {},
    pause() {},
    resume() {},
    retireInput() {},
    stop() {
      state.observer.onExit({ exitCode: 0 });
      return Promise.resolve({
        kind: "exited",
        exit: { exitCode: 0 },
        cleanup: {
          scope: "initial-process-group",
          verified: false,
          graceful: { kind: "not-attempted", reason: "already-exited" },
          force: { kind: "not-attempted", reason: "already-exited" },
        },
      });
    },
    snapshot() {
      return {
        pid: 71,
        exited: state.exits.length > 0,
        writer: "closed",
        earlyOutputBytes: 0,
        paused: false,
        input: {
          allocatedBytes: 0,
          tasks: 0,
          peakAllocatedBytes: 0,
          peakTasks: 0,
          maxBytes: 4096,
          maxTasks: 2,
        },
      };
    },
  };
  return {
    state,
    factory: {
      spawn(_spec, observer) {
        state.observer = {
          onData: (bytes) => observer.onData(bytes),
          onFault: (fault) => {
            state.faults.push(fault);
            observer.onFault(fault);
          },
          onExit: (exit) => {
            state.exits.push(exit);
            observer.onExit(exit);
          },
        };
        return { kind: "created", pty: adapter };
      },
    },
  };
}

test("nine automatic query families are unchanged across zero, one or two passive recipients", async () => {
  const delivery = installedBin();
  const publicFile = join(delivery.consumerRoot, "query-observation-public.mjs");
  writeFileSync(
    publicFile,
    'export { createRunSession } from "@cove/terminal-worker/execution";\n',
  );
  const { createRunSession } = await import(pathToFileURL(publicFile).href);
  const traces = [];
  try {
    for (const [family, bytes] of Object.entries(queryBytes)) {
      for (const cardinality of [0, 1, 2]) {
        const peer = recordingPeer();
        const recipients = Array.from({ length: cardinality }, () => []);
        const options = {
          run: run(`query-${family}-${cardinality}`),
          geometry: { cols: 12, rows: 4 },
          spawn: { file: "unused", args: [], cwd: repo, env: {} },
          factory: peer.factory,
          onFault: (fault) => peer.state.faults.push(fault),
          ...(cardinality && {
            onFact(fact) {
              for (const recipient of recipients)
                recipient.push({
                  type: fact.event.type,
                  seq: fact.event.seq,
                  hex: fact.bytes && Buffer.from(fact.bytes).toString("hex"),
                });
            },
          }),
        };
        const created = createRunSession(options);
        expect(created.kind).toBe("created");
        if (created.kind !== "created") continue;
        try {
          peer.state.observer.onData(Buffer.from(bytes));
          expect((await created.session.barrier()).ok).toBe(true);
          const expected = [
            {
              kind: "query",
              atSeq: 1,
              hex: Buffer.from(expectedLiveReplies[family]).toString("hex"),
            },
          ];
          expect(peer.state.replies).toEqual(expected);
          expect(peer.state.faults).toEqual([]);
          for (const recipient of recipients)
            expect(recipient.filter((fact) => fact.type === "output")).toEqual([
              { type: "output", seq: 1, hex: Buffer.from(bytes).toString("hex") },
            ]);
          traces.push({ family, cardinality, replies: peer.state.replies, recipients });
        } finally {
          const disposal = await created.session.dispose();
          expect(disposal.ownershipEvidence).toBe("closure-proven");
        }
      }
    }
    expect(traces).toHaveLength(27);
    for (const family of Object.keys(queryBytes)) {
      const group = traces.filter((trace) => trace.family === family);
      expect(group.map((trace) => trace.replies)).toEqual([
        group[0].replies,
        group[0].replies,
        group[0].replies,
      ]);
    }
    const altered = structuredClone(traces[0].replies);
    altered.push(altered[0]);
    expect(altered).not.toEqual(traces[0].replies);
    expect([]).not.toEqual(traces[1].replies);
  } finally {
    preserve("query-recipient-cardinality", traces);
    delivery.cleanup();
  }
});

test("real PTY distinguishes worker automatic query reply from reply-shaped user input", async () => {
  const delivery = installedBin();
  const publicFile = join(delivery.consumerRoot, "query-paste-public.mjs");
  writeFileSync(
    publicFile,
    'export { createWorkerExecution } from "@cove/terminal-worker/execution";\nexport { createNativePtyFactory } from "@cove/terminal-worker/native-adapter";\n',
  );
  const { createWorkerExecution, createNativePtyFactory } = await import(
    pathToFileURL(publicFile).href
  );
  const temp = mkdtempSync(join(tmpdir(), "cove-query-paste-"));
  const nonce = randomUUID();
  const facts = [];
  const faults = [];
  const origins = [];
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
      const result = native.spawn(spec, observer);
      if (result.kind !== "created") return result;
      const adapter = new Proxy(result.pty, {
        get(target, key) {
          if (key === "automaticOutputSink")
            return (event) => {
              origins.push({
                origin: "automatic",
                kind: event.kind,
                atSeq: event.atSeq,
                hex: Buffer.from(event.bytes).toString("hex"),
              });
              return target.automaticOutputSink(event);
            };
          if (key === "submit")
            return (bytes, settled) => {
              const event = {
                origin: "user",
                hex: Buffer.from(bytes).toString("hex"),
                settlements: [],
              };
              origins.push(event);
              const admission = target.submit(bytes, (value) => {
                event.settlements.push(value);
                settled(value);
              });
              event.admission = admission;
              return admission;
            };
          const value = target[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return { kind: "created", pty: adapter };
    },
  };
  const execution = createWorkerExecution({
    worker,
    effectiveBudgets: budgets,
    factory,
    onFact: (fact) =>
      facts.push({
        type: fact.event.type,
        seq: fact.event.seq,
        hex: fact.bytes && Buffer.from(fact.bytes).toString("hex"),
      }),
    onFault: (fault) => faults.push(fault),
  });
  const target = run(`paste-${nonce}`);
  const spawn = spawnCommand(target, process.execPath, [childEntry, nonce, temp], repo);
  let start;
  let finish;
  let primary;
  let shutdown;
  try {
    expect(await execution.execute(spawn.metadata, spawn.payload)).toMatchObject({
      type: "result",
      outcome: "accepted",
      atSeq: 0,
    });
    start = await receipt(join(temp, "start.json"), "query child start");
    expect(start).toMatchObject({ nonce });
    expect(psIdentity(start.pid)).toContain(nonce);
    const automatic = await receipt(join(temp, "automatic.json"), "automatic DSR reply");
    expect(automatic).toMatchObject({ nonce, pid: start.pid, hex: reply.toString("hex") });
    expect(origins.filter((event) => event.origin === "automatic")).toMatchObject([
      { origin: "automatic", kind: "query", hex: reply.toString("hex") },
    ]);
    expect(origins[0].atSeq).toBeGreaterThan(0);
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
    expect(await execution.execute(control)).toMatchObject({ type: "result", outcome: "accepted" });
    const input = command("input", target, {
      subscription: subscription(target),
      epoch: 1,
      inputSeq: 1,
    });
    expect(await execution.execute(input, reply)).toMatchObject({
      type: "result",
      outcome: "accepted",
      writtenBytes: reply.length,
    });
    finish = await receipt(join(temp, "finish.json"), "reply-shaped paste receipt");
    expect(finish).toMatchObject({
      nonce,
      pid: start.pid,
      total: reply.length * 2,
      automaticHex: reply.toString("hex"),
      userHex: reply.toString("hex"),
      sha256: createHash("sha256")
        .update(Buffer.concat([reply, reply]))
        .digest("hex"),
    });
    expect(origins.map((event) => event.origin)).toEqual(["automatic", "user"]);
    expect(origins[1]).toMatchObject({ hex: reply.toString("hex") });
    expect(origins[1].settlements).toHaveLength(1);
    expect(faults).toEqual([]);
    expect(
      facts.some(
        (fact) =>
          fact.type === "output" &&
          fact.hex?.includes(Buffer.from(`READY:${nonce}`).toString("hex")),
      ),
    ).toBe(true);
    await until(() => !psIdentity(start.pid), 8000, "query child exit");
  } catch (error) {
    primary = error;
  } finally {
    try {
      shutdown = await execution.shutdown("query-paste-finally");
    } catch (error) {
      primary = new AggregateError([...(primary ? [primary] : []), error], "shutdown failed");
    }
    preserve(`query-paste-${nonce}-before-cleanup`, {
      nonce,
      start,
      finish,
      facts,
      faults,
      origins,
      shutdown,
      factory: native.snapshot(),
      currentIdentity: start && psIdentity(start.pid),
      primary: primary && { name: primary.name, message: primary.message },
    });
    if (start && psIdentity(start.pid)) {
      try {
        const identity = psIdentity(start.pid);
        if (!identity.includes(childEntry) || !identity.includes(nonce)) {
          primary = new AggregateError(
            [...(primary ? [primary] : []), Error(`query child identity changed: ${identity}`)],
            "owned cleanup identity uncertain",
          );
        } else {
          process.kill(start.pid, "SIGHUP");
          await until(() => !psIdentity(start.pid), 5000, "query child cleanup exit");
        }
      } catch (error) {
        primary = new AggregateError(
          [...(primary ? [primary] : []), error],
          "owned cleanup failed",
        );
      }
    }
    preserve(`query-paste-${nonce}-after-cleanup`, {
      nonce,
      start,
      shutdown,
      factory: native.snapshot(),
      currentIdentity: start && psIdentity(start.pid),
      primary: primary && { name: primary.name, message: primary.message },
    });
    delivery.cleanup();
    if (!primary) rmSync(temp, { recursive: true, force: true });
  }
  expect(native.snapshot().owners).toBe(0);
  expect(shutdown?.every((item) => item.ownershipEvidence === "closure-proven")).toBe(true);
  if (primary) throw primary;
});
