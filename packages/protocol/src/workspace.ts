import { z } from "zod";
import { ControlHolderSchema } from "./terminal-events.js";
import { M0_LIMITS } from "./budgets.js";
import { DOMAIN_ERROR_KINDS, DomainErrorSchema } from "./errors.js";
import { OpaqueIdSchema, RunRefSchema, SequenceSchema } from "./provisional/identity.js";
import { AppearanceSchema, GeometrySchema } from "./profile.js";

// M1 task/workspace domain contract (docs/milestones/m1.md). Every schema here is part of the
// pre-release wire contract: no protocol version bump until the first release (relay-protocol §10).
//
// Fingerprint rule for writes: a domain write carries only what the operator asked for. Values the
// server resolves (current revisions, the relay instance, the main branch, terminal size) are not
// filled in by clients, so `cove ... --operation-id X` rebuilt from the same arguments produces the
// same canonical intent before and after a restart. Optional `expected*Revision` fields are
// preconditions the operator chose explicitly; they stay part of the fingerprint.

export const M1_LIMITS = Object.freeze({
  mountsPerWorkspace: 16,
  listPage: M0_LIMITS.listPage,
  sharedTasks: 128,
  bindingHistory: 128,
  progressTokens: 8,
  titleChars: 256,
  displayNameChars: 128,
  refChars: 255,
  // The blocking runs a failed binding.delete keeps in its stored error (m1 T5); a refusal before
  // acceptance lists up to 128 in the RPC error response.
  storedErrorRuns: 4,
});

// A path interpreted by the execution host. The server validates, normalizes and resolves it;
// clients never treat it as a local path.
export const HostPathSchema = z
  .string()
  .min(1)
  .max(M0_LIMITS.cwdBytes)
  .refine((value) => !value.includes("\0"));
export const TitleSchema = z.string().min(1).max(M1_LIMITS.titleChars);
export const DisplayNameSchema = z.string().min(1).max(M1_LIMITS.displayNameChars);
// Mount names become a directory name under the workspace entry (D1), so they are a single path
// segment that cannot be `.`/`..` or start with `-`.
export const MountNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const TabNameSchema = z.string().min(1).max(M1_LIMITS.displayNameChars);
// Git refs and branch names are passed to git as arguments. A leading `-` could be read as an
// option, and whitespace or control bytes are never part of a ref Cove accepts.
export const GitRefSchema = z
  .string()
  .min(1)
  .max(M1_LIMITS.refChars)
  .regex(/^[^-\s~^:?*[\\][^\s~^:?*[\\]*$/)
  .refine((value) => ![...value].some((char) => char < " " || char === "\u007f"));
export const CommitIdSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
export const ListLimitSchema = z.number().int().min(1).max(M1_LIMITS.listPage);
export const TimestampMsSchema = SequenceSchema;
// Identifier of a server-assigned resource (repo, task, workspace, mount, tab). Shorter than the
// client-chosen OpaqueId so that operation records holding them fit their budget (see
// OperationResultDataSchema); a UUID fits.
export const ResourceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/);

const atLeastOne = (keys: readonly string[]) => (value: Record<string, unknown>) =>
  keys.some((key) => value[key] !== undefined);

// ---------------------------------------------------------------------------------------------
// Repo registration (T2)

export const RepoRecordSchema = z.object({
  repoId: ResourceIdSchema,
  revision: SequenceSchema,
  displayName: DisplayNameSchema,
  // Canonical real path of the clone's top level.
  path: HostPathSchema,
  // Cove's main-branch setting; null means resolve from the remote (D1).
  mainBranch: GitRefSchema.nullable(),
  registeredAtMs: TimestampMsSchema,
});
export type RepoRecord = z.infer<typeof RepoRecordSchema>;

export const RepoRegisterParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  path: HostPathSchema,
  displayName: DisplayNameSchema.optional(),
});
export const RepoListParamsSchema = z.object({
  limit: ListLimitSchema,
  afterRepoId: ResourceIdSchema.optional(),
});
export const RepoListResultSchema = z.object({
  repos: z.array(RepoRecordSchema).max(M1_LIMITS.listPage),
  nextAfterRepoId: ResourceIdSchema.optional(),
});
export const RepoGetParamsSchema = z.object({ repoId: ResourceIdSchema });
export const RepoGetResultSchema = z.object({ repo: RepoRecordSchema });
export const RepoUpdateParamsSchema = z
  .object({
    operationId: OpaqueIdSchema,
    repoId: ResourceIdSchema,
    expectedRevision: SequenceSchema.optional(),
    displayName: DisplayNameSchema.optional(),
    // null clears the setting.
    mainBranch: GitRefSchema.nullable().optional(),
  })
  .refine(atLeastOne(["displayName", "mainBranch"]));
