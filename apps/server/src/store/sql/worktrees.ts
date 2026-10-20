import { randomUUID } from "node:crypto";
import {
  domainError,
  DomainErrorSchema,
  type DomainError,
  type DomainErrorKind,
} from "@cove/protocol/errors";
import {
  OperationRecordSchema,
  type OperationReceiptKey,
  type OperationRecord,
} from "@cove/protocol/rpc";
import type { MountRecord } from "@cove/protocol/workspace";
import {
  checkedReceiptRecord,
  type OperationResultData,
  type ReceiptLimits,
} from "../../operations/receipt-records.js";
import { Rollback, statement, type Connection } from "./statements.js";

// Managed worktree preparation (docs/milestones/m1.md T3b; the rules are in domain/worktrees.ts).
// Four tables are involved:
// - mounts: a worktree mount is `pending` while an attempt prepares it, then `ready` or `failed`;
// - worktree_preparations (migration 003): what the mount was asked for and its current attempt;
// - worktree_attempts (migration 003): each attempt's phase, every effect it started and what was
//   observed of it, its outcome and the abandon that claimed it;
// - managed_worktrees (migration 001): the intent of the Git steps (path, branch, base commit and
//   the owning operation), recorded before the first step, and kept for good once recorded: the
//   checkout admission check refuses every path in it (D2).
//
// Settlement is atomic: the transaction that settles an operation's last pending attempt also
// writes the operation's final receipt, computed from all of its attempts, so no mount is ever
// settled while the outcome of its operation could still be lost, and an operation is only ever
// reported succeeded when every one of its attempts was recorded ready. Every change of a mount's
// state advances the workspace revision, so the entry's manifest (which lists the state) follows a
// new revision.

const encoder = new TextEncoder();
const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

export type ManagedState = "intent" | "ready" | "abandoned" | "deleted";

// A managed_worktrees row.
export type ManagedWorktree = {
  worktreeId: string;
  path: string;
  branch: string;
  baseCommit: string;
  commonDir: string;
  state: ManagedState;
  mountId: string | null;
  operation: OperationReceiptKey;
};

// A path a previous attempt left recorded may be taken by a new intent only when nothing of that
// attempt is there any more: it was abandoned (only exactly its own artifacts were removed, and
// none were left) or deleted (T5). An intent or a ready worktree holds its path.
export const REUSABLE_MANAGED_STATES: ReadonlySet<ManagedState> = new Set(["abandoned", "deleted"]);

type ManagedRow = {
  worktree_id: string;
  path: string;
  branch: string;
  base_commit: string;
  common_dir: string;
  state: ManagedState;
  mount_id: string | null;
  operation_server_id: string;
  operation_principal_id: string;
  operation_id: string;
};

function toManaged(row: ManagedRow): ManagedWorktree {
  return {
    worktreeId: row.worktree_id,
    path: row.path,
    branch: row.branch,
    baseCommit: row.base_commit,
    commonDir: row.common_dir,
    state: row.state,
    mountId: row.mount_id,
    operation: {
      serverId: row.operation_server_id,
      principalId: row.operation_principal_id,
      operationId: row.operation_id,
    },
  };
}

export function managedAt(db: Connection, path: string): ManagedWorktree | null {
  const row = statement(db, "SELECT * FROM managed_worktrees WHERE path = ?").get(path) as
    ManagedRow | undefined;
  return row ? toManaged(row) : null;
}

// The Git common directory of the ready managed worktree bound to a mount, for the read-time
// verification of a ready worktree mount (domain/workspaces.ts); null when there is none.
export function readyWorktreeCommonDir(db: Connection, mountId: string): string | null {
  return (
    (
      statement(
        db,
        "SELECT common_dir FROM managed_worktrees WHERE mount_id = ? AND state = 'ready'",
      ).get(mountId) as { common_dir: string } | undefined
    )?.common_dir ?? null
  );
}

// ---------------------------------------------------------------------------------------------
// Attempts and their step ledger.

// The effects an attempt starts. The first four create (fetch changes only remote-tracking refs,
// which are not an artifact of the attempt); the last two remove what the attempt created.
export type StepName =
  "fetch" | "branch" | "worktree" | "checkout" | "remove-worktree" | "delete-branch";

// What is known of one run of a step:
// - started: recorded before the command started; what it did is not known yet (a restart that
//   finds it treats it as uncertain);
// - succeeded: Cove's own command was seen to exit with status 0, so its effect is Cove's;
// - verified: it was uncertain, its process has ended, and the state carries proof that the
//   effect is this attempt's own (domain/worktrees.ts, ownership evidence);
// - void: it was uncertain, its process has ended, and nothing of its effect exists, so it may be
//   run again;
// - failed: it ended with another status or never started; whatever state matches its effect is
//   not Cove's;
// - uncertain: it was not seen to end;
// - unproven: it was uncertain, its process has ended, and the state neither proves it this
//   attempt's nor shows that nothing of it exists. Only an abandon records this (a continue stops
//   as requires_attention instead): the artifact may be Cove's, so it is left in place and listed,
//   and it is never removed;
// - removed / preserved: a removal step removed its artifact, or left it in place because the
//   artifact was not provably Cove's and unchanged.
export type StepOutcome =
  | "started"
  | "succeeded"
  | "verified"
  | "void"
  | "failed"
  | "uncertain"
  | "unproven"
  | "removed"
  | "preserved";

export type StepEntry = { step: StepName; outcome: StepOutcome };

