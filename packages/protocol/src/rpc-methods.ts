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
import * as A from "./auth.js";
import { M2_RESULT_FIELDS, M2_RESULT_KEYS, ServiceStatusSchema } from "./auth.js";
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
  "tab.send",
  "binding.convert",
  "binding.delete",
  "auth.invite.create",
  "auth.invite.cancel",
  "auth.device.rename",
  "auth.device.revoke",
  "auth.device.rotate",
  "entry.set",
  "server.tsnet.login",
  "server.tsnet.logout",
] as const;
export type WriteRpcMethod = (typeof WRITE_RPC_METHODS)[number];
export const OperationMethodSchema = z.enum(WRITE_RPC_METHODS);
const TERMINAL_OPERATION_METHODS: ReadonlySet<string> = new Set([
  "terminal.create",
  "terminal.stop",
]);

// The M1 result fields plus the M2 references (auth.ts). An M2 field never shares a record with
// mounts, source counts or a continue/abandon target, which keeps the largest record within
// operationRecordBytes (workspace-contract.test.mjs and auth-contract.test.mjs build it).
// Unknown members are stripped on parse, so a field that is not declared, a secret included, can
// never be stored in a record.
const OperationRecordResultSchema = OperationResultDataSchema.safeExtend(M2_RESULT_FIELDS).refine(
  (result) =>
    M2_RESULT_KEYS.every((key) => result[key] === undefined) ||
    (result.mounts === undefined &&
      result.sourceChanges === undefined &&
      result.targetOperationId === undefined),
);
const OperationRecordFieldsSchema = z.object({
  operationId: OpaqueIdSchema,
  method: OperationMethodSchema,
  revision: SequenceSchema,
  state: OperationStateSchema,
  // The run the operation acts on. A terminal operation always has one; it may belong to an
  // earlier relay instance when the record is historical.
  run: RunRefSchema.optional(),
  result: OperationRecordResultSchema.optional(),
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
// The result fields each M2 write may store (m2 "秘密与操作记录的分界"): a fixed, secret-free
// projection of references, so a handler cannot park a secret in some schema-valid string field
// of a record (a target operation ID, a run reference) that operation.get and a resend would then
// return for as long as the record is kept. An M2 record never references a run, and the M2
// fields appear in M2 records only. A later task that needs another field extends this table
// through the protocol's single writer.
const M2_RECORD_RESULT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "auth.invite.create": ["inviteId", "expiresAtMs", "secretDelivery"],
  "auth.invite.cancel": ["inviteId"],
  "auth.device.rename": ["deviceId"],
  "auth.device.revoke": ["deviceId", "unclosedConnections"],
  "auth.device.rotate": ["deviceId", "expiresAtMs", "secretDelivery"],
  "entry.set": ["resource", "appliesAfterRestart"],
  "server.tsnet.login": ["secretDelivery"],
  "server.tsnet.logout": ["remoteLogoutConfirmed"],
});
function m2ProjectionHolds(value: z.infer<typeof OperationRecordFieldsSchema>): boolean {
  const keys = Object.keys(value.result ?? {});
  const allowed = Object.hasOwn(M2_RECORD_RESULT_KEYS, value.method)
    ? M2_RECORD_RESULT_KEYS[value.method]
    : undefined;
  if (!allowed) return keys.every((key) => !(M2_RESULT_KEYS as readonly string[]).includes(key));
  return value.run === undefined && keys.every((key) => allowed.includes(key));
}
export const OperationRecordSchema = OperationRecordFieldsSchema.refine((value) => {
  const terminal = TERMINAL_OPERATION_METHODS.has(value.method);
  const keys = Object.keys(value.result ?? {});
  const terminalKeys: readonly string[] = TERMINAL_RESULT_KEYS;
  return (
    (!terminal || !!value.run) &&
    keys.every((key) => terminalKeys.includes(key) === terminal) &&
    storedDetailsAllowed(value) &&
    m2ProjectionHolds(value) &&
    (value.method === "tab.send"
      ? !!value.run &&
        !!value.result?.input &&
        keys.every((key) => key === "resource" || key === "input") &&
        (value.state !== "succeeded" ||
          (value.result.input.text.status === "written" &&
            (value.result.input.submit === null || value.result.input.submit.status === "written")))
      : value.result?.input === undefined) &&
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
  // How the server runs as a service (m2 D1, D2; T3 reports it). Optional: a server before T3
  // does not send it.
  service: ServiceStatusSchema.optional(),
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
  // M2 (T0 placeholders): auth (T1), entry (T3), service: server.impact (T3), tsnet:
  // server.tsnet.* (T5b).
  "auth",
  "entry",
  "service",
  "tsnet",
] as const;
export type RpcDomain = (typeof RPC_DOMAINS)[number];

// Who may call a method (m2 D7). Every authenticated principal is the owner: the local owner
// (the same OS user, holding the data directory's local secret) and every paired device have the
// same rights, since a device can run anything on the host through a terminal anyway.
// "local-owner" methods are refused to devices (FORBIDDEN) for operational, not security,
// reasons: logging the server's tsnet node in or out over RPC could cut the very entry a remote
// caller depends on, and a tsnet auth key has no business crossing the network to the server.
// Installing, starting, stopping and upgrading the service are local CLI actions, not RPCs.
export type RpcPermission = "owner" | "local-owner";

// The secret members of a method (m2 "秘密与操作记录的分界"): keys of `params.secrets` (input)
// and of `result.secrets` (output). Checked against the schemas below when this module loads.
export type SecretFields = {
  readonly input: readonly string[];
  readonly output: readonly string[];
};
const NO_SECRETS: SecretFields = Object.freeze({ input: [], output: [] });

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
  readonly permission: RpcPermission;
  readonly secrets: SecretFields;
  readonly cli: string;
};

// M1 and M2 methods are served under the negotiated operation-receipts capability; a separate
// capability would change the bootstrap contract, which is not needed before the first release
// (m2 D12).
const owner = {
  permission: "owner",
  capability: "operation-receipts-v1",
  secrets: NO_SECRETS,
} as const;
const read = <D extends RpcDomain, P extends MethodSpec["params"], R extends z.ZodType>(
  domain: D,
  params: P,
  result: R,
  cli: string,
) => ({ ...owner, params, result, class: "read", scope: "server", domain, cli }) as const;
const write = <D extends RpcDomain, P extends MethodSpec["params"]>(
  domain: D,
  params: P,
  cli: string,
) =>
  ({
    ...owner,
    params,
    result: OperationResultSchema,
    class: "write",
    scope: "server",
    domain,
    cli,
  }) as const;
// A write whose live response may carry output secrets beside the record. Only the response of
// the call that committed the operation has them; a resend or operation.get returns the record
// alone (database-operations.ts, executeSecretWrite).
const secretWrite = <D extends RpcDomain, P extends MethodSpec["params"], S extends z.ZodType>(
  domain: D,
  params: P,
  secrets: SecretFields,
  outputs: S,
  cli: string,
) =>
  ({
    ...write(domain, params, cli),
    result: OperationResultSchema.extend({ secrets: outputs.optional() }),
    secrets,
  }) as const;

export const RPC_METHODS = Object.freeze({
  "server.status": {
    params: ServerStatusParamsSchema,
    result: ServerStatusResultSchema,
    class: "read",
    scope: "instance",
    domain: "server",
    capability: "operation-receipts-v1",
    permission: "owner",
    secrets: NO_SECRETS,
    cli: "status",
  },
  "terminal.list": {
    params: TerminalListParamsSchema,
    result: TerminalListResultSchema,
    class: "read",
    scope: "instance",
    domain: "terminal",
    capability: "terminal-preview-v1",
    permission: "owner",
    secrets: NO_SECRETS,
    cli: "terminal list",
  },
  "terminal.get": {
    params: TerminalGetParamsSchema,
    result: TerminalGetResultSchema,
    class: "read",
    scope: "instance",
    domain: "terminal",
    capability: "terminal-preview-v1",
    permission: "owner",
    secrets: NO_SECRETS,
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
  "tab.send": write("tab", W.TabSendParamsSchema, "tab send"),
  "binding.convert": write("binding", W.BindingConvertParamsSchema, "mount convert"),
  "binding.delete": write("binding", W.BindingDeleteParamsSchema, "mount delete-worktree"),
  "binding.list": read(
    "binding",
    W.BindingListParamsSchema,
    W.BindingListResultSchema,
    "mount history",
  ),
  // M2 (docs/milestones/m2.md T0). Pairing redemption is not an RPC: it goes to the pairing
  // listener and leaves no operation record (D6).
  "auth.invite.create": secretWrite(
    "auth",
    A.AuthInviteCreateParamsSchema,
    { input: [], output: ["invitation"] },
    A.AuthInviteCreateSecretsSchema,
    "auth invite create",
  ),
  "auth.invite.list": read(
    "auth",
    A.AuthInviteListParamsSchema,
    A.AuthInviteListResultSchema,
    "auth invite list",
  ),
  "auth.invite.cancel": write("auth", A.AuthInviteCancelParamsSchema, "auth invite cancel"),
  "auth.device.list": read(
    "auth",
    A.AuthDeviceListParamsSchema,
    A.AuthDeviceListResultSchema,
    "auth device list",
  ),
  "auth.device.rename": write("auth", A.AuthDeviceRenameParamsSchema, "auth device rename"),
  "auth.device.revoke": write("auth", A.AuthDeviceRevokeParamsSchema, "auth device revoke"),
  "auth.device.rotate": secretWrite(
    "auth",
    A.AuthDeviceRotateParamsSchema,
    { input: [], output: ["token"] },
    A.AuthDeviceRotateSecretsSchema,
    "auth device rotate",
  ),
  "entry.get": read("entry", A.EntryGetParamsSchema, A.EntryGetResultSchema, "server entry get"),
  "entry.set": write("entry", A.EntrySetParamsSchema, "server entry set"),
  "server.impact": read(
    "service",
    A.ServerImpactParamsSchema,
    A.ServerImpactResultSchema,
    "server restart",
  ),
  "server.tsnet.login": {
    ...secretWrite(
      "tsnet",
      A.TsnetLoginParamsSchema,
      { input: ["authKey"], output: ["loginUrl"] },
      A.TsnetLoginSecretsSchema,
      "server tsnet login",
    ),
    permission: "local-owner",
  },
  "server.tsnet.status": read(
    "tsnet",
    A.TsnetStatusParamsSchema,
    A.TsnetStatusResultSchema,
    "server tsnet status",
  ),
  "server.tsnet.logout": {
    ...write("tsnet", A.TsnetLogoutParamsSchema, "server tsnet logout"),
    permission: "local-owner",
  },
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

// The one member that holds a method's secrets, in params and in results (auth.ts).
export const SECRETS_MEMBER = "secrets";

// Keys of a schema's optional `secrets` object, or null when it has none.
function secretKeys(schema: z.ZodType): { keys: string[]; optional: boolean } | null {
  const member = (schema as { shape?: Record<string, z.ZodType> }).shape?.[SECRETS_MEMBER];
  if (!member) return null;
  const optional = member instanceof z.ZodOptional;
  const inner = optional ? (member as z.ZodOptional<z.ZodType>).unwrap() : member;
  const shape = (inner as { shape?: Record<string, unknown> }).shape;
  return { keys: shape ? Object.keys(shape).sort() : [], optional };
}
// The table's declarations are the schemas' `secrets` members exactly: a secret cannot be added
// to a schema without being declared, nor declared without the schema carrying it. Input secrets
// are optional, so params with their secrets dropped (a CLI pending record) still validate.
for (const [method, spec] of Object.entries(RPC_METHODS)) {
  const declared: SecretFields = spec.secrets;
  for (const [side, schema] of [
    ["input", spec.params],
    ["output", spec.result],
  ] as const) {
    const found = secretKeys(schema);
    const expected = [...declared[side]].sort();
    if (
      found === null
        ? expected.length !== 0
        : !found.optional || expected.length === 0 || found.keys.join() !== expected.join()
    )
      throw new Error(`Secret fields of ${method} (${side}) do not match its schema`);
  }
}

export function secretFields(method: RpcMethod): SecretFields {
  return RPC_METHODS[method].secrets;
}

// A copy of params or a result without its `secrets` member, and that member. Every path that
// keeps, fingerprints or forwards a request or record past its live use goes through this.
export function splitSecrets<T extends Record<string, unknown>>(
  value: T,
): { value: Omit<T, typeof SECRETS_MEMBER>; secrets: Record<string, unknown> | undefined } {
  const { [SECRETS_MEMBER]: secrets, ...rest } = value;
  return {
    value: rest as Omit<T, typeof SECRETS_MEMBER>,
    secrets:
      secrets && typeof secrets === "object" && !Array.isArray(secrets)
        ? (secrets as Record<string, unknown>)
        : undefined,
  };
}

// Every M2 write has its record projection, and only M2 writes do.
const M2_DOMAINS: readonly RpcDomain[] = ["auth", "entry", "service", "tsnet"];
for (const [method, spec] of Object.entries(RPC_METHODS))
  if (
    (spec.class === "write" && M2_DOMAINS.includes(spec.domain)) !==
    Object.hasOwn(M2_RECORD_RESULT_KEYS, method)
  )
    throw new Error(`The record projection of ${method} is missing or misplaced`);

// Every secret schema requires at least this many characters, so a secret never matches
// ordinary short text (an ID, a state name) by chance in the checks below.
export const MIN_SECRET_LENGTH = 16;

// The strings of a value that may be secrets, at any depth.
export function secretStrings(value: unknown): string[] {
  const found: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === "string") {
      if (next.length >= MIN_SECRET_LENGTH) found.push(next);
    } else if (next && typeof next === "object") pending.push(...Object.values(next));
  }
  return found;
}

// Whether any decoded string of `value` (a member name or a string value, at any depth) contains
// one of `secrets`. It inspects the values themselves, not their JSON text: a secret holding `"`
// or `\` is escaped in JSON and would escape a search of the serialized form.
export function holdsSecret(value: unknown, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  const pending: unknown[] = [value];
  const hit = (text: string) => secrets.some((secret) => text.includes(secret));
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === "string") {
      if (hit(next)) return true;
    } else if (next && typeof next === "object") {
      for (const [key, member] of Object.entries(next)) {
        if (hit(key)) return true;
        pending.push(member);
      }
    }
  }
  return false;
}

