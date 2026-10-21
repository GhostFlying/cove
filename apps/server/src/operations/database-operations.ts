import { domainError, type DomainError } from "@cove/protocol/errors";
import {
  SECRETS_MEMBER,
  canonicalWriteIntent,
  secretFields,
  type OperationReceiptKey,
  type OperationRecord,
  type WriteRpcMethod,
} from "@cove/protocol/rpc";
import { StoreUnavailableError } from "../store/store-errors.js";
import type { OperationReceipts } from "./operation-receipts.js";
import type { DatabaseWriteApply, DatabaseWriteOutcome } from "./receipt-records.js";

export type {
  DatabaseWriteApply,
  DatabaseWriteOutcome,
  OperationResultData,
} from "./receipt-records.js";

export type DatabaseWriteContext = {
  serverId: string;
  receipts: OperationReceipts;
  encodeUtf8: (text: string) => Uint8Array;
};

// The domain error a client gets when the store failed a call (store/store-errors.ts). An
// uncertain outcome (the store failed while the call was in flight) is RESULT_UNKNOWN with
// acceptance unknown: the client asks for the operation's record later and never assumes either
// way. A call that never reached the database, or whose transaction rolled back, was not
// accepted: BUSY when the store's queue was full or the transaction failed, and
// CAPABILITY_UNAVAILABLE when the store is closed or failed (the server is stopping).
export function storeFailureError(error: unknown): DomainError {
  if (error instanceof StoreUnavailableError) {
    if (error.outcome === "unknown") return domainError("RESULT_UNKNOWN", "unknown");
    return domainError(error.reason === "busy" ? "BUSY" : "CAPABILITY_UNAVAILABLE");
  }
  return domainError("BUSY");
}

// The domain error of a failed read: a read has no effect to be uncertain about, so it is never
// RESULT_UNKNOWN.
export function storeReadError(error: unknown): DomainError {
  return domainError(
    error instanceof StoreUnavailableError && error.reason !== "busy"
      ? "CAPABILITY_UNAVAILABLE"
      : "BUSY",
  );
}

// The answer for a write request that already has a receipt, or null when it has none and must
// be checked and executed. A domain looks the receipt up before checks that need the filesystem
// or Git, so a resend never depends on a precondition that may have changed since (the clone moved,
// the path is mounted by now); executeDatabaseWrite looks it up again inside its transaction. A
// domain also calls it before returning a refusal decided after an await: while that request
// waited, an identical one may have committed, and its record (or OPERATION_ID_CONFLICT for a
// changed intent) answers both, never a late "not accepted".
export async function recordedWrite(
  context: DatabaseWriteContext,
  principalId: string,
  method: WriteRpcMethod,
  params: Record<string, unknown> & { operationId: string },
): Promise<DatabaseWriteOutcome | null> {
  const intent = canonicalWriteIntent(method, params, context.encodeUtf8);
  if (!intent) return { error: domainError("INVALID_ARGUMENT") };
  const found = await context.receipts.lookup(
    { serverId: context.serverId, principalId, operationId: params.operationId },
    intent,
  );
  if (found.kind === "existing") return { operation: found.record };
  if (found.kind === "conflict") return { error: domainError("OPERATION_ID_CONFLICT") };
  if (found.kind !== "reserve") return { error: domainError("BUSY") };
  return null;
}

