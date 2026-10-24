import { expect, test } from "vitest";
import { createServerSession } from "@cove/client";
import { bootstrapFailure } from "@cove/protocol/bootstrap";
import {
  batch,
  bindingFixture,
  codec,
  config,
  cursor,
  identity,
  operation,
  settle,
  snapshot,
} from "./business-fixture.mjs";

function session(fixtures, options = {}) {
  let index = 0;
  return createServerSession({
    serverId: identity.serverId,
    scheduler: fixtures[0].clock,
    codec,
    bind: () => ({
      result: Promise.resolve(fixtures[Math.min(index++, fixtures.length - 1)].binding),
      dispose() {},
    }),
    ...options,
  });
}

test("session connects shared mirror without sending any automatic business or terminal commands", async () => {
  const f = bindingFixture();
  const value = session([f]);
  expect(await value.connect()).toEqual({ ok: true });
  expect(value.snapshot().status).toBe("current");
  expect(value.snapshot().mirror.records).toHaveLength(1);
  expect(f.calls).toHaveLength(0);
  expect(f.terminalSent.map((message) => message.type)).toEqual(["cove-bootstrap"]);
  value.suspend();
  expect(value.snapshot().status).toBe("suspended");
  expect(value.snapshot().mirror.status).toBe("stale");
  expect(f.disposed).toBe(1);
  value.dispose();
});

test("pending entry verification is cancelled promptly and late bindings never request credentials", async () => {
  const f = bindingFixture();
  let resolve;
  let cancelled = 0;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const value = session([f], {
    bind: () => ({
      result: pending,
      dispose() {
        cancelled++;
      },
    }),
  });
  const connected = value.connect();
  await settle();
  value.dispose();
  expect(await connected).toEqual({ ok: false, reason: "disposed" });
  expect(cancelled).toBe(1);
  resolve(f.binding);
  await settle();
  expect(f.credentials).toBe(0);
  expect(f.disposed).toBe(1);
  expect(f.clock.pending).toBe(0);
});

test("wrong stable server identity is rejected before Client construction or credentials", async () => {
  const f = bindingFixture({ ids: { ...identity, serverId: "wrong" } });
  const value = session([f]);
  expect(await value.connect()).toEqual({ ok: false, reason: "entry-identity" });
  expect(f.credentials).toBe(0);
  value.dispose();
  const refused = bindingFixture();
  refused.binding.client.http = {
    post(request, callbacks) {
      queueMicrotask(() =>
        callbacks.onResponse({
          status: 403,
          headers: {},
          body: codec.encode(JSON.stringify(bootstrapFailure("DEVICE_REVOKED"))),
        }),
      );
      return { cancel: () => "not-sent" };
    },
  };
  const rejected = session([refused]);
  expect(await rejected.connect()).toEqual({ ok: false, reason: "DEVICE_REVOKED" });
  expect(rejected.snapshot().lastError).toBe("DEVICE_REVOKED");
  rejected.dispose();
});

test("unknown write survives reset, absent snapshot, not-found query and server restart without replay", async () => {
  const f = bindingFixture({
    rpc: (call) => call.callbacks.onFailure({ reason: "transport", disposition: "handed-off" }),
  });
  const ids = { ...identity, relayInstanceId: "instance-2" };
  const next = bindingFixture({ ids });
  const value = session([f, next]);
  await value.connect();
  const outcome = await value.call("config.set", {
    operationId: "original",
    patch: { workspaceRoot: "/new" },
  });
  expect(outcome.kind).toBe("operation-unknown");
  expect(value.forgetOperation("original")).toBe(false);
  expect(await value.reconnect()).toEqual({ ok: true });
  await settle(150);
  const tracked = value.snapshot().operations[0];
  expect(tracked.reference).toEqual({
    operationId: "original",
    method: "config.set",
    relayInstanceId: "instance-1",
  });
  expect(tracked.delivery).toBe("unknown");
  expect(tracked.observation).toBe("not-found");
  expect(value.snapshot().mirror.identity).toEqual(ids);
  expect(f.calls.map((call) => call.message.method)).toEqual(["config.set"]);
  expect(next.calls.map((call) => call.message.method)).toEqual(["operation.get"]);
  expect(value.snapshot().operations).toHaveLength(1);
  value.dispose();
});

