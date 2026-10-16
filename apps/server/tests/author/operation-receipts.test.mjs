import { describe, it, expect } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { canonicalOperationIntent } from "@cove/protocol/rpc";
import { encodePipeFrame } from "@cove/protocol/pipe";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { WorkerPipeSession } from "../../dist/terminal/worker-pipe-session.js";
import { WorkerPool } from "../../dist/terminal/worker-pool.js";
import { RunRegistry } from "../../dist/terminal/run-registry.js";
import { LocalRuntime } from "../../dist/terminal/local-runtime.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { TerminalOperations } from "../../dist/operations/terminal-operations.js";

const codec = {
  encode: (text) => new TextEncoder().encode(text),
  decode: (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
};
const worker = {
  serverId: "server",
  relayInstanceId: "instance",
  workerId: "worker",
  workerIncarnationId: "birth",
};
const create = (operationId = "create") => ({
  operationId,
  expectedRelayInstanceId: "instance",
  executable: "synthetic-shell",
  argv: [],
  cwd: "/synthetic-owned",
  geometry: { cols: 80, rows: 24 },
});
// Lets every pending promise continuation run: operations now await the receipts (asynchronous
// like the store) before they send a command to the worker.
const settled = () => new Promise((resolve) => setImmediate(resolve));

function fixture(changes = {}) {
  const budgets = { ...M0_LIMITS, ...changes };
  const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
  const composition = new RuntimeComposition("server", "instance", budgets, bytes);
  const commands = [];
  const session = new WorkerPipeSession({
    worker,
    composition,
    codec,
    buildVersion: "author",
    transport: {
      write: (data, done, handing) => {
        const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(8);
        const metadata = JSON.parse(codec.decode(data.subarray(16, 16 + length)));
        handing();
        if (metadata.type !== "hello") commands.push(metadata);
        done();
        return true;
      },
    },
    now: () => 0,
    timeoutMs: 100,
    identityLimit: 32,
  });
  session.start();
  session.receive(
    encodePipeFrame(
      2,
      codec.encode(
        JSON.stringify({
          type: "ready",
          worker,
          pipeVersion: 2,
          buildVersion: "peer",
          effectiveBudgets: budgets,
        }),
      ),
      new Uint8Array(),
    ).value,
  );
  const pool = new WorkerPool(composition, 1, budgets.maxRuns);
  const registry = new RunRegistry(composition);
  const runtime = new LocalRuntime(pool, registry, codec.encode);
  runtime.addWorker(session);
  const receipts = new OperationReceipts(composition, codec.encode);
  const operations = new TerminalOperations({
    composition,
    runtime,
    receipts,
    encodeUtf8: codec.encode,
  });
  const reply = (index = 0, extra = {}) => {
    const command = commands[index];
    session.receive(
      encodePipeFrame(
        2,
        codec.encode(
          JSON.stringify({
            type: "result",
            worker,
            run: command.run,
            requestId: command.requestId,
            commandType: command.type,
            operationId: command.operationId,
            outcome: "accepted",
            ...extra,
          }),
        ),
        new Uint8Array(),
      ).value,
    );
  };
  const close = () => {
    operations.dispose();
    receipts.dispose();
    runtime.dispose();
    session.transportReleased();
  };
  return {
    bytes,
    composition,
    commands,
    session,
    runtime,
    registry,
    receipts,
    operations,
    reply,
    close,
  };
}

// A receipt committed by an earlier instance of the same server. T0 keeps receipts in memory,
// so the historical record is installed through the store API exactly as T1 will load it.
async function seedHistorical(f, method, params, oldRun) {
  const key = { serverId: "server", principalId: "principal", operationId: params.operationId };
  const intent = canonicalOperationIntent(method, params, codec.encode);
  const preparation = await f.receipts.prepare(key, intent);
  const record = {
    operationId: params.operationId,
    method,
    revision: 0,
    state: "accepted",
    run: oldRun,
  };
  expect(await preparation.commit(record)).toBe(true);
  expect(
    await f.receipts.update(key, {
      ...record,
      revision: 1,
      state: "succeeded",
      result: { run: oldRun },
    }),
  ).toBe(true);
  return f.receipts.get(key);
}
const oldRun = { serverId: "server", relayInstanceId: "old", runId: "run-old" };
const oldCreate = (operationId = "create") => ({
  ...create(operationId),
  expectedRelayInstanceId: "old",
});

describe("durable operation receipts", () => {
  it("returns the original old-instance record for a same-intent resend without executing", async () => {
    const f = fixture();
    const stored = await seedHistorical(f, "terminal.create", oldCreate(), oldRun);
    const before = f.bytes.snapshot();
    const resent = await f.operations.create("principal", oldCreate());
    expect(resent).toEqual({ operation: stored });
    expect(resent.operation.run).toEqual(oldRun);
    expect(f.commands).toHaveLength(0);
    expect(f.registry.count).toBe(0);
    expect(f.receipts.count).toBe(1);
    expect(f.bytes.snapshot()).toEqual(before);
    expect(await f.operations.get("principal", "create")).toEqual({ operation: stored });
    f.close();
  });

  it("conflicts on a changed intent before the stale-instance check", async () => {
    const f = fixture();
    await seedHistorical(f, "terminal.create", oldCreate(), oldRun);
    // Same old-instance precondition, different command.
    const changed = await f.operations.create("principal", { ...oldCreate(), argv: ["other"] });
    expect(changed.error.kind).toBe("OPERATION_ID_CONFLICT");
    // Rebuilt for the current instance: a new intent under the old operation ID.
    const rebuilt = await f.operations.create("principal", create());
    expect(rebuilt.error.kind).toBe("OPERATION_ID_CONFLICT");
    expect(f.commands).toHaveLength(0);
    expect(f.registry.count).toBe(0);
    expect(f.receipts.count).toBe(1);
    f.close();
  });

  it("rejects a new old-instance request that has no receipt", async () => {
    const f = fixture();
    await seedHistorical(f, "terminal.create", oldCreate(), oldRun);
    const before = f.bytes.snapshot();
    const stale = await f.operations.create("principal", oldCreate("fresh"));
    expect(stale.error.kind).toBe("INSTANCE_MISMATCH");
    const staleStop = await f.operations.stop("principal", {
      operationId: "fresh-stop",
      expectedRelayInstanceId: "old",
      run: oldRun,
    });
    expect(staleStop.error.kind).toBe("INSTANCE_MISMATCH");
    expect(f.commands).toHaveLength(0);
    expect(f.receipts.count).toBe(1);
    expect(f.bytes.snapshot()).toEqual(before);
    f.close();
  });

  it("returns an old-instance stop record and conflicts on a changed target", async () => {
    const f = fixture();
    const stop = { operationId: "stop", expectedRelayInstanceId: "old", run: oldRun };
    const stored = await seedHistorical(f, "terminal.stop", stop, oldRun);
    expect(await f.operations.stop("principal", stop)).toEqual({ operation: stored });
    const other = { ...oldRun, runId: "run-other" };
    expect((await f.operations.stop("principal", { ...stop, run: other })).error.kind).toBe(
      "OPERATION_ID_CONFLICT",
    );
    expect(f.commands).toHaveLength(0);
    f.close();
  });

  it("keys receipts by server, principal and operation ID without the instance", async () => {
    const f = fixture();
    await seedHistorical(f, "terminal.create", oldCreate(), oldRun);
    // Another principal's operation with the same ID is unrelated new work.
    const other = f.operations.create("other-principal", oldCreate());
    expect((await other).error.kind).toBe("INSTANCE_MISMATCH");
    expect((await f.operations.get("other-principal", "create")).error.kind).toBe(
      "OPERATION_NOT_FOUND",
    );
    const foreign = { serverId: "foreign", principalId: "principal", operationId: "create" };
    expect(await f.receipts.get(foreign)).toBeNull();
    expect((await f.receipts.lookup(foreign, "intent")).kind).toBe("invalid");
    // A record may reference an earlier instance but never another server.
    const key = { serverId: "server", principalId: "principal", operationId: "foreign-run" };
    const preparation = await f.receipts.prepare(key, "intent");
    expect(
      await preparation.commit({
        operationId: "foreign-run",
        method: "terminal.create",
        revision: 0,
        state: "accepted",
        run: { ...oldRun, serverId: "foreign" },
      }),
    ).toBe(false);
    preparation.cancel();
    f.close();
  });
});

describe("terminal operation states", () => {
  it("rejects every update after a terminal state, cancelled included", async () => {
    const f = fixture();
    for (const state of ["succeeded", "failed", "cancelled", "requires_attention"]) {
      const key = { serverId: "server", principalId: "principal", operationId: `op-${state}` };
      const record = {
        operationId: key.operationId,
        method: "terminal.create",
        revision: 0,
        state: "accepted",
        run: oldRun,
      };
      expect(await (await f.receipts.prepare(key, `intent-${state}`)).commit(record)).toBe(true);
      expect(await f.receipts.update(key, { ...record, revision: 1, state })).toBe(true);
      for (const next of ["running", "succeeded", "failed", "cancelled"])
        expect(await f.receipts.update(key, { ...record, revision: 2, state: next })).toBe(false);
      expect(await f.receipts.get(key)).toMatchObject({ revision: 1, state });
    }
    f.close();
  });
});

describe("explicit recovery of requires_attention", () => {
  async function attention(f, operationId) {
    const key = { serverId: "server", principalId: "principal", operationId };
    const record = {
      operationId,
      method: "terminal.create",
      revision: 0,
      state: "accepted",
      run: oldRun,
    };
    expect(await (await f.receipts.prepare(key, `intent-${operationId}`)).commit(record)).toBe(
      true,
    );
    expect(
      await f.receipts.update(key, { ...record, revision: 1, state: "requires_attention" }),
    ).toBe(true);
    return { key, record: await f.receipts.get(key) };
  }

  it("continues to running or recovering and then finishes through ordinary updates", async () => {
    const f = fixture();
    for (const resumed of ["running", "recovering"]) {
      const { key, record } = await attention(f, `continue-${resumed}`);
      // A late executor result is still refused; only the explicit transition resumes.
      expect(await f.receipts.update(key, { ...record, revision: 2, state: "succeeded" })).toBe(
        false,
      );
      expect(await f.receipts.recover(key, 1, { ...record, revision: 2, state: resumed })).toBe(
        true,
      );
      expect(await f.receipts.update(key, { ...record, revision: 3, state: "succeeded" })).toBe(
        true,
      );
      expect(await f.receipts.update(key, { ...record, revision: 4, state: "running" })).toBe(
        false,
      );
      expect(await f.receipts.get(key)).toMatchObject({ revision: 3, state: "succeeded" });
    }
    f.close();
  });

  it("abandons to cancelled, which never changes again", async () => {
    const f = fixture();
    const { key, record } = await attention(f, "abandon");
    expect(await f.receipts.recover(key, 1, { ...record, revision: 2, state: "cancelled" })).toBe(
      true,
    );
    expect(await f.receipts.update(key, { ...record, revision: 3, state: "running" })).toBe(false);
    expect(await f.receipts.recover(key, 2, { ...record, revision: 3, state: "running" })).toBe(
      false,
    );
    expect(await f.receipts.get(key)).toMatchObject({ revision: 2, state: "cancelled" });
    f.close();
  });

  it("refuses stale, out-of-order or non-recovery transitions", async () => {
    const f = fixture();
    const { key, record } = await attention(f, "guarded");
    // Stale inspected revision, skipped revision, and a state recovery cannot jump to.
    expect(await f.receipts.recover(key, 0, { ...record, revision: 2, state: "running" })).toBe(
      false,
    );
    expect(await f.receipts.recover(key, 1, { ...record, revision: 3, state: "running" })).toBe(
      false,
    );
    for (const state of ["succeeded", "failed", "accepted", "requires_attention"])
      expect(await f.receipts.recover(key, 1, { ...record, revision: 2, state })).toBe(false);
    expect(
      await f.receipts.recover(key, 1, {
        ...record,
        revision: 2,
        state: "running",
        method: "terminal.stop",
      }),
    ).toBe(false);
    expect(await f.receipts.get(key)).toMatchObject({ revision: 1, state: "requires_attention" });
    // Records that are not waiting for attention cannot be recovered.
    for (const state of ["running", "succeeded", "failed", "cancelled"]) {
      const other = { serverId: "server", principalId: "principal", operationId: `not-${state}` };
      const base = { ...record, operationId: other.operationId, revision: 0, state: "accepted" };
      expect(await (await f.receipts.prepare(other, `intent-not-${state}`)).commit(base)).toBe(
        true,
      );
      expect(await f.receipts.update(other, { ...base, revision: 1, state })).toBe(true);
      expect(await f.receipts.recover(other, 1, { ...base, revision: 2, state: "running" })).toBe(
        false,
      );
    }
    f.close();
  });
});

describe("instance-bound operation receipts", () => {
  it("rejects a receipts store on an equal-limit separate ledger before operations can run", () => {
    const f = fixture();
    const otherBytes = new RuntimeRetainedBytes(f.bytes.limit, f.bytes.controlReserve);
    const composition = new RuntimeComposition("server", "instance", { ...M0_LIMITS }, otherBytes);
    const receipts = new OperationReceipts(composition, codec.encode);
    const before = f.bytes.snapshot();
    const otherBefore = otherBytes.snapshot();
    expect(
      () =>
        new TerminalOperations({
          composition: f.composition,
          runtime: f.runtime,
          receipts,
          encodeUtf8: codec.encode,
        }),
    ).toThrow("Runtime composition mismatch");
    expect(f.commands).toHaveLength(0);
    expect(f.registry.count).toBe(0);
    expect(f.bytes.snapshot()).toEqual(before);
    expect(otherBytes.snapshot()).toEqual(otherBefore);
    receipts.dispose();
    f.close();
    expect(f.bytes.snapshot().total).toBe(0);
    expect(otherBytes.snapshot().total).toBe(0);
  });

  it("rejects operation composition with different budgets despite sharing the same ledger", () => {
    const f = fixture();
    const composition = new RuntimeComposition(
      "server",
      "instance",
      { ...M0_LIMITS, operationReceipts: 1 },
      f.bytes,
    );
    const receipts = new OperationReceipts(composition, codec.encode);
    const before = f.bytes.snapshot();
    for (const supplied of [f.composition, composition]) {
      expect(
        () =>
          new TerminalOperations({
            composition: supplied,
            runtime: f.runtime,
            receipts,
            encodeUtf8: codec.encode,
          }),
      ).toThrow("Runtime composition mismatch");
    }
    expect(f.commands).toHaveLength(0);
    expect(f.bytes.snapshot()).toEqual(before);
    receipts.dispose();
    f.close();
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("rejects foreign receipt authority before creating an operation", () => {
    const f = fixture();
    for (const [serverId, relayInstanceId] of [
      ["foreign-server", "instance"],
      ["server", "foreign-instance"],
    ]) {
      const composition = new RuntimeComposition(
        serverId,
        relayInstanceId,
        { ...M0_LIMITS },
        f.bytes,
      );
      const receipts = new OperationReceipts(composition, codec.encode);
      const before = f.bytes.snapshot();
      expect(
        () =>
          new TerminalOperations({
            composition: f.composition,
            runtime: f.runtime,
            receipts,
            encodeUtf8: codec.encode,
          }),
      ).toThrow("Runtime composition mismatch");
      expect(f.bytes.snapshot()).toEqual(before);
      expect(receipts.count).toBe(0);
      receipts.dispose();
    }
    expect(f.commands).toHaveLength(0);
    f.close();
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("reserves before spawn and concurrent same intent starts only one run", async () => {
    const f = fixture();
    const first = f.operations.create("principal", create());
    await settled();
    expect(f.commands).toHaveLength(1);
    const duplicate = await f.operations.create("principal", create());
    expect(duplicate.operation).toMatchObject({
      state: "running",
      revision: 1,
      run: f.commands[0].run,
    });
    expect(f.commands).toHaveLength(1);
    expect(f.receipts.count).toBe(1);
    f.reply();
    expect((await first).operation.state).toBe("succeeded");
    const repeated = await f.operations.create("principal", create());
    expect(repeated.operation.state).toBe("succeeded");
    expect(f.commands).toHaveLength(1);
    f.close();
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("preserves unknown after response loss and never respawns a duplicate", async () => {
    const f = fixture();
    const first = f.operations.create("principal", create());
    await settled();
    f.session.loseContact();
    const result = await first;
    expect(result.operation).toMatchObject({
      state: "requires_attention",
      error: { kind: "RESULT_UNKNOWN", acceptance: "unknown", nextAction: "query-operation" },
    });
    expect((await f.operations.create("principal", create())).operation).toEqual(result.operation);
    expect(f.commands).toHaveLength(1);
    expect(f.registry.get(result.operation.run).status.status).toBe("unverifiable");
    f.close();
  });

  it("conflicts on changed canonical intent without another side effect", async () => {
    const f = fixture();
    const held = f.operations.create("principal", create());
    await settled();
    const conflict = await f.operations.create("principal", { ...create(), argv: ["different"] });
    expect(conflict.error.kind).toBe("OPERATION_ID_CONFLICT");
    expect(f.commands).toHaveLength(1);
    f.reply();
    await held;
    f.close();
  });

  it("rejects an old instance before receipt run or worker reservation", async () => {
    const f = fixture();
    const before = f.bytes.snapshot();
    const result = await f.operations.create("principal", {
      ...create(),
      expectedRelayInstanceId: "old",
    });
    expect(result.error.kind).toBe("INSTANCE_MISMATCH");
    expect(f.commands).toHaveLength(0);
    expect(f.receipts.count).toBe(0);
    expect(f.registry.count).toBe(0);
    expect(f.bytes.snapshot()).toEqual(before);
    f.close();
  });

  it("binds deduplication to principal as well as operation ID", async () => {
    const f = fixture();
    const first = f.operations.create("first", create());
    await settled();
    f.reply(0);
    await first;
    const second = f.operations.create("second", create());
    await settled();
    expect(f.commands).toHaveLength(2);
    expect(f.commands[0].run).not.toEqual(f.commands[1].run);
    f.reply(1);
    await second;
    expect(f.receipts.count).toBe(2);
    f.close();
  });

  it("refuses receipt cap plus one and keeps completed deduplication proof", async () => {
    const f = fixture({ operationReceipts: 1 });
    const first = f.operations.create("principal", create());
    await settled();
    f.reply();
    await first;
    const before = f.bytes.snapshot();
    expect((await f.operations.create("principal", create("extra"))).error.kind).toBe("BUSY");
    expect(f.commands).toHaveLength(1);
    expect(f.registry.count).toBe(1);
    expect(f.bytes.snapshot()).toEqual(before);
    expect((await f.operations.create("principal", create())).operation.state).toBe("succeeded");
    f.close();
  });

  it("cancels a prepared receipt when run capacity is unavailable", async () => {
    const f = fixture({ maxRuns: 1, listPage: 1 });
    const first = f.operations.create("principal", create());
    await settled();
    f.reply();
    await first;
    const before = f.bytes.snapshot();
    expect((await f.operations.create("principal", create("extra"))).error.kind).toBe("BUSY");
    expect(f.receipts.count).toBe(1);
    expect(f.registry.count).toBe(1);
    expect(f.commands).toHaveLength(1);
    expect(f.bytes.snapshot()).toEqual(before);
    f.close();
  });

  it("does not turn accepted stop into exit or release pool capacity", async () => {
    const f = fixture();
    const started = f.operations.create("principal", create());
    await settled();
    f.reply();
    const run = (await started).operation.run;
    const stopped = f.operations.stop("principal", {
      operationId: "stop",
      expectedRelayInstanceId: "instance",
      run,
    });
    await settled();
    f.reply(1);
    const result = await stopped;
    expect(result.operation.state).toBe("running");
    expect(f.runtime.pool.snapshot().runs).toBe(1);
    expect(f.registry.get(run).status.status).toBe("unverifiable");
    expect(
      (
        await f.operations.stop("principal", {
          operationId: "stop",
          expectedRelayInstanceId: "instance",
          run,
        })
      ).operation,
    ).toEqual(result.operation);
    expect(f.commands).toHaveLength(2);
    f.close();
  });

  it("finishes stop only after correlated exited run evidence without native capacity release", async () => {
    const f = fixture();
    const started = f.operations.create("principal", create());
    await settled();
    f.reply();
    const run = (await started).operation.run;
    const stopped = f.operations.stop("principal", {
      operationId: "stop",
      expectedRelayInstanceId: "instance",
      run,
    });
    await settled();
    f.reply(1);
    await stopped;
    const request = { type: "status", worker, run, requestId: "status-proof" };
    const checked = f.runtime.getStatus(request);
    await settled();
    f.reply(2, {
      runStatus: {
        run,
        status: "exited",
        geometry: { cols: 80, rows: 24 },
        controlEpoch: 0,
        controlHolder: null,
        receivedSeq: 0,
        parsedSeq: 0,
        recovery: "unavailable",
        exitCode: 0,
        signal: null,
      },
    });
    await checked;
    expect((await f.operations.get("principal", "stop")).operation.state).toBe("succeeded");
    expect(f.runtime.pool.snapshot().runs).toBe(1);
    f.close();
  });

  it("returns detached records and prevents terminal revision rewrites", async () => {
    const f = fixture();
    const held = f.operations.create("principal", create());
    await settled();
    f.reply();
    const result = await held;
    result.operation.run.runId = "mutated";
    const key = { serverId: "server", principalId: "principal", operationId: "create" };
    const stored = await f.receipts.get(key);
    expect(stored.run.runId).toBe("run-1");
    expect(
      await f.receipts.update(key, { ...stored, revision: stored.revision + 1, state: "running" }),
    ).toBe(false);
    f.close();
  });

  it("uses public canonical intent independent of JSON order and operation ID", () => {
    const input = create();
    const reverse = Object.fromEntries(
      Object.entries({ ...input, operationId: "other" }).reverse(),
    );
    expect(canonicalOperationIntent("terminal.create", input, codec.encode)).toBe(
      canonicalOperationIntent("terminal.create", reverse, codec.encode),
    );
  });

  it("refuses a lower canonical-byte budget before accepted ownership", async () => {
    const f = fixture({ canonicalIntentBytes: 1 });
    const before = f.bytes.snapshot();
    expect((await f.operations.create("principal", create())).error.kind).toBe("BUSY");
    expect(f.receipts.count).toBe(0);
    expect(f.commands).toHaveLength(0);
    expect(f.registry.count).toBe(0);
    expect(f.bytes.snapshot()).toEqual(before);
    f.close();
  });
});