// Removing a registration never touches the clone directory.
export const RepoRemoveParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  repoId: ResourceIdSchema,
  expectedRevision: SequenceSchema.optional(),
});

// ---------------------------------------------------------------------------------------------
// Task, workspace and mounts (T3a, T3b)

export const MountSourceSchema = z.enum(["checkout", "worktree"]);
export type MountSource = z.infer<typeof MountSourceSchema>;

const WorktreeOptionsFields = {
  // Default `cove/<slug>` (D1).
  branch: GitRefSchema.optional(),
  // Overrides the main-branch resolution (D1).
  base: GitRefSchema.optional(),
  // Skips the fetch before creation; only an explicit request may do this (D1).
  noFetch: z.boolean().optional(),
};

// What the operator asks for when adding a mount. A checkout may name an existing worktree of the
// registered clone through `path`; it never names a Cove-managed worktree
// (MANAGED_WORKTREE_NOT_MOUNTABLE, D2).
export const MountSpecSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("checkout"),
    repoId: ResourceIdSchema,
    name: MountNameSchema.optional(),
    path: HostPathSchema.optional(),
  }),
  z.object({
    source: z.literal("worktree"),
    repoId: ResourceIdSchema,
    name: MountNameSchema.optional(),
    ...WorktreeOptionsFields,
  }),
]);
export type MountSpec = z.infer<typeof MountSpecSchema>;

// The recorded state of a mount (and of a mount in an operation result).
export const MountStateSchema = z.enum(["pending", "ready", "failed", "missing"]);
// A mount as a read reports it: the recorded state, with a ready binding verified when the record
// is read. A ready checkout whose directory is gone, is no longer the registered clone's working
// tree (another repository, a symlink in its place, a Cove-managed worktree now, its Git metadata
// gone) is `missing`; one that could not be verified (Git did not answer within the read's time
// budget, permission denied, Git refused a directory whose metadata is still there, as for a
// safe.directory refusal) is `unavailable`, which claims neither that it is there nor that it is
// gone.
export const MountRecordStateSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "missing",
  "unavailable",
]);
export const MountRecordSchema = z.object({
  mountId: ResourceIdSchema,
  name: MountNameSchema,
  source: MountSourceSchema,
  repoId: ResourceIdSchema,
  // Real directory of the binding: the checkout itself or the managed worktree.
  path: HostPathSchema,
  // Path inside the workspace entry. A managed worktree lives at `<entry>/<name>`; a checkout has
  // no path in the entry and is null (D2 option C): it is reached through its real `path`, which
  // the entry's mount manifest lists.
  entryPath: HostPathSchema.nullable(),
  state: MountRecordStateSchema,
  branch: GitRefSchema.nullable(),
  baseCommit: CommitIdSchema.nullable(),
  // Other tasks mounting the same checkout (D4: shown, never locked).
  sharedWithTaskIds: z.array(ResourceIdSchema).max(M1_LIMITS.sharedTasks),
  error: DomainErrorSchema.optional(),
});
export type MountRecord = z.infer<typeof MountRecordSchema>;

