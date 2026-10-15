import { domainError, type DomainError } from "@cove/protocol/errors";
import {
  canonicalWriteIntent,
  type OperationRecord,
  type OperationReceiptKey,
  type WriteRpcMethod,
} from "@cove/protocol/rpc";
import type { OperationReceipts } from "./operation-receipts.js";

export type OperationResultData = NonNullable<OperationRecord["result"]>;
export type DatabaseWriteOutcome = { operation: OperationRecord } | { error: DomainError };

export type DatabaseWriteContext = {
  serverId: string;
  receipts: OperationReceipts;
  encodeUtf8: (text: string) => Uint8Array;
  // Runs fn as one database transaction (Store.transaction); it must roll back when fn throws.
  transaction: <T>(fn: () => T) => T;
};

class Refused extends Error {
  constructor(readonly error: DomainError) {
    super(error.kind);
  }
}

// A write whose whole effect is a database change (config, and the repo/task/tab record writes of
// later tasks). relay-protocol §11.3: the receipt is looked up first, so a same-intent resend
// returns the original record (even one an earlier instance wrote) and a changed intent is
// OPERATION_ID_CONFLICT; only a request without a receipt runs `apply`. The resource change and the
// receipt commit in one transaction, so a crash leaves either both or neither, and such an
// operation is never left accepted or running for startup verification.
//
// `apply` runs inside the transaction. It checks preconditions (expected revisions) against the
// current state and returns the result data, or a domain error that rolls everything back and
// leaves no receipt: the request was not accepted, so nothing was executed.
export function executeDatabaseWrite(
  context: DatabaseWriteContext,
  principalId: string,
  method: WriteRpcMethod,
  params: Record<string, unknown> & { operationId: string },
  apply: () => { result: OperationResultData } | { error: DomainError },
): DatabaseWriteOutcome {
  const intent = canonicalWriteIntent(method, params, context.encodeUtf8);
  if (!intent) return { error: domainError("INVALID_ARGUMENT") };
  const key: OperationReceiptKey = {
    serverId: context.serverId,
    principalId,
    operationId: params.operationId,
  };
  const found = context.receipts.lookup(key, intent);
  if (found.kind === "existing") return { operation: found.record };
  if (found.kind === "conflict") return { error: domainError("OPERATION_ID_CONFLICT") };
  if (found.kind !== "reserve") return { error: domainError("BUSY") };
  const preparation = context.receipts.prepare(key, intent);
  if (!preparation) return { error: domainError("BUSY") };
  try {
    return context.transaction(() => {
      const applied = apply();
      if ("error" in applied) throw new Refused(applied.error);
      const accepted: OperationRecord = {
        operationId: params.operationId,
        method,
        revision: 0,
        state: "accepted",
      };
      if (!preparation.commit(accepted)) throw new Refused(domainError("BUSY"));
      const succeeded: OperationRecord = {
        ...accepted,
        revision: 1,
        state: "succeeded",
        result: applied.result,
      };
      if (!context.receipts.update(key, succeeded)) throw new Refused(domainError("BUSY"));
      return { operation: context.receipts.get(key) ?? succeeded };
    });
  } catch (error) {
    preparation.cancel();
    if (error instanceof Refused) return { error: error.error };
    return { error: domainError("BUSY") };
  }
}
