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
  SPAWN_ENV_KEYS,
  SPAWN_ENV_PAYLOAD_BYTES,
  SPAWN_ENV_VALUE_CHARS,
  SpawnArgumentsSchema,
  SpawnCommandSchema,
  composeSpawnPayload,
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
  validatePipeReadiness,
  validatePipeResultForCommand,
  validateSpawnPayload,
} from "@cove/protocol/pipe";
import { createPipeDecoder as createProbeDecoder } from "@cove/protocol/provisional/pipe";
import { RPC_METHODS, canonicalOperationIntent } from "@cove/protocol/rpc";

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
  expect(PIPE_VERSION).toBe(2);
  expect(PIPE_REVISION).toBe(2);
  const oldRevision = encoded.value.slice();
  oldRevision[3] = 1;
  expect(createPipeDecoder().read(oldRevision)).toMatchObject({
    status: "error",
    error: { code: "UNSUPPORTED_FORMAT" },
  });
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
  expect(validatePipeFrame(frame(2), { ...hello, type: "ready", pipeVersion: 1 }).ok).toBe(false);
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

// #120: the spawn `env` carries only Cove's run identity. Fixture values only.
const identity = { COVE_TASK_ID: "task-fixture-1", COVE_TAB_ID: "tab-fixture-1" };
const spawnCommand = (bytes) => ({
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
});

test("spawn env accepts the Cove identity keys and a spawn without it is the command-only payload", () => {
  expect(SPAWN_ENV_KEYS).toEqual(["COVE_TASK_ID", "COVE_TAB_ID"]);
  const withEnv = { ...spawnArgs, env: identity };
  const composed = composeSpawnPayload(withEnv, encoder);
  expect(JSON.parse(new TextDecoder().decode(composed.bytes))).toEqual(withEnv);
  const command = spawnCommand(composed.bytes);
  expect(validatePipeFrame(frame(1, composed.bytes), command).ok).toBe(true);
  expect(validateSpawnPayload(command, composed.bytes, withEnv, encoder)).toEqual(withEnv);
  // Either key alone, an empty map, and printable ASCII up to the bound (space, quote, backslash).
  for (const env of [
    { COVE_TAB_ID: "t" },
    {},
    { COVE_TASK_ID: ` !"\\~${"a".repeat(SPAWN_ENV_VALUE_CHARS - 5)}` },
  ])
    expect(composeSpawnPayload({ ...spawnArgs, env }, encoder)?.arguments.env).toEqual(env);
  // No env: the payload is the command-only JSON, with no env member.
  const plain = composeSpawnPayload(spawnArgs, encoder);
  expect(new TextDecoder().decode(plain.bytes)).toBe(JSON.stringify(spawnArgs));
  expect(plain.arguments).not.toHaveProperty("env");
  // The env member is part of the canonical bytes: dropping it does not reproduce the payload.
  const oldReencoded = encoder(JSON.stringify(SpawnCommandSchema.parse(withEnv)));
  expect(Buffer.from(oldReencoded).equals(Buffer.from(composed.bytes))).toBe(false);
});

test("spawn env rejects unknown keys, oversized values and control characters", () => {
  const rejected = [
    { PATH: "/usr/bin" },
    { LD_PRELOAD: "/tmp/x.so" },
    { cove_task_id: "lowercase" },
    { COVE_TASK_ID: "t", COVE_HOME: "/elsewhere" },
    { COVE_TASK_ID: "a".repeat(SPAWN_ENV_VALUE_CHARS + 1) },
    { COVE_TASK_ID: "" },
    { COVE_TASK_ID: "line\nbreak" },
    { COVE_TASK_ID: "nul\u0000byte" },
    { COVE_TASK_ID: "esc\u001b[31m" },
    { COVE_TASK_ID: "tab\there" },
    { COVE_TASK_ID: "del\u007f" },
    { COVE_TASK_ID: "café" },
    { COVE_TASK_ID: 7 },
    { COVE_TASK_ID: null },
    ["COVE_TASK_ID=x"],
    "COVE_TASK_ID=x",
  ];
  for (const env of rejected) {
    expect(SpawnArgumentsSchema.safeParse({ ...spawnArgs, env }).success).toBe(false);
    expect(composeSpawnPayload({ ...spawnArgs, env }, encoder)).toBeNull();
  }
  // A worker re-validates the payload it receives: an unknown key a sender wrote by hand is
  // refused rather than stripped and run.
  const forged = { ...spawnArgs, env: { ...identity, PATH: "/tmp" } };
  const bytes = encoder(JSON.stringify(forged));
  expect(validateSpawnPayload(spawnCommand(bytes), bytes, forged, encoder)).toBeNull();
});

