import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import {
  BOOTSTRAP_VERSION,
  LOCAL_PATHS,
  negotiateBootstrap,
  validateWsFirstMessage,
  type AdmissionKind,
} from "@cove/protocol/bootstrap";
import { WS_CLOSE_CODES } from "@cove/protocol/errors";
import {
  createTerminalDecoder,
  validateTerminalFrame,
  MAX_FRAME_BYTES,
  type TerminalCommand,
} from "@cove/protocol/terminal";
import { sameConnectionRef, type ConnectionRef } from "@cove/protocol/identity";
import { TerminalConnectionDelivery } from "../terminal/terminal-connection-delivery.js";
import { TerminalCommandService } from "../terminal/terminal-command-service.js";
import { ControlArbiter } from "../terminal/control-arbiter.js";
import { actualHeaders, LocalAdmission, type LocalHeaders } from "./local-admission.js";
import type { LocalCore } from "./http-rpc.js";
import { encodeUtf8, sendHttpAdmissionFailure } from "./http-rpc.js";
import type { LocalTimer } from "../terminal/local-runtime-clock.js";

export interface LocalSocket {
  send(bytes: Uint8Array | string, callback: (error?: Error) => void): void;
  close(code: number): void;
  on(event: "message", callback: (bytes: Uint8Array, binary: boolean) => void): unknown;
  on(event: "close" | "error", callback: () => void): unknown;
}
type Claim = { release(): void };
const timers: LocalTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

// This handler is shared by the registered upgrade and passive lower-carrier tests.
export class TerminalWebSocket {
  readonly services = new Set<TerminalCommandService>();
  private readonly peers = new Set<{ close(): void }>();
  constructor(
    readonly admission: LocalAdmission,
    private readonly core: LocalCore,
    private readonly arbiter: ControlArbiter,
    private readonly now: () => number,
    private readonly timer: LocalTimer = timers,
  ) {}
  prepare(headers: LocalHeaders): { kind: AdmissionKind; claim?: Claim } {
    const kind = this.admission.upgrade(LOCAL_PATHS.terminal, headers);
    if (kind !== "accepted") return { kind };
    const claim = this.admission.claim("unauthenticated");
    return claim ? { kind, claim } : { kind: "busy" };
  }
  accept(socket: LocalSocket, unauthenticated: Claim): void {
    const decoder = createTerminalDecoder();
    let started: number;
    const connection: ConnectionRef = { connectionId: randomUUID(), generation: 1 };
    let authenticated: Claim | undefined;
    let service: TerminalCommandService | undefined;
    let retired = false;
    let physicallyClosed = false;
    let deadline: unknown;
    const close = (
      code: (typeof WS_CLOSE_CODES)[keyof typeof WS_CLOSE_CODES] = WS_CLOSE_CODES.protocol,
    ): void => {
      if (retired) return;
      retired = true;
      this.timer.clear(deadline);
      service?.close();
      try {
        socket.close(code);
      } catch {
        /* No physical-close proof from a failed close request. */
      }
    };
    const owner = { close };
    this.peers.add(owner);
    const closed = (): void => {
      if (physicallyClosed) return;
      physicallyClosed = true;
      retired = true;
      this.timer.clear(deadline);
      unauthenticated.release();
      authenticated?.release();
      service?.close();
      if (service) this.services.delete(service);
      this.peers.delete(owner);
    };
    socket.on("close", closed);
    socket.on("error", () => close());
    try {
      started = this.now();
    } catch {
      close();
      return;
    }
    deadline = this.timer.set(() => close(WS_CLOSE_CODES.policy), 5000);
    socket.on("message", (bytes, binary) => {
      if (retired || physicallyClosed) return;
      try {
        if (!authenticated) {
          if (binary) {
            close();
            return;
          }
          if (bytes.byteLength > this.admission.budgets.bootstrapBytes) {
            close(WS_CLOSE_CODES.size);
            return;
          }
          let input: unknown;
          try {
            input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } catch {
            close();
            return;
          }
          const secret =
            input && typeof input === "object" && "secret" in input
              ? (input as { secret: unknown }).secret
              : undefined;
          const elapsedMs = this.now() - started;
          const secretMatches = typeof secret === "string" && this.admission.verifies(secret);
          const request = validateWsFirstMessage(input, bytes.byteLength, elapsedMs, secretMatches);
          if (!request) {
            const version =
              input && typeof input === "object" && "bootstrapVersion" in input
                ? input.bootstrapVersion
                : undefined;
            // Probe the auth/shape guard; negotiate the untouched version below.
            const unsupportedVersion =
              typeof version === "number" &&
              Number.isSafeInteger(version) &&
              version > 0 &&
              version !== BOOTSTRAP_VERSION &&
              validateWsFirstMessage(
                { ...(input as Record<string, unknown>), bootstrapVersion: BOOTSTRAP_VERSION },
                bytes.byteLength,
                elapsedMs,
                secretMatches,
              ) !== null;
            if (!unsupportedVersion) {
              close(WS_CLOSE_CODES.policy);
              return;
            }
          }
          const result = negotiateBootstrap(
            request ?? input,
            {
              ...this.admission.identity,
              buildVersion: this.core.buildVersion,
              effectiveBudgets: this.admission.budgets,
            },
            connection,
          );
          if (result.type !== "cove-bootstrap-result") {
            socket.send(JSON.stringify(result), () => close());
            close();
            return;
          }
          const claim = this.admission.claim("authenticated");
          if (!claim) {
            close(WS_CLOSE_CODES.capacity);
            return;
          }
          authenticated = claim;
          const delivery = new TerminalConnectionDelivery(this.core.runtime.composition, {
            connection,
            encodeUtf8,
            itemLimit:
              this.admission.budgets.postNEvents + this.admission.budgets.pendingWorkerCommands + 4,
            transport: {
              write: (raw, settled) => {
                let owned = true;
                socket.send(raw, (error) => {
                  if (!owned) return;
                  owned = false;
                  settled(error);
                  if (!error) delivery.drain();
                });
                return false;
              },
            },
            failed: () => close(),
          });
          try {
            service = new TerminalCommandService(
              this.core.runtime.composition,
              this.core.runtime,
              delivery,
              this.arbiter,
              {
                createOpaqueId: randomUUID,
                now: this.now,
                identityLimit: 4096,
                requestLimit: 4096,
              },
            );
          } catch {
            delivery.close();
            close(WS_CLOSE_CODES.capacity);
            return;
          }
          unauthenticated.release();
          this.timer.clear(deadline);
          this.services.add(service);
          socket.send(JSON.stringify(result), (error) => {
            if (error) close();
          });
          return;
        }
        if (!binary) {
          close();
          return;
        }
        if (bytes.byteLength > MAX_FRAME_BYTES) {
          close(WS_CLOSE_CODES.size);
          return;
        }
        let offset = 0;
        while (offset < bytes.byteLength && !retired) {
          const decoded = decoder.read(bytes.subarray(offset));
          if (decoded.status === "error" || decoded.consumedBytes === 0) {
            close();
            return;
          }
          offset += decoded.consumedBytes;
          for (const frame of decoded.frames) {
            if (retired) break;
            let metadata: unknown;
            try {
              metadata = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(frame.metadata),
              );
            } catch {
              close();
              break;
            }
            const parsed = validateTerminalFrame(frame, metadata, connection);
            if (!parsed.ok || frame.kind !== 1) {
              close();
              break;
            }
            if (
              parsed.value.type === "attach" &&
              !sameConnectionRef(parsed.value.connection, connection)
            ) {
              close();
              break;
            }
            void service!
              .handle(parsed.value as TerminalCommand, frame.payload)
              .catch(() => close());
          }
        }
      } catch {
        close();
      }
    });
  }
  close(): void {
    for (const peer of [...this.peers]) peer.close();
  }
}

