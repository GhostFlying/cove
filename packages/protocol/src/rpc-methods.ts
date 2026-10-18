import { z } from "zod";
import { PROTOCOL_VERSION } from "./bootstrap.js";
import { sameRunRef } from "./identity.js";
import { validateAppearance } from "./profile.js";
import { EffectiveBudgetsSchema, M0_LIMITS } from "./budgets.js";
import { DomainErrorSchema } from "./errors.js";
import { OpaqueIdSchema, RunRefSchema, SequenceSchema } from "./identity.js";
import { AppearanceSchema, GeometrySchema, ProfileSchema } from "./profile.js";
import { RunStatusSchema, SpawnCommandSchema } from "./pipe.js";
import { WorkerHealthSchema } from "./terminal-events.js";
import * as W from "./workspace.js";
import {
  TERMINAL_RESULT_KEYS,
  OperationGetParamsSchema,
  OperationProgressSchema,
  OperationResultDataSchema,
  OperationStateSchema,
} from "./workspace.js";

// Every method with class "write" in RPC_METHODS, in table order; checked against the table below.
export const WRITE_RPC_METHODS = [
  "terminal.create",
  "terminal.stop",
  "operation.continue",
  "operation.abandon",
  "config.set",
  "repo.register",
  "repo.update",
  "repo.remove",
  "task.create",
  "task.update",
  "task.archive",
  "task.unarchive",
  "mount.add",
  "mount.remove",
  "mount.retry",
  "tab.create",
  "tab.reopen",
  "tab.stop",
  "tab.close",
  "binding.convert",
  "binding.delete",
] as const;
export type WriteRpcMethod = (typeof WRITE_RPC_METHODS)[number];
export const OperationMethodSchema = z.enum(WRITE_RPC_METHODS);
const TERMINAL_OPERATION_METHODS: ReadonlySet<string> = new Set([
  "terminal.create",
  "terminal.stop",
]);

