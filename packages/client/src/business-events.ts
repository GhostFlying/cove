import {
  M0_CAPABILITIES,
  BootstrapFailureSchema,
  BootstrapSuccessSchema,
} from "@cove/protocol/bootstrap";
import {
  BUSINESS_EVENT_CAPABILITY,
  BUSINESS_LIMITS,
  BusinessFrameSchema,
  BusinessSubscribeSchema,
  businessFilterIdentity,
  type BusinessCursor,
  type BusinessFrame,
  type BusinessSubscribe,
} from "@cove/protocol/business-events";
import { BASELINE_ENCODING, PROFILE } from "@cove/protocol/profile";
import { M0_LIMITS } from "@cove/protocol/budgets";
import {
  checkBootstrap,
  createBootstrapRequest,
  createTerminalBootstrap,
  type FrozenOffer,
} from "./connection-session.js";
import type {
  CancellationHandle,
  CredentialSupplier,
  Disposable,
  Scheduler,
  TerminalConnection,
  TerminalPort,
  Utf8Codec,
} from "./transport-ports.js";

export interface BusinessReaderOptions {
  readonly target: { readonly serverId: string; readonly relayInstanceId: string };
  readonly buildVersion: string;
  readonly credentials: CredentialSupplier;
  readonly port: TerminalPort;
  readonly scheduler: Scheduler;
  readonly codec: Utf8Codec;
  readonly request: BusinessSubscribe;
  // Resolves when the consumer accepted a frame. The queue and acceptance deadline are bounded.
  readonly frame: (frame: BusinessFrame) => void | Promise<void>;
}

export type BusinessReaderOutcome =
  | { readonly kind: "disposed" }
  | { readonly kind: "reset"; readonly reason: Extract<BusinessFrame, { type: "reset" }>["reason"] }
  | {
      readonly kind: "refused";
      readonly reason: Extract<BusinessFrame, { type: "error" }>["reason"];
    }
  | { readonly kind: "error"; readonly message: string };

export interface BusinessReader extends Disposable {
  readonly done: Promise<BusinessReaderOutcome>;
}

export function sameBusinessCursor(a: BusinessCursor, b: BusinessCursor): boolean {
  return (
    a.serverId === b.serverId &&
    a.relayInstanceId === b.relayInstanceId &&
    a.streamId === b.streamId &&
    a.filter === b.filter &&
    a.sequence === b.sequence
  );
}

// Diagnostic text is fixed here: a JSON/codec/adapter exception may contain private records.
class BusinessReadError extends Error {}

function release(action: (() => unknown) | undefined): void {
  try {
    action?.();
  } catch {
    /* An owned adapter's cleanup cannot prevent cancellation from settling. */
  }
}

