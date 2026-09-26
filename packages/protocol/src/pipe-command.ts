import { z } from "zod";
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

export const PIPE_VERSION = 2;
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

export const SpawnArgumentsSchema = z.object({
  executable: z.string().min(1).max(M0_LIMITS.executableBytes),
  argv: z.array(z.string()).max(M0_LIMITS.argvCount),
  cwd: z.string().min(1).max(M0_LIMITS.cwdBytes),
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
    spawnPayloadBytes: z.number().int().min(1).max(M0_LIMITS.argvBytes),
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
  const bytes = encodeUtf8(JSON.stringify(args));
  if (bytes.byteLength < 1 || bytes.byteLength > M0_LIMITS.argvBytes) return null;
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
