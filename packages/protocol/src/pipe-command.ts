import { z } from "zod";
import { TAB_SEND_TEXT_BYTES, TabInputReceiptSchema } from "./workspace.js";
import { M0_LIMITS, EffectiveBudgetsSchema } from "./budgets.js";
import { DomainErrorSchema } from "./errors.js";
import {
  OpaqueIdSchema,
  RunRefSchema,
  SequenceSchema,
  SubscriptionRefSchema,
  WorkerRefSchema,
} from "./identity.js";
import { AppearanceSchema, GeometrySchema, ProfileSchema } from "./profile.js";
import { ControlHolderSchema, TerminalEventSchema } from "./terminal-events.js";
import { HEADER_BYTES, MAX_METADATA_BYTES } from "./provisional/frame.js";

export const PIPE_VERSION = 2;
// Route-control commands (applied-ack, baseline-progress, unsubscribe) a runtime may have
// outstanding on one worker pipe at once, across all connections. The worker executes them one
// at a time in arrival order and queues the rest up to this bound; the runtime never sends more,
// so a worker that receives more treats it as a protocol violation and fails closed. Both sides
// read this one constant so the sender's window can never exceed the receiver's queue.
export const PIPE_ROUTE_CONTROL_COMMANDS = 4;
// The largest route-control frame: these commands carry no payload.
export const PIPE_ROUTE_CONTROL_FRAME_BYTES = HEADER_BYTES + MAX_METADATA_BYTES;
// Route-control frames of live subscriptions are prepaid by the runtime and kept outside
// pipeQueuedBytes (issue #96): it may have this many bytes of them queued or in transport on
// top of pipeQueuedBytes. The worker's ingress bound includes them; both sides read this one
// constant.
export const PIPE_PREPAID_ROUTE_CONTROL_BYTES =
  PIPE_ROUTE_CONTROL_COMMANDS * PIPE_ROUTE_CONTROL_FRAME_BYTES;
// A ready worker sends a heartbeat frame at this interval from a timer, independent of command
// execution (issue #103). The runtime counts any frame as contact and declares the worker lost
// only after PIPE_LIVENESS_WINDOW_MS of observed silence, so a worker that is merely slow to
// answer commands (CPU-saturated by parsing, say) is never mistaken for a lost one.
export const PIPE_HEARTBEAT_INTERVAL_MS = 1000;
// The runtime's liveness window: silence it observed itself (see WorkerPipeSession.tick), not
// wall-clock time. It is deliberately independent of recoveryDeadlineMs, which is how long a
// client waits for one recovery and may be negotiated down to a millisecond; a worker is never
// declared lost for answering slowly, only for saying nothing for this long (user decision on
// #103: 120 s). A window must span several heartbeats, or one late timer turn would look like
// loss; PIPE_LIVENESS_MIN_HEARTBEATS states that relation, and the runtime refuses a smaller window.
export const PIPE_LIVENESS_WINDOW_MS = 120_000;
export const PIPE_LIVENESS_MIN_HEARTBEATS = 3;
// The largest heartbeat frame. A worker has at most one heartbeat queued or in transport, and
// that frame is prepaid outside reservedControlBytes and pipeQueuedBytes (issue #103 review B2):
// charged to the control reserve, one slow control command at the smallest legal reserve held
// the whole reserve and every heartbeat was skipped, so an idle live worker looked lost. The
// runtime's bound on unread worker output includes this one frame; both sides read this constant.
export const PIPE_HEARTBEAT_FRAME_BYTES = HEADER_BYTES + MAX_METADATA_BYTES;
const build = z.string().min(1).max(128);
const common = { worker: WorkerRefSchema };
const command = { ...common, run: RunRefSchema, requestId: OpaqueIdSchema };

export const PipeHelloSchema = z.object({
  type: z.literal("hello"),
  ...common,
  pipeVersion: z.literal(PIPE_VERSION),
  buildVersion: build,
  effectiveBudgets: EffectiveBudgetsSchema,
});
export const PipeReadySchema = z.object({
  type: z.literal("ready"),
  ...common,
  pipeVersion: z.literal(PIPE_VERSION),
  buildVersion: build,
  effectiveBudgets: EffectiveBudgetsSchema,
});
// The worker's own load over the interval since its previous heartbeat (issue #103 health).
// Explicit measurements, not engine state; the runtime combines them with what it observes
// itself (heartbeat gap, oldest command age) to judge overload. Milliseconds are capped at an
// hour and the CPU share at 100 by the worker. cpuPercent is the main thread's share of one
// core, null where the platform cannot measure it; it is supporting data, never a trigger.
const loadMs = z.number().int().min(0).max(3_600_000);
export const WorkerLoadSchema = z.object({
  windowMs: loadMs,
  eventLoopDelayP99Ms: loadMs,
  eventLoopDelayMaxMs: loadMs,
  cpuPercent: z.number().int().min(0).max(100).nullable(),
  // PTY output read but not yet parsed, over every run on the worker.
  parseBacklogBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  // Commands the worker has started and not yet answered.
  executingCommands: z.number().int().min(0).max(65_536),
});
export type WorkerLoad = z.infer<typeof WorkerLoadSchema>;
// Worker-to-runtime liveness and load; it needs no reply.
export const PipeHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  ...common,
  load: WorkerLoadSchema,
});