/** One read-only /events connection. Entry verification belongs to the host, before this call. */
export function openBusinessEvents(options: BusinessReaderOptions): BusinessReader {
  let settle!: (outcome: BusinessReaderOutcome) => void;
  const done = new Promise<BusinessReaderOutcome>((resolve) => {
    settle = resolve;
  });
  let finished = false;
  let connection: TerminalConnection | undefined;
  let cancellation: CancellationHandle | undefined;
  let timer: Disposable | undefined;
  let timerGeneration = 0;
  let bootstrapped = false;
  let ready = false;
  let opened = false;
  let bufferedBytes = 0;
  let bufferedItems = 0;
  let tail = Promise.resolve();
  let cursor: BusinessCursor | undefined;
  let snapshot: { id: string; page: number; items: number; bytes: number } | undefined;
  let initialized = false;
  const parsedRequest = BusinessSubscribeSchema.safeParse(options.request);
  const request = parsedRequest.success ? parsedRequest.data : undefined;
  const target = { ...options.target };
  const offer: FrozenOffer = {
    expectedServerId: target.serverId,
    expectedRelayInstanceId: target.relayInstanceId,
    buildVersion: options.buildVersion,
    capabilities: [...new Set([...M0_CAPABILITIES, BUSINESS_EVENT_CAPABILITY])],
    profiles: [PROFILE],
    encodings: [BASELINE_ENCODING],
  };
  cursor = request?.since;
  initialized = !!cursor;

  const clearTimer = (): void => {
    timerGeneration++;
    const owned = timer;
    timer = undefined;
    release(() => owned?.dispose());
  };
  const finish = (outcome: BusinessReaderOutcome): void => {
    if (finished) return;
    // Fence before foreign cleanup; close/cancel may synchronously call any port callback.
    finished = true;
    const ownedConnection = connection;
    const ownedCancellation = cancellation;
    connection = undefined;
    cancellation = undefined;
    clearTimer();
    release(() => ownedConnection?.close());
    release(() => ownedCancellation?.cancel());
    settle(Object.freeze(outcome));
  };
  const fail = (message: string): void => finish({ kind: "error", message });
  const deadline = (message: string): void => {
    clearTimer();
    if (finished) return;
    const generation = timerGeneration;
    try {
      const returned = options.scheduler.setTimer(BUSINESS_LIMITS.progressTimeoutMs, () => {
        if (!finished && timerGeneration === generation) fail(message);
      });
      if (finished || timerGeneration !== generation) release(() => returned.dispose());
      else timer = returned;
    } catch {
      fail("Business event transport unavailable");
    }
  };
  const boundCursor = (value: BusinessCursor): boolean =>
    value.serverId === target.serverId &&
    value.relayInstanceId === target.relayInstanceId &&
    value.filter === businessFilterIdentity(request!.filter);

  const handle = async (bytes: Uint8Array): Promise<void> => {
    if (finished) return;
    let input: unknown;
    try {
      input = JSON.parse(options.codec.decodeFatal(bytes));
    } catch {
      throw new BusinessReadError("Invalid business event JSON");
    }
    if (finished) return;
    if (!bootstrapped) {
      const result = BootstrapSuccessSchema.safeParse(input);
      if (!result.success) {
        const failure = BootstrapFailureSchema.safeParse(input);
        throw new BusinessReadError(
          failure.success
            ? `Business event bootstrap refused: ${failure.data.kind}`
            : "Invalid business event bootstrap result",
        );
      }
      if (
        !checkBootstrap({ kind: "success", value: result.data }, "terminal", offer).ok ||
        !result.data.capabilities.includes(BUSINESS_EVENT_CAPABILITY)
      )
        throw new BusinessReadError("Business event identity or capability mismatch");
      bootstrapped = true;
      if (connection?.send(JSON.stringify(request)) !== "handed-off")
        throw new BusinessReadError("Business event subscription was not sent");
      return;
    }
    const parsed = BusinessFrameSchema.safeParse(input);
    if (!parsed.success) throw new BusinessReadError("Invalid business event frame");
    const frame = parsed.data;
    if (frame.type === "snapshot-begin") {
      if (initialized || snapshot || request!.since)
        throw new BusinessReadError("Unexpected business snapshot");
      snapshot = { id: frame.snapshotId, page: 0, items: 0, bytes: 2 };
    } else if (frame.type === "snapshot-page") {
      if (!snapshot || snapshot.id !== frame.snapshotId || snapshot.page !== frame.page)
        throw new BusinessReadError("Business snapshot page gap");
      for (const record of frame.records) {
        snapshot.bytes +=
          options.codec.encode(JSON.stringify(record)).byteLength + (snapshot.items ? 1 : 0);
        snapshot.items++;
      }
      if (
        snapshot.bytes > BUSINESS_LIMITS.snapshotBytes ||
        snapshot.items > BUSINESS_LIMITS.snapshotItems
      )
        throw new BusinessReadError("Business snapshot exceeds reader capacity");
      snapshot.page++;
    } else if (frame.type === "snapshot-end") {
      if (!snapshot || snapshot.id !== frame.snapshotId || snapshot.page !== frame.pages)
        throw new BusinessReadError("Incomplete business snapshot");
      cursor = frame.cursor;
      initialized = true;
      snapshot = undefined;
    } else if (frame.type === "changes") {
      if (
        !initialized ||
        !cursor ||
        !sameBusinessCursor(frame.after, cursor) ||
        frame.cursor.sequence !== cursor.sequence + 1 ||
        !sameBusinessCursor({ ...frame.cursor, sequence: cursor.sequence }, cursor)
      )
        throw new BusinessReadError("Business event cursor gap");
      cursor = frame.cursor;
    } else if (frame.type === "ready") {
      if (ready || !initialized || !cursor || !sameBusinessCursor(cursor, frame.cursor))
        throw new BusinessReadError("Business event ready cursor mismatch");
      ready = true;
    }
    if ("cursor" in frame && !boundCursor(frame.cursor))
      throw new BusinessReadError("Business event cursor binding mismatch");
    // Each output acceptance is bounded as well as setup: a stalled callback must not retain
    // an unbounded promise chain or leave disposal waiting for its promise.
    deadline("Business event setup timed out");
    await options.frame(frame);
    if (finished) return;
    if (frame.type === "reset") finish({ kind: "reset", reason: frame.reason });
    else if (frame.type === "error") finish({ kind: "refused", reason: frame.reason });
    else if (ready) clearTimer();
  };

  const start = async (): Promise<void> => {
    // A caller may intentionally present a stale/differently filtered cursor. Let the
    // authenticated server return its explicit reset reason (and preserve CLI exit 3).
    if (!request) {
      fail("Business event cursor binding mismatch");
      return;
    }
    deadline("Business event credential unavailable");
    if (finished) return;
    let credential;
    try {
      credential = await options.credentials();
    } catch {
      fail("Business event credential unavailable");
      return;
    }
    if (finished) return;
    const bootstrap = createTerminalBootstrap(
      createBootstrapRequest(offer),
      credential.terminalSecret,
    );
    if (!bootstrap) {
      fail("Business event credential unavailable");
      return;
    }
    deadline("Business event setup timed out");
    if (finished) return;
    try {
      const returned = options.port.open({
        onOpen: (value) => {
          if (finished || opened) {
            release(() => value.close());
            return;
          }
          opened = true;
          connection = value;
          try {
            if (value.send(JSON.stringify(bootstrap)) !== "handed-off")
              fail("Business event bootstrap was not sent");
          } catch {
            fail("Business event transport unavailable");
          }
        },
        onText: (bytes) => {
          if (finished) return;
          if (
            !opened ||
            bytes.byteLength >
              (bootstrapped ? BUSINESS_LIMITS.frameBytes : M0_LIMITS.bootstrapBytes) ||
            bufferedBytes + bytes.byteLength > BUSINESS_LIMITS.queueBytes ||
            bufferedItems >= BUSINESS_LIMITS.queueItems
          ) {
            fail("Business event reader overflow; state is no longer current");
            return;
          }
          const owned = new Uint8Array(bytes);
          bufferedBytes += owned.byteLength;
          bufferedItems++;
          tail = tail
            .then(() => handle(owned))
            .finally(() => {
              bufferedBytes -= owned.byteLength;
              bufferedItems--;
            });
          void tail.catch((error: unknown) =>
            fail(
              error instanceof BusinessReadError
                ? error.message
                : "Business event stream is invalid or incomplete",
            ),
          );
        },
        onBinary: () => fail("Unexpected binary business event frame"),
        onClose: () => {
          // Drain already-received reset/end frames, with the existing acceptance deadline.
          deadline("Business event connection closed; state is no longer current");
          void tail.then(
            () => fail("Business event connection closed; state is no longer current"),
            () => fail("Business event connection failed"),
          );
        },
      });
      if (finished) release(() => returned.cancel());
      else cancellation = returned;
    } catch {
      fail("Business event transport unavailable");
    }
  };
  // Defer the supplier so callers can acquire and cancel the handle before any host callback.
  void Promise.resolve()
    .then(start)
    .catch(() => fail("Business event transport unavailable"));
  return Object.freeze({ done, dispose: () => finish({ kind: "disposed" }) });
}