test("the identity has its own payload room and a client cannot send one with terminal.create", () => {
  // The largest identity, every character needing a JSON escape, stays within its room.
  const largest = Object.fromEntries(
    SPAWN_ENV_KEYS.map((key) => [key, '"'.repeat(SPAWN_ENV_VALUE_CHARS)]),
  );
  const extra =
    encoder(JSON.stringify({ ...spawnArgs, env: largest })).length -
    encoder(JSON.stringify(spawnArgs)).length;
  expect(extra).toBeLessThanOrEqual(SPAWN_ENV_PAYLOAD_BYTES);
  // A command at its own pre-#120 bound still composes with the largest identity.
  const filler = "a".repeat(
    M0_LIMITS.argvBytes - encoder(JSON.stringify({ ...spawnArgs, argv: [""] })).length,
  );
  const full = { ...spawnArgs, argv: [filler] };
  expect(encoder(JSON.stringify(full)).length).toBe(M0_LIMITS.argvBytes);
  const composed = composeSpawnPayload({ ...full, env: largest }, encoder);
  expect(composed).not.toBeNull();
  expect(PipeCommandSchema.safeParse(spawnCommand(composed.bytes)).success).toBe(true);
  expect(
    composeSpawnPayload({ ...spawnArgs, argv: [`${filler}a`], env: identity }, encoder),
  ).toBeNull();
  // terminal.create names a command only: an env member is dropped, never forwarded.
  const params = RPC_METHODS["terminal.create"].params.parse({
    ...spawnArgs,
    env: identity,
    operationId: "op1",
    expectedRelayInstanceId: "i1",
    geometry,
  });
  expect(params).not.toHaveProperty("env");
  const intent = canonicalOperationIntent("terminal.create", { ...params, env: identity }, encoder);
  expect(intent).not.toBeNull();
  expect(intent).not.toContain("COVE_TASK_ID");
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
  expect(validatePipeResultForCommand(command, { ...result, requestId: "q2" })).toBe(false);
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
  const event = {
    type: "terminal-event",
    worker,
    run,
    subscription,
    terminal: { type: "output", run, seq: 1 },
  };
  expect(validatePipeFrame(frame(3, Uint8Array.of(27, 0)), event).ok).toBe(true);
  expect(validatePipeFrame(frame(3), event).ok).toBe(false);
  expect(
    validatePipeFrame(frame(3, Uint8Array.of(1)), {
      ...event,
      terminal: { ...event.terminal, run: { ...run, runId: "r2" } },
    }).ok,
  ).toBe(false);
  expect(
    validatePipeFrame(frame(3, Uint8Array.of(1)), { ...event, subscription: undefined }).ok,
  ).toBe(false);
  expect(
    validatePipeFrame(frame(3, Uint8Array.of(1)), {
      ...event,
      subscription: { ...subscription, subscriptionId: "sub2" },
    }).ok,
  ).toBe(true);
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
  expect(validatePipeFrame({ ...frame(4), metadata: new Uint8Array(4097) }, error).ok).toBe(false);
  const output = {
    type: "terminal-event",
    worker,
    run,
    subscription,
    terminal: { type: "output", run, seq: 1 },
  };
  expect(validatePipeFrame(frame(3, new Uint8Array(65_537)), output).ok).toBe(false);
  expect(encodePipeFrame(3, encoder(JSON.stringify(output)), new Uint8Array(65_537)).ok).toBe(
    false,
  );
});

test("recover keeps one complete subscription and accepted result marks the barrier", () => {
  const command = {
    type: "recover",
    worker,
    run,
    requestId: "q1",
    subscription,
    appliedSeq: 3,
  };
  expect(validatePipeFrame(frame(1), command).ok).toBe(true);
  const result = {
    type: "result",
    worker,
    run,
    requestId: command.requestId,
    commandType: "recover",
    outcome: "accepted",
    recoveryMode: "replay",
    atSeq: 3,
  };
  expect(validatePipeFrame(frame(2), result).ok).toBe(true);
  expect(validatePipeResultForCommand(command, result)).toBe(true);
  expect(validatePipeResultForCommand({ ...command, appliedSeq: undefined }, result)).toBe(false);
  expect(
    validatePipeResultForCommand(
      { ...command, appliedSeq: undefined },
      { ...result, recoveryMode: "baseline" },
    ),
  ).toBe(true);
  expect(validatePipeFrame(frame(2), { ...result, recoveryMode: undefined }).ok).toBe(false);
  expect(validatePipeFrame(frame(2), { ...result, atSeq: undefined }).ok).toBe(false);
  expect(validatePipeResultForCommand(command, { ...result, atSeq: 2 })).toBe(false);
  expect(
    validatePipeFrame(frame(2), {
      ...result,
      commandType: "status",
      recoveryMode: "baseline",
    }).ok,
  ).toBe(false);
  const subscribe = {
    type: "subscribe",
    worker,
    run,
    requestId: "q-subscribe",
    subscription: { ...subscription, subscriptionId: "sub-new" },
    atSeq: 4,
  };
  const subscribed = {
    ...result,
    requestId: subscribe.requestId,
    commandType: "subscribe",
    recoveryMode: "baseline",
    atSeq: 4,
  };
  expect(validatePipeFrame(frame(1), subscribe).ok).toBe(true);
  expect(validatePipeFrame(frame(2), subscribed).ok).toBe(true);
  expect(validatePipeResultForCommand(subscribe, subscribed)).toBe(true);
  expect(validatePipeFrame(frame(2), { ...subscribed, recoveryMode: undefined }).ok).toBe(false);
  const projected = PipeCommandSchema.parse({
    ...command,
    replacement: { ...subscription, subscriptionId: "sub-new" },
  });
  expect(Object.hasOwn(projected, "replacement")).toBe(false);
});

