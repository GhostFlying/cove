import { createServer, type Server, type Socket } from "node:net";
import type { InvitationPayload } from "@cove/protocol/auth";
import type { ConnectionRecord } from "./connection-types.js";
import { RemoteError, type OpenedEntry } from "./entry-types.js";
import {
  Channel,
  ChannelBroken,
  DaemonUnavailable,
  DialError,
  type TsnetDaemon,
  printable,
} from "./tsnet-daemon.js";

// The tsnet entry (m2 D9, D14): this client's own tailnet node, run by the per-user
// `cove-tsnet dial` daemon (tsnet-daemon.ts), reaches the server's tailnet node.
//
// Peer check. Every stream is requested for the server node's stable ID recorded at pairing (the
// invitation's), never a name. The daemon resolves that ID in its netmap, connects, and keeps the
// connection only if WhoIs on the connected address reports the same stable ID; otherwise it
// refuses the stream (PEER_MISMATCH) and nothing is forwarded. The CLI also checks the peer the
// daemon reports. A stream that passed is the channel's peer check, as the host key is for SSH;
// entries.ts verifiedIdentity checks the serverId over it next, and only then is the token (or the
// invitation secret) sent.
//
// Endpoint. The client packages speak HTTP and WebSocket to an origin, so the entry is a listener
// on 127.0.0.1 whose every accepted connection is bridged to a new stream (each HTTP request and
// each terminal WebSocket is one connection). The server accepts any loopback literal as Host
// (user decision 2026-10-22), so bytes pass unchanged. Stream handoff: the stream's bytes are
// forwarded only after the daemon's dial answer was read and the peer checked; until then the
// bytes the local client already wrote stay in the local socket, and a failed dial sends nothing.
// The first stream is opened while the entry opens, so that a failure (not logged in, peer not
// found, PEER_MISMATCH, the node held after an identity change) is reported with its reason and
// before anything is sent; the first local connection uses it. A stream for a later connection
// can fail for the same reasons (the node was held, or the address now answers as another node);
// that connection is closed with nothing forwarded, and the reason is kept as the entry's
// failure(), which a failing command adds to its error.
//
// Retries. Opening a stream retries only what happens before the stream exists: the daemon start
// loop (tsnet-daemon.ts), and a dial refused with SHUTTING_DOWN (the daemon was stopping; nothing
// was dialed), within one deadline. Once bytes flow, a broken stream is a broken connection for
// the client, which never repeats a request on its own (M1 operation records).
//
// The tailnet port is the one the record names (the business port, which the server's tailnet node
// serves at the same number as its loopback port), and for pairing the invitation's pairing port.

const DIAL_TIMEOUT_MS = 15_000;
const DIAL_ANSWER_MARGIN_MS = 5_000;
const OPEN_DEADLINE_MS = 10_000;
// What a failed stream for a later connection did not send: that connection's request. Earlier
// requests of the command went over their own streams.
const LATER_UNSENT = "the request on that connection was not sent";

type Target = {
  readonly nodeId: string;
  readonly port: number;
  // Shown in the daemon's stream list (`remote tsnet status`, a refused logout); at most 64 bytes.
  readonly label: string;
};

type Stream = { readonly socket: Socket; readonly first: Buffer };

// A verified stream waiting for its local connection: the raw socket after the dial answer and
// the peer check, until splice() takes it over. Ownership passes in two explicit steps, and the
// socket always has an error listener: the Channel's until detach(), this one's from detach()
// to claim(), and splice()'s after that. Without it, a reset in the window (the first stream
// waits for the client's first request; a later one for a promise turn) would be an unhandled
// 'error' that crashes the CLI. A stream that failed while it waited is claimed as an error;
// nothing was forwarded on it.
export class PendingStream {
  private failure: Error | undefined;
  private readonly onError = (error: Error) => {
    this.failure ??= error;
    this.socket.destroy();
  };

  constructor(
    private readonly socket: Socket,
    private readonly first: Buffer,
  ) {
    socket.on("error", this.onError);
  }

  // Detaches the verified stream from `channel` and holds it, in one synchronous step.
  static detach(channel: Channel): PendingStream {
    const first = channel.detach();
    return new PendingStream(channel.socket, first);
  }

