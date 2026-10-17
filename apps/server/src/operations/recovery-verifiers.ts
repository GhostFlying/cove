import { createWorktreeVerifier } from "../domain/worktrees.js";
import type { Store } from "../store/database.js";
import type { ReceiptVerifiers } from "./operation-receipts.js";

// What a startup verifier may use to prove the outcome of an operation an earlier instance left
// unfinished: the store (managed worktree steps, process ownership records) and the identity of the
// instance that is starting.
export type RecoveryContext = {
  readonly store: Store;
  readonly serverId: string;
  readonly relayInstanceId: string;
  readonly now: () => number;
};

// The method → verifier registry consulted by startup recovery (entry/main.ts →
// OperationReceipts.recoverInterrupted). It is a seam: domain tasks (T3b for managed worktree
// creation and deletion) fill this module without touching the entry. A method without a verifier
// keeps the generic outcome, requires_attention with RESULT_UNKNOWN; T1 registers none, because
// its own durable writes (config.set) commit receipt and effect in one transaction and terminal
// runs of an earlier instance cannot be proven after a restart (D9). T3b registers the methods
// that create managed worktrees, whose receipt stays running until the preparation settles it, and
// operation.abandon, whose receipt stays running until its removals ended.
export function createRecoveryVerifiers(context: RecoveryContext): ReceiptVerifiers {
  const worktrees = createWorktreeVerifier(context);
  return {
    "task.create": worktrees,
    "mount.add": worktrees,
    "mount.retry": worktrees,
    "operation.abandon": worktrees,
  };
}
