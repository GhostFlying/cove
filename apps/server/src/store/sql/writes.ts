import { authWrites } from "./auth.js";
import { bindingWrites } from "./bindings.js";
import { configWrites } from "./config.js";
import { repoWrites } from "./repos.js";
import { tabWrites } from "./tabs.js";
import { workspaceWrites } from "./workspaces.js";
import { worktreeWrites } from "./worktrees.js";

// The database writes receipts.write may apply (operations/database-operations.ts). Each is a
// synchronous function of the connection and its structured-clone-safe arguments that checks its
// preconditions against the current rows and returns the operation's result data, or a domain
// error, which rolls the whole transaction back and leaves no receipt.
//
// This is the registration point for domain writes: a domain task adds its module's writes here
// (one writer per change, like the RPC dispatch table).
export const DATABASE_WRITES = Object.freeze({
  ...configWrites,
  ...repoWrites,
  ...workspaceWrites,
  ...tabWrites,
  ...worktreeWrites,
  ...bindingWrites,
  ...authWrites,
});

export type DatabaseWrites = typeof DATABASE_WRITES;
