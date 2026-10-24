import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import {
  canonicalWriteIntent,
  OperationRecordSchema,
  validateRpcMethodParams,
  validateRpcResultForCall,
} from "@cove/protocol/rpc";
import { validatePipeResultForCommand } from "@cove/protocol/pipe";
import { inputPartReceipt, TabSendParamsSchema } from "@cove/protocol/workspace";
const run = { serverId: "s", relayInstanceId: "i", runId: "r" };
const params = {
  operationId: "op",
  tabId: "tab",
  run,
  ifControlEpoch: 0,
  text: "hello",
  submit: true,
};
const encode = (s) => new TextEncoder().encode(s);

test("send binds exact run, instance, epoch, UTF-8 text and submit to immutable intent", () => {
  const original = canonicalWriteIntent("tab.send", params, encode);
  expect(original).toBeTruthy();
  expect(canonicalWriteIntent("tab.send", { ...params, operationId: "other" }, encode)).toBe(
    original,
  );
  for (const patch of [
    { run: { ...run, runId: "new" } },
    { run: { ...run, relayInstanceId: "new" } },
    { ifControlEpoch: 1 },
    { text: "hello\n" },
    { submit: false },
  ])
    expect(canonicalWriteIntent("tab.send", { ...params, ...patch }, encode)).not.toBe(original);
  expect(domainError("CONTROL_HELD").nextAction).toBe("refresh-control");
});

test("send bounds UTF-8 and serialized intent separately without truncation", () => {
  expect(TabSendParamsSchema.safeParse({ ...params, text: "😀".repeat(1024) }).success).toBe(true);
  for (const text of ["😀".repeat(1025), "x".repeat(4097), "\ud800"])
    expect(validateRpcMethodParams("tab.send", { ...params, text })).toBeNull();
  expect(
    canonicalWriteIntent("tab.send", { ...params, text: "\u0001".repeat(2000) }, encode),
  ).toBeNull();
  expect(validateRpcMethodParams("tab.send", { ...params, text: "", submit: false })).toBeNull();
  expect(validateRpcMethodParams("tab.send", { ...params, text: "", submit: true })).not.toBeNull();
});

test("receipt preserves a confirmed byte prefix and suppresses submit after incomplete text", () => {
  const operation = {
    operationId: "op",
    method: "tab.send",
    revision: 2,
    state: "requires_attention",
    run,
    result: {
      resource: { kind: "tab", id: "tab", revision: 0 },
      input: {
        text: inputPartReceipt(5, 2, 3, "worker-lost"),
        submit: inputPartReceipt(1, 0, 0, "text-not-complete"),
      },
    },
  };
  expect(OperationRecordSchema.safeParse(operation).success).toBe(true);
  expect(validateRpcResultForCall("tab.send", params, { operation })).toBe(true);
  expect(
    validateRpcResultForCall(
      "tab.send",
      { ...params, run: { ...run, runId: "changed" } },
      { operation },
    ),
  ).toBe(false);
  expect(
    validateRpcResultForCall("tab.send", { ...params, text: "different-length" }, { operation }),
  ).toBe(false);
  expect(encode(JSON.stringify(operation)).byteLength).toBeLessThan(M0_LIMITS.operationRecordBytes);
  const wrong = structuredClone(operation);
  wrong.result.input.submit = inputPartReceipt(1, 1, 0);
  expect(OperationRecordSchema.safeParse(wrong).success).toBe(false);
  wrong.result.input = {
    text: { status: "partial", requestedBytes: 5, writtenBytes: 6, unknownBytes: 0 },
    submit: null,
  };
  expect(OperationRecordSchema.safeParse(wrong).success).toBe(false);
});

test("programmatic pipe result correlates immutable lengths, identity and completion", () => {
  const command = {
    type: "programmatic-input",
    requestId: "req",
    operationId: "op",
    run,
    worker: { serverId: "s", relayInstanceId: "i", workerId: "w", workerIncarnationId: "b" },
    epoch: 0,
    textBytes: 5,
    submit: true,
  };
  const result = {
    type: "result",
    commandType: command.type,
    requestId: "req",
    operationId: "op",
    run,
    worker: command.worker,
    outcome: "accepted",
    input: { text: inputPartReceipt(5, 5, 0), submit: inputPartReceipt(1, 1, 0) },
  };
  expect(validatePipeResultForCommand(command, result)).toBe(true);
  expect(validatePipeResultForCommand(command, { ...result, operationId: "other" })).toBe(false);
  expect(
    validatePipeResultForCommand(command, { ...result, input: { ...result.input, submit: null } }),
  ).toBe(false);
  expect(
    validatePipeResultForCommand(command, {
      ...result,
      input: { ...result.input, text: inputPartReceipt(5, 2, 3) },
    }),
  ).toBe(false);
});