  // Hands the stream over to its new owner, which must attach its own error listener before it
  // yields. Throws (and destroys the stream) when it failed or closed while it waited.
  claim(): Stream {
    this.socket.off("error", this.onError);
    if (this.failure || this.socket.destroyed) {
      this.socket.destroy();
      const cause = this.failure as NodeJS.ErrnoException | undefined;
      throw new Error(
        `the stream ended before it was used (${printable(cause?.code ?? cause?.message ?? "closed", 64)})`,
      );
    }
    return { socket: this.socket, first: this.first };
  }

  discard(): void {
    this.socket.destroy();
  }
}

function label(text: string): string {
  return Buffer.from(text, "utf8").subarray(0, 64).toString("utf8").replace(/�$/, "");
}

// Why a dial failed, for the operator.
function dialFailure(error: DialError, target: Target): string {
  const node = `server node ${target.nodeId}`;
  switch (error.code) {
    case "NOT_LOGGED_IN":
      return "this client's tsnet node is not logged in (`cove remote tsnet login`)";
    case "IDENTITY_CHANGED":
    case "LOGIN_UNCERTAIN":
      return (
        `this client's tsnet node is held after a login (${error.code}: ${error.detail}); ` +
        "see `cove remote tsnet status`"
      );
    case "PEER_NOT_FOUND":
      return `no node with the stable ID of ${node} is visible on this client's tailnet`;
    case "PEER_MISMATCH":
      return (
        `the tailnet address of ${node} answered as another node (PEER_MISMATCH: ${error.detail}); ` +
        "the stream was refused"
      );
    case "DIAL_FAILED":
      return `${node} did not accept a connection on port ${target.port} (${error.detail})`;
    default:
      return `the tsnet dial daemon refused the stream (${error.code}: ${error.detail})`;
  }
}

// One verified stream to `target`, held until it is claimed: the raw socket after the daemon's
// answer, with the stream bytes that came with the answer. Throws RemoteError; nothing was sent to
// the server then.
export interface TsnetEntries {
  openTsnetEntry(record: ConnectionRecord, home: string): Promise<OpenedEntry>;
  openTsnetPairing(payload: InvitationPayload, home: string): Promise<OpenedEntry>;
}

