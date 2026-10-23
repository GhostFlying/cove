import type { CredentialSupplier, TerminalConnection, TerminalPort } from "@cove/client";
import {
  BOOTSTRAP_VERSION,
  BootstrapSuccessSchema,
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
  const credential = await options.credentials();
  if (options.signal.aborted) return 130;
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
      const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!bootstrapped) {
        const parsed = BootstrapSuccessSchema.safeParse(input);
        if (!parsed.success) throw new Error("Business event authentication or bootstrap refused");
        const result = parsed.data;
        if (
          result.serverId !== options.target.serverId ||
          result.relayInstanceId !== options.target.relayInstanceId ||
          !result.capabilities.includes(BUSINESS_EVENT_CAPABILITY)
        )
          throw new Error("Business event identity or capability mismatch");
        bootstrapped = true;
        if (connection?.send(JSON.stringify(options.request)) !== "handed-off")
          throw new Error("Business event subscription was not sent");
        return;
      }
      const parsed = BusinessFrameSchema.safeParse(input);
      if (!parsed.success) throw new Error("Invalid business event frame");
      const frame = parsed.data;
      if (frame.type === "reset" || frame.type === "error") {
        await options.frame(frame);
        finish(frame.type === "reset" ? 3 : 1);
        return;
      }
      if (frame.type === "snapshot-begin") {
        if (initialized || snapshot || options.request.since)
          throw new Error("Unexpected business snapshot");
        snapshot = { id: frame.snapshotId, page: 0 };
      } else if (frame.type === "snapshot-page") {
        if (!snapshot || snapshot.id !== frame.snapshotId || snapshot.page !== frame.page)
          throw new Error("Business snapshot page gap");
        snapshot.page++;
      } else if (frame.type === "snapshot-end") {
        if (!snapshot || snapshot.id !== frame.snapshotId || snapshot.page !== frame.pages)
          throw new Error("Incomplete business snapshot");
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
          throw new Error("Business event cursor gap");
        cursor = frame.cursor;
      } else if (frame.type === "ready") {
        if (!initialized || !cursor || !sameCursor(cursor, frame.cursor))
          throw new Error("Business event ready cursor mismatch");
        clearTimeout(timer);
      }
      if (
        "cursor" in frame &&
        (frame.cursor.serverId !== options.target.serverId ||
          frame.cursor.relayInstanceId !== options.target.relayInstanceId ||
          frame.cursor.filter !== businessFilterIdentity(options.request.filter))
      )
        throw new Error("Business event cursor binding mismatch");
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
          void tail.catch(() =>
            finish(1, new Error("Business event stream is invalid or incomplete")),
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
