import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PtyInputController, SharedNativeInputBudget } from "../../dist/src/pty-input.js";

export function currentByteFactory(options = {}) {
  const shared = new SharedNativeInputBudget(options.sharedBytes ?? 64 * 1024 * 1024, 256);
  const owners = [];
  const receipts = [];
  let ticket = 0;
  const factory = {
    retainedBytesAccounting: "participating",
    owners,
    receipts,
    shared,
    spawn(spec, observer) {
      let closed = false;
      let exited = false;
      let paused = false;
      let releaseWriter;
      const writerCompletion = new Promise((resolve) => {
        releaseWriter = resolve;
      });
      const tasks = [];
      const owner = { observer, tasks, automatic: [], resizeCalls: [], spec };
      const retireRaw = (task) => {
        task.byteLength = task.raw.byteLength;
        task.sha256 = createHash("sha256").update(task.raw).digest("hex");
        task.raw = undefined;
      };
      const writer = {
        writeBounded(raw, callback) {
          if (options.rejectWriter) return { accepted: false, reason: options.rejectWriter };
          if (closed) return { accepted: false, reason: "closed" };
          assert(tasks.length < 256, "bounded native receipt arena");
          const task = { ticket: ++ticket, raw, callback, settled: false };
          tasks.push(task);
          receipts.push({ phase: "writer-admitted", ticket: task.ticket, bytes: raw.length });
          options.onWrite?.(owner, task);
          if (!options.hold) queueMicrotask(() => owner.settle(task));
          return { accepted: true, ticket: task.ticket, byteLength: raw.length };
        },
        disposeBoundedWrite() {
          if (closed) return true;
          closed = true;
          for (const task of tasks) if (!task.settled) owner.settle(task, "closed", 0);
          releaseWriter({ kind: "closed" });
          return true;
        },
      };
      const controller = new PtyInputController({
        writer,
        sharedBudget: shared,
        maxBytes: spec.inputBytes ?? 65536,
        maxTasks: spec.inputTasks ?? 256,
        reserveRetainedBytes: (bytes) => spec.reserveRetainedBytes?.("native-input", bytes),
        onFault: (fault) => observer.onFault({ kind: "input", reason: fault.reason }),
      });
      owner.controller = controller;
      owner.writer = writer;
      owner.settle = (task = tasks.find((item) => !item.settled), status = "written", written) => {
        assert(task, "actual admitted writer task required");
        const originalBytes = task.raw?.length ?? task.byteLength;
        const writtenBytes = written ?? originalBytes;
        const value = {
          ticket: task.ticket,
          status,
          originalBytes,
          writtenBytes,
          remainingBytes: originalBytes - writtenBytes,
        };
        if (!task.settled) {
          task.settled = true;
          retireRaw(task);
        }
        receipts.push({ phase: "settlement-enter", ...value });
        options.onSettlement?.(owner, value);
        task.callback(value);
        receipts.push({
          phase: "settlement-return",
          ticket: task.ticket,
          controller: controller.snapshot(),
          shared: shared.snapshot(),
        });
      };
      owner.emit = (raw) => observer.onData(Buffer.from(raw));
      owner.exit = (exitCode = 0) => {
        exited = true;
        observer.onExit({ exitCode });
      };
      owner.adapter = {
        pid: owners.length + 1,
        writerCompletion,
        submit: (raw, callback) =>
          controller.submit(raw, "user", (result) => {
            receipts.push({
              phase: "consumer-enter",
              bytes: result.originalBytes,
              controller: controller.snapshot(),
              shared: shared.snapshot(),
            });
            callback(result);
            options.onConsumerReturn?.(owner, result);
            receipts.push({ phase: "consumer-return", controller: controller.snapshot() });
          }),
        automaticOutputSink(event) {
          owner.automatic.push({
            kind: event.kind,
            atSeq: event.atSeq,
            bytes: Buffer.from(event.bytes).toString("hex"),
          });
          controller.submit(event.bytes, event.kind, () => {});
        },
        pause() {
          paused = true;
        },
        resume() {
          paused = false;
        },
        resize(cols, rows) {
          owner.resizeCalls.push({ cols, rows });
        },
        retireInput() {
          controller.retire();
        },
        async stop() {
          controller.retire();
          if (options.stopUnverifiable)
            return {
              kind: "unverifiable",
              cause: "controlled contact loss",
              cleanup: {
                scope: "initial-process-group",
                verified: false,
                graceful: { kind: "not-attempted", reason: "already-exited" },
                force: { kind: "not-attempted", reason: "already-exited" },
              },
            };
          if (!exited) owner.exit();
          return {
            kind: "exited",
            exit: { exitCode: 0 },
            cleanup: {
              scope: "initial-process-group",
              verified: false,
              graceful: { kind: "not-attempted", reason: "already-exited" },
              force: { kind: "not-attempted", reason: "already-exited" },
            },
          };
        },
        snapshot() {
          return {
            pid: owners.length,
            exited,
            writer: closed ? "closed" : "pending",
            input: controller.snapshot(),
            earlyOutputBytes: 0,
            paused,
          };
        },
      };
      owners.push(owner);
      return { kind: "created", pty: owner.adapter };
    },
    snapshot() {
      const active = owners.filter((owner) => owner.adapter.snapshot().writer !== "closed").length;
      return {
        owners: active,
        provisionalOwners: 0,
        rollbackPendingOwners: 0,
        activeOwners: active,
        tombstones: owners.length - active,
        peakOwners: owners.length,
        maxOwners: 128,
        aggregateInput: shared.snapshot(),
      };
    },
  };
  return factory;
}
