import type {
  ClientCredentials,
  CredentialSupplier,
  TerminalConnection,
  TerminalPort,
} from "@cove/client";
import {
  BOOTSTRAP_VERSION,
  BootstrapSuccessSchema,
  BootstrapFailureSchema,
  M0_CAPABILITIES,
  PROTOCOL_VERSION,
} from "@cove/protocol/bootstrap";
import { BASELINE_ENCODING, PROFILE } from "@cove/protocol/profile";
import {
  BUSINESS_EVENT_CAPABILITY,
  BUSINESS_LIMITS,
  BusinessFrameSchema,
  businessFilterIdentity,
  type BusinessCursor,
  type BusinessFrame,
  type BusinessSubscribe,
} from "@cove/protocol/business-events";

export type BusinessReaderOptions = {
  target: { serverId: string; relayInstanceId: string };
  buildVersion: string;
  credentials: CredentialSupplier;
  port: TerminalPort;
  request: BusinessSubscribe;
  signal: AbortSignal;
  // Resolves when the output consumer accepted the frame; queued input has a fixed bound.
  frame(frame: BusinessFrame): Promise<void>;
};

// Only our fixed diagnostics and protocol enums may reach stderr; JSON parser messages may
// quote a frame containing private resource data and are deliberately not forwarded.
class BusinessReadError extends Error {}

function credentialsFor(options: BusinessReaderOptions): Promise<ClientCredentials | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (credential: ClientCredentials | null, failed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", aborted);
      if (failed) reject(new BusinessReadError("Business event credential unavailable"));
      else resolve(credential);
    };
    const aborted = () => finish(null);
    const timer = setTimeout(() => finish(null, true), BUSINESS_LIMITS.progressTimeoutMs);
    options.signal.addEventListener("abort", aborted, { once: true });
    if (options.signal.aborted) {
      aborted();
      return;
    }
    // The host supplier may be asynchronous. Its late result after cancellation is ignored;
    // cancellation must not wait indefinitely on storage and must never open a new channel.
    void Promise.resolve()
      .then(() => options.credentials())
      .then(
        (credential) => finish(credential),
        () => finish(null, true),
      );
  });
}

function sameCursor(a: BusinessCursor, b: BusinessCursor): boolean {
  return (
    a.serverId === b.serverId &&
    a.relayInstanceId === b.relayInstanceId &&
    a.streamId === b.streamId &&
    a.filter === b.filter &&
    a.sequence === b.sequence
  );
}