// Records `entry` in a ledger, for worktrees.advance and the domain's mirror of the ledger
// (domain/worktrees.ts record). An entry that is not `started` replaces the last entry when that
// one is the same step, started or uncertain: it is what became of that run. Otherwise the entry
// is appended.
//
// Then only the last entry of each step is kept. Every reader decides from a step's last run
// (lastRun, credited, remainingArtifacts) or from the ledger's last entry (a started or uncertain
// step is always last: uncertainty is resolved before anything else is recorded), and the last
// entry of each step, in their order, keeps both. A step runs again only after a run that did not
// take effect (void; a removal also after preserved), so what is dropped never credited an
// effect. The ledger therefore holds at most one entry per step name, and an abandon or a cleanup
// can always record its removals: earlier, a ledger filled by repeated uncertain runs (64 entries)
// refused them, and the abandon could never finish (#126 item 10).
export function appendStep(steps: readonly StepEntry[], entry: StepEntry): StepEntry[] {
  const last = steps.at(-1);
  const next =
    entry.outcome !== "started" &&
    last?.step === entry.step &&
    (last.outcome === "started" || last.outcome === "uncertain")
      ? [...steps.slice(0, -1), entry]
      : [...steps, entry];
  return next.filter(
    (item, index) => !next.slice(index + 1).some((later) => later.step === item.step),
  );
}

export type AttemptPhase = "planned" | "fetched" | "resolved" | "intent";
const PHASES: readonly AttemptPhase[] = ["planned", "fetched", "resolved", "intent"];

// A mount state as recorded; "unavailable" is only ever a read's verdict.
type StoredMountState = Exclude<MountRecord["state"], "unavailable">;

export type Attempt = {
  attemptId: string;
  operation: OperationReceiptKey;
  position: number;
  mountId: string;
  workspaceId: string;
  path: string;
  branch: string;
  baseRef: string | null;
  noFetch: boolean;
  phase: AttemptPhase;
  entryIdentity: string | null;
  baseCommit: string | null;
  worktreeId: string | null;
  steps: StepEntry[];
  outcome: "pending" | "ready" | "failed";
  errorKind: DomainErrorKind | null;
  abandon: OperationReceiptKey | null;
  // The registration as it is now; null when it is gone.
  repo: { repoId: string; path: string; commonDir: string; mainBranch: string | null } | null;
  // The managed_worktrees row at the attempt's path, whoever recorded it.
  managed: ManagedWorktree | null;
  // The attempt prepares the target of a binding.convert (migration 004): its mount is still the
  // checkout it will replace, so settling it never touches the mount, and a ready target is
  // switched to by the binding module instead (WorktreeService.convertWith).
  conversion: boolean;
};

// The last recorded run of `step`, or null when it never ran.
export function lastRun(steps: readonly StepEntry[], step: StepName): StepEntry | null {
  for (let index = steps.length - 1; index >= 0; index--)
    if (steps[index]!.step === step) return steps[index]!;
  return null;
}

// Whether the step's effect is the attempt's own: seen to succeed, or proven after the fact.
export function credited(steps: readonly StepEntry[], step: StepName): boolean {
  const last = lastRun(steps, step)?.outcome;
  return last === "succeeded" || last === "verified";
}

// The artifacts an attempt created, or may have created (unproven), and has not removed: what an
// abandon or a failure leaves in place when it does not remove them. A checkout that did not
// provably complete leaves its worktree partial; it is the worktree's artifact all the same.
export function remainingArtifacts(steps: readonly StepEntry[]): ("worktree" | "branch")[] {
  const left: ("worktree" | "branch")[] = [];
  const made = (step: StepName) =>
    credited(steps, step) || lastRun(steps, step)?.outcome === "unproven";
  if (made("worktree") && lastRun(steps, "remove-worktree")?.outcome !== "removed")
    left.push("worktree");
  if (made("branch") && lastRun(steps, "delete-branch")?.outcome !== "removed") left.push("branch");
  return left;
}

type AttemptRow = {
  attempt_id: string;
  operation_server_id: string;
  operation_principal_id: string;
  operation_id: string;
  position: number;
  mount_id: string;
  workspace_id: string;
  path: string;
  branch: string;
  base_ref: string | null;
  no_fetch: number;
  phase: AttemptPhase;
  entry_identity: string | null;
  base_commit: string | null;
  worktree_id: string | null;
  steps_json: string;
  outcome: "pending" | "ready" | "failed";
  error_json: string | null;
  abandon_server_id: string | null;
  abandon_principal_id: string | null;
  abandon_operation_id: string | null;
  repo_id: string | null;
};

const ATTEMPT_SELECT = `SELECT a.*, m.repo_id FROM worktree_attempts a
  LEFT JOIN mounts m ON m.mount_id = a.mount_id`;

function toAttempt(db: Connection, row: AttemptRow): Attempt {
  const repo =
    row.repo_id === null
      ? undefined
      : (statement(db, "SELECT path, common_dir, main_branch FROM repos WHERE repo_id = ?").get(
          row.repo_id,
        ) as { path: string; common_dir: string; main_branch: string | null } | undefined);
  return {
    attemptId: row.attempt_id,
    operation: {
      serverId: row.operation_server_id,
      principalId: row.operation_principal_id,
      operationId: row.operation_id,
    },
    position: row.position,
    mountId: row.mount_id,
    workspaceId: row.workspace_id,
    path: row.path,
    branch: row.branch,
    baseRef: row.base_ref,
    noFetch: row.no_fetch === 1,
    phase: row.phase,
    entryIdentity: row.entry_identity,
    baseCommit: row.base_commit,
    worktreeId: row.worktree_id,
    steps: JSON.parse(row.steps_json) as StepEntry[],
    outcome: row.outcome,
    errorKind:
      row.error_json === null ? null : DomainErrorSchema.parse(JSON.parse(row.error_json)).kind,
    abandon:
      row.abandon_operation_id === null
        ? null
        : {
            serverId: row.abandon_server_id!,
            principalId: row.abandon_principal_id!,
            operationId: row.abandon_operation_id,
          },
    repo:
      repo && row.repo_id
        ? {
            repoId: row.repo_id,
            path: repo.path,
            commonDir: repo.common_dir,
            mainBranch: repo.main_branch,
          }
        : null,
    managed: managedAt(db, row.path),
    conversion: isConversion(db, row.attempt_id),
  };
}

function isConversion(db: Connection, attemptId: string): boolean {
  return (
    statement(db, "SELECT 1 FROM binding_conversions WHERE attempt_id = ?").get(attemptId) !==
    undefined
  );
}