export const WorkspaceRecordSchema = z.object({
  workspaceId: ResourceIdSchema,
  // Increases on every binding change, including conversion to a worktree.
  revision: SequenceSchema,
  entryPath: HostPathSchema,
  // The entry directory and its mount manifest, verified when the record is read, for the
  // revision this record carries. The database record comes first and the filesystem follows it,
  // so they can differ:
  // - ready: the entry is Cove's directory and its manifest is exactly the current one (this
  //   workspace and revision, the current mount list);
  // - pending: the record is ahead of the filesystem (being written, a failed attempt such as an
  //   unwritable workspace root, or an older manifest of this workspace), or a change committed
  //   while the record was being read; the next attempt writes it;
  // - missing: the entry was (or may have been) published once and is gone now. A read reports
  //   this and never recreates it; the next binding change writes the entry again;
  // - unavailable: something Cove does not own is at the entry path (a foreign directory, file
  //   or symlink, or a manifest of another workspace or one that does not parse), or the path to
  //   it changed (a symlink in place of an ancestor), or it cannot be read or was not checked
  //   within the read's time budget. Cove never writes over what it does not own; the operator
  //   resolves it.
  entryState: z.enum(["ready", "pending", "missing", "unavailable"]),
  mounts: z.array(MountRecordSchema).max(M1_LIMITS.mountsPerWorkspace),
});
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

export const TaskRecordSchema = z.object({
  taskId: ResourceIdSchema,
  revision: SequenceSchema,
  title: TitleSchema,
  // Fixed at creation; renaming the task never moves its directory (D1). One ref component and
  // file name in the title's own script (domain/workspaces.ts taskSlug): Unicode letters and
  // digits, `.`, `_` and `-`, neither starting nor ending with `.` or `-`, without `..` or a
  // trailing `.lock`, at most 64 code points (the derivation keeps 48). Slugs of earlier
  // releases (lower-case ASCII) match too.
  slug: z
    .string()
    .regex(/^(?!.*\.\.)(?!.*\.lock$)[\p{L}\p{N}_](?:[\p{L}\p{N}._-]{0,62}[\p{L}\p{N}_])?$/iu),
  archived: z.boolean(),
  createdAtMs: TimestampMsSchema,
  workspace: WorkspaceRecordSchema,
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const TaskCreateParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  title: TitleSchema,
  // A task may start without mounts (design §2).
  mounts: z.array(MountSpecSchema).max(M1_LIMITS.mountsPerWorkspace),
});
export const TaskListParamsSchema = z.object({
  limit: ListLimitSchema,
  afterTaskId: ResourceIdSchema.optional(),
  archived: z.enum(["exclude", "include", "only"]).optional(),
});
export const TaskListResultSchema = z.object({
  tasks: z.array(TaskRecordSchema).max(M1_LIMITS.listPage),
  nextAfterTaskId: ResourceIdSchema.optional(),
});
export const TaskGetParamsSchema = z.object({ taskId: ResourceIdSchema });
export const TaskGetResultSchema = z.object({ task: TaskRecordSchema });
export const TaskUpdateParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  taskId: ResourceIdSchema,
  expectedRevision: SequenceSchema.optional(),
  title: TitleSchema,
});
export const TaskArchiveParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  taskId: ResourceIdSchema,
  expectedRevision: SequenceSchema.optional(),
});

export const MountAddParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  taskId: ResourceIdSchema,
  expectedWorkspaceRevision: SequenceSchema.optional(),
  mount: MountSpecSchema,
});
// Removing a mount never deletes a checkout; deleting a managed worktree is binding.delete.
export const MountRemoveParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  taskId: ResourceIdSchema,
  mountId: ResourceIdSchema,
  expectedWorkspaceRevision: SequenceSchema.optional(),
});
// Retries a failed worktree mount; the overrides apply to this attempt only.
export const MountRetryParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  taskId: ResourceIdSchema,
  mountId: ResourceIdSchema,
  ...WorktreeOptionsFields,
});

