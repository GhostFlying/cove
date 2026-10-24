import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CallOutcome } from "@cove/client";
import { OpaqueIdSchema } from "@cove/protocol/identity";
import {
  canonicalWriteIntent,
  isWriteRpcMethod,
  secretFields,
  splitSecrets,
  validateRpcMethodParams,
  type OperationRecord,
  type WriteRpcMethod,
} from "@cove/protocol/rpc";
import type { Session } from "../session.js";
import {
  flag,
  homeDirectory,
  print,
  requireSucceeded,
  settle,
  unwrap,
  UsageError,
  type Arguments,
} from "./_common.js";

// The CLI's local pending record of a write (relay-protocol §11.2, m1 "操作身份跨重启"): saved
// under the data directory before the first send, with the server it was meant for, the method
// and the complete immutable params. `cove operation resend` sends exactly this request again, and
// only to the same server (serverId); the relay instance may have changed in between.
//
// Secrets are never saved (m2 "秘密与操作记录的分界"): `params` is the request without its
// `secrets` member, and `omittedSecrets` names the secret fields the request carried. Such a
// record cannot be resent, since the request it saved is incomplete; `resend` refuses it locally
// and the operator runs the original command again (`operation get` still reads its outcome).
// The fingerprint excludes secrets, so the saved params still identify the operation.
//
// Retention (m2 D13, #97): a saved record expires PENDING_RETENTION_MS after it was saved, as the
// server's receipts do after they end. An expired record is never sent again: `resend` refuses it
// locally, and a command reusing its operation ID is refused before sending. A request that old
// may have been executed, recorded and since cleared by the server (which then answers
// OPERATION_HISTORY_EXPIRED), or never have arrived, in which case sending it now would execute a
// month-old intent as new work. The record stays on disk; `operation get` still asks the server.
// Age is measured on this machine's wall clock against savedAtMs: a clock that went back only makes
// a record look younger, so it never expires one early; a record saved "in the future" of the
// current clock waits until the clock passes savedAtMs plus the retention.
export type PendingOperation = {
  readonly version: 1;
  readonly serverId: string;
  readonly method: WriteRpcMethod;
  readonly params: Record<string, unknown> & { operationId: string };
  readonly omittedSecrets?: readonly string[];
  readonly savedAtMs: number;
};

export const PENDING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Whether a saved record is past its retention at `now`.
export function pendingExpired(pending: PendingOperation, now: number = Date.now()): boolean {
  return now - pending.savedAtMs >= PENDING_RETENTION_MS;
}

function expiredDescription(pending: PendingOperation): string {
  return (
    `the saved request for operation ${pending.params.operationId} was saved at ` +
    `${new Date(pending.savedAtMs).toISOString()} and expired after 30 days`
  );
}

function pendingDirectory(home: string): string {
  return join(home, "cli", "operations");
}

function pendingPath(home: string, operationId: string): string {
  if (!OpaqueIdSchema.safeParse(operationId).success)
    throw new UsageError("an operation ID is 1-128 letters, digits, '.', '_' or '-'");
  return join(pendingDirectory(home), `${operationId}.json`);
}

