import { domainError, type DomainError } from "@cove/protocol/errors";
import type { TsnetEntry, TsnetEntryContext } from "./listeners.js";

// The server's tsnet entry (m2 D9, D10; T5b): starts and supervises `cove-tsnet serve` and hands
// the connections it forwards to the business server and the pairing listener. Placeholder of the
// listener set (listeners.ts): nothing is started, and the entry reports ENTRY_UNAVAILABLE. T5b
// replaces this module only; the listener set and its context stay as they are.
export function createTsnetEntry(): TsnetEntry {
  const unavailable: DomainError = domainError("ENTRY_UNAVAILABLE");
  return {
    kind: "tsnet",
    async start(_context: TsnetEntryContext) {
      return { error: unavailable };
    },
    async close() {},
  };
}