test("late RPC and old event callbacks cannot restore deleted records after reconnect", async () => {
  let held;
  const f = bindingFixture({
    rpc: (call) => {
      held = call;
    },
  });
  const nextIds = { ...identity, relayInstanceId: "instance-2" };
  const next = bindingFixture({
    ids: nextIds,
    frames: () => snapshot([config(2)], cursor(0, nextIds)),
  });
  const value = session([f, next]);
  await value.connect();
  const reading = value.call("config.get", {});
  await settle();
  await value.reconnect();
  const current = value.snapshot().mirror.cursor;
  next.events.latest().emit(batch(current, [{ type: "delete", kind: "config", id: "server" }]));
  await settle(100);
  held.response({ config: config(9).record });
  f.events.latest().emit(batch(cursor(), [{ type: "upsert", value: config(9) }]));
  expect((await reading).ok).toBe(false);
  await settle();
  expect(value.snapshot().mirror.records).toHaveLength(0);
  value.dispose();
});

test("one explicit reset obtains a fresh snapshot but repeated resets stop with stale state", async () => {
  let subscribed = 0;
  const f = bindingFixture({
    frames: () =>
      ++subscribed === 1 ? [{ type: "reset", reason: "generation" }] : snapshot([config(3)]),
  });
  const value = session([f]);
  expect(await value.connect()).toEqual({ ok: true });
  expect(subscribed).toBe(2);
  expect(f.events.connections[1].sent[1].since).toBeUndefined();
  expect(f.calls).toHaveLength(0);
  f.events.latest().emit({ type: "reset", reason: "gap" });
  await settle(150);
  expect(value.snapshot().status).toBe("stale");
  expect(f.events.connections).toHaveLength(2);
  value.dispose();
});

test("operation record observations cannot regress newer stream revisions and require_attention stays retained", async () => {
  let held;
  const f = bindingFixture({
    rpc: (call) => {
      held = call;
    },
  });
  const value = session([f]);
  await value.connect();
  const writing = value.call("config.set", { operationId: "op", patch: { workspaceRoot: "/new" } });
  await settle();
  const latest = operation("op", 4, "requires_attention");
  f.events
    .latest()
    .emit(
      batch(cursor(), [{ type: "upsert", value: { kind: "operation", id: "op", record: latest } }]),
    );
  await settle(100);
  held.response({ operation: operation("op", 1, "running") });
  expect((await writing).ok).toBe(true);
  expect(value.snapshot().operations[0].record.state).toBe("requires_attention");
  expect(value.snapshot().operations[0].record.revision).toBe(4);
  expect(value.forgetOperation("op")).toBe(false);
  value.dispose();
});

test("local operation capacity rejects before dispatch and settled records are explicitly released", async () => {
  const f = bindingFixture();
  const value = session([f]);
  await value.connect();
  for (let index = 0; index < 256; index++)
    expect(
      (
        await value.call("config.set", {
          operationId: `op-${index}`,
          patch: { workspaceRoot: "/new" },
        })
      ).ok,
    ).toBe(true);
  expect(
    (await value.call("config.set", { operationId: "excess", patch: { workspaceRoot: "/new" } }))
      .error.reason,
  ).toBe("capacity");
  expect(f.calls).toHaveLength(256);
  expect(value.forgetOperation("op-0")).toBe(true);
  expect(
    (
      await value.call("config.set", {
        operationId: "replacement",
        patch: { workspaceRoot: "/new" },
      })
    ).ok,
  ).toBe(true);
  value.dispose();
});

test("retirement of a pending write preserves unknown identity and cancels only owned channels", async () => {
  const f = bindingFixture({ rpc() {} });
  const value = session([f]);
  await value.connect();
  const writing = value.call("config.set", {
    operationId: "pending",
    patch: { workspaceRoot: "/new" },
  });
  await settle();
  value.suspend();
  expect((await writing).kind).toBe("operation-unknown");
  expect(value.snapshot().operations[0].delivery).toBe("unknown");
  expect(f.disposed).toBe(1);
  expect(f.calls).toHaveLength(1);
  expect(f.events.latest().cancelled).toBe(1);
  value.dispose();
});

test("cleanup re-entry cannot resurrect a superseded session or send cancelled writes", async () => {
  const f = bindingFixture();
  const value = session([f]);
  await value.connect();
  f.binding.dispose = () => value.dispose();
  expect((await value.reconnect()).ok).toBe(false);
  expect(value.snapshot().status).toBe("disposed");
  const next = bindingFixture();
  const other = session([next]);
  await other.connect();
  const writing = other.call("config.set", {
    operationId: "unsent",
    patch: { workspaceRoot: "/new" },
  });
  other.suspend();
  expect((await writing).kind).toBe("operation-not-sent");
  expect(other.snapshot().operations[0].delivery).toBe("not-sent");
  expect(next.calls).toHaveLength(0);
  other.dispose();
});