// ---------------------------------------------------------------------------------------------
// Tabs and runs (T4)

export const TabRecipeSchema = z.discriminatedUnion("kind", [
  // The user's default login shell.
  z.object({ kind: z.literal("shell") }),
  z.object({
    kind: z.literal("command"),
    executable: z.string().min(1).max(M0_LIMITS.executableBytes),
    argv: z.array(z.string()).max(M0_LIMITS.argvCount),
  }),
]);
export const TabCwdSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entry") }),
  z.object({ kind: z.literal("mount"), mountId: ResourceIdSchema }),
]);
export const TabRecordSchema = z.object({
  tabId: ResourceIdSchema,
  taskId: ResourceIdSchema,
  revision: SequenceSchema,
  name: TabNameSchema,
  recipe: TabRecipeSchema,
  cwd: TabCwdSchema,
  createdAtMs: TimestampMsSchema,
  // Latest run of the tab, whether or not it is still alive.
  latestRun: RunRefSchema.nullable(),
});
export type TabRecord = z.infer<typeof TabRecordSchema>;

// The durable record of one PTY run. A run of an earlier relay instance is never shown as live
// after a restart: it is `stopped-with-server` after an orderly stop, otherwise `interrupted` with
// `unverifiable` verification (D9).
export const RunLifecycleSchema = z.enum([
  "starting",
  "running",
  "exited",
  "stopped-with-server",
  "interrupted",
]);
export const RunVerificationSchema = z.enum(["live", "unverifiable", "final"]);
export const RunHistoryRecordSchema = z.object({
  run: RunRefSchema,
  // Null for a run started by `terminal.create`, which belongs to no tab.
  tabId: ResourceIdSchema.nullable(),
  taskId: ResourceIdSchema.nullable(),
  workspaceRevision: SequenceSchema.nullable(),
  cwd: HostPathSchema,
  // Mount mapping snapshot at start; later binding changes do not rewrite it.
  mounts: z
    .array(z.object({ name: MountNameSchema, source: MountSourceSchema, path: HostPathSchema }))
    .max(M1_LIMITS.mountsPerWorkspace),
  lifecycle: RunLifecycleSchema,
  verification: RunVerificationSchema,
  startedAtMs: TimestampMsSchema,
  endedAtMs: TimestampMsSchema.nullable(),
  lastObservedAtMs: TimestampMsSchema.nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(64).nullable(),
});
export type RunHistoryRecord = z.infer<typeof RunHistoryRecordSchema>;

export const TabCreateParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  taskId: ResourceIdSchema,
  name: TabNameSchema.optional(),
  recipe: TabRecipeSchema,
  // Defaults to the workspace entry.
  cwd: TabCwdSchema.optional(),
  // Defaults to true: `tab create` starts the first run (D8).
  start: z.boolean().optional(),
  // Omitted means the server default, so a rebuilt request does not depend on a terminal size.
  geometry: GeometrySchema.optional(),
  appearance: AppearanceSchema.optional(),
});
export const TabListParamsSchema = z.object({
  taskId: ResourceIdSchema,
  limit: ListLimitSchema,
  afterTabId: ResourceIdSchema.optional(),
});
export const TabListResultSchema = z.object({
  tabs: z.array(TabRecordSchema).max(M1_LIMITS.listPage),
  nextAfterTabId: ResourceIdSchema.optional(),
});
export const TabGetParamsSchema = z.object({ tabId: ResourceIdSchema });
// Model A programmatic input never acquires a controller. These receipts count the
// confirmed prefix of the immutable UTF-8 request; the rest is either unknown or not sent.
export const TAB_SEND_TEXT_BYTES = 4096;
export const TAB_SEND_PENDING_PER_RUN = 32;
export const InputPartReceiptSchema = z
  .object({
    status: z.enum(["written", "notSent", "partial", "unknown"]),
    requestedBytes: z.number().int().min(0).max(TAB_SEND_TEXT_BYTES),
    writtenBytes: z.number().int().min(0).max(TAB_SEND_TEXT_BYTES),
    unknownBytes: z.number().int().min(0).max(TAB_SEND_TEXT_BYTES),
    reason: z.string().min(1).max(128).optional(),
  })
  .refine(
    (r) =>
      r.writtenBytes + r.unknownBytes <= r.requestedBytes &&
      (r.status === "written"
        ? r.writtenBytes === r.requestedBytes && r.unknownBytes === 0
        : r.status === "notSent"
          ? r.writtenBytes === 0 && r.unknownBytes === 0
          : r.status === "partial"
            ? r.writtenBytes > 0 && r.writtenBytes < r.requestedBytes && r.unknownBytes === 0
            : r.unknownBytes > 0),
  );