// What a client may ask a run to execute (terminal.create extends this): never an environment.
export const SpawnCommandSchema = z.object({
  executable: z.string().min(1).max(M0_LIMITS.executableBytes),
  argv: z.array(z.string()).max(M0_LIMITS.argvCount),
  cwd: z.string().min(1).max(M0_LIMITS.cwdBytes),
});

// Cove's run identity variables (M1 D8, #120): the only environment a spawn can carry. The server
// sets them for a tab's run; the worker sets exactly these over its inherited environment and
// removes any inherited copy it was not given (see worker-execution.ts). The schema is closed:
// an unknown key, an empty or over-long value or any character outside printable ASCII (no
// control characters, so no NUL, newline or escape) is a schema error, so arbitrary environment
// can never reach a PTY through this field. Values are identifiers, not secrets, but nothing logs
// them either.
export const SPAWN_ENV_KEYS = ["COVE_TASK_ID", "COVE_TAB_ID"] as const;
export type SpawnEnvKey = (typeof SPAWN_ENV_KEYS)[number];
export const SPAWN_ENV_VALUE_CHARS = 128;
const SpawnEnvValueSchema = z
  .string()
  .regex(new RegExp(`^[\\x20-\\x7e]{1,${SPAWN_ENV_VALUE_CHARS}}$`));
export const SpawnEnvSchema = z.strictObject(
  Object.fromEntries(SPAWN_ENV_KEYS.map((key) => [key, SpawnEnvValueSchema.optional()])) as {
    [K in SpawnEnvKey]: z.ZodOptional<typeof SpawnEnvValueSchema>;
  },
);
export type SpawnEnv = z.infer<typeof SpawnEnvSchema>;
// The most the `env` member can add to the JSON spawn payload: every key with a value of the
// largest length whose characters all need a JSON escape (`\"` or `\\`), plus punctuation. The
// payload bound below is the command bound plus this, so adding the identity never makes a
// recipe that fitted before #120 unframable.
export const SPAWN_ENV_PAYLOAD_BYTES = 1024;
const SPAWN_PAYLOAD_BYTES = M0_LIMITS.argvBytes + SPAWN_ENV_PAYLOAD_BYTES;

// The spawn payload. `env` is optional and absent for a run that belongs to no tab
// (terminal.create), and then the payload is the command-only JSON it always was. Before the first
// release, server and worker must come from the same build: mixed builds are unsupported and the
// pipe version is not bumped for this change (relay-protocol §10).
export const SpawnArgumentsSchema = SpawnCommandSchema.extend({
  env: SpawnEnvSchema.optional(),
});
export type SpawnArguments = z.infer<typeof SpawnArgumentsSchema>;

export const PipeCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("spawn"),
    ...command,
    operationId: OpaqueIdSchema,
    geometry: GeometrySchema,
    profile: ProfileSchema,
    appearance: AppearanceSchema,
    effectiveBudgets: EffectiveBudgetsSchema,
    spawnPayloadBytes: z.number().int().min(1).max(SPAWN_PAYLOAD_BYTES),
  }),
  z.object({ type: z.literal("stop"), ...command, operationId: OpaqueIdSchema }),
  z.object({
    type: z.literal("set-control"),
    ...command,
    expectedEpoch: SequenceSchema,
    nextEpoch: SequenceSchema.min(1),
    holder: ControlHolderSchema.nullable(),
    geometry: GeometrySchema,
    appearance: AppearanceSchema.optional(),
  }),
  z.object({
    type: z.literal("input"),
    ...command,
    subscription: SubscriptionRefSchema,
    epoch: SequenceSchema.min(1),
    inputSeq: SequenceSchema.min(1),
  }),
  z.object({
    type: z.literal("programmatic-input"),
    ...command,
    operationId: OpaqueIdSchema,
    epoch: SequenceSchema,
    textBytes: z.number().int().min(0).max(TAB_SEND_TEXT_BYTES),
    submit: z.boolean(),
  }),
  z.object({
    type: z.literal("resize"),
    ...command,
    subscription: SubscriptionRefSchema,
    epoch: SequenceSchema.min(1),
    geometry: GeometrySchema,
  }),
  z.object({
    type: z.literal("appearance"),
    ...command,
    subscription: SubscriptionRefSchema,
    epoch: SequenceSchema.min(1),
    appearance: AppearanceSchema,
  }),
  z.object({
    type: z.literal("subscribe"),
    ...command,
    subscription: SubscriptionRefSchema,
    atSeq: SequenceSchema,
  }),
  z.object({
    type: z.literal("recover"),
    ...command,
    subscription: SubscriptionRefSchema,
    appliedSeq: SequenceSchema.optional(),
  }),
  z.object({ type: z.literal("unsubscribe"), ...command, subscription: SubscriptionRefSchema }),
  z.object({
    type: z.literal("applied-ack"),
    ...command,
    subscription: SubscriptionRefSchema,
    appliedSeq: SequenceSchema,
  }),
  z.object({
    type: z.literal("baseline-progress"),
    ...command,
    subscription: SubscriptionRefSchema,
    baselineId: OpaqueIdSchema,
    lastParsedOrdinal: z
      .number()
      .int()
      .min(0)
      .max(M0_LIMITS.baselineChunks - 1),
  }),
  z.object({ type: z.literal("status"), ...command }),
  z.object({
    type: z.literal("preview-refresh"),
    ...command,
    knownVersion: SequenceSchema.optional(),
  }),
]);
export type PipeCommand = z.infer<typeof PipeCommandSchema>;
export type PipeCommandType = PipeCommand["type"];

