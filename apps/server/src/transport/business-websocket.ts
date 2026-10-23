import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  BOOTSTRAP_VERSION,
  LOCAL_PATHS,
  bootstrapFailure,
  negotiateBootstrap,
  validateWsFirstMessage,
  type AdmissionKind,
} from "@cove/protocol/bootstrap";
import {
  BUSINESS_EVENT_CAPABILITY,
  BUSINESS_LIMITS,
  BusinessSubscribeSchema,
  type BusinessFrame,
  type BusinessRecord,
  type BusinessSubscribe,
} from "@cove/protocol/business-events";
import { WS_CLOSE_CODES } from "@cove/protocol/errors";
import type { EntryKind } from "../auth/devices.js";
import type { BusinessSnapshots } from "../business/snapshot.js";
import type { LocalCore } from "../rpc/context.js";
import { actualHeaders, type LocalAdmission, type LocalHeaders } from "./local-admission.js";
import { originFormTarget, sendHttpAdmissionFailure } from "./http-rpc.js";
import { entryOf } from "./connection-entry.js";
import type { LocalSocket } from "./terminal-websocket.js";

type Claim = { release(): void };
type Queued = { text: string; bytes: number };

// Independent business WS. A single send is in flight; later live frames have both byte and
// item bounds. During snapshot delivery live changes wait in that same bounded queue, while
// the snapshot retains one explicitly capped lease and sends pages one at a time.
export class BusinessWebSocket {
  private readonly peers = new Set<{ close(): void }>();
  constructor(
    readonly admission: LocalAdmission,
    private readonly core: LocalCore,
    private readonly snapshots: BusinessSnapshots | undefined,
    private readonly now: () => number,
  ) {}
  prepare(headers: LocalHeaders): { kind: AdmissionKind; claim?: Claim } {
    const kind = this.admission.upgrade(LOCAL_PATHS.events, headers);
    if (kind !== "accepted") return { kind };
    const claim = this.admission.claim("unauthenticated");
    return claim ? { kind, claim } : { kind: "busy" };
  }
  accept(socket: LocalSocket, unauthenticated: Claim, entry: EntryKind): void {
    let retired = false;
    let ending = false;
    let physicallyClosed = false;
    let authenticated: Claim | undefined;
    let confirming = false;
    let subscribing = false;
    let snapshotting = false;
    let pumping = false;
    let subscription: { dispose(): void } | undefined;
    let releaseSnapshot: (() => void) | undefined;
    let pendingSend: ((error?: Error) => void) | undefined;
    const queue: Queued[] = [];
    let queuedBytes = 0;
    const started = this.now();
    let markClosed!: () => void;
    const physicallyDone = new Promise<void>((done) => {
      markClosed = done;
    });
    const close = (code: number = WS_CLOSE_CODES.protocol): void => {
      if (retired) return;
      retired = true;
      clearTimeout(deadline);
      subscription?.dispose();
      queue.length = 0;
      queuedBytes = 0;
      pendingSend?.(new Error("Business connection closed"));
      releaseSnapshot?.();
      releaseSnapshot = undefined;
      try {
        socket.close(code);
      } catch {
        /* Physical close remains unverified. */
      }
    };
    const peer = { close };
    this.peers.add(peer);
    const deadline = setTimeout(() => close(WS_CLOSE_CODES.policy), 5000);
    socket.on("close", () => {
      if (physicallyClosed) return;
      physicallyClosed = true;
      close();
      markClosed();
      unauthenticated.release();
      authenticated?.release();
      this.peers.delete(peer);
    });
    socket.on("error", () => close());
    const write = (text: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (retired) {
          reject(new Error("Business connection closed"));
          return;
        }
        if (Buffer.byteLength(text) > BUSINESS_LIMITS.frameBytes) {
          reject(new Error("Business frame too large"));
          return;
        }
        let settled = false;
        const timer = setTimeout(
          () => finish(new Error("Business send timed out")),
          BUSINESS_LIMITS.progressTimeoutMs,
        );
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pendingSend = undefined;
          if (error) reject(error);
          else resolve();
        };
        pendingSend = finish;
        try {
          socket.send(text, (error) => finish(error ?? undefined));
        } catch {
          finish(new Error("Business send failed"));
        }
      });
    const pump = async () => {
      if (pumping || snapshotting || retired || ending) return;
      pumping = true;
      try {
        while (queue.length > 0 && !retired && !ending) {
          const next = queue.shift()!;
          queuedBytes -= next.bytes;
          await write(next.text);
        }
      } catch {
        close();
      } finally {
        pumping = false;
      }
    };
    const fail = (frame: Extract<BusinessFrame, { type: "reset" | "error" }>) => {
      if (retired || ending) return;
      ending = true;
      subscription?.dispose();
      queue.length = 0;
      queuedBytes = 0;
      // A reset is best effort if a send is already stalled. Closing is itself explicit loss
      // of currency: the caller must not call an unreceived snapshot-end a complete view.
      if (pendingSend) {
        close(WS_CLOSE_CODES.capacity);
        return;
      }
      void write(JSON.stringify(frame))
        .finally(() => close(WS_CLOSE_CODES.capacity))
        .catch(() => undefined);
    };
    const enqueue = (frame: BusinessFrame) => {
      if (retired || ending) return;
      if (frame.type === "reset" || frame.type === "error") {
        fail(frame);
        return;
      }
      const text = JSON.stringify(frame);
      const bytes = Buffer.byteLength(text);
      if (
        bytes > BUSINESS_LIMITS.frameBytes ||
        queue.length >= BUSINESS_LIMITS.queueItems ||
        queuedBytes + bytes > BUSINESS_LIMITS.queueBytes
      ) {
        fail({ type: "reset", reason: "overflow" });
        return;
      }
      queue.push({ text, bytes });
      queuedBytes += bytes;
      void pump();
    };
    const start = async (request: BusinessSubscribe) => {
      const snapshots = this.snapshots;
      if (!snapshots) {
        fail({ type: "error", reason: "unavailable" });
        return;
      }
      snapshotting = true;
      try {
        const captured = request.since ? undefined : await snapshots.capture(request.filter);
        if (retired || ending) {
          if (captured && "release" in captured) captured.release();
          return;
        }
        if (captured && "error" in captured) {
          fail({ type: "error", reason: captured.error });
          return;
        }
        if (captured) releaseSnapshot = captured.release;
        const since = request.since ?? captured!.cursor;
        const attached = snapshots.stream.subscribe(request.filter, since, enqueue);
        if (typeof attached === "string") {
          fail(
            attached === "busy"
              ? { type: "error", reason: "busy" }
              : { type: "reset", reason: attached },
          );
          return;
        }
        subscription = attached;
        if (retired || ending) {
          subscription.dispose();
          return;
        }
        // Ready follows replay through this exact synchronous subscription watermark. Changes
        // arriving while pages are handed off enqueue after it, preserving order.
        enqueue({ type: "ready", cursor: snapshots.stream.cursor(request.filter) });
        if (captured) {
          const snapshotId = randomUUID();
          await write(JSON.stringify({ type: "snapshot-begin", snapshotId }));
          let page = 0;
          let records: BusinessRecord[] = [];
          let bytes = 0;
          const sendPage = async () => {
            if (records.length === 0) return;
            await write(
              JSON.stringify({ type: "snapshot-page", snapshotId, page: page++, records }),
            );
            records = [];
            bytes = 0;
          };
          for (const record of captured.records) {
            const size = Buffer.byteLength(JSON.stringify(record)) + 1;
            if (size > BUSINESS_LIMITS.frameBytes - 1024) {
              fail({ type: "error", reason: "snapshot-too-large" });
              return;
            }
            if (bytes + size > BUSINESS_LIMITS.frameBytes - 1024) await sendPage();
            if (retired || ending) return;
            records.push(record);
            bytes += size;
          }
          await sendPage();
          await write(
            JSON.stringify({
              type: "snapshot-end",
              snapshotId,
              pages: page,
              cursor: captured.cursor,
              history: "latest-and-active-runs-unresolved-operations",
            }),
          );
        }
      } catch {
        fail({ type: "reset", reason: "unavailable" });
      } finally {
        releaseSnapshot?.();
        releaseSnapshot = undefined;
        snapshotting = false;
        void pump();
      }
    };
    const first = (input: unknown, bytes: number, elapsed: number, confirmed = false) => {
      const secret =
        input && typeof input === "object" && "secret" in input ? input.secret : undefined;
      const verdict = this.admission.authenticate(typeof secret === "string" ? secret : undefined);
      if (verdict.kind === "device" && verdict.confirm) {
        if (!this.core.auth || !validateWsFirstMessage(input, bytes, elapsed, true)) {
          close(WS_CLOSE_CODES.policy);
          return;
        }
        if (confirmed) {
          void write(JSON.stringify(bootstrapFailure("UNAVAILABLE")))
            .finally(() => close(WS_CLOSE_CODES.capacity))
            .catch(() => undefined);
          return;
        }
        confirming = true;
        void this.core.auth.confirm(verdict, entry).then(
          (outcome) => {
            confirming = false;
            if (retired) return;
            if (outcome.kind === "unavailable") {
              void write(JSON.stringify(bootstrapFailure("UNAVAILABLE")))
                .finally(() => close(WS_CLOSE_CODES.capacity))
                .catch(() => undefined);
              return;
            }
            first(input, bytes, elapsed, true);
          },
          () => close(),
        );
        return;
      }
      const matches = verdict.kind === "device" || verdict.kind === "local-owner";
      let request = validateWsFirstMessage(input, bytes, elapsed, matches);
      if (verdict.kind === "revoked" && validateWsFirstMessage(input, bytes, elapsed, true)) {
        void write(JSON.stringify(bootstrapFailure("DEVICE_REVOKED")))
          .finally(() => close(WS_CLOSE_CODES.policy))
          .catch(() => undefined);
        return;
      }
      if (!request) {
        const version =
          input && typeof input === "object" && "bootstrapVersion" in input
            ? input.bootstrapVersion
            : undefined;
        if (
          typeof version !== "number" ||
          !Number.isSafeInteger(version) ||
          version < 1 ||
          version === BOOTSTRAP_VERSION ||
          !validateWsFirstMessage(
            { ...(input as object), bootstrapVersion: BOOTSTRAP_VERSION },
            bytes,
            elapsed,
            matches,
          )
        ) {
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
        { connectionId: randomUUID(), generation: 1 },
      );
      if (result.type !== "cove-bootstrap-result") {
        void write(JSON.stringify(result))
          .finally(() => close())
          .catch(() => undefined);
        return;
      }
      if (!this.snapshots || !result.capabilities.includes(BUSINESS_EVENT_CAPABILITY)) {
        void write(JSON.stringify(bootstrapFailure("UNAVAILABLE")))
          .finally(() => close(WS_CLOSE_CODES.capacity))
          .catch(() => undefined);
        return;
      }
      const claim = this.admission.claim("authenticated");
      if (!claim) {
        close(WS_CLOSE_CODES.capacity);
        return;
      }
      authenticated = claim;
      unauthenticated.release();
      clearTimeout(deadline);
      if (verdict.kind === "device" && this.core.auth) {
        this.core.auth.admitted(verdict, entry);
        this.core.auth.connections.register(verdict.deviceId, {
          close: () => close(WS_CLOSE_CODES.policy),
          closed: physicallyDone,
        });
      }
      // Reserve output ownership before accepting the subscribe frame, including clients that
      // pipeline it immediately after bootstrap. The start waits for this first send to settle.
      handshake = write(JSON.stringify(result));
      void handshake.catch(() => close());
    };
    let handshake = Promise.resolve();
    socket.on("message", (bytes, binary) => {
      if (retired || ending) return;
      try {
        if (binary || bytes.byteLength > this.admission.budgets.bootstrapBytes) {
          close(WS_CLOSE_CODES.size);
          return;
        }
        const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!authenticated) {
          if (confirming || pendingSend) {
            close();
            return;
          }
          first(input, bytes.byteLength, this.now() - started);
          return;
        }
        if (subscribing) {
          close();
          return;
        }
        const parsed = BusinessSubscribeSchema.safeParse(input);
        if (!parsed.success) {
          close();
          return;
        }
        subscribing = true;
        void handshake.then(() => start(parsed.data)).catch(() => close());
      } catch {
        close();
      }
    });
  }
  close(): void {
    for (const peer of [...this.peers]) peer.close();
  }
}

export function registerBusinessWebSocket(app: FastifyInstance, business: BusinessWebSocket): void {
  const claims = new WeakMap<FastifyRequest, Claim>();
  app.get(
    LOCAL_PATHS.events,
    {
      websocket: true,
      onRequest: (request, reply, done) => {
        const result = originFormTarget(request)
          ? business.prepare(actualHeaders(request.headers, request.raw.rawHeaders))
          : { kind: "malformed" as const };
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
      business.accept(
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
        entryOf(request.raw.socket),
      );
    },
  );
}