// Whether a value has a `secrets` member below its top level. Secrets belong only to the
// top-level member of a request or result; one nested anywhere else is misplaced.
export function nestedSecretsMember(value: unknown): boolean {
  const pending: unknown[] = Object.values(value && typeof value === "object" ? value : {});
  while (pending.length > 0) {
    const next = pending.pop();
    if (next && typeof next === "object") {
      if (!Array.isArray(next) && Object.hasOwn(next, SECRETS_MEMBER)) return true;
      pending.push(...Object.values(next));
    }
  }
  return false;
}

// The output secrets of `method` when `secrets` is exactly a valid instance of its declared
// output secrets: only declared keys, each value valid. null otherwise, including a member the
// schema would silently strip, so a defect is refused rather than half-delivered.
export function checkedOutputSecrets(
  method: RpcMethod,
  secrets: unknown,
): Record<string, string> | null {
  const member = (RPC_METHODS[method].result as { shape?: Record<string, z.ZodType> }).shape?.[
    SECRETS_MEMBER
  ];
  if (!member || !secrets || typeof secrets !== "object" || Array.isArray(secrets)) return null;
  const parsed = member.safeParse(secrets);
  if (!parsed.success || !parsed.data) return null;
  const data = parsed.data as Record<string, string>;
  const keys = Object.keys(secrets);
  return keys.length === Object.keys(data).length && keys.every((key) => Object.hasOwn(data, key))
    ? data
    : null;
}

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