export const RunStatusSchema = z.object({
  run: RunRefSchema,
  status: z.enum(["live", "unverifiable", "exited"]),
  geometry: GeometrySchema,
  controlEpoch: SequenceSchema,
  controlHolder: ControlHolderSchema.nullable(),
  receivedSeq: SequenceSchema.nullable(),
  parsedSeq: SequenceSchema.nullable(),
  recovery: z.enum(["ready", "waiting-checkpoint", "unavailable"]),
  reason: z.string().max(128).optional(),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(64).nullable(),
});
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const PipeResultSchema = z.object({
  type: z.literal("result"),
  ...command,
  commandType: z.enum([
    "spawn",
    "stop",
    "set-control",
    "input",
    "programmatic-input",
    "resize",
    "appearance",
    "subscribe",
    "recover",
    "unsubscribe",
    "applied-ack",
    "baseline-progress",
    "status",
    "preview-refresh",
  ]),
  outcome: z.enum(["accepted", "rejected", "unknown"]),
  recoveryMode: z.enum(["replay", "baseline"]).optional(),
  operationId: OpaqueIdSchema.optional(),
  atSeq: SequenceSchema.optional(),
  inputSeq: SequenceSchema.optional(),
  input: TabInputReceiptSchema.optional(),
  writtenBytes: z.number().int().min(1).max(65_536).optional(),
  runStatus: RunStatusSchema.optional(),
  previewVersion: SequenceSchema.optional(),
});
export type PipeResult = z.infer<typeof PipeResultSchema>;

export const PipeEventSchema = z.object({
  type: z.literal("terminal-event"),
  ...common,
  run: RunRefSchema,
  subscription: SubscriptionRefSchema.optional(),
  terminal: TerminalEventSchema,
});
export type PipeEvent = z.infer<typeof PipeEventSchema>;
export const PipeErrorSchema = z.object({
  type: z.literal("error"),
  ...command,
  commandType: PipeResultSchema.shape.commandType,
  error: DomainErrorSchema,
});
export type PipeError = z.infer<typeof PipeErrorSchema>;

export const PipeMetadataSchema = z.discriminatedUnion("type", [
  PipeHelloSchema,
  PipeReadySchema,
  PipeHeartbeatSchema,
  ...PipeCommandSchema.options,
  PipeResultSchema,
  PipeEventSchema,
  PipeErrorSchema,
]);
export type PipeMetadata = z.infer<typeof PipeMetadataSchema>;

// The host owns fatal UTF-8 encoding; this pure composition check prevents an unframable accepted spawn.
export function composeSpawnPayload(
  input: unknown,
  encodeUtf8: (text: string) => Uint8Array,
): { arguments: SpawnArguments; bytes: Uint8Array } | null {
  const parsed = SpawnArgumentsSchema.safeParse(input);
  if (!parsed.success) return null;
  const args = parsed.data;
  if (
    encodeUtf8(args.executable).byteLength > M0_LIMITS.executableBytes ||
    encodeUtf8(args.cwd).byteLength > M0_LIMITS.cwdBytes
  )
    return null;
  let argvBytes = 0;
  for (const arg of args.argv) argvBytes += encodeUtf8(arg).byteLength;
  if (argvBytes > M0_LIMITS.argvBytes) return null;
  // The command part keeps its pre-#120 bound; the identity has its own room on top.
  const { env: _env, ...command } = args;
  if (encodeUtf8(JSON.stringify(command)).byteLength > M0_LIMITS.argvBytes) return null;
  const bytes = encodeUtf8(JSON.stringify(args));
  if (bytes.byteLength < 1 || bytes.byteLength > SPAWN_PAYLOAD_BYTES) return null;
  return { arguments: args, bytes };
}

export function validateSpawnPayload(
  command: Extract<PipeCommand, { type: "spawn" }>,
  payload: Uint8Array,
  decoded: unknown,
  encodeUtf8: (text: string) => Uint8Array,
): SpawnArguments | null {
  const composed = composeSpawnPayload(decoded, encodeUtf8);
  if (
    !composed ||
    payload.byteLength !== command.spawnPayloadBytes ||
    payload.byteLength !== composed.bytes.byteLength
  )
    return null;
  for (let index = 0; index < payload.byteLength; index++)
    if (payload[index] !== composed.bytes[index]) return null;
  return composed.arguments;
}
