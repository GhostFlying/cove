import type { Duplex } from "node:stream";
import type { EntryKind } from "../auth/devices.js";

// Which entry a connection of the business or pairing listener came through (m2 D3, D10), and
// for a tsnet connection the tailnet peer WhoIs reported, for the device's last-use record and
// logs only; neither ever authorizes anything. The tsnet entry marks the connections its node
// forwards (network/tsnet.ts) before handing them over; every other connection was accepted on a
// loopback port. An SSH forward also arrives there, and the server cannot tell it apart, so it is
// recorded as loopback.
export type ConnectionPeer = { readonly stableNodeID: string | null; readonly name: string | null };

const ENTRIES = new WeakMap<object, { entry: EntryKind; peer: ConnectionPeer | null }>();

export function markEntry(
  socket: Duplex,
  entry: EntryKind,
  peer: ConnectionPeer | null = null,
): void {
  ENTRIES.set(socket, { entry, peer });
}

export function entryOf(socket: object | undefined | null): EntryKind {
  return (socket && ENTRIES.get(socket)?.entry) || "loopback";
}

export function peerOf(socket: object | undefined | null): ConnectionPeer | null {
  return (socket && ENTRIES.get(socket)?.peer) || null;
}
