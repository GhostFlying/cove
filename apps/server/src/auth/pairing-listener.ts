import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  PAIRING_LIMITS,
  PAIRING_PATHS,
  PairingRedeemRequestSchema,
  type PairingFailure,
  type PairingRedeemRequest,
  type PairingRedeemResult,
} from "@cove/protocol/auth";
import { bootstrapIdentity, isLoopbackLiteralHost } from "@cove/protocol/bootstrap";

// The pairing listener (m2 D6): a separate loopback port that exists only while an invitation is
// open. It is reachable before authentication, so it is small and bounded on purpose:
// - two POST paths (PAIRING_PATHS), bodies of at most PAIRING_LIMITS.requestBytes, a short
//   request deadline and a connection cap;
// - the M0 browser defenses: the Host must be a loopback IP literal (no DNS rebinding; any port, so
//   an SSH -L forward's local port is accepted, user decision 2026-10-22) and a request that
//   carries an Origin or Sec-Fetch metadata (a browser) is refused;
// - a global limit on redemption attempts across all invitations, beside the per-invitation
//   wrong-secret limit the store enforces;
// - fixed answers that never echo the request, so a secret sent here cannot come back in an
//   error. The only secret in any answer is the issued token of a successful redemption.

export const PAIRING_BOUNDS = Object.freeze({
  connections: 8,
  requestTimeoutMs: 5_000,
  // Redemption attempts per window, over every invitation.
  attempts: 20,
  attemptWindowMs: 60_000,
});

export type PairingHandlers = {
  identity(): { serverId: string; relayInstanceId: string; buildVersion: string };
  redeem(request: PairingRedeemRequest): Promise<PairingRedeemResult | PairingFailure>;
};

const STATUS: Record<PairingFailure["kind"], number> = {
  INVITATION_UNAVAILABLE: 403,
  BUSY: 429,
  INVALID_ARGUMENT: 400,
};

function failure(kind: PairingFailure["kind"]): PairingFailure {
  return { type: "cove-pairing-error", kind };
}

export class PairingListener {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private attempts: number[] = [];
  private boundPort: number | undefined;

  constructor(
    private readonly host: "127.0.0.1" | "::1",
    private readonly handlers: PairingHandlers,
    private readonly now: () => number = Date.now,
  ) {}

  get port(): number | undefined {
    return this.server ? this.boundPort : undefined;
  }

  // Starts listening on `port` (0: any free port); resolves with the bound port.
  async open(port: number): Promise<number> {
    if (this.server && this.boundPort !== undefined) return this.boundPort;
    const server = createServer({ requestTimeout: PAIRING_BOUNDS.requestTimeoutMs }, (req, res) =>
      this.serve(req, res),
    );
    server.maxConnections = PAIRING_BOUNDS.connections;
    server.headersTimeout = PAIRING_BOUNDS.requestTimeoutMs;
    server.keepAliveTimeout = 1_000;
    server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    // Never let a malformed request reach the default handler, which would describe it.
    server.on("clientError", (_error, socket: Socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: this.host, port, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string" || address.address !== this.host) {
      server.close();
      throw new Error("Invalid pairing listener bind");
    }
    this.server = server;
    this.boundPort = address.port;
    return address.port;
  }

  // Stops listening at once, so the port no longer accepts connections; a request already being
  // answered (the redemption that ended the last invitation) still gets its answer. Idle
  // connections are dropped, and anything left open is destroyed after the request deadline.
  close(): void {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.boundPort = undefined;
    server.close();
    server.closeIdleConnections();
    const sockets = [...this.sockets];
    setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, PAIRING_BOUNDS.requestTimeoutMs).unref();
  }

  // Destroys every connection now (server shutdown).
  dispose(): void {
    this.close();
    for (const socket of this.sockets) socket.destroy();
  }

  private allowedAttempt(): boolean {
    const at = this.now();
    this.attempts = this.attempts.filter((time) => at - time < PAIRING_BOUNDS.attemptWindowMs);
    if (this.attempts.length >= PAIRING_BOUNDS.attempts) return false;
    this.attempts.push(at);
    return true;
  }

  private serve(req: IncomingMessage, res: ServerResponse): void {
    const send = (status: number, body: unknown): void => {
      if (res.writableEnded || res.destroyed) return;
      const text = JSON.stringify(body);
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        "Cache-Control": "no-store",
      });
      res.end(text);
    };
    const path = req.url;
    if (
      req.method !== "POST" ||
      (path !== PAIRING_PATHS.identity && path !== PAIRING_PATHS.redeem) ||
      !isLoopbackLiteralHost(req.headers.host ?? "") ||
      req.headers.origin !== undefined ||
      req.headers["sec-fetch-mode"] !== undefined ||
      req.headers["sec-fetch-site"] !== undefined
    ) {
      req.resume();
      send(403, failure("INVALID_ARGUMENT"));
      return;
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > PAIRING_LIMITS.requestBytes) {
      req.resume();
      send(413, failure("INVALID_ARGUMENT"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > PAIRING_LIMITS.requestBytes) {
        if (!refused) send(413, failure("INVALID_ARGUMENT"));
        refused = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => res.destroy());
    req.on("end", () => {
      if (refused) return;
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        send(400, failure("INVALID_ARGUMENT"));
        return;
      }
      if (path === PAIRING_PATHS.identity) {
        const identity = bootstrapIdentity(body, this.handlers.identity());
        send(identity.type === "cove-bootstrap-identity" ? 200 : 400, identity);
        return;
      }
      const request = PairingRedeemRequestSchema.safeParse(body);
      if (!request.success) {
        send(400, failure("INVALID_ARGUMENT"));
        return;
      }
      if (!this.allowedAttempt()) {
        send(429, failure("BUSY"));
        return;
      }
      this.handlers.redeem(request.data).then(
        (answer) =>
          answer.type === "cove-pairing-result"
            ? send(200, answer)
            : send(STATUS[answer.kind], failure(answer.kind)),
        () => send(429, failure("BUSY")),
      );
    });
  }
}
