import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { OpaqueIdSchema } from "@cove/protocol/identity";
import {
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

// Write-once: a record that already exists is never replaced, so a later command that reuses the
// operation ID with other params cannot change what `resend` sends (the server answers such a
// request with OPERATION_ID_CONFLICT). The file is published by link(2), which refuses an existing
// path, after its content is complete and synced.
export async function savePending(home: string, pending: PendingOperation): Promise<void> {
  const path = pendingPath(home, pending.params.operationId);
  const directory = pendingDirectory(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await lstat(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(pending)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary);
  }
}

// The operation ID of a write: --operation-id, or a fresh one the CLI chooses before sending.
export function operationIdFor(args: Arguments): string {
  const chosen = flag(args, "--operation-id");
  if (chosen === undefined) return randomUUID();
  if (!OpaqueIdSchema.safeParse(chosen).success)
    throw new UsageError("--operation-id is 1-128 letters, digits, '.', '_' or '-'");
  return chosen;
}

// Sends one write: save the pending record, send it, then wait for its settled state.
export async function submitWrite<M extends WriteRpcMethod>(
  args: Arguments,
  session: Session,
  method: M,
  params: Record<string, unknown> & { operationId: string },
): Promise<OperationRecord> {
  await savePending(homeDirectory(args), {
    version: 1,
    serverId: session.record.serverId,
    method,
    params,
    savedAtMs: Date.now(),
  });
  const accepted = unwrap(method, await session.client.call(method, params as never));
  return settle(session.client, (accepted as { operation: OperationRecord }).operation);
}

// The common ending of a write command: print the settled record, failing unless it succeeded.
export function printSucceeded(operation: OperationRecord): void {
  print(requireSucceeded(operation));
}
