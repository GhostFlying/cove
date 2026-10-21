import type { InvitationPayload } from "@cove/protocol/auth";
import type { ServerRecord } from "./credentials.js";
import { RemoteError, type OpenedEntry } from "./entry-types.js";

// The tsnet entry (m2 D9, D14): a placeholder that T4 replaces with the client tsnet node (the
// resident `cove-tsnet dial` process, which checks the server node's stable ID before it forwards).
// Until then both the entry of a paired server and the pairing over tsnet are unavailable, and
// nothing is sent. T4 keeps these signatures: entries.ts selects through them. The opened entry's
// endpoint can be the dial process's local loopback port as it is: the server accepts any
// loopback literal Host (user decision 2026-10-22), so no Host rewriting is needed.

function unavailable(what: string): RemoteError {
  return new RemoteError(
    "ENTRY_UNAVAILABLE",
    `the tsnet entry is not available in this build; ${what}`,
  );
}

export async function openTsnetEntry(_record: ServerRecord): Promise<OpenedEntry> {
  throw unavailable("nothing was sent");
}

export async function openTsnetPairing(_payload: InvitationPayload): Promise<OpenedEntry> {
  throw unavailable("the invitation was not sent");
}