// The saved record of an operation ID, validated, whether or not it can be resent.
async function loadPending(home: string, operationId: string): Promise<PendingOperation> {
  let text: string;
  try {
    text = await readFile(pendingPath(home, operationId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`no saved request for operation ${operationId} under ${home}`);
    throw error;
  }
  let parsed: PendingOperation;
  try {
    parsed = JSON.parse(text) as PendingOperation;
  } catch {
    throw new Error(`the saved request for operation ${operationId} is unreadable`);
  }
  if (
    parsed?.version !== 1 ||
    !OpaqueIdSchema.safeParse(parsed.serverId).success ||
    !isWriteRpcMethod(parsed.method) ||
    parsed.params?.operationId !== operationId ||
    !Number.isSafeInteger(parsed.savedAtMs) ||
    Object.hasOwn(parsed.params, "secrets") ||
    (parsed.omittedSecrets !== undefined &&
      (!Array.isArray(parsed.omittedSecrets) ||
        parsed.omittedSecrets.some(
          (field) => !secretFields(parsed.method).input.includes(field as string),
        ))) ||
    !validateRpcMethodParams(parsed.method, parsed.params)
  )
    throw new Error(`the saved request for operation ${operationId} is invalid`);
  return parsed;
}

// The saved request of an operation ID, for `operation resend`: refused when it expired or when its
// secrets were omitted. Only field names are printed, never a value.
export async function readPending(home: string, operationId: string): Promise<PendingOperation> {
  const parsed = await loadPending(home, operationId);
  if (pendingExpired(parsed))
    throw new Error(
      `${expiredDescription(parsed)}, so it is never sent again; nothing was sent ` +
        `(\`cove operation get ${operationId}\` shows what the server recorded)`,
    );
  if (parsed.omittedSecrets?.length)
    throw new Error(
      `operation ${operationId} carried secrets (${parsed.omittedSecrets.join(", ")}) that are ` +
        `never saved, so it cannot be resent; nothing was sent. Run the original command again ` +
        `(\`cove operation get ${operationId}\` shows whether the server recorded it)`,
    );
  return parsed;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// The saved record of an operation ID, or null when none exists yet.
async function existingPending(
  home: string,
  operationId: string,
): Promise<PendingOperation | null> {
  try {
    await lstat(pendingPath(home, operationId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return loadPending(home, operationId);
}

// Makes a published pending record's directory entries durable: every directory from the record's
// directory up to the filesystem root is fsynced. A file fsync does not make its directory entry
// durable, and a host crash after the server accepted the operation must not lose the only local
// copy of its ID and request.
//
// The whole chain is synced on every call, never only "what this call created": a command that
// created the data directory (and possibly ancestors above it) can die before syncing them, and a
// later command finds them already present. The call is idempotent, so `publishPending` (whether
// it published or found the record) and `resend` both run it before transmitting. Every directory
// the CLI may have created is its own and readable; an ancestor that cannot be opened for reading
// existed before (the CLI could not have created it) and is skipped.
export async function syncPendingPublication(home: string): Promise<void> {
  const directory = pendingDirectory(home);
  const homeParent = dirname(home);
  for (let current = directory; ; current = dirname(current)) {
    try {
      await syncDirectory(current);
    } catch (error) {
      const above = current.length < homeParent.length;
      if (!above || (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    }
    if (dirname(current) === current) break;
  }
}

// Publishes the pending record of a write before it is first sent and returns the record that is
// saved under its operation ID: this one, or the one an earlier command (or a concurrent one that
// won the race) already saved. Write-once: an existing record is never replaced, so `resend` keeps
// sending the request the ID was first used for.
//
// The content is complete and synced before link(2) publishes it (link refuses an existing path,
// so of two concurrent commands exactly one publishes); syncPendingPublication then makes the
// entry durable.
export async function publishPending(
  home: string,
  pending: PendingOperation,
): Promise<PendingOperation> {
  const operationId = pending.params.operationId;
  const path = pendingPath(home, operationId);
  const directory = pendingDirectory(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const syncPublication = () => syncPendingPublication(home);
  const saved = await existingPending(home, operationId);
  if (saved) {
    // An earlier command may have crashed between link(2) and its directory sync.
    await syncPublication();
    return saved;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(pending)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let published = true;
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    published = false;
  } finally {
    await unlink(temporary);
  }
  await syncPublication();
  if (published) return pending;
  // Lost the race: the record of the command that won is the saved one.
  const winner = await existingPending(home, operationId);
  if (!winner) throw new Error(`the saved request for operation ${operationId} disappeared`);
  return winner;
}

const encoder = new TextEncoder();

// Whether two records carry the same request: the same server, method and canonical intent (the
// params without the operation ID, in the form the server fingerprints them).
export function samePendingRequest(a: PendingOperation, b: PendingOperation): boolean {
  if (a.serverId !== b.serverId || a.method !== b.method) return false;
  const intent = canonicalWriteIntent(a.method, a.params, (text) => encoder.encode(text));
  return (
    intent !== null &&
    intent === canonicalWriteIntent(b.method, b.params, (text) => encoder.encode(text))
  );
}

// Whether parsing kept every member of `input` with its value: the parse may add defaults, but
// may not drop or change anything the caller gave.
function keptByParse(input: unknown, parsed: unknown): boolean {
  if (input === null || typeof input !== "object") return Object.is(input, parsed);
  if (parsed === null || typeof parsed !== "object") return false;
  if (Array.isArray(input) !== Array.isArray(parsed)) return false;
  if (Array.isArray(input) && input.length !== (parsed as unknown[]).length) return false;
  return Object.entries(input).every(
    // An undefined member is absent on the wire (JSON drops it), so it has nothing to keep.
    ([key, value]) =>
      value === undefined ||
      (Object.hasOwn(parsed, key) && keptByParse(value, (parsed as Record<string, unknown>)[key])),
  );
}

// The operation ID of a write: --operation-id, or a fresh one the CLI chooses before sending.
export function operationIdFor(args: Arguments): string {
  const chosen = flag(args, "--operation-id");
  if (chosen === undefined) return randomUUID();
  if (!OpaqueIdSchema.safeParse(chosen).success)
    throw new UsageError("--operation-id is 1-128 letters, digits, '.', '_' or '-'");
  return chosen;
}

// Sends one write: save the pending record, send the saved request, then wait for its settled
// state. A reused operation ID whose saved request differs (another server, method or params) is
// refused before anything is sent: sending the new params would let the server execute a request
// that `resend` cannot reproduce, and the server would answer the saved one with
// OPERATION_ID_CONFLICT.
export async function submitWrite<M extends WriteRpcMethod>(
  args: Arguments,
  session: Session,
  method: M,
  params: Record<string, unknown> & { operationId: string },
  // Sees a call that did not return the accepted record before the command fails with it (T5: a
  // refusal that lists the live runs in its details).
  onFailure?: (outcome: Exclude<CallOutcome<unknown>, { ok: true }>) => void,
): Promise<OperationRecord> {
  return settle(session.client, await acceptWrite(args, session, method, params, onFailure));
}

// submitWrite without the settling: the record as the server accepted it, for a command that must
// still print it when polling its state afterwards fails (operation continue/abandon).
export async function acceptWrite<M extends WriteRpcMethod>(
  args: Arguments,
  session: Session,
  method: M,
  params: Record<string, unknown> & { operationId: string },
  onFailure?: (outcome: Exclude<CallOutcome<unknown>, { ok: true }>) => void,
): Promise<OperationRecord> {
  // Checked before anything touches the disk: params the method's schema would change (a member
  // it strips, such as a secret placed outside `secrets` or under an undeclared name there) are
  // refused, so what is saved below is exactly a valid request without its declared secrets.
  const validated = validateRpcMethodParams(method, params);
  if (!validated || !keptByParse(params, validated.params))
    throw new Error(
      `the ${method} request is invalid (a field is malformed or not part of the method); ` +
        `nothing was saved or sent`,
    );
  // The secrets stay in this process: the record keeps the params without them.
  const { value: stored, secrets } = splitSecrets(params);
  const omitted = Object.keys(secrets ?? {}).sort();
  const pending: PendingOperation = {
    version: 1,
    serverId: session.record.serverId,
    method,
    params: stored as typeof params,
    ...(omitted.length > 0 ? { omittedSecrets: omitted } : {}),
    savedAtMs: Date.now(),
  };
  const saved = await publishPending(homeDirectory(args), pending);
  if (!samePendingRequest(saved, pending) && method === "tab.send")
    throw new Error(
      `operation ${params.operationId} already has a different saved immutable request; nothing was sent. Inspect the original operation before making any independent input decision`,
    );
  if (!samePendingRequest(saved, pending))
    throw new Error(
      `operation ${params.operationId} already has a saved request with another server, method ` +
        `or parameters; nothing was sent. Use a fresh --operation-id for this request ` +
        `(\`cove operation resend ${params.operationId}\` sends the saved one)`,
    );
  if (method === "tab.send" && saved !== pending) {
    // A published send may have reached the PTY even if this process never saw acceptance.
    // Query only: an absent receipt is insufficient proof to transmit the saved bytes again.
    return unwrap("operation.get", await session.client.getOperation(params.operationId)).operation;
  }
  // An earlier command's record past its retention is never sent again (see PendingOperation).
  if (saved !== pending && pendingExpired(saved))
    throw new Error(
      `${expiredDescription(saved)}; nothing was sent. Use a fresh --operation-id for this ` +
        `request (\`cove operation get ${params.operationId}\` shows what the server recorded)`,
    );
  // The secrets are not part of the intent, but whether a request has them decides whether its
  // saved record may be resent. A reused ID whose secret fields differ from the saved record's
  // (a login first sent without an auth key, then with one) would leave a resendable record for
  // a request that carried a secret, so it is refused.
  if ([...(saved.omittedSecrets ?? [])].sort().join() !== omitted.join())
    throw new Error(
      `operation ${params.operationId} was saved with other secret fields ` +
        `(${(saved.omittedSecrets ?? []).join(", ") || "none"}); nothing was sent. Use a fresh ` +
        `--operation-id for this request`,
    );
  // The saved request plus this command's own secrets (same intent: secrets are not part of it).
  const outcome = await session.client.call(
    method,
    (secrets ? { ...saved.params, secrets } : saved.params) as never,
  );
  if (!outcome.ok) onFailure?.(outcome);
  const accepted = unwrap(method, outcome);
  return (accepted as { operation: OperationRecord }).operation;
}

// The common ending of a write command: print the settled record, failing unless it succeeded.
export function printSucceeded(operation: OperationRecord): void {
  print(requireSucceeded(operation));
}
