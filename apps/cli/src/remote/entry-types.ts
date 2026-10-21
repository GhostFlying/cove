import type { EntryKind } from "./credentials.js";

// The types every entry module shares (entries.ts selects among loopback, ssh-tunnel.ts and
// tsnet.ts), kept apart so that the entry modules do not import the selection that imports them.

// The entry `--via` names. loopback is never named: it is only ever a record's default.
export type Via = "ssh" | "tsnet";

// A failure of a remote command that is not an RPC answer. `kind` is the protocol error kind
// (errors.ts) it corresponds to; nothing was sent to the server when it is raised before the
// credential was released, which every raise in the entry modules is.
export class RemoteError extends Error {
  constructor(
    readonly kind: "ENTRY_UNAVAILABLE" | "SERVER_ID_MISMATCH" | "INVITATION_UNAVAILABLE",
    readonly detail: string,
  ) {
    super(`${detail} (${kind})`);
  }
}

// An opened entry: the local HTTP endpoint (an origin, `http://127.0.0.1:<port>`) that reaches
// the server, and what to release afterwards. Requests to it carry the endpoint's own authority as
// Host: the server's (loopback) or the channel's local end (an SSH tunnel), which the server
// accepts as a loopback literal (user decision 2026-10-22). close() releases the channel (an SSH
// tunnel's process) and never throws; the entry must not be used afterwards.
// failure(), when the entry has it, is the latest failure of the channel after the entry opened
// (a tsnet stream the daemon refused for a later connection), which the client itself only sees
// as a closed connection; a command that fails reports it with its own error.
export type OpenedEntry = {
  readonly kind: EntryKind;
  readonly endpoint: string;
  close(): Promise<void>;
  failure?(): RemoteError | undefined;
};

// `error` (a command's failure over `entry`) with the entry's own latest failure, if any, so that
// the reason a later connection was refused (an identity hold, PEER_MISMATCH) is not lost behind
// the client's report of a closed connection.
export function withEntryFailure(error: unknown, entry: Pick<OpenedEntry, "failure">): unknown {
  const failure = entry.failure?.();
  if (!failure) return error;
  // The same error object, so that its class (an exit status, a usage error) still applies.
  if (error instanceof Error) {
    error.message = `${error.message}; ${failure.message}`;
    return error;
  }
  return new Error(`${String(error)}; ${failure.message}`);
}