export type InputPartReceipt = z.infer<typeof InputPartReceiptSchema>;
// Counts always describe one confirmed prefix; no caller may infer application execution.
export function inputPartReceipt(
  requestedBytes: number,
  writtenBytes: number,
  unknownBytes: number,
  reason?: string,
): InputPartReceipt {
  const status =
    unknownBytes > 0
      ? "unknown"
      : writtenBytes === requestedBytes
        ? "written"
        : writtenBytes > 0
          ? "partial"
          : "notSent";
  return {
    status,
    requestedBytes,
    writtenBytes,
    unknownBytes,
    ...(reason ? { reason: reason.slice(0, 128) } : {}),
  };
}
export const TabInputReceiptSchema = z
  .object({
    text: InputPartReceiptSchema,
    submit: InputPartReceiptSchema.nullable(),
  })
  .refine(
    (r) =>
      r.submit === null ||
      (r.submit.requestedBytes === 1 &&
        (r.text.status === "written" ||
          r.submit.status === "notSent" ||
          (r.text.status === "unknown" && r.submit.status === "unknown"))),
  );
export type TabInputReceipt = z.infer<typeof TabInputReceiptSchema>;
export function tabSendTextByteLength(text: string): number {
  let bytes = 0;
  for (const scalar of text) {
    const code = scalar.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
export const TabSendParamsSchema = z
  .object({
    operationId: OpaqueIdSchema,
    tabId: ResourceIdSchema,
    run: RunRefSchema,
    ifControlEpoch: SequenceSchema,
    text: z.string().max(TAB_SEND_TEXT_BYTES),
    submit: z.boolean().default(false),
  })
  .refine(
    (p) =>
      (p.text.length > 0 || p.submit) &&
      p.text.isWellFormed() &&
      tabSendTextByteLength(p.text) <= TAB_SEND_TEXT_BYTES,
  );
export type TabSendParams = z.infer<typeof TabSendParamsSchema>;
export const TabControlObservationSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("current"),
    run: RunRefSchema,
    epoch: SequenceSchema,
    holder: ControlHolderSchema.nullable(),
  }),
  z.object({
    state: z.literal("unknown"),
    run: RunRefSchema.nullable(),
    reason: z.string().max(128),
  }),
  z.object({ state: z.literal("not-live"), run: RunRefSchema.nullable() }),
]);
export type TabControlObservation = z.infer<typeof TabControlObservationSchema>;
export const TabGetResultSchema = z.object({
  tab: TabRecordSchema,
  latestRun: RunHistoryRecordSchema.nullable(),
  control: TabControlObservationSchema.optional(),
});
export const TabRunsParamsSchema = z.object({
  tabId: ResourceIdSchema,
  limit: ListLimitSchema,
  // Newest first; continue before this run.
  beforeRunId: OpaqueIdSchema.optional(),
});
export const TabRunsResultSchema = z.object({
  runs: z.array(RunHistoryRecordSchema).max(M1_LIMITS.listPage),
  nextBeforeRunId: OpaqueIdSchema.optional(),
});
// Starts a new run with the recorded recipe; refused while a run of the tab is alive.
export const TabReopenParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  tabId: ResourceIdSchema,
  geometry: GeometrySchema.optional(),
  appearance: AppearanceSchema.optional(),
});
// Stops the tab's current run; `run` optionally pins which run the operator meant.
export const TabStopParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  tabId: ResourceIdSchema,
  run: RunRefSchema.optional(),
});
// Deletes the tab record; refused while a run of the tab is alive (LIVE_RUNS_PRESENT).
export const TabCloseParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  tabId: ResourceIdSchema,
});

