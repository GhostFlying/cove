import { openBusinessEvents, type CredentialSupplier, type TerminalPort } from "@cove/client";
import { createDefaultScheduler, createUtf8Codec } from "@cove/client/web-ports";
import type { BusinessFrame, BusinessSubscribe } from "@cove/protocol/business-events";

export type BusinessReaderOptions = {
  target: { serverId: string; relayInstanceId: string };
  buildVersion: string;
  credentials: CredentialSupplier;
  port: TerminalPort;
  request: BusinessSubscribe;
  signal: AbortSignal;
  frame(frame: BusinessFrame): Promise<void>;
};

// CLI owns signals/output/exit codes; shared client code owns protocol state and cancellation.
export async function readBusinessEvents(options: BusinessReaderOptions): Promise<number> {
  if (options.signal.aborted) return 130;
  const reader = openBusinessEvents({
    ...options,
    scheduler: createDefaultScheduler(),
    codec: createUtf8Codec(),
  });
  const aborted = () => reader.dispose();
  options.signal.addEventListener("abort", aborted, { once: true });
  if (options.signal.aborted) reader.dispose();
  try {
    const outcome = await reader.done;
    if (outcome.kind === "disposed") return 130;
    if (outcome.kind === "reset") return 3;
    if (outcome.kind === "refused") return 1;
    throw new Error(outcome.message);
  } finally {
    options.signal.removeEventListener("abort", aborted);
    reader.dispose();
  }
}