// Ends a pending conversion's row as failed (its attempt failed or was abandoned): the checkout
// stays bound (migration 004). A no-op for any other attempt.
function failConversion(db: Connection, attemptId: string, at: number): void {
  statement(
    db,
    `UPDATE binding_conversions SET outcome = 'failed', updated_at_ms = ?
     WHERE attempt_id = ? AND outcome = 'pending'`,
  ).run(at, attemptId);
}

export function attemptsOf(db: Connection, operation: OperationReceiptKey): Attempt[] {
  return (
    statement(
      db,
      `${ATTEMPT_SELECT}
       WHERE a.operation_server_id = ? AND a.operation_principal_id = ? AND a.operation_id = ?
       ORDER BY a.position, a.mount_id`,
    ).all(operation.serverId, operation.principalId, operation.operationId) as AttemptRow[]
  ).map((row) => toAttempt(db, row));
}

function claimedBy(db: Connection, abandon: OperationReceiptKey): Attempt[] {
  return (
    statement(
      db,
      `${ATTEMPT_SELECT}
       WHERE a.abandon_server_id = ? AND a.abandon_principal_id = ? AND a.abandon_operation_id = ?
       ORDER BY a.position, a.mount_id`,
    ).all(abandon.serverId, abandon.principalId, abandon.operationId) as AttemptRow[]
  ).map((row) => toAttempt(db, row));
}

function attemptRow(db: Connection, attemptId: string): AttemptRow | undefined {
  return statement(db, `${ATTEMPT_SELECT} WHERE a.attempt_id = ?`).get(attemptId) as
    AttemptRow | undefined;
}

function sameOperation(a: OperationReceiptKey, b: OperationReceiptKey): boolean {
  return (
    a.serverId === b.serverId && a.principalId === b.principalId && a.operationId === b.operationId
  );
}

// The pending attempt `attemptId` when `actor` may act on it: its own operation while no abandon
// claimed it, or the abandon that claimed it.
export function actable(
  db: Connection,
  attemptId: string,
  actor: OperationReceiptKey,
): AttemptRow | undefined {
  const row = attemptRow(db, attemptId);
  if (!row || row.outcome !== "pending") return undefined;
  if (row.abandon_operation_id === null) {
    const owner = {
      serverId: row.operation_server_id,
      principalId: row.operation_principal_id,
      operationId: row.operation_id,
    };
    return sameOperation(owner, actor) ? row : undefined;
  }
  const abandon = {
    serverId: row.abandon_server_id!,
    principalId: row.abandon_principal_id!,
    operationId: row.abandon_operation_id,
  };
  return sameOperation(abandon, actor) ? row : undefined;
}

// What a new worktree mount was asked for (MountSpec), stored with it.
export type WorktreeSpec = { branch: string | null; baseRef: string | null; noFetch: boolean };

// `path` is the worktree's path: the mount's own, except for a conversion's target (T5).
function insertAttempt(
  db: Connection,
  mountId: string,
  operation: OperationReceiptKey,
  position: number,
  options: { branch: string; baseRef: string | null; noFetch: boolean; path?: string },
  at: number,
): string {
  const mount = statement(db, "SELECT workspace_id, path FROM mounts WHERE mount_id = ?").get(
    mountId,
  ) as { workspace_id: string; path: string };
  const attemptId = randomUUID();
  statement(
    db,
    `INSERT INTO worktree_attempts (attempt_id, operation_server_id, operation_principal_id,
       operation_id, position, mount_id, workspace_id, path, branch, base_ref, no_fetch, phase,
       steps_json, outcome, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', '[]', 'pending', ?, ?)`,
  ).run(
    attemptId,
    operation.serverId,
    operation.principalId,
    operation.operationId,
    position,
    mountId,
    mount.workspace_id,
    options.path ?? mount.path,
    options.branch,
    options.baseRef,
    options.noFetch ? 1 : 0,
    at,
    at,
  );
  return attemptId;
}

