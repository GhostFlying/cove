import { describe, expect, it } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { ERROR_CODES } from "@cove/protocol/errors";
import { RPC_DOMAINS, RPC_METHODS } from "@cove/protocol/rpc";
import { dispatchRpc } from "../../dist/rpc/dispatch.js";
import { rpcBody } from "../../dist/transport/http-rpc.js";

const encoder = new TextEncoder();
const unimplemented = new Set([
  "config",
  "repo",
  "task",
  "mount",
  "tab",
  "binding",
  // M2 T0 placeholders (auth: T1, entry and service: T3, tsnet: T5b).
  "auth",
  "entry",
  "service",
  "tsnet",
]);

// The initial domain modules touch no services; the existing ones see only what they call.
function fakeCore(extra = {}) {
  const calls = [];
  return {
    calls,
    core: {
      runtime: { composition: { budgets: { ...M0_LIMITS } } },
      operations: {
        get: (principalId, operationId) => {
          calls.push(["get", principalId, operationId]);
          return { error: { kind: "OPERATION_NOT_FOUND" } };
        },
        create: async (principalId, params) => {
          calls.push(["create", principalId, params.operationId]);
          return { error: { kind: "BUSY" } };
        },
      },
      buildVersion: "author",
      ...extra,
    },
  };
}

describe("table-driven RPC dispatch", () => {
  it("routes every method of an unimplemented domain to CAPABILITY_UNAVAILABLE", async () => {
    const methods = Object.entries(RPC_METHODS).filter(([, spec]) =>
      unimplemented.has(spec.domain),
    );
    expect(new Set(methods.map(([, spec]) => spec.domain))).toEqual(unimplemented);
    const { core, calls } = fakeCore();
    for (const [method] of methods) {
      const result = await dispatchRpc(core, method, {});
      expect(result).toEqual({
        error: expect.objectContaining({
          kind: "CAPABILITY_UNAVAILABLE",
          acceptance: "not-accepted",
        }),
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("answers an unimplemented write with a domain error that proves it was not accepted", async () => {
    const { core } = fakeCore();
    const request = {
      jsonrpc: "2.0",
      id: "q1",
      method: "task.create",
      params: { operationId: "o1", title: "Investigate", mounts: [] },
    };
    const response = await rpcBody(core, encoder.encode(JSON.stringify(request)));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      jsonrpc: "2.0",
      id: "q1",
      error: {
        code: ERROR_CODES.CAPABILITY_UNAVAILABLE,
        message: "CAPABILITY UNAVAILABLE",
        data: expect.objectContaining({
          kind: "CAPABILITY_UNAVAILABLE",
          acceptance: "not-accepted",
        }),
      },
    });
    // Schema validation still precedes dispatch.
    const invalid = await rpcBody(
      core,
      encoder.encode(
        JSON.stringify({
          ...request,
          method: "binding.delete",
          params: { operationId: "o2", taskId: "t", mountId: "m" },
        }),
      ),
    );
    expect(JSON.parse(invalid.body).error.code).toBe(-32602);
  });

  it("passes the durable principal to the operation and terminal modules", async () => {
    const first = fakeCore();
    await dispatchRpc(first.core, "operation.get", { operationId: "o1" });
    const second = fakeCore({ principalId: "owner-1" });
    await dispatchRpc(second.core, "operation.get", { operationId: "o1" });
    await dispatchRpc(second.core, "terminal.create", { operationId: "o2" });
    expect(first.calls).toEqual([["get", "m0-local", "o1"]]);
    expect(second.calls).toEqual([
      ["get", "owner-1", "o1"],
      ["create", "owner-1", "o2"],
    ]);
  });

  it("has a module for every domain of the method table", async () => {
    const { core } = fakeCore();
    for (const domain of RPC_DOMAINS)
      expect(Object.values(RPC_METHODS).some((spec) => spec.domain === domain)).toBe(true);
    for (const method of Object.keys(RPC_METHODS).filter(
      (name) => RPC_METHODS[name].domain !== "server" && RPC_METHODS[name].domain !== "terminal",
    ))
      await expect(
        Promise.resolve(dispatchRpc(core, method, { operationId: "o" })),
      ).resolves.toBeTruthy();
  });
});