// ---------------------------------------------------------------------------------------------
// Server configuration (T1). `cove server init` is a local bootstrap, not an RPC (D7).

export const ConfigRecordSchema = z.object({
  revision: SequenceSchema,
  settings: z.object({
    // Applies to workspaces created afterwards only (server-architecture §9.2).
    workspaceRoot: z.object({ value: HostPathSchema, isDefault: z.boolean() }),
  }),
});
export type ConfigRecord = z.infer<typeof ConfigRecordSchema>;
export const ConfigGetParamsSchema = z.object({});
export const ConfigGetResultSchema = z.object({ config: ConfigRecordSchema });
export const ConfigSetParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  expectedRevision: SequenceSchema.optional(),
  // Field-level patch; null resets a field to its default.
  patch: z
    .object({ workspaceRoot: HostPathSchema.nullable().optional() })
    .refine(atLeastOne(["workspaceRoot"])),
});

// ---------------------------------------------------------------------------------------------
// Binding change and managed worktree deletion (T5)

// Replaces a checkout mount with a new managed worktree (D3: from a commit only; source changes
// stay in the source).
export const BindingConvertParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  taskId: ResourceIdSchema,
  mountId: ResourceIdSchema,
  expectedWorkspaceRevision: SequenceSchema.optional(),
  ...WorktreeOptionsFields,
});
// Deletes the managed worktree bound to a mount and removes the mount; the branch is kept (D10).
// `confirmed: true` is required by the schema itself, so a request without it is invalid params
// and nothing is deleted, whichever client sent it.
export const BindingDeleteParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  taskId: ResourceIdSchema,
  mountId: ResourceIdSchema,
  expectedWorkspaceRevision: SequenceSchema.optional(),
  confirmed: z.literal(true),
});
export const BindingRecordSchema = z.object({
  workspaceRevision: SequenceSchema,
  mountId: ResourceIdSchema,
  source: MountSourceSchema,
  path: HostPathSchema,
  branch: GitRefSchema.nullable(),
  boundAtMs: TimestampMsSchema,
  unboundAtMs: TimestampMsSchema.nullable(),
});
export const BindingListParamsSchema = z.object({
  taskId: ResourceIdSchema,
  mountId: ResourceIdSchema,
});
export const BindingListResultSchema = z.object({
  bindings: z.array(BindingRecordSchema).max(M1_LIMITS.bindingHistory),
});

// ---------------------------------------------------------------------------------------------
// Operations

// relay-protocol §11.5. `recovering` is the startup verification of an operation left accepted or
// running by an earlier instance; one whose result cannot be proven becomes `requires_attention`.
// Abandoning a requires_attention operation ends it as `cancelled` with its remaining effects.
export const OperationStateSchema = z.enum([
  "accepted",
  "running",
  "recovering",
  "requires_attention",
  "succeeded",
  "failed",
  "cancelled",
]);
export type OperationState = z.infer<typeof OperationStateSchema>;

// Continue and abandon are explicit writes with their own operation ID; resending the target's
// own operation ID only returns its record.
export const OperationGetParamsSchema = z.object({ operationId: OpaqueIdSchema });
export const OperationTargetParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  targetOperationId: OpaqueIdSchema,
});

const ProgressTokenSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
// Observed progress of a long operation: step names, never paths or command output.
export const OperationProgressSchema = z.object({
  completedSteps: z.array(ProgressTokenSchema).max(M1_LIMITS.progressTokens),
  remainingEffects: z.array(ProgressTokenSchema).max(M1_LIMITS.progressTokens),
  recoveryActions: z.array(z.enum(["continue", "abandon"])).max(2),
});

export const ResourceRefSchema = z.object({
  kind: z.enum(["repo", "task", "mount", "tab", "config"]),
  id: ResourceIdSchema,
  revision: SequenceSchema,
});
// Per-mount outcome of a multi-repo preparation; partial success stays visible (m1 S4). Only the
// mount ID, its state and the error kind are kept; names, paths and full errors live in the mount
// records (task.get). `left` names what a failed or abandoned preparation left in place because
// deleting it could lose work (m1 T3b): the managed worktree, its
// branch, or both. A reference like the rest: the path and the branch name are in the mount
// record, the clone in the repo record.
export const MountLeftoverSchema = z.enum(["worktree", "branch", "both"]);
// `branch` names a branch left in place (with `left` of branch or both), which the mount record
// does not: a conversion's mount is still the checkout, and a retry may have chosen another
// branch than the attempt that left it (#132).
export const MountOutcomeSchema = z
  .object({
    mountId: ResourceIdSchema,
    state: MountStateSchema,
    errorKind: z.enum(DOMAIN_ERROR_KINDS).optional(),
    left: MountLeftoverSchema.optional(),
    branch: GitRefSchema.optional(),
  })
  .refine(
    (outcome) =>
      outcome.branch === undefined || outcome.left === "branch" || outcome.left === "both",
  );

// Compact result policy. Every schema-valid operation record must fit operationRecordBytes
// (4 KiB): a result that cannot be stored would leave an executed operation without its receipt.
// Results therefore hold references only, and the fields split by method:
// - terminal writes use `run`, `exitCode` and `signal`;
// - every other write uses the domain fields below and never these three (its run, if any, is
//   the record-level `run`);
// - a result with any mount's `left` carries no `targetOperationId`, and `sourceChanges` or a
//   mount's `branch` only when it has exactly one mount: `left` is only ever on a
//   worktree-preparing write (task.create, mount.add, mount.retry, binding.convert),
//   `targetOperationId` belongs to continue/abandon, `sourceChanges` to binding conversion, which
//   prepares exactly one mount (m1 T5), and `branch` matters only to mount.retry and
//   binding.convert, which prepare one mount each. The budget needs it: sixteen mounts with `left`
//   and the source counts, or sixteen branch names, would not fit.
// workspace-contract.test.mjs builds the largest record this schema admits and checks the budget.
export const TERMINAL_RESULT_KEYS = ["run", "exitCode", "signal"] as const;
export const OperationResultDataSchema = z
  .object({
    run: RunRefSchema.optional(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().max(64).nullable().optional(),
    resource: ResourceRefSchema.optional(),
    input: TabInputReceiptSchema.optional(),
    workspaceRevision: SequenceSchema.optional(),
    mounts: z.array(MountOutcomeSchema).max(M1_LIMITS.mountsPerWorkspace).optional(),
    // Changes left in the source on conversion (D3), counted only.
    sourceChanges: z
      .object({
        staged: z.number().int().min(0),
        unstaged: z.number().int().min(0),
        untracked: z.number().int().min(0),
      })
      .optional(),
    targetOperationId: OpaqueIdSchema.optional(),
  })
  .refine(
    (result) =>
      !result.mounts?.some((mount) => mount.left !== undefined) ||
      (result.targetOperationId === undefined &&
        ((result.sourceChanges === undefined &&
          result.mounts.every((mount) => mount.branch === undefined)) ||
          result.mounts.length === 1)),
  );
