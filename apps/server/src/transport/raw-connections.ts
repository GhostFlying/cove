import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

// Bounds on the raw connections of the business listener (#156), applied before the HTTP parser
// or any admission sees a byte. local-admission.ts budgets requests (unauthenticated sockets,
// in-flight RPC, terminal WebSockets) only once their headers are parsed, so without these a peer
// holding incomplete headers could keep sockets, and file descriptors, open in any number. Since
// the tsnet node forwards tailnet connections into the same listener (network/tsnet.ts), that peer
// can be anyone the tailnet ACL lets reach the node, not only a local process.
//
// - `connections` caps every open socket of the listener, loopback and tsnet-forwarded alike;
// - `awaitingHeaders` caps the sockets that have not sent a complete request head: new ones, and
//   kept-alive ones between requests. When either cap is full, the socket that has waited longest
//   for headers is closed to make room. A legitimate client sends its head at once, so under a
//   flood of incomplete heads its new connection is the youngest and survives, while the oldest
//   holders are the ones closed; only when no socket awaits headers (every socket carries a
//   request or a WebSocket) is the new connection itself refused.
// - `headerDeadlineMs` closes a socket that has not completed a head within that time of being
//   accepted, or of its previous response ending (Fastify's keepAliveTimeout, entry/main.ts, ends
//   an idle kept-alive socket first; this deadline also covers one that started a head and
//   stalled). A request that runs long is not affected: its socket awaits nothing.
//
// Closing such a socket loses nothing: no request on it has been parsed, so none was accepted.
export const RAW_CONNECTION_BOUNDS = Object.freeze({
  connections: 128,
  awaitingHeaders: 64,
  headerDeadlineMs: 5_000,
});

export type RawConnectionBounds = {
  readonly connections: number;
  readonly awaitingHeaders: number;
  readonly headerDeadlineMs: number;
};

export class RawConnectionGate {
  private readonly open = new Set<Duplex>();
  // Sockets awaiting a request head, oldest first (Map keeps insertion order), with their
  // deadline timers.
  private readonly awaiting = new Map<Duplex, ReturnType<typeof setTimeout>>();
  private readonly requests = new Map<Duplex, number>();
  private readonly upgraded = new WeakSet<Duplex>();
  private refusedCount = 0;

  constructor(private readonly bounds: RawConnectionBounds = RAW_CONNECTION_BOUNDS) {}

  // Installs the gate on `server`. Its listeners run before every other listener of these events
  // (prependListener), so a socket over the cap is closed before the HTTP parser is attached.
  attach(server: Server): void {
    server.prependListener("connection", (socket: Duplex) => this.admit(socket));
    server.prependListener("request", (request: IncomingMessage, response: ServerResponse) =>
      this.started(request.socket, response),
    );
    server.prependListener("upgrade", (request: IncomingMessage) => {
      const socket = request.socket;
      this.upgraded.add(socket);
      this.received(socket);
    });
  }

  // Open sockets, sockets awaiting a head, and sockets refused or closed by the bounds so far.
  snapshot(): { open: number; awaitingHeaders: number; refused: number } {
    return {
      open: this.open.size,
      awaitingHeaders: this.awaiting.size,
      refused: this.refusedCount,
    };
  }

  private admit(socket: Duplex): void {
    if (this.open.has(socket) || socket.destroyed) return;
    if (this.open.size >= this.bounds.connections && !this.evictOldest()) {
      this.refusedCount++;
      socket.destroy();
      return;
    }
    this.open.add(socket);
    socket.once("close", () => {
      this.received(socket);
      this.open.delete(socket);
      this.requests.delete(socket);
    });
    this.await(socket);
  }

  // Closes the socket that has awaited a head longest; false when none awaits one.
  private evictOldest(): boolean {
    const oldest = this.awaiting.keys().next();
    if (oldest.done) return false;
    this.refusedCount++;
    this.received(oldest.value);
    // `close` (and so the slot in `open`) follows asynchronously; the slot is counted free now.
    this.open.delete(oldest.value);
    oldest.value.destroy();
    return true;
  }

  private await(socket: Duplex): void {
    if (this.awaiting.has(socket) || socket.destroyed) return;
    if (this.awaiting.size >= this.bounds.awaitingHeaders) this.evictOldest();
    const timer = setTimeout(() => {
      if (!this.awaiting.has(socket)) return;
      this.refusedCount++;
      this.received(socket);
      socket.destroy();
    }, this.bounds.headerDeadlineMs);
    timer.unref();
    this.awaiting.set(socket, timer);
  }

  private received(socket: Duplex): void {
    const timer = this.awaiting.get(socket);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.awaiting.delete(socket);
  }

  // A complete head: the socket awaits nothing until its last response ends. Requests are counted
  // because a pipelined head can be parsed before the previous response ended.
  private started(socket: Duplex, response: ServerResponse): void {
    if (!this.open.has(socket)) return;
    this.received(socket);
    this.requests.set(socket, (this.requests.get(socket) ?? 0) + 1);
    response.once("close", () => {
      const left = (this.requests.get(socket) ?? 1) - 1;
      if (left > 0) {
        this.requests.set(socket, left);
        return;
      }
      this.requests.delete(socket);
      if (this.open.has(socket) && !this.upgraded.has(socket)) this.await(socket);
    });
  }
}