export function createTsnetEntries(daemon: TsnetDaemon): TsnetEntries {
  async function openStream(home: string, target: Target, unsent: string): Promise<PendingStream> {
    const deadline = Date.now() + OPEN_DEADLINE_MS;
    for (;;) {
      let channel: Channel;
      try {
        ({ channel } = await daemon.openDaemon(home, { deadline }));
      } catch (error) {
        if (error instanceof DaemonUnavailable)
          throw new RemoteError("ENTRY_UNAVAILABLE", `${error.message}; ${unsent}`);
        throw error;
      }
      let answer: unknown;
      try {
        answer = await channel.request(
          {
            op: "dial",
            target: { stableNodeID: target.nodeId },
            port: target.port,
            label: target.label,
            timeoutMs: DIAL_TIMEOUT_MS,
          },
          DIAL_TIMEOUT_MS + DIAL_ANSWER_MARGIN_MS,
        );
      } catch (error) {
        channel.close();
        // The daemon was stopping (a concurrent `remote tsnet stop`) and dialed nothing, or the
        // connection ended before an answer: no stream bytes were forwarded either way, so the
        // stream may be requested again while the deadline lasts.
        const again =
          (error instanceof DialError && error.code === "SHUTTING_DOWN") ||
          error instanceof ChannelBroken;
        if (again && Date.now() < deadline) continue;
        if (error instanceof DialError)
          throw new RemoteError("ENTRY_UNAVAILABLE", `${dialFailure(error, target)}; ${unsent}`);
        throw new RemoteError(
          "ENTRY_UNAVAILABLE",
          `the tsnet dial daemon did not answer the stream request; ${unsent}`,
        );
      }
      const peer = (answer as { peer?: { stableNodeID?: unknown } } | null)?.peer?.stableNodeID;
      if (peer !== target.nodeId) {
        channel.close();
        throw new RemoteError(
          "ENTRY_UNAVAILABLE",
          `the tsnet dial daemon reported peer ${printable(peer, 64)} for server node ` +
            `${target.nodeId}; the stream was refused; ${unsent}`,
        );
      }
      return PendingStream.detach(channel);
    }
  }

  // Joins a local connection and a stream, half-closes included: each side's end is passed on, and
  // a side that fails or fully closes ends the other.
  function splice(local: Socket, stream: Stream): void {
    const remote = stream.socket;
    if (stream.first.length) local.write(stream.first);
    local.pipe(remote);
    remote.pipe(local);
    remote.resume();
    const destroyBoth = () => {
      local.destroy();
      remote.destroy();
    };
    local.on("error", destroyBoth);
    remote.on("error", destroyBoth);
    local.on("close", () => remote.destroy());
    remote.on("close", () => {
      if (!local.destroyed) local.end();
    });
  }

  async function openBridge(home: string, target: Target, unsent: string): Promise<OpenedEntry> {
    let pending: PendingStream | undefined = await openStream(home, target, unsent);
    const sockets = new Set<Socket>();
    // The latest failure of a stream for a later connection. The client sees only that connection
    // close, so the reason (an identity hold, PEER_MISMATCH, the daemon gone) is kept for the
    // command's own error (entry-types.ts withEntryFailure).
    let failure: RemoteError | undefined;
    const failed = (error: unknown) => {
      const reason =
        error instanceof RemoteError
          ? error.detail
          : `the stream to server node ${target.nodeId}: ` +
            `${error instanceof Error ? error.message : String(error)}; ${LATER_UNSENT}`;
      failure = new RemoteError(
        "ENTRY_UNAVAILABLE",
        `the tsnet entry refused a later connection: ${reason}`,
      );
    };
    const server: Server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (local) => {
      sockets.add(local);
      local.on("close", () => sockets.delete(local));
      local.on("error", () => local.destroy());
      const ready = pending;
      pending = undefined;
      // A later connection gets its own stream. If that fails, or a held stream failed while it
      // waited, nothing is forwarded and the local connection is closed, which the client reports
      // as a failed request; the reason is kept in `failure`.
      (ready ? Promise.resolve(ready) : openStream(home, target, LATER_UNSENT)).then(
        (held) => {
          if (local.destroyed) {
            held.discard();
            return;
          }
          let stream: Stream;
          try {
            stream = held.claim();
          } catch (error) {
            failed(error);
            local.destroy();
            return;
          }
          // claim() and splice() run in one synchronous step: the stream is never without an
          // error listener.
          sockets.add(stream.socket);
          stream.socket.on("close", () => sockets.delete(stream.socket));
          splice(local, stream);
          local.resume();
        },
        (error: unknown) => {
          failed(error);
          local.destroy();
        },
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
    } catch {
      pending?.discard();
      throw new RemoteError(
        "ENTRY_UNAVAILABLE",
        `cannot open a local port for the tsnet entry; ${unsent}`,
      );
    }
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
      kind: "tsnet",
      endpoint: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          pending?.discard();
          pending = undefined;
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
      failure: () => failure,
    };
  }

  // The tsnet entry of a paired server: streams to its recorded node and business port.
  async function openTsnetEntry(record: ConnectionRecord, home: string): Promise<OpenedEntry> {
    const entry = record.entries.tsnet;
    if (!entry)
      throw new RemoteError(
        "ENTRY_UNAVAILABLE",
        `${record.alias} has no tsnet entry; nothing was sent`,
      );
    return openBridge(
      home,
      {
        nodeId: entry.nodeId,
        port: entry.port,
        label: label(`${record.alias} (cove pid ${process.pid})`),
      },
      "nothing was sent",
    );
  }

  // The pairing listener of an invitation over tsnet: streams to the invitation's server node and
  // pairing port.
  async function openTsnetPairing(payload: InvitationPayload, home: string): Promise<OpenedEntry> {
    const entry = payload.entries.tsnet;
    if (!entry)
      throw new RemoteError(
        "ENTRY_UNAVAILABLE",
        "the invitation names no tsnet entry; the invitation was not sent",
      );
    return openBridge(
      home,
      {
        nodeId: entry.nodeId,
        port: payload.pairingPort,
        label: label(`pairing (cove pid ${process.pid})`),
      },
      "the invitation was not sent",
    );
  }

  return { openTsnetEntry, openTsnetPairing };
}
