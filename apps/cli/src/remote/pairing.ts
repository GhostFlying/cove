import type { InvitationPayload, PairingRedeemResult } from "@cove/protocol/auth";
import type { ServerRecord } from "./credentials.js";
import type { Via } from "@cove/node-client";
import { nodeAdapters } from "./adapters.js";
export { parseInvitation } from "@cove/node-client";
export const { redeemInvitation } = nodeAdapters;

// The credential record of a redeemed invitation (D5, D11, S7). It holds every entry the
// invitation carries, so that one client can reach the server over SSH and over tsnet and switch
// with --via (m2 deliverable 6, S7):
// - the invitation's SSH target and tsnet node, if any, at the business port on that host: the
//   server's tailnet node serves the business port at the same number as its loopback port (an
//   interface requirement on the server's tsnet wiring, m2 T5b), and the SSH tunnel forwards to
//   the target host's loopback business port;
// - paired over loopback (no `via`), also the loopback business port: the server is on this host.
//   A client that paired over SSH or tsnet is on another host, where the server's loopback port
//   is not this host's, so it never records loopback.
// The default entry is the one the pairing went through: loopback without `via`, else `via`
// (with `--via`, the first entry this client uses is its operator's choice, not the invitation's
// order). `cove remote entry default` changes it; nothing switches it automatically.
//
// An entry the pairing did not go through is recorded unexercised. That is no weaker than the
// exercised one: an entry is never trusted because it was recorded, and every use verifies it
// again before the token is released, with the channel's own peer check (ssh checks the target's
// host key against the user's known_hosts; the dial daemon checks the server node's stable ID,
// which the invitation named, with WhoIs) and then the serverId the pairing established
// (entries.ts verifiedIdentity). An entry that fails that check fails its command, naming the
// entries and --via; Cove never tries another entry instead.
export function pairedRecord(
  alias: string,
  payload: InvitationPayload,
  result: PairingRedeemResult,
  via: Via | undefined,
  pairedAtMs: number = Date.now(),
): ServerRecord {
  const port = result.businessPort;
  const ssh = payload.entries.ssh ? { ssh: { target: payload.entries.ssh.target, port } } : {};
  const node = payload.entries.tsnet;
  const tsnet = node ? { tsnet: { nodeId: node.nodeId, name: node.name, port } } : {};
  const base = {
    version: 1 as const,
    alias,
    serverId: result.serverId,
    deviceId: result.deviceId,
    token: result.token,
    pairedAtMs,
  };
  // The pairing went through `via`, so the invitation has it (entries.ts openPairingEntry).
  if (via !== undefined && !payload.entries[via])
    throw new Error(`the invitation names no ${via} entry`);
  if (via !== undefined) return { ...base, defaultEntry: via, entries: { ...ssh, ...tsnet } };
  return { ...base, defaultEntry: "loopback", entries: { loopback: { port }, ...ssh, ...tsnet } };
}
