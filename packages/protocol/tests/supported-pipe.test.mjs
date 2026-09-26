import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import {
  PIPE_LANE,
  PIPE_REVISION,
  PIPE_VERSION,
  PipeCommandSchema,
  RunStatusSchema,
  composeSpawnPayload,
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
  validatePipeReadiness,
  validatePipeResultForCommand,
  validateSpawnPayload,
} from "@cove/protocol/pipe";
import { createPipeDecoder as createProbeDecoder } from "@cove/protocol/provisional/pipe";

const worker = {
  serverId: "s1",
  relayInstanceId: "i1",
  workerId: "w1",
  workerIncarnationId: "wi1",
};
const run = { serverId: "s1", relayInstanceId: "i1", runId: "r1" };
const subscription = {
  run,
  connection: { connectionId: "c1", generation: 1 },
  subscriptionId: "sub1",
  viewId: "v1",
};
const empty = new Uint8Array();
const frame = (kind, payload = empty) => ({ kind, metadata: empty, payload });
const hello = {
  type: "hello",
  worker,
  pipeVersion: PIPE_VERSION,
  buildVersion: "build-a",
  effectiveBudgets: M0_LIMITS,
};
const geometry = { cols: 80, rows: 24 };
const spawnArgs = { executable: "/bin/sh", argv: ["-c", "echo ok"], cwd: "/tmp" };
const encoder = (text) => new TextEncoder().encode(text);

test("frozen pipe lane rejects provisional frames and owns split bytes", () => {
  const encoded = encodePipeFrame(1, encoder(JSON.stringify(hello)), empty);
  expect(encoded.ok).toBe(true);
  expect(Array.from(encoded.value.subarray(0, 5))).toEqual([67, 80, PIPE_LANE, PIPE_REVISION, 1]);
  expect(createProbeDecoder().read(encoded.value).status).toBe("error");
  const decoder = createPipeDecoder();
  expect(decoder.read(encoded.value.subarray(0, 7)).frames).toHaveLength(0);
  expect(decoder.read(encoded.value.subarray(7)).frames).toHaveLength(1);
});

test("hello/ready require exact worker, version and limits but not build string", () => {
  expect(validatePipeFrame(frame(1), hello).ok).toBe(true);
  expect(validatePipeFrame(frame(2), hello).ok).toBe(false);
  expect(validatePipeReadiness(hello, { ...hello, type: "ready", buildVersion: "build-b" })).toBe(
    true,
  );
  expect(
    validatePipeReadiness(hello, {
      ...hello,
      type: "ready",
      worker: {
        ...worker,
        workerIncarnationId: "wi2",
      },
    }),
  ).toBe(false);
  expect(validatePipeFrame(frame(2), { ...hello, type: "ready", pipeVersion: 2 }).ok).toBe(false);
  expect(
    validatePipeFrame(frame(1), {
      ...hello,
      effectiveBudgets: {
        ...M0_LIMITS,
        subscriptionCreditBytes: 1,
      },
    }).ok,
  ).toBe(false);
});

test("spawn payload composition is exact UTF-8 JSON within eight KiB", () => {
  const composed = composeSpawnPayload(spawnArgs, encoder);
  expect(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(composed.bytes))).toEqual(
    spawnArgs,
  );
  expect(composeSpawnPayload({ ...spawnArgs, argv: ["a".repeat(8192)] }, encoder)).toBeNull();
  expect(composeSpawnPayload({ ...spawnArgs, executable: "é".repeat(4096) }, encoder)).toBeNull();
  expect(composeSpawnPayload({ ...spawnArgs, argv: Array(65).fill("a") }, encoder)).toBeNull();
});

