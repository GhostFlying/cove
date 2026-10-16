import type { DomainError } from "@cove/protocol/errors";
import type { OperationResultData } from "../../operations/receipt-records.js";
import { nextConfig, type ConfigSetArgs, type ConfigState } from "../config-rules.js";
import { statement, type Connection } from "./statements.js";

function read(db: Connection): ConfigState {
  const row = statement(db, "SELECT revision, workspace_root FROM config WHERE id = 1").get() as
    { revision: number; workspace_root: string | null } | undefined;
  if (!row) throw new Error("Server configuration is not initialized");
  return { revision: row.revision, workspaceRoot: row.workspace_root };
}

function write(db: Connection, next: ConfigState, at: number): void {
  const changed = statement(
    db,
    "UPDATE config SET revision = ?, workspace_root = ?, updated_at_ms = ? WHERE id = 1",
  ).run(next.revision, next.workspaceRoot, at).changes;
  if (changed !== 1) throw new Error("Server configuration is not initialized");
}

export const configOperations = {
  "config.read": (db: Connection): ConfigState => read(db),

  // `cove server init` (D7): sets the first workspaceRoot of a database whose identity this very
  // init created. The caller validated the path.
  "config.initialize": (db: Connection, args: { workspaceRoot: string; at: number }): void => {
    const current = read(db);
    write(db, { revision: current.revision + 1, workspaceRoot: args.workspaceRoot }, args.at);
  },
};

// Database writes applied inside receipts.write (store/sql/receipts.ts), in the same transaction
// as the receipt.
export const configWrites = {
  "config.set": (
    db: Connection,
    args: ConfigSetArgs & { at: number },
  ): { result: OperationResultData } | { error: DomainError } => {
    const applied = nextConfig(read(db), args);
    if ("error" in applied) return applied;
    write(db, applied.next, args.at);
    return { result: applied.result };
  },
};
