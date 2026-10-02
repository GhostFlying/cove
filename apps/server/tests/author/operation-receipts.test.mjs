import { describe, it, expect } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { canonicalOperationIntent } from "@cove/protocol/rpc";
import { encodePipeFrame } from "@cove/protocol/pipe";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
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
function fixture(changes = {}) {
  const budgets = { ...M0_LIMITS, ...changes };
  const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
  const commands = [];
  const session = new WorkerPipeSession({
    worker,
    budgets,
    bytes,
    codec,
    buildVersion: "author",
    transport: {
      write: (data, done) => {
        const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(8);
        const metadata = JSON.parse(codec.decode(data.subarray(16, 16 + length)));
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
  const pool = new WorkerPool(budgets, bytes, 1, budgets.maxRuns);
  const registry = new RunRegistry("server", "instance", budgets.maxRuns, bytes);
  const runtime = new LocalRuntime(pool, registry, bytes, codec.encode);
  runtime.addWorker(session);
  const receipts = new OperationReceipts("server", "instance", budgets, bytes, codec.encode);
  const operations = new TerminalOperations({
    serverId: "server",
    relayInstanceId: "instance",
    budgets,
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
  return { bytes, commands, session, runtime, registry, receipts, operations, reply, close };
}

describe("instance-bound operation receipts", () => {
  it("reserves before spawn and concurrent same intent starts only one run", async () => {
    const f = fixture();
    const first = f.operations.create("principal", create());
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
    f.reply(0);
    await first;
    const second = f.operations.create("second", create());
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
    f.reply();
    const run = (await started).operation.run;
    const stopped = f.operations.stop("principal", {
      operationId: "stop",
      expectedRelayInstanceId: "instance",
      run,
    });
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
    f.reply();
    const run = (await started).operation.run;
    const stopped = f.operations.stop("principal", {
      operationId: "stop",
      expectedRelayInstanceId: "instance",
      run,
    });
    f.reply(1);
    await stopped;
    const request = { type: "status", worker, run, requestId: "status-proof" };
    const checked = f.runtime.getStatus(request);
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
    expect(f.operations.get("principal", "stop", "instance").operation.state).toBe("succeeded");
    expect(f.runtime.pool.snapshot().runs).toBe(1);
    f.close();
  });

  it("returns detached records and prevents terminal revision rewrites", async () => {
    const f = fixture();
    const held = f.operations.create("principal", create());
    f.reply();
    const result = await held;
    result.operation.run.runId = "mutated";
    const key = {
      serverId: "server",
      relayInstanceId: "instance",
      principalId: "principal",
      operationId: "create",
    };
    const stored = f.receipts.get(key);
    expect(stored.run.runId).toBe("run-1");
    expect(
      f.receipts.update(key, { ...stored, revision: stored.revision + 1, state: "running" }),
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