test("spawn is a closed command with payload, geometry and profile", () => {
  const bytes = composeSpawnPayload(spawnArgs, encoder).bytes;
  const command = {
    type: "spawn",
    worker,
    run,
    requestId: "q1",
    operationId: "o1",
    geometry,
    profile: "pragmatic-logical-grid-v1",
    appearance: DEFAULT_APPEARANCE,
    effectiveBudgets: M0_LIMITS,
    spawnPayloadBytes: bytes.length,
  };
  expect(validatePipeFrame(frame(1, bytes), command).ok).toBe(true);
  expect(validateSpawnPayload(command, bytes, spawnArgs, encoder)).toEqual(spawnArgs);
  expect(
    validateSpawnPayload(command, bytes, { ...spawnArgs, cwd: "/elsewhere" }, encoder),
  ).toBeNull();
  expect(validatePipeFrame(frame(1, bytes.subarray(1)), command).ok).toBe(false);
  expect(
    validatePipeFrame(frame(1, bytes), { ...command, run: { ...run, serverId: "s2" } }).ok,
  ).toBe(false);
  expect(PipeCommandSchema.safeParse({ ...command, type: "exec" }).success).toBe(false);
});

test("input bytes are opaque and require bound worker/run/subscription", () => {
  const command = {
    type: "input",
    worker,
    run,
    requestId: "q1",
    subscription,
    epoch: 2,
    inputSeq: 3,
  };
  expect(validatePipeFrame(frame(1, Uint8Array.of(0, 255)), command).ok).toBe(true);
  expect(validatePipeFrame(frame(1), command).ok).toBe(false);
  expect(
    validatePipeFrame(frame(1, Uint8Array.of(1)), {
      ...command,
      subscription: { ...subscription, run: { ...run, runId: "r2" } },
    }).ok,
  ).toBe(false);
});

test("result correlation fences worker incarnation, request, run and command", () => {
  const command = { type: "stop", worker, run, requestId: "q1", operationId: "o1" };
  const result = {
    type: "result",
    worker,
    run,
    requestId: "q1",
    commandType: "stop",
    outcome: "accepted",
    operationId: "o1",
  };
  expect(validatePipeFrame(frame(2), result).ok).toBe(true);
  expect(validatePipeResultForCommand(command, result)).toBe(true);
  for (const mismatch of [
    { requestId: "q2" },
    { commandType: "spawn" },
    { operationId: "o2" },
    { worker: { ...worker, workerIncarnationId: "wi2" } },
    { run: { ...run, relayInstanceId: "i2" } },
  ])
    expect(validatePipeResultForCommand(command, { ...result, ...mismatch })).toBe(false);
});

test("terminal event has one metadata copy and one opaque payload", () => {
  const event = { type: "terminal-event", worker, run, terminal: { type: "output", run, seq: 1 } };
  expect(validatePipeFrame(frame(3, Uint8Array.of(27, 0)), event).ok).toBe(true);
  expect(validatePipeFrame(frame(3), event).ok).toBe(false);
  expect(
    validatePipeFrame(frame(3, Uint8Array.of(1)), {
      ...event,
      terminal: { ...event.terminal, run: { ...run, runId: "r2" } },
    }).ok,
  ).toBe(false);
});

test("preview and run status distinguish current, stale and exited evidence", () => {
  const preview = { type: "preview-refresh", worker, run, requestId: "q1", knownVersion: 2 };
  expect(validatePipeFrame(frame(1), preview).ok).toBe(true);
  expect(validatePipeFrame(frame(1, Uint8Array.of(1)), preview).ok).toBe(false);
  const status = {
    run,
    status: "unverifiable",
    geometry,
    controlEpoch: 2,
    controlHolder: null,
    receivedSeq: 4,
    parsedSeq: 3,
    recovery: "waiting-checkpoint",
    exitCode: null,
    signal: null,
  };
  expect(RunStatusSchema.safeParse(status).success).toBe(true);
  expect(RunStatusSchema.safeParse({ ...status, status: "dead" }).success).toBe(false);
});

test("safe pipe errors and structure bounds reject credential leakage", () => {
  const error = {
    type: "error",
    worker,
    run,
    requestId: "q1",
    commandType: "status",
    error: domainError("WORKER_UNAVAILABLE", "unknown"),
  };
  expect(validatePipeFrame(frame(4), error).ok).toBe(true);
  expect(
    validatePipeFrame(frame(4), {
      ...error,
      error: {
        ...error.error,
        message: "secret path",
      },
    }).ok,
  ).toBe(false);
  let nested = {};
  for (let index = 0; index < 17; index++) nested = { child: nested };
  expect(validatePipeFrame(frame(4), { ...error, future: nested }).ok).toBe(false);
});
