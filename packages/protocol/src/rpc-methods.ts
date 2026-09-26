import { z } from "zod";
import { PROTOCOL_VERSION } from "./bootstrap.js";
import { sameRunRef } from "./identity.js";
import { validateAppearance } from "./profile.js";
import { EffectiveBudgetsSchema, M0_LIMITS } from "./budgets.js";
import { DomainErrorSchema } from "./errors.js";
import { OpaqueIdSchema, RunRefSchema, SequenceSchema } from "./identity.js";
import { AppearanceSchema, GeometrySchema, ProfileSchema } from "./profile.js";
import { RunStatusSchema, SpawnArgumentsSchema } from "./pipe.js";

export const OperationMethodSchema = z.enum(["terminal.create", "terminal.stop"]);
const OperationRecordFieldsSchema = z.object({
  operationId: OpaqueIdSchema,
  method: OperationMethodSchema,
  revision: SequenceSchema,
  state: z.enum(["accepted", "running", "succeeded", "failed", "requires_attention"]),
  run: RunRefSchema.optional(),
  result: z
    .object({
      run: RunRefSchema.optional(),
      exitCode: z.number().int().nullable().optional(),
      signal: z.string().max(64).nullable().optional(),
    })
    .optional(),
  error: DomainErrorSchema.optional(),
});
export const OperationRecordSchema = OperationRecordFieldsSchema.refine(
  (value) => !!value.run && (!value.result?.run || sameRunRef(value.run, value.result.run)),
);
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

export const RunRecordSchema = z.object({
  run: RunRefSchema,
  status: RunStatusSchema.shape.status,
  geometry: GeometrySchema,
  controlEpoch: SequenceSchema,
  controlHolder: RunStatusSchema.shape.controlHolder,
  preview: z.object({
    version: SequenceSchema.nullable(),
    generatedAtMs: SequenceSchema.nullable(),
    checkedAtMs: SequenceSchema.nullable(),
    stale: z.boolean(),
    byteLength: z.number().int().min(0).max(M0_LIMITS.previewBytesPerRun),
  }),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const ServerStatusParamsSchema = z.object({});
export const ServerStatusResultSchema = z.object({
  serverId: OpaqueIdSchema,
  relayInstanceId: OpaqueIdSchema,
  buildVersion: z.string().min(1).max(128),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  profile: ProfileSchema,
  effectiveBudgets: EffectiveBudgetsSchema,
  workerCount: z.number().int().min(0).max(M0_LIMITS.maxRuns),
  runCount: z.number().int().min(0).max(M0_LIMITS.maxRuns),
  admission: z.enum(["ready", "busy", "unavailable"]),
  health: z.enum(["live", "unverifiable"]),
});
export const TerminalListParamsSchema = z.object({
  limit: z.number().int().min(1).max(M0_LIMITS.listPage),
  afterRunId: OpaqueIdSchema.optional(),
});
export const TerminalListResultSchema = z.object({
  runs: z.array(RunRecordSchema).max(M0_LIMITS.listPage),
  nextAfterRunId: OpaqueIdSchema.optional(),
});
export const TerminalGetParamsSchema = z.object({ run: RunRefSchema });
export const TerminalGetResultSchema = z.object({ record: RunRecordSchema });
export const TerminalCreateParamsSchema = SpawnArgumentsSchema.extend({
  operationId: OpaqueIdSchema,
  expectedRelayInstanceId: OpaqueIdSchema,
  geometry: GeometrySchema,
  appearance: AppearanceSchema.optional(),
});
export const TerminalStopParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  expectedRelayInstanceId: OpaqueIdSchema,
  run: RunRefSchema,
});
export const OperationGetParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  expectedRelayInstanceId: OpaqueIdSchema,
});
export const OperationResultSchema = z.object({ operation: OperationRecordSchema });

export const RPC_METHODS = Object.freeze({
  "server.status": {
    params: ServerStatusParamsSchema,
    result: ServerStatusResultSchema,
    class: "read",
    capability: "operation-receipts-v1",
    permission: "local-principal",
    cli: "status",
  },
  "terminal.list": {
    params: TerminalListParamsSchema,
    result: TerminalListResultSchema,
    class: "read",
    capability: "terminal-preview-v1",
    permission: "local-principal",
    cli: "terminal list",
  },
  "terminal.get": {
    params: TerminalGetParamsSchema,
    result: TerminalGetResultSchema,
    class: "read",
    capability: "terminal-preview-v1",
    permission: "local-principal",
    cli: "terminal get",
  },
  "terminal.create": {
    params: TerminalCreateParamsSchema,
    result: OperationResultSchema,
    class: "write",
    capability: "operation-receipts-v1",
    permission: "local-principal",
    cli: "terminal create",
  },
  "terminal.stop": {
    params: TerminalStopParamsSchema,
    result: OperationResultSchema,
    class: "write",
    capability: "operation-receipts-v1",
    permission: "local-principal",
    cli: "terminal stop",
  },
  "operation.get": {
    params: OperationGetParamsSchema,
    result: OperationResultSchema,
    class: "read",
    capability: "operation-receipts-v1",
    permission: "local-principal",
    cli: "operation get/wait",
  },
} as const);
export type RpcMethod = keyof typeof RPC_METHODS;

export function validateRpcMethodParams(
  method: string,
  input: unknown,
): { method: RpcMethod; params: Record<string, unknown> } | null {
  if (!Object.hasOwn(RPC_METHODS, method)) return null;
  const known = method as RpcMethod;
  const parsed = RPC_METHODS[known].params.safeParse(input);
  if (!parsed.success) return null;
  if (known === "terminal.stop") {
    const stop = TerminalStopParamsSchema.safeParse(parsed.data);
    if (!stop.success || stop.data.run.relayInstanceId !== stop.data.expectedRelayInstanceId)
      return null;
  }
  if (known === "terminal.create") {
    const create = TerminalCreateParamsSchema.safeParse(parsed.data);
    if (!create.success || (create.data.appearance && !validateAppearance(create.data.appearance)))
      return null;
  }
  return { method: known, params: parsed.data };
}
