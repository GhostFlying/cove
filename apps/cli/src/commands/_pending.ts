import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CallOutcome } from "@cove/client";
import { OpaqueIdSchema } from "@cove/protocol/identity";
import {
  canonicalWriteIntent,
  isWriteRpcMethod,
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
export type PendingOperation = {
  readonly version: 1;
  readonly serverId: string;
  readonly method: WriteRpcMethod;
  readonly params: Record<string, unknown> & { operationId: string };
  readonly savedAtMs: number;
};

function pendingDirectory(home: string): string {
  return join(home, "cli", "operations");
}

function pendingPath(home: string, operationId: string): string {
  if (!OpaqueIdSchema.safeParse(operationId).success)
    throw new UsageError("an operation ID is 1-128 letters, digits, '.', '_' or '-'");
  return join(pendingDirectory(home), `${operationId}.json`);
}

export async function readPending(home: string, operationId: string): Promise<PendingOperation> {
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
    !validateRpcMethodParams(parsed.method, parsed.params)
  )
    throw new Error(`the saved request for operation ${operationId} is invalid`);
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
  return readPending(home, operationId);
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
  const pending: PendingOperation = {
    version: 1,
    serverId: session.record.serverId,
    method,
    params,
    savedAtMs: Date.now(),
  };
  const saved = await publishPending(homeDirectory(args), pending);
  if (!samePendingRequest(saved, pending))
    throw new Error(
      `operation ${params.operationId} already has a saved request with another server, method ` +
        `or parameters; nothing was sent. Use a fresh --operation-id for this request ` +
        `(\`cove operation resend ${params.operationId}\` sends the saved one)`,
    );
  const outcome = await session.client.call(method, saved.params as never);
  if (!outcome.ok) onFailure?.(outcome);
  const accepted = unwrap(method, outcome);
  return (accepted as { operation: OperationRecord }).operation;
}

// The common ending of a write command: print the settled record, failing unless it succeeded.
export function printSucceeded(operation: OperationRecord): void {
  print(requireSucceeded(operation));
}