// A write whose whole effect is a database change (config, and the repo/task/tab record writes of
// later tasks). relay-protocol §11.3: the receipt is looked up first, so a same-intent resend
// returns the original record (even one an earlier instance wrote) and a changed intent is
// OPERATION_ID_CONFLICT; only a request without a receipt is executed. A reservation keeps a
// second request with the same key from running concurrently (BUSY).
//
// Execution is one store call, receipts.write (store/sql/receipts.ts): in a single transaction it
// looks the receipt up again, runs the named write `apply` (which checks its preconditions, such
// as expected revisions, against the current rows) and commits the receipt. The recheck and the
// write cannot be separated by another call, and a crash leaves either both the change and the
// receipt or neither, so such an operation is never left accepted or running for startup
// verification. A refusal of `apply` rolls everything back and leaves no receipt: the request was
// not accepted, so nothing was executed.
export async function executeDatabaseWrite(
  context: DatabaseWriteContext,
  principalId: string,
  method: WriteRpcMethod,
  params: Record<string, unknown> & { operationId: string },
  apply: DatabaseWriteApply,
): Promise<DatabaseWriteOutcome> {
  return (await executeDatabaseWriteCommitted(context, principalId, method, params, apply)).outcome;
}

// executeDatabaseWrite that also tells whether this call committed the change (receipts.write
// `committed`), as opposed to answering from a receipt found by either lookup. Only the
// committing call may follow its write with work outside the database (domain/workspaces.ts).
export async function executeDatabaseWriteCommitted(
  context: DatabaseWriteContext,
  principalId: string,
  method: WriteRpcMethod,
  params: Record<string, unknown> & { operationId: string },
  apply: DatabaseWriteApply,
): Promise<{ outcome: DatabaseWriteOutcome; committed: boolean }> {
  const answer = (outcome: DatabaseWriteOutcome) => ({ outcome, committed: false });
  const intent = canonicalWriteIntent(method, params, context.encodeUtf8);
  if (!intent) return answer({ error: domainError("INVALID_ARGUMENT") });
  const key: OperationReceiptKey = {
    serverId: context.serverId,
    principalId,
    operationId: params.operationId,
  };
  const found = await context.receipts.lookup(key, intent);
  if (found.kind === "existing") return answer({ operation: found.record });
  if (found.kind === "conflict") return answer({ error: domainError("OPERATION_ID_CONFLICT") });
  if (found.kind !== "reserve") return answer({ error: domainError("BUSY") });
  const preparation = await context.receipts.prepare(key, intent);
  if (!preparation) return answer({ error: domainError("BUSY") });
  try {
    const result = await context.receipts.write({ key, canonicalIntent: intent, method, apply });
    if ("error" in result) return answer(result);
    // The flag stays inside the server: the client's record is the operation alone.
    return { outcome: { operation: result.operation }, committed: result.committed === true };
  } catch (error) {
    return answer({ error: storeFailureError(error) });
  } finally {
    preparation.cancel();
  }
}

// A database write whose live answer carries output secrets (auth.invite.create, auth.device.rotate;
// m2 "秘密与操作记录的分界"). The apply stores only what may be kept (a hash of the secret, the
// references the record shows), and the record never holds the secret itself. `secrets` is
// returned beside the record by the call that committed the operation and by no other: a resend,
// or a request that finds the receipt of an identical one, answers with the record alone, so a
// lost secret is never handed out again; recovery is a new explicit operation (cancel and
// re-invite, or rotate again with the old token).
//
// `params` are the dispatch layer's params, which never hold `secrets`; one that does is a
// caller defect and is refused before anything is looked up, so no receipt can be keyed on it.
export async function executeSecretWrite<S extends Record<string, string>>(
  context: DatabaseWriteContext,
  principalId: string,
  method: WriteRpcMethod,
  params: Record<string, unknown> & { operationId: string },
  apply: DatabaseWriteApply,
  secrets: S,
): Promise<{ operation: OperationRecord; secrets?: S } | { error: DomainError }> {
  const declared = secretFields(method).output;
  if (
    Object.hasOwn(params, SECRETS_MEMBER) ||
    declared.length === 0 ||
    Object.keys(secrets).some((key) => !declared.includes(key))
  )
    throw new Error(`${method} cannot return these secrets`);
  const { outcome, committed } = await executeDatabaseWriteCommitted(
    context,
    principalId,
    method,
    params,
    apply,
  );
  if ("error" in outcome || !committed) return outcome;
  return { operation: outcome.operation, secrets };
}
