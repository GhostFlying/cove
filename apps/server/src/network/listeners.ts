import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import type { DomainError } from "@cove/protocol/errors";
import { installedClosureRoot, workspaceRootOf } from "../build-id.js";
import { createTsnetEntry } from "./tsnet.js";
import type { ConnectionPeer } from "../transport/connection-entry.js";

// The server's entries (m2 D3, D9, D10): every way a client reaches this server. SSH needs no
// listener of its own: it forwards to the loopback ports (D3).
//
// - loopback business port: the M0/M1 HTTP RPC and terminal WebSocket listener, on the fixed
//   port of the entry configuration (or a free one when none is configured);
// - pairing port: the listener of auth/service.ts, open only while an invitation is open (D6);
// - tsnet: the server's own Tailnet node (network/tsnet.ts, T5b), which forwards connections for
//   the business and pairing ports to this process.
//
// The set fixes their order. Start: business first, because a redemption answers with the bound
// business port and the tsnet node forwards to it; then pairing (reopened when invitations survived
// a restart, S12); then tsnet. A pairing port or tsnet node that cannot start is logged and leaves
// the business entry serving: losing one entry must not stop a server whose PTYs are fine. Close:
// the reverse, so no entry forwards to a listener that is already gone.
//
// Each entry kind is its own module; T5b replaces network/tsnet.ts and does not change this set.

// What the tsnet entry is given when the server starts (T5b's contract with this set).
export type TsnetEntryContext = {
  // The data directory; the node keeps its state under it.
  readonly home: string;
  // entry configuration tsnetHostname as read at start (null: the default, `cove-<host name>`).
  readonly hostname: string | null;
  readonly buildVersion: string;
  // The `cove-tsnet` executable of this build (tsnetBinaryPath), or null when there is none.
  readonly binary: string | null;
  readonly businessPort: number;
  // The pairing listener's port while it is open.
  pairingPort(): number | undefined;
  // Hands a connection the node accepted on the business port to the business server, which
  // then applies the same raw bounds and admission as to a loopback connection. `peer` is what
  // WhoIs reported (display and audit only; transport/connection-entry.ts).
  acceptBusiness(socket: Duplex, peer: ConnectionPeer | null): void;
  // The same for the pairing port, while the pairing listener is open (closed otherwise).
  acceptPairing(socket: Duplex, peer: ConnectionPeer | null): void;
  // Registers the node's port sync: called, and awaited, each time the pairing listener opens or
  // closes, before an invitation for the new port is created (D6; network/tsnet.ts "Ports").
  onPairingPortChange(listener: () => Promise<void>): void;
  log(event: Record<string, unknown>): void;
};

// What an invitation advertises for the tsnet entry (InvitationPayloadSchema entries.tsnet).
export type TsnetInvitationEntry = { readonly nodeId: string; readonly name: string };

export interface TsnetEntry {
  readonly kind: "tsnet";
  // Resolves once the node is started (it may still be restoring), or with the reason it is not
  // (ENTRY_UNAVAILABLE).
  start(context: TsnetEntryContext): Promise<{ error: DomainError } | void>;
  close(): Promise<void>;
}

// The business listener (the Fastify application of entry/main.ts).
export type BusinessListener = {
  listen(options: { host: string; port: number }): Promise<unknown>;
  readonly server: Server;
  close(): Promise<unknown>;
};

// The pairing listener's owner (auth/service.ts AuthService).
export type PairingEntry = {
  start(businessPort: number): Promise<void>;
  readonly pairingPort: number | undefined;
  // A connection the tsnet node accepted on the pairing port.
  accept?(socket: Duplex): void;
  // See TsnetEntryContext onPairingPortChange.
  onPortChange?(listener: () => Promise<void>): void;
  dispose(): Promise<void>;
};

// Where this build's `cove-tsnet` is: `bin/cove-tsnet` of an installed closure (D1), else the
// output of `pnpm tsnet:build` in the workspace this server was built in. Null when neither exists:
// the tsnet entry is then unavailable, the other entries are not affected.
export function tsnetBinaryPath(): string | null {
  const closure = installedClosureRoot();
  if (closure) {
    const installed = join(closure, "bin", "cove-tsnet");
    return existsSync(installed) ? installed : null;
  }
  const root = workspaceRootOf();
  if (!root) return null;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const built = join(
    root,
    "native",
    "tailscale",
    "dist",
    `${process.platform}-${arch}`,
    "cove-tsnet",
  );
  return existsSync(built) ? built : null;
}

export class ListenerSet {
  private readonly tsnet: TsnetEntry;
  private boundPort: number | undefined;
  private closing: Promise<boolean> | undefined;

  constructor(
    private readonly parts: {
      host: "127.0.0.1" | "::1";
      // 0: a free port.
      businessPort: number;
      business: BusinessListener;
      pairing?: PairingEntry;
      tsnet: Omit<
        TsnetEntryContext,
        "businessPort" | "pairingPort" | "acceptBusiness" | "acceptPairing" | "onPairingPortChange"
      >;
      // The tsnet entry; by default this build's (network/tsnet.ts).
      tsnetEntry?: TsnetEntry;
      log: (event: Record<string, unknown>) => void;
    },
  ) {
    this.tsnet = parts.tsnetEntry ?? createTsnetEntry();
  }

  get businessPort(): number | undefined {
    return this.boundPort;
  }

  // Binds the business port and resolves with it; `bound` runs before any other entry opens (the
  // admission must know its authority before a forwarded connection can arrive).
  async start(bound: (port: number) => void): Promise<number> {
    const { business, host } = this.parts;
    await business.listen({ host, port: this.parts.businessPort });
    const address = business.server.address();
    if (!address || typeof address === "string" || address.address !== host)
      throw new Error("Invalid numeric local bind");
    this.boundPort = address.port;
    bound(address.port);
    await this.parts.pairing?.start(address.port);
    const started = await this.tsnet.start({
      ...this.parts.tsnet,
      businessPort: address.port,
      pairingPort: () => this.parts.pairing?.pairingPort,
      acceptBusiness: (socket) => business.server.emit("connection", socket),
      acceptPairing: (socket) =>
        this.parts.pairing?.accept ? this.parts.pairing.accept(socket) : socket.destroy(),
      onPairingPortChange: (listener) => this.parts.pairing?.onPortChange?.(listener),
    });
    // The placeholder (and a host without cove-tsnet) is simply not an entry; anything else is
    // worth a log line. The business entry keeps serving either way.
    if (started && started.error.kind !== "ENTRY_UNAVAILABLE")
      this.parts.log({ event: "entry-unavailable", entry: "tsnet", kind: started.error.kind });
    return address.port;
  }

  // Closes every entry, tsnet first; resolves false when one of them failed to close.
  close(): Promise<boolean> {
    return (this.closing ??= (async () => {
      let ok = true;
      for (const step of [
        () => this.tsnet.close(),
        () => this.parts.business.close(),
        // The pairing listener closes with the business listener; pending last-use writes settle
        // before the store closes.
        () => this.parts.pairing?.dispose(),
      ])
        try {
          await step();
        } catch {
          ok = false;
        }
      return ok;
    })());
  }
}
