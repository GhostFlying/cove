import {
  BoundedPtySpawnError,
  checkBoundedPtySupport,
  type BoundedPtyCleanupResult,
  type IPty,
  type OwnedSignalResult,
} from "node-pty";

const support = checkBoundedPtySupport();
if (support.supported) {
  const version: 3 = support.contractVersion;
  void version;
} else {
  const reason: "unsupported-platform" | "binding-unavailable" | "binding-mismatch" =
    support.reason;
  void reason;
}

export function stopOwned(terminal: IPty): OwnedSignalResult | undefined {
  return terminal.signalOwned?.("SIGHUP", "leader");
}

export async function observeFailure(error: unknown): Promise<BoundedPtyCleanupResult | undefined> {
  if (error instanceof BoundedPtySpawnError) {
    const code: "COVE_BOUNDED_PTY_SPAWN_FAILED" = error.code;
    void code;
    return error.cleanup;
  }
  return undefined;
}