export function registerTerminalWebSocket(app: FastifyInstance, terminal: TerminalWebSocket): void {
  const claims = new WeakMap<FastifyRequest, Claim>();
  app.get(
    LOCAL_PATHS.terminal,
    {
      websocket: true,
      onRequest: (request, reply, done) => {
        const result = terminal.prepare(actualHeaders(request.headers, request.raw.rawHeaders));
        if (!result.claim) {
          sendHttpAdmissionFailure(reply, result.kind);
          return;
        }
        claims.set(request, result.claim);
        request.raw.once("aborted", () => result.claim!.release());
        done();
      },
      onResponse: (request, _reply, done) => {
        claims.get(request)?.release();
        claims.delete(request);
        done();
      },
    },
    (socket, request) => {
      const claim = claims.get(request);
      claims.delete(request);
      if (!claim) {
        socket.close(WS_CLOSE_CODES.capacity);
        return;
      }
      terminal.accept(
        {
          send: (bytes, callback) => socket.send(bytes, callback),
          close: (code) => socket.close(code),
          on: (event, callback) => {
            if (event === "message")
              return socket.on("message", (raw, binary) => {
                const bytes = Array.isArray(raw)
                  ? Buffer.concat(raw)
                  : raw instanceof ArrayBuffer
                    ? new Uint8Array(raw)
                    : raw;
                (callback as (bytes: Uint8Array, binary: boolean) => void)(bytes, binary);
              });
            return socket.on(event, callback as () => void);
          },
        },
        claim,
      );
    },
  );
}