const OperationRecordFieldsSchema = z.object({
  operationId: OpaqueIdSchema,
  method: OperationMethodSchema,
  revision: SequenceSchema,
  state: OperationStateSchema,
  // The run the operation acts on. A terminal operation always has one; it may belong to an
  // earlier relay instance when the record is historical.
  run: RunRefSchema.optional(),
  result: OperationResultDataSchema.optional(),
  progress: OperationProgressSchema.optional(),
  error: DomainErrorSchema.optional(),
});
// See the compact result policy in workspace.ts. Error details (blocking runs) belong to the RPC
// error response, not to a stored record, with one exception: a binding.delete that was accepted
// and then found a run using the worktree keeps up to M1_LIMITS.storedErrorRuns (workspace.ts) of them, since
// its final record is the only place a client can learn which runs stopped it (m1 T5). Its result
// is small (no mounts, no run), so the budget holds.
function storedDetailsAllowed(value: z.infer<typeof OperationRecordFieldsSchema>): boolean {
  const details = value.error?.details;
  return (
    details === undefined ||
    (value.method === "binding.delete" && details.runs.length <= W.M1_LIMITS.storedErrorRuns)
  );
}
export const OperationRecordSchema = OperationRecordFieldsSchema.refine((value) => {
  const terminal = TERMINAL_OPERATION_METHODS.has(value.method);
  const keys = Object.keys(value.result ?? {});
  const terminalKeys: readonly string[] = TERMINAL_RESULT_KEYS;
  return (
    (!terminal || !!value.run) &&
    keys.every((key) => terminalKeys.includes(key) === terminal) &&
    storedDetailsAllowed(value) &&
    (!value.run || !value.result?.run || sameRunRef(value.run, value.result.run))
  );
});
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
const signalMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// One terminal worker's informational health (issue #103) and the signals it was judged from.
// The worker's own measurements are those of its latest heartbeat (null before the first);
// heartbeatGapMs is the silence since that heartbeat as the server observed it, and
// oldestCommandAgeMs the age of the oldest command sent to the worker and not yet answered.
export const WorkerStatusSchema = z.object({
  workerId: OpaqueIdSchema,
  health: WorkerHealthSchema,
  // When the current state began, in milliseconds before this status was produced.
  stateAgeMs: signalMs,
  signals: z.object({
    eventLoopDelayP99Ms: signalMs.nullable(),
    eventLoopDelayMaxMs: signalMs.nullable(),
    cpuPercent: z.number().int().min(0).max(100).nullable(),
    parseBacklogBytes: signalMs.nullable(),
    executingCommands: z.number().int().min(0).max(65_536).nullable(),
    heartbeatGapMs: signalMs,
    oldestCommandAgeMs: signalMs.nullable(),
  }),
});
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;
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
  // Live workers only; a lost worker's terminals are unverifiable, which `health` reports.
  // Optional on the wire because a server from before issue #103 does not send it; this server
  // always does.
  workers: z.array(WorkerStatusSchema).max(M0_LIMITS.maxRuns).optional(),
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
// A run that belongs to no tab: the client names a command only. It carries no environment (the
// spawn `env` is the server's, for a tab run; D8), and an `env` member a client sends is dropped.
export const TerminalCreateParamsSchema = SpawnCommandSchema.extend({
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
export const OperationResultSchema = z.object({ operation: OperationRecordSchema });

// Server handler module that owns a method: apps/server/src/rpc/<domain>.ts.
export const RPC_DOMAINS = [
  "server",
  "terminal",
  "operation",
  "config",
  "repo",
  "task",
  "mount",
  "tab",
  "binding",
] as const;
export type RpcDomain = (typeof RPC_DOMAINS)[number];

type MethodSpec = {
  readonly params: z.ZodType<Record<string, unknown>>;
  readonly result: z.ZodType;
  readonly class: "read" | "write";
  // "instance": params and results reference only the current relay instance (live terminal
  // reads). "server": they may reference any instance of the same server, so that a resent write
  // or a historical record is still accepted (m1 "操作身份跨重启").
  readonly scope: "instance" | "server";
  readonly domain: RpcDomain;
  readonly capability: string;
  readonly permission: "local-principal";
  readonly cli: string;
};

// M1 methods are served under the negotiated operation-receipts capability; a separate
// capability would change the bootstrap contract, which M1 does not need before the first release.
const local = { permission: "local-principal", capability: "operation-receipts-v1" } as const;
const read = <D extends RpcDomain, P extends MethodSpec["params"], R extends z.ZodType>(
  domain: D,
  params: P,
  result: R,
  cli: string,
) => ({ params, result, class: "read", scope: "server", domain, cli, ...local }) as const;
const write = <D extends RpcDomain, P extends MethodSpec["params"]>(
  domain: D,
  params: P,
  cli: string,
) =>
  ({
    params,
    result: OperationResultSchema,
    class: "write",
    scope: "server",
    domain,
    cli,
    ...local,
  }) as const;

export const RPC_METHODS = Object.freeze({
  "server.status": {
    params: ServerStatusParamsSchema,
    result: ServerStatusResultSchema,
    class: "read",
    scope: "instance",
    domain: "server",
    capability: "operation-receipts-v1",
    permission: "local-principal",
    cli: "status",
  },
  "terminal.list": {
    params: TerminalListParamsSchema,
    result: TerminalListResultSchema,
    class: "read",
    scope: "instance",
    domain: "terminal",
    capability: "terminal-preview-v1",
    permission: "local-principal",
    cli: "terminal list",
  },
  "terminal.get": {
    params: TerminalGetParamsSchema,
    result: TerminalGetResultSchema,
    class: "read",
    scope: "instance",
    domain: "terminal",
    capability: "terminal-preview-v1",
    permission: "local-principal",
    cli: "terminal get",
  },
  "terminal.create": write("terminal", TerminalCreateParamsSchema, "terminal create"),
  "terminal.stop": write("terminal", TerminalStopParamsSchema, "terminal stop"),
  "operation.get": read(
    "operation",
    OperationGetParamsSchema,
    OperationResultSchema,
    "operation get/wait",
  ),
  // In M1 only managed worktree creation can be continued or abandoned, so these are served by
  // the mount module (T3b) rather than a generic recovery registry.
  "operation.continue": write("mount", W.OperationTargetParamsSchema, "operation continue"),
  "operation.abandon": write("mount", W.OperationTargetParamsSchema, "operation abandon"),
  "config.get": read("config", W.ConfigGetParamsSchema, W.ConfigGetResultSchema, "config get"),
  "config.set": write("config", W.ConfigSetParamsSchema, "config set"),
  "repo.register": write("repo", W.RepoRegisterParamsSchema, "repo register"),
  "repo.list": read("repo", W.RepoListParamsSchema, W.RepoListResultSchema, "repo list"),
  "repo.get": read("repo", W.RepoGetParamsSchema, W.RepoGetResultSchema, "repo get"),
  "repo.update": write("repo", W.RepoUpdateParamsSchema, "repo set"),
  "repo.remove": write("repo", W.RepoRemoveParamsSchema, "repo remove"),
  "task.create": write("task", W.TaskCreateParamsSchema, "task create"),
  "task.list": read("task", W.TaskListParamsSchema, W.TaskListResultSchema, "task list"),
  "task.get": read("task", W.TaskGetParamsSchema, W.TaskGetResultSchema, "task get"),
  "task.update": write("task", W.TaskUpdateParamsSchema, "task rename"),
  "task.archive": write("task", W.TaskArchiveParamsSchema, "task archive"),
  "task.unarchive": write("task", W.TaskArchiveParamsSchema, "task unarchive"),
  // Adding and removing mounts belong to the workspace module (T3a); retrying a failed worktree
  // mount belongs to the worktree module (T3b).
  "mount.add": write("task", W.MountAddParamsSchema, "mount add"),
  "mount.remove": write("task", W.MountRemoveParamsSchema, "mount remove"),
  "mount.retry": write("mount", W.MountRetryParamsSchema, "mount retry"),
  "tab.create": write("tab", W.TabCreateParamsSchema, "tab create"),
  "tab.list": read("tab", W.TabListParamsSchema, W.TabListResultSchema, "tab list"),
  "tab.get": read("tab", W.TabGetParamsSchema, W.TabGetResultSchema, "tab get"),
  "tab.runs": read("tab", W.TabRunsParamsSchema, W.TabRunsResultSchema, "tab runs"),
  "tab.reopen": write("tab", W.TabReopenParamsSchema, "tab reopen"),
  "tab.stop": write("tab", W.TabStopParamsSchema, "tab stop"),
  "tab.close": write("tab", W.TabCloseParamsSchema, "tab close"),
  "binding.convert": write("binding", W.BindingConvertParamsSchema, "mount convert"),
  "binding.delete": write("binding", W.BindingDeleteParamsSchema, "mount delete-worktree"),
  "binding.list": read(
    "binding",
    W.BindingListParamsSchema,
    W.BindingListResultSchema,
    "mount history",
  ),
} as const satisfies Record<string, MethodSpec>);
export type RpcMethod = keyof typeof RPC_METHODS;

const tableWrites = Object.entries(RPC_METHODS)
  .filter(([, spec]) => spec.class === "write")
  .map(([method]) => method);
if (
  tableWrites.length !== WRITE_RPC_METHODS.length ||
  tableWrites.some((method, index) => method !== WRITE_RPC_METHODS[index])
)
  throw new Error("WRITE_RPC_METHODS must list the write methods of RPC_METHODS in order");

export function isWriteRpcMethod(method: string): method is WriteRpcMethod {
  return Object.hasOwn(RPC_METHODS, method) && RPC_METHODS[method as RpcMethod].class === "write";
}

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
  // Every launch that carries an appearance (terminal.create, tab.create, tab.reopen) gets the
  // same semantic check, such as unique palette indices, before it can be accepted.
  const appearance = (parsed.data as { appearance?: unknown }).appearance;
  if (appearance !== undefined && !validateAppearance(appearance)) return null;
  return { method: known, params: parsed.data };
}