test("baseline route matches its embedded ref and preview forbids a live route", () => {
  const baseline = {
    type: "terminal-event",
    worker,
    run,
    subscription,
    terminal: {
      type: "baseline-chunk",
      run,
      subscription,
      baselineId: "b1",
      ordinal: 0,
    },
  };
  expect(validatePipeFrame(frame(3, Uint8Array.of(1)), baseline).ok).toBe(true);
  expect(
    validatePipeFrame(frame(3, Uint8Array.of(1)), {
      ...baseline,
      subscription: { ...subscription, viewId: "v2" },
    }).ok,
  ).toBe(false);
  expect(
    validatePipeFrame(frame(3, Uint8Array.of(1)), { ...baseline, subscription: undefined }).ok,
  ).toBe(false);
  const preview = {
    type: "terminal-event",
    worker,
    run,
    terminal: { type: "preview-chunk", run, previewId: "p1", version: 1, ordinal: 0 },
  };
  expect(validatePipeFrame(frame(3, Uint8Array.of(1)), preview).ok).toBe(true);
  expect(validatePipeFrame(frame(3, Uint8Array.of(1)), { ...preview, subscription }).ok).toBe(
    false,
  );
});

test("non-null control grant increments epoch exactly once", () => {
  const command = {
    type: "set-control",
    worker,
    run,
    requestId: "q1",
    expectedEpoch: 4,
    nextEpoch: 5,
    geometry,
    holder: { connection: subscription.connection, viewId: "v1", subscriptionId: "sub1" },
  };
  expect(validatePipeFrame(frame(1), command).ok).toBe(true);
  expect(validatePipeFrame(frame(1), { ...command, nextEpoch: 4 }).ok).toBe(false);
  expect(validatePipeFrame(frame(1), { ...command, nextEpoch: 6 }).ok).toBe(false);
  expect(validatePipeFrame(frame(1), { ...command, holder: null, nextEpoch: 4 }).ok).toBe(true);
});

test("successful status and input results require bound execution evidence", () => {
  const statusCommand = { type: "status", worker, run, requestId: "q1" };
  const status = {
    run,
    status: "live",
    geometry,
    controlEpoch: 1,
    controlHolder: null,
    receivedSeq: 2,
    parsedSeq: 2,
    recovery: "ready",
    exitCode: null,
    signal: null,
  };
  const result = {
    type: "result",
    worker,
    run,
    requestId: "q1",
    commandType: "status",
    outcome: "accepted",
    runStatus: status,
  };
  expect(validatePipeFrame(frame(2), result).ok).toBe(true);
  expect(validatePipeResultForCommand(statusCommand, result)).toBe(true);
  expect(validatePipeFrame(frame(2), { ...result, runStatus: undefined }).ok).toBe(false);
  expect(
    validatePipeFrame(frame(2), {
      ...result,
      runStatus: { ...status, run: { ...run, runId: "r2" } },
    }).ok,
  ).toBe(false);
  const input = {
    type: "input",
    worker,
    run,
    requestId: "q2",
    subscription,
    epoch: 1,
    inputSeq: 1,
  };
  const written = {
    type: "result",
    worker,
    run,
    requestId: "q2",
    commandType: "input",
    outcome: "accepted",
    inputSeq: 1,
    writtenBytes: 2,
  };
  expect(validatePipeFrame(frame(2), written).ok).toBe(true);
  expect(validatePipeResultForCommand(input, written)).toBe(true);
  expect(validatePipeFrame(frame(2), { ...written, writtenBytes: undefined }).ok).toBe(false);
});