// Records the preparation of a new worktree mount and its first attempt by `operation` (called
// inside task.create and mount.add after the mount row, store/sql/workspaces.ts).
export function insertPreparation(
  db: Connection,
  mountId: string,
  branch: string,
  spec: WorktreeSpec,
  operation: OperationReceiptKey,
  position: number,
  at: number,
): void {
  const attemptId = insertAttempt(
    db,
    mountId,
    operation,
    position,
    { branch, baseRef: spec.baseRef, noFetch: spec.noFetch },
    at,
  );
  statement(
    db,
    `INSERT INTO worktree_preparations (mount_id, spec_branch, spec_base_ref, spec_no_fetch,
       attempt_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(mountId, spec.branch, spec.baseRef, spec.noFetch ? 1 : 0, attemptId);
}

// The first attempt of a binding.convert (m1 T5): it prepares the target worktree at `path` for
// the checkout mount `mountId`, which keeps its binding meanwhile, so no worktree_preparations
// row is written (store/sql/bindings.ts records the conversion).
export function insertConversionAttempt(
  db: Connection,
  mountId: string,
  path: string,
  branch: string,
  spec: WorktreeSpec,
  operation: OperationReceiptKey,
  at: number,
): string {
  return insertAttempt(
    db,
    mountId,
    operation,
    0,
    { branch, baseRef: spec.baseRef, noFetch: spec.noFetch, path },
    at,
  );
}

// Whether the mount's current attempt belongs to an operation that has not ended (any state but
// succeeded, failed and cancelled): such a mount is neither removed nor retried, so the outcome
// that operation will record is never taken from under it (store/sql/workspaces.ts mount.remove).
export function attemptOperationOpen(db: Connection, mountId: string): boolean {
  // A pending conversion of the mount (T5) owns it the same way until it switched or failed.
  if (
    statement(
      db,
      "SELECT 1 FROM binding_conversions WHERE mount_id = ? AND outcome = 'pending'",
    ).get(mountId) !== undefined
  )
    return true;
  const row = statement(
    db,
    `SELECT o.state, a.abandon_operation_id, a.abandon_server_id, a.abandon_principal_id
     FROM worktree_preparations p
       JOIN worktree_attempts a ON a.attempt_id = p.attempt_id
       LEFT JOIN operations o ON o.server_id = a.operation_server_id
         AND o.principal_id = a.operation_principal_id AND o.operation_id = a.operation_id
     WHERE p.mount_id = ?`,
  ).get(mountId) as
    | {
        state: string | null;
        abandon_operation_id: string | null;
        abandon_server_id: string | null;
        abandon_principal_id: string | null;
      }
    | undefined;
  if (!row) return false;
  if (row.state === null || !ENDED_STATES.has(row.state)) return true;
  if (row.abandon_operation_id === null) return false;
  const abandon = statement(
    db,
    "SELECT state FROM operations WHERE server_id = ? AND principal_id = ? AND operation_id = ?",
  ).get(row.abandon_server_id, row.abandon_principal_id, row.abandon_operation_id) as
    { state: string } | undefined;
  return !abandon || !ENDED_STATES.has(abandon.state);
}

const ENDED_STATES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

export function bumpWorkspace(db: Connection, workspaceId: string): number {
  const { revision } = statement(db, "SELECT revision FROM workspaces WHERE workspace_id = ?").get(
    workspaceId,
  ) as { revision: number };
  // The revision is a SequenceSchema value; a workspace at the limit stays there rather than
  // leaving a state change unrecorded (the manifest compares bytes as well).
  const next = revision === Number.MAX_SAFE_INTEGER ? revision : revision + 1;
  statement(db, "UPDATE workspaces SET revision = ? WHERE workspace_id = ?").run(next, workspaceId);
  return next;
}

function workspaceRevision(db: Connection, workspaceId: string): number | null {
  return (
    (
      statement(db, "SELECT revision FROM workspaces WHERE workspace_id = ?").get(workspaceId) as
        { revision: number } | undefined
    )?.revision ?? null
  );
}

// ---------------------------------------------------------------------------------------------
// Operation records computed from attempts. Pure: the store operations below use them inside
// their transactions, and the startup verifier (domain/worktrees.ts) with what it read.

export type Progress = NonNullable<OperationRecord["progress"]>;

// The operation's result with each of its attempts' mounts at the attempt's outcome. Checkout
// mounts of a task.create keep their outcome.
export function resultWith(
  current: OperationRecord,
  attempts: readonly Attempt[],
  revision: number | null,
): OperationResultData {
  const result: OperationResultData = { ...current.result };
  const byMount = new Map(attempts.map((attempt) => [attempt.mountId, attempt]));
  if (result.mounts)
    result.mounts = result.mounts.map((outcome) => {
      const attempt = byMount.get(outcome.mountId);
      if (!attempt) return outcome;
      return {
        mountId: outcome.mountId,
        state: attempt.outcome,
        ...(attempt.outcome === "failed" && attempt.errorKind
          ? { errorKind: attempt.errorKind }
          : {}),
        ...(attempt.outcome === "failed" ? leftOf(attempt.steps) : {}),
      };
    });
  if (revision !== null && result.workspaceRevision !== undefined)
    result.workspaceRevision = revision;
  return result;
}

// What an ended attempt left in place (the mount outcome's `left`). Only a failed attempt has
// leftovers: a ready one keeps its worktree and branch as the mount's, and a pending one may still
// remove them. The result never carries targetOperationId (it belongs to continue/abandon), and
// sourceChanges only for a binding conversion, which prepares exactly one mount (m1 T5), so the
// schema's exclusion holds.
function leftOf(steps: readonly StepEntry[]): { left?: "worktree" | "branch" | "both" } {
  const remaining = remainingArtifacts(steps);
  if (remaining.length === 2) return { left: "both" };
  return remaining.length ? { left: remaining[0]! } : {};
}

// The outcome of an operation whose attempts all ended: succeeded only when every one was recorded
// ready, otherwise failed with the first failure's error kind (the per-mount outcomes are in the
// result). Null while any attempt is pending: such an operation is never reported settled.
export function settledRecord(
  current: OperationRecord,
  attempts: readonly Attempt[],
  revision: number | null,
): OperationRecord | null {
  if (!attempts.length || attempts.some((attempt) => attempt.outcome === "pending")) return null;
  const failed = attempts.find((attempt) => attempt.outcome === "failed");
  const { progress: _progress, error: _error, ...rest } = current;
  return {
    ...rest,
    revision: current.revision + 1,
    state: failed ? "failed" : "succeeded",
    result: resultWith(current, attempts, revision),
    ...(failed ? { error: domainError(failed.errorKind ?? "RESULT_UNKNOWN") } : {}),
  };
}

// `error` names why the operation stopped when that is known (a conversion whose switch was
// refused, T5); otherwise its outcome is unknown. A stored record never carries error details.
export function attentionRecord(
  current: OperationRecord,
  attempts: readonly Attempt[],
  revision: number | null,
  progress: Progress,
  error?: DomainError,
): OperationRecord {
  return {
    ...current,
    revision: current.revision + 1,
    state: "requires_attention",
    result: attempts.length ? resultWith(current, attempts, revision) : current.result,
    progress,
    error: error ? domainError(error.kind) : domainError("RESULT_UNKNOWN", "unknown"),
  };
}

function receiptOf(
  db: Connection,
  key: OperationReceiptKey,
): { record: OperationRecord; state: string } | null {
  const row = statement(
    db,
    `SELECT record_json, state FROM operations
     WHERE server_id = ? AND principal_id = ? AND operation_id = ?`,
  ).get(key.serverId, key.principalId, key.operationId) as
    { record_json: string; state: string } | undefined;
  if (!row) return null;
  const parsed = OperationRecordSchema.safeParse(JSON.parse(row.record_json));
  if (!parsed.success) throw new Error("Stored operation record is invalid");
  return { record: parsed.data, state: row.state };
}

// The receipt `key` when its stored revision is `expectedRevision` and its state requires
// attention, the only state operation.continue and operation.abandon act on.
function attentionReceipt(
  db: Connection,
  key: OperationReceiptKey,
  expectedRevision: number,
): OperationRecord | null {
  const found = receiptOf(db, key);
  if (!found || found.record.revision !== expectedRevision) return null;
  return found.state === "requires_attention" ? found.record : null;
}

// Replaces the receipt `key` with `next` (its successor), inside the caller's transaction: a
// compare-and-set on the revision `current` was read at.
export function replaceReceipt(
  db: Connection,
  key: OperationReceiptKey,
  current: OperationRecord,
  next: OperationRecord,
  limits: ReceiptLimits,
  at: number,
): boolean {
  const checked = checkedReceiptRecord(key, next, limits, encodeUtf8);
  if (!checked || checked.revision !== current.revision + 1 || checked.method !== current.method)
    return false;
  return (
    statement(
      db,
      `UPDATE operations SET state = ?, revision = ?, record_json = ?, updated_at_ms = ?
       WHERE server_id = ? AND principal_id = ? AND operation_id = ? AND revision = ?`,
    ).run(
      checked.state,
      checked.revision,
      JSON.stringify(checked),
      at,
      key.serverId,
      key.principalId,
      key.operationId,
      current.revision,
    ).changes === 1
  );
}

// The running receipt `key`, or null.
export function runningReceipt(db: Connection, key: OperationReceiptKey): OperationRecord | null {
  const found = receiptOf(db, key);
  return found && found.state === "running" ? found.record : null;
}

type Applied = { result: OperationResultData; running?: true } | { error: DomainError };
const refuse = (kind: Parameters<typeof domainError>[0]): { error: DomainError } => ({
  error: domainError(kind),
});

export type MountRetryArgs = {
  operation: OperationReceiptKey;
  taskId: string;
  mountId: string;
  branch: string;
  baseRef: string | null;
  noFetch: boolean;
  at: number;
};

export type TargetArgs = {
  target: OperationReceiptKey;
  expectedRevision: number;
  next: OperationRecord;
  limits: ReceiptLimits;
  at: number;
};

// What a retry needs to know about the mount it names, before its transaction.
export type RetrySource = {
  taskId: string;
  archived: boolean;
  workspaceId: string;
  mountId: string;
  source: "checkout" | "worktree";
  state: StoredMountState;
  path: string;
  repoId: string;
  // The registration's Git common directory, where the retry chooses a default branch; null when
  // the repo is no longer registered.
  commonDir: string | null;
  spec: WorktreeSpec | null;
  // The operations of the mount's current attempt: its own and the abandon that claimed it.
  prior: OperationReceiptKey[];
};

export const worktreeOperations = {
  // The attempts of an operation, in the order it prepares them.
  "worktrees.attempts": (db: Connection, args: { operation: OperationReceiptKey }): Attempt[] =>
    attemptsOf(db, args.operation),

  // The attempts an operation.abandon claimed.
  "worktrees.claimed": (db: Connection, args: { abandon: OperationReceiptKey }): Attempt[] =>
    claimedBy(db, args.abandon),

  "worktrees.retrySource": (
    db: Connection,
    args: { taskId: string; mountId: string },
  ): RetrySource | null => {
    const row = statement(
      db,
      `SELECT t.task_id, t.archived, w.workspace_id, m.mount_id, m.source, m.state, m.path,
         m.repo_id, p.spec_branch, p.spec_base_ref, p.spec_no_fetch, a.operation_server_id,
         a.operation_principal_id, a.operation_id, a.abandon_server_id, a.abandon_principal_id,
         a.abandon_operation_id, r.common_dir
       FROM mounts m
         JOIN workspaces w ON w.workspace_id = m.workspace_id
         JOIN tasks t ON t.task_id = w.task_id
         LEFT JOIN repos r ON r.repo_id = m.repo_id
         LEFT JOIN worktree_preparations p ON p.mount_id = m.mount_id
         LEFT JOIN worktree_attempts a ON a.attempt_id = p.attempt_id
       WHERE m.mount_id = ? AND t.task_id = ?`,
    ).get(args.mountId, args.taskId) as
      | {
          task_id: string;
          archived: number;
          workspace_id: string;
          mount_id: string;
          source: "checkout" | "worktree";
          state: StoredMountState;
          path: string;
          repo_id: string;
          spec_branch: string | null;
          spec_base_ref: string | null;
          spec_no_fetch: number | null;
          operation_server_id: string | null;
          operation_principal_id: string | null;
          operation_id: string | null;
          abandon_server_id: string | null;
          abandon_principal_id: string | null;
          abandon_operation_id: string | null;
          common_dir: string | null;
        }
      | undefined;
    if (!row) return null;
    const prior: OperationReceiptKey[] = [];
    if (row.operation_id !== null)
      prior.push({
        serverId: row.operation_server_id!,
        principalId: row.operation_principal_id!,
        operationId: row.operation_id,
      });
    if (row.abandon_operation_id !== null)
      prior.push({
        serverId: row.abandon_server_id!,
        principalId: row.abandon_principal_id!,
        operationId: row.abandon_operation_id,
      });
    return {
      taskId: row.task_id,
      archived: row.archived === 1,
      workspaceId: row.workspace_id,
      mountId: row.mount_id,
      source: row.source,
      state: row.state,
      path: row.path,
      repoId: row.repo_id,
      commonDir: row.common_dir,
      spec:
        row.spec_no_fetch === null
          ? null
          : {
              branch: row.spec_branch,
              baseRef: row.spec_base_ref,
              noFetch: row.spec_no_fetch === 1,
            },
      prior,
    };
  },

  // Records what an actor did or is about to do for one attempt (see migration 003), in one
  // statement: a step entry, the next phase (never backwards), the resolved base commit, the
  // entry identity. A step entry goes in by appendStep. False, with nothing written, when `actor`
  // may not act on the attempt (it settled, or an abandon claimed it).
  "worktrees.advance": (
    db: Connection,
    args: {
      attemptId: string;
      actor: OperationReceiptKey;
      step?: StepEntry;
      phase?: AttemptPhase;
      baseCommit?: string;
      entryIdentity?: string;
      at: number;
    },
  ): boolean => {
    const row = actable(db, args.attemptId, args.actor);
    if (!row) return false;
    let steps = JSON.parse(row.steps_json) as StepEntry[];
    if (args.step) steps = appendStep(steps, args.step);
    const phase =
      args.phase && PHASES.indexOf(args.phase) > PHASES.indexOf(row.phase) ? args.phase : row.phase;
    statement(
      db,
      `UPDATE worktree_attempts SET steps_json = ?, phase = ?, base_commit = ?, entry_identity = ?,
         updated_at_ms = ?
       WHERE attempt_id = ?`,
    ).run(
      JSON.stringify(steps),
      phase,
      args.baseCommit ?? row.base_commit,
      args.entryIdentity ?? row.entry_identity,
      args.at,
      args.attemptId,
    );
    return true;
  },

  // Records the intent of the Git steps before the first one (relay-protocol §11.4): the target
  // path, the branch, the resolved base commit and the owning operation. "gone" unless the attempt
  // is pending, actable by its own operation, resolved, and its registration still exists;
  // "taken" when the path is held in managed_worktrees (see REUSABLE_MANAGED_STATES).
  "worktrees.recordIntent": (
    db: Connection,
    args: { attemptId: string; actor: OperationReceiptKey; worktreeId: string; at: number },
  ): "recorded" | "taken" | "gone" => {
    const row = actable(db, args.attemptId, args.actor);
    if (!row || row.abandon_operation_id !== null || row.phase !== "resolved" || !row.base_commit)
      return "gone";
    // The mount's current attempt, or the target of its pending conversion (T5).
    const conversion =
      statement(
        db,
        "SELECT 1 FROM binding_conversions WHERE attempt_id = ? AND outcome = 'pending'",
      ).get(row.attempt_id) !== undefined;
    const mount = statement(
      db,
      `SELECT m.repo_id, w.task_id FROM mounts m
         JOIN workspaces w ON w.workspace_id = m.workspace_id
         LEFT JOIN worktree_preparations p ON p.mount_id = m.mount_id
       WHERE m.mount_id = ? AND (p.attempt_id = ? OR ?)`,
    ).get(row.mount_id, row.attempt_id, conversion ? 1 : 0) as
      { repo_id: string; task_id: string } | undefined;
    if (!mount) return "gone";
    const repo = statement(db, "SELECT common_dir FROM repos WHERE repo_id = ?").get(
      mount.repo_id,
    ) as { common_dir: string } | undefined;
    if (!repo) return "gone";
    const existing = managedAt(db, row.path);
    if (existing && !REUSABLE_MANAGED_STATES.has(existing.state)) return "taken";
    // The path's earlier row is replaced: an abandoned intent left nothing behind, and a deleted
    // worktree's binding history is kept in bindings (T5).
    if (existing) statement(db, "DELETE FROM managed_worktrees WHERE path = ?").run(row.path);
    statement(
      db,
      `INSERT INTO managed_worktrees (worktree_id, path, repo_id, common_dir, branch, base_commit,
         task_id, workspace_id, mount_id, operation_server_id, operation_principal_id,
         operation_id, state, completed_steps_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', '[]', ?, ?)`,
    ).run(
      args.worktreeId,
      row.path,
      mount.repo_id,
      repo.common_dir,
      row.branch,
      row.base_commit,
      mount.task_id,
      row.workspace_id,
      row.mount_id,
      row.operation_server_id,
      row.operation_principal_id,
      row.operation_id,
      args.at,
      args.at,
    );
    statement(
      db,
      `UPDATE worktree_attempts SET phase = 'intent', worktree_id = ?, updated_at_ms = ?
       WHERE attempt_id = ?`,
    ).run(args.worktreeId, args.at, args.attemptId);
    // A conversion's mount is still the checkout; its base commit is set when it switches.
    if (!conversion)
      statement(db, "UPDATE mounts SET base_commit = ? WHERE mount_id = ?").run(
        row.base_commit,
        row.mount_id,
      );
    return "recorded";
  },

  // Ends one attempt for good: ready (its intent becomes the ready managed worktree) or failed
  // with `error` (an intent none of whose artifacts are left becomes abandoned; one with
  // artifacts left keeps holding its path). The mount follows when this is still its current
  // attempt, and the workspace revision grows by one. When no attempt of the operation is pending
  // any more, the same transaction writes the operation's final receipt (settledRecord), so the
  // two can never be seen apart. Null, with nothing written, when the attempt is not pending and
  // actable by its own operation, or the operation's receipt is not running.
  "worktrees.settle": (
    db: Connection,
    args: {
      attemptId: string;
      actor: OperationReceiptKey;
      outcome: "ready" | "failed";
      error?: DomainError;
      limits: ReceiptLimits;
      at: number;
    },
  ): { revision: number | null; settled: boolean } | null => {
    const row = actable(db, args.attemptId, args.actor);
    if (!row || row.abandon_operation_id !== null) return null;
    const owner = {
      serverId: row.operation_server_id,
      principalId: row.operation_principal_id,
      operationId: row.operation_id,
    };
    const receipt = runningReceipt(db, owner);
    if (!receipt) return null;
    const steps = JSON.parse(row.steps_json) as StepEntry[];
    const managed = managedAt(db, row.path);
    const own =
      managed && row.worktree_id !== null && managed.worktreeId === row.worktree_id
        ? managed
        : null;
    const current = statement(db, "SELECT 1 FROM worktree_preparations WHERE attempt_id = ?").get(
      args.attemptId,
    );
    if (args.outcome === "ready") {
      if (!own || own.state !== "intent" || !current) return null;
      statement(
        db,
        `UPDATE managed_worktrees SET state = 'ready', mount_id = ?, completed_steps_json = ?,
           updated_at_ms = ?
         WHERE worktree_id = ?`,
      ).run(
        row.mount_id,
        JSON.stringify(["intent", "branch", "worktree", "checkout"]),
        args.at,
        own.worktreeId,
      );
      statement(
        db,
        "UPDATE mounts SET state = 'ready', error_json = NULL, base_commit = ? WHERE mount_id = ?",
      ).run(own.baseCommit, row.mount_id);
      statement(
        db,
        "UPDATE worktree_attempts SET outcome = 'ready', updated_at_ms = ? WHERE attempt_id = ?",
      ).run(args.at, args.attemptId);
    } else {
      if (own?.state === "intent" && remainingArtifacts(steps).length === 0)
        statement(
          db,
          "UPDATE managed_worktrees SET state = 'abandoned', updated_at_ms = ? WHERE worktree_id = ?",
        ).run(args.at, own.worktreeId);
      const error = JSON.stringify(
        DomainErrorSchema.parse(args.error ?? domainError("RESULT_UNKNOWN", "unknown")),
      );
      statement(
        db,
        `UPDATE worktree_attempts SET outcome = 'failed', error_json = ?, updated_at_ms = ?
         WHERE attempt_id = ?`,
      ).run(error, args.at, args.attemptId);
      if (current)
        statement(db, "UPDATE mounts SET state = 'failed', error_json = ? WHERE mount_id = ?").run(
          error,
          row.mount_id,
        );
      failConversion(db, args.attemptId, args.at);
    }
    const revision = current ? bumpWorkspace(db, row.workspace_id) : null;
    const attempts = attemptsOf(db, owner);
    const final = settledRecord(receipt, attempts, workspaceRevision(db, row.workspace_id));
    // Not expected (the receipt was read as running in this transaction); everything written
    // above is rolled back rather than leaving the attempt settled without its operation.
    if (final && !replaceReceipt(db, owner, receipt, final, args.limits, args.at))
      throw new Rollback(null);
    return { revision, settled: final !== null };
  },

  // Moves a running operation to requires_attention with `progress`: the result shows each of
  // its attempts as it stands. False when the receipt is not running.
  "worktrees.attention": (
    db: Connection,
    args: {
      operation: OperationReceiptKey;
      progress: Progress;
      error?: DomainError;
      limits: ReceiptLimits;
      at: number;
    },
  ): boolean => {
    const receipt = runningReceipt(db, args.operation);
    if (!receipt) return false;
    const attempts = attemptsOf(db, args.operation);
    const revision = attempts[0] ? workspaceRevision(db, attempts[0].workspaceId) : null;
    return replaceReceipt(
      db,
      args.operation,
      receipt,
      attentionRecord(receipt, attempts, revision, args.progress, args.error),
      args.limits,
      args.at,
    );
  },

  // Finishes an operation.abandon whose removals all ended, in one transaction: each attempt it
  // claimed ends failed (OPERATION_NOT_RESUMABLE) and its mount with it; an intent none of whose
  // artifacts are left becomes abandoned; the target becomes cancelled with what is left in
  // `progress`; the abandon itself succeeds. False when either receipt is not as expected.
  "worktrees.finishAbandon": (
    db: Connection,
    args: {
      abandon: OperationReceiptKey;
      target: OperationReceiptKey;
      limits: ReceiptLimits;
      at: number;
    },
  ): boolean => {
    const abandonReceipt = runningReceipt(db, args.abandon);
    const target = receiptOf(db, args.target);
    if (!abandonReceipt || target?.state !== "requires_attention") return false;
    const error = JSON.stringify(domainError("OPERATION_NOT_RESUMABLE"));
    const workspaces = new Set<string>();
    const completed: string[] = [];
    const left: string[] = [];
    const add = (into: string[], items: readonly string[]) => {
      for (const item of items) if (!into.includes(item)) into.push(item);
    };
    for (const attempt of claimedBy(db, args.abandon)) {
      if (attempt.outcome !== "pending") continue;
      const remaining = remainingArtifacts(attempt.steps);
      add(left, remaining);
      for (const step of ["branch", "worktree", "checkout"] as const)
        if (credited(attempt.steps, step)) add(completed, [step]);
      if (
        attempt.managed?.state === "intent" &&
        attempt.worktreeId !== null &&
        attempt.managed.worktreeId === attempt.worktreeId &&
        remaining.length === 0
      )
        statement(
          db,
          "UPDATE managed_worktrees SET state = 'abandoned', updated_at_ms = ? WHERE worktree_id = ?",
        ).run(args.at, attempt.worktreeId);
      statement(
        db,
        `UPDATE worktree_attempts SET outcome = 'failed', error_json = ?, updated_at_ms = ?
         WHERE attempt_id = ?`,
      ).run(error, args.at, attempt.attemptId);
      failConversion(db, attempt.attemptId, args.at);
      const current = statement(db, "SELECT 1 FROM worktree_preparations WHERE attempt_id = ?").get(
        attempt.attemptId,
      );
      if (current) {
        statement(db, "UPDATE mounts SET state = 'failed', error_json = ? WHERE mount_id = ?").run(
          error,
          attempt.mountId,
        );
        workspaces.add(attempt.workspaceId);
      }
    }
    for (const workspaceId of workspaces) bumpWorkspace(db, workspaceId);
    const attempts = attemptsOf(db, args.target);
    const revision = attempts[0] ? workspaceRevision(db, attempts[0].workspaceId) : null;
    const { error: _error, ...rest } = target.record;
    const cancelled: OperationRecord = {
      ...rest,
      revision: target.record.revision + 1,
      state: "cancelled",
      result: resultWith(target.record, attempts, revision),
      progress: {
        completedSteps: completed.slice(0, 8),
        remainingEffects: left.slice(0, 8),
        recoveryActions: [],
      },
    };
    const { progress: _progress, error: _abandonError, ...done } = abandonReceipt;
    const succeeded: OperationRecord = {
      ...done,
      revision: abandonReceipt.revision + 1,
      state: "succeeded",
    };
    if (
      !replaceReceipt(db, args.target, target.record, cancelled, args.limits, args.at) ||
      !replaceReceipt(db, args.abandon, abandonReceipt, succeeded, args.limits, args.at)
    )
      throw new Rollback(false);
    return true;
  },

  "worktrees.workspaceRevision": (db: Connection, args: { workspaceId: string }): number | null =>
    workspaceRevision(db, args.workspaceId),

  // The principals under which an operation ID of this server is being verified at startup
  // (domain/worktrees.ts createWorktreeVerifier, which receives the record without its key).
  "worktrees.recoveringPrincipals": (
    db: Connection,
    args: { serverId: string; operationId: string },
  ): string[] =>
    (
      statement(
        db,
        `SELECT principal_id FROM operations
         WHERE server_id = ? AND operation_id = ? AND state = 'recovering'
         ORDER BY principal_id`,
      ).all(args.serverId, args.operationId) as { principal_id: string }[]
    ).map((row) => row.principal_id),
};