// Port-injected read-only stream consumer. It never reconnects or executes domain writes. The
// Session host owns entry selection and credential rotation; this reader sees no CLI file token.
export async function readBusinessEvents(options: BusinessReaderOptions): Promise<number> {
  const credential = await credentialsFor(options);
  if (!credential || options.signal.aborted) return 130;
  return new Promise<number>((resolve, reject) => {
    let connection: TerminalConnection | undefined;
    let cancellation: ReturnType<TerminalPort["open"]> | undefined;
    let finished = false;
    let bootstrapped = false;
    let cursor = options.request.since;
    let snapshot: { id: string; page: number } | undefined;
    let initialized = !!cursor;
    let bufferedBytes = 0;
    let bufferedItems = 0;
    let tail = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      connection?.close();
      cancellation?.cancel();
      if (error) reject(error);
      else resolve(code);
    };
    const abort = () => finish(130);
    options.signal.addEventListener("abort", abort, { once: true });
    const deadline = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => finish(1, new Error("Business event setup timed out")),
        BUSINESS_LIMITS.progressTimeoutMs,
      );
    };
    deadline();
    const handle = async (bytes: Uint8Array) => {
      if (finished) return;
      let input: unknown;
      try {
        input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new BusinessReadError("Invalid business event JSON");
      }
      if (!bootstrapped) {
        const parsed = BootstrapSuccessSchema.safeParse(input);
        if (!parsed.success) {
          const failure = BootstrapFailureSchema.safeParse(input);
          throw new BusinessReadError(
            failure.success
              ? `Business event bootstrap refused: ${failure.data.kind}`
              : "Invalid business event bootstrap result",
          );
        }
        const result = parsed.data;
        if (
          result.serverId !== options.target.serverId ||
          result.relayInstanceId !== options.target.relayInstanceId ||
          !result.capabilities.includes(BUSINESS_EVENT_CAPABILITY)
        )
          throw new BusinessReadError("Business event identity or capability mismatch");
        bootstrapped = true;
        if (connection?.send(JSON.stringify(options.request)) !== "handed-off")
          throw new BusinessReadError("Business event subscription was not sent");
        return;
      }
      const parsed = BusinessFrameSchema.safeParse(input);
      if (!parsed.success) throw new BusinessReadError("Invalid business event frame");
      const frame = parsed.data;
      if (frame.type === "reset" || frame.type === "error") {
        await options.frame(frame);
        finish(frame.type === "reset" ? 3 : 1);
        return;
      }
      if (frame.type === "snapshot-begin") {
        if (initialized || snapshot || options.request.since)
          throw new BusinessReadError("Unexpected business snapshot");
        snapshot = { id: frame.snapshotId, page: 0 };
      } else if (frame.type === "snapshot-page") {
        if (!snapshot || snapshot.id !== frame.snapshotId || snapshot.page !== frame.page)
          throw new BusinessReadError("Business snapshot page gap");
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
          !sameCursor(frame.after, cursor) ||
          frame.cursor.sequence !== cursor.sequence + 1 ||
          !sameCursor({ ...frame.cursor, sequence: cursor.sequence }, cursor)
        )
          throw new BusinessReadError("Business event cursor gap");
        cursor = frame.cursor;
      } else if (frame.type === "ready") {
        if (!initialized || !cursor || !sameCursor(cursor, frame.cursor))
          throw new BusinessReadError("Business event ready cursor mismatch");
        clearTimeout(timer);
      }
      if (
        "cursor" in frame &&
        (frame.cursor.serverId !== options.target.serverId ||
          frame.cursor.relayInstanceId !== options.target.relayInstanceId ||
          frame.cursor.filter !== businessFilterIdentity(options.request.filter))
      )
        throw new BusinessReadError("Business event cursor binding mismatch");
      if (snapshot) deadline();
      await options.frame(frame);
    };
    try {
      cancellation = options.port.open({
        onOpen: (opened) => {
          connection = opened;
          if (finished) {
            opened.close();
            return;
          }
          if (
            opened.send(
              JSON.stringify({
                type: "cove-bootstrap",
                bootstrapVersion: BOOTSTRAP_VERSION,
                expectedServerId: options.target.serverId,
                expectedRelayInstanceId: options.target.relayInstanceId,
                protocolVersion: PROTOCOL_VERSION,
                buildVersion: options.buildVersion,
                capabilities: [...M0_CAPABILITIES],
                profiles: [PROFILE],
                encodings: [BASELINE_ENCODING],
                secret: credential.terminalSecret,
              }),
            ) !== "handed-off"
          )
            finish(1, new Error("Business event bootstrap was not sent"));
        },
        onText: (bytes) => {
          if (finished) return;
          if (
            bytes.byteLength > BUSINESS_LIMITS.frameBytes ||
            bufferedBytes + bytes.byteLength > BUSINESS_LIMITS.queueBytes ||
            bufferedItems >= BUSINESS_LIMITS.queueItems
          ) {
            finish(1, new Error("Business event reader overflow; state is no longer current"));
            return;
          }
          bufferedBytes += bytes.byteLength;
          bufferedItems++;
          const owned = new Uint8Array(bytes);
          tail = tail
            .then(() => handle(owned))
            .finally(() => {
              bufferedBytes -= owned.byteLength;
              bufferedItems--;
            });
          void tail.catch((error: unknown) =>
            finish(
              1,
              error instanceof BusinessReadError
                ? error
                : new Error("Business event stream is invalid or incomplete"),
            ),
          );
        },
        onBinary: () => finish(1, new Error("Unexpected binary business event frame")),
        onClose: () => {
          void tail.then(
            () =>
              finish(1, new Error("Business event connection closed; state is no longer current")),
            () => finish(1, new Error("Business event connection failed")),
          );
        },
      });
      if (finished) cancellation.cancel();
    } catch {
      finish(1, new Error("Business event transport unavailable"));
    }
  });
}