// The target of a continue or an abandon: its pending attempts, and whether an abandon claimed
// any of them (then only that abandon acts on them).
function targetAttempts(db: Connection, target: OperationReceiptKey) {
  const attempts = attemptsOf(db, target).filter((attempt) => attempt.outcome === "pending");
  return { attempts, claimed: attempts.some((attempt) => attempt.abandon !== null) };
}

// Receipt-checked writes (store/sql/writes.ts).
export const worktreeWrites = {
  // Starts a new attempt at a failed worktree mount: the mount becomes pending under this
  // operation with this attempt's options, and the workspace revision grows by one. Refused while
  // the operation of the mount's current attempt (or the abandon that claimed it) has not ended.
  "mount.retry": (db: Connection, args: MountRetryArgs): Applied => {
    const row = statement(
      db,
      `SELECT m.state, m.source, m.path, m.workspace_id, t.archived
       FROM mounts m JOIN workspaces w ON w.workspace_id = m.workspace_id
         JOIN tasks t ON t.task_id = w.task_id
       WHERE m.mount_id = ? AND t.task_id = ?`,
    ).get(args.mountId, args.taskId) as
      | { state: string; source: string; path: string; workspace_id: string; archived: number }
      | undefined;
    if (!row) {
      const task = statement(db, "SELECT 1 FROM tasks WHERE task_id = ?").get(args.taskId);
      return refuse(task ? "MOUNT_NOT_FOUND" : "TASK_NOT_FOUND");
    }
    if (row.archived === 1) return refuse("TASK_ARCHIVED");
    if (row.source !== "worktree" || row.state !== "failed") return refuse("INVALID_ARGUMENT");
    const prepared = statement(db, "SELECT 1 FROM worktree_preparations WHERE mount_id = ?").get(
      args.mountId,
    );
    if (!prepared) return refuse("INVALID_ARGUMENT");
    if (attemptOperationOpen(db, args.mountId)) return refuse("OPERATION_EFFECTS_ACTIVE");
    const managed = managedAt(db, row.path);
    if (managed && !REUSABLE_MANAGED_STATES.has(managed.state))
      return refuse("MOUNT_NAME_CONFLICT");
    statement(
      db,
      `UPDATE mounts SET state = 'pending', branch = ?, base_commit = NULL, error_json = NULL
       WHERE mount_id = ?`,
    ).run(args.branch, args.mountId);
    statement(
      db,
      `UPDATE bindings SET branch = ? WHERE mount_id = ? AND unbound_at_ms IS NULL`,
    ).run(args.branch, args.mountId);
    const attemptId = insertAttempt(
      db,
      args.mountId,
      args.operation,
      0,
      { branch: args.branch, baseRef: args.baseRef, noFetch: args.noFetch },
      args.at,
    );
    statement(db, "UPDATE worktree_preparations SET attempt_id = ? WHERE mount_id = ?").run(
      attemptId,
      args.mountId,
    );
    const revision = bumpWorkspace(db, row.workspace_id);
    return {
      result: {
        resource: { kind: "mount", id: args.mountId, revision },
        workspaceRevision: revision,
        mounts: [{ mountId: args.mountId, state: "pending" }],
      },
      running: true,
    };
  },

  // Moves a requires_attention target back to running (its executor, or for an abandon its
  // removals, then finish it), in the transaction that commits the continue operation itself.
  // The revision the caller inspected must still be the target's, so a decision made on a stale
  // view is refused; so is a target whose attempts an abandon claimed.
  "operation.continue": (db: Connection, args: TargetArgs): Applied => {
    const current = attentionReceipt(db, args.target, args.expectedRevision);
    if (!current) return refuse("OPERATION_NOT_RESUMABLE");
    if (args.next.state !== "running") return refuse("INVALID_ARGUMENT");
    if (current.method !== "operation.abandon" && targetAttempts(db, args.target).claimed)
      return refuse("OPERATION_EFFECTS_ACTIVE");
    if (!replaceReceipt(db, args.target, current, args.next, args.limits, args.at))
      return refuse("OPERATION_NOT_RESUMABLE");
    return { result: { targetOperationId: args.target.operationId } };
  },

  // Accepts an abandon before anything is removed: the abandon is committed running and claims
  // every pending attempt of the target, which stays requires_attention, so no continue, retry
  // or second abandon acts on them meanwhile. Its removals follow outside the transaction, each
  // recorded in the attempt's ledger, and worktrees.finishAbandon ends both operations at once.
  "operation.abandon": (
    db: Connection,
    args: {
      operation: OperationReceiptKey;
      target: OperationReceiptKey;
      expectedRevision: number;
      at: number;
    },
  ): Applied => {
    const current = attentionReceipt(db, args.target, args.expectedRevision);
    if (!current || current.method === "operation.abandon")
      return refuse("OPERATION_NOT_RESUMABLE");
    const { attempts, claimed } = targetAttempts(db, args.target);
    if (claimed) return refuse("OPERATION_EFFECTS_ACTIVE");
    for (const attempt of attempts)
      statement(
        db,
        `UPDATE worktree_attempts SET abandon_server_id = ?, abandon_principal_id = ?,
           abandon_operation_id = ?, updated_at_ms = ?
         WHERE attempt_id = ? AND outcome = 'pending' AND abandon_operation_id IS NULL`,
      ).run(
        args.operation.serverId,
        args.operation.principalId,
        args.operation.operationId,
        args.at,
        attempt.attemptId,
      );
    return { result: { targetOperationId: args.target.operationId }, running: true };
  },
};
