import {
  BoundedPtySpawnError,
  checkBoundedPtySupport,
  type BoundedPtyCleanupResult,
} from "node-pty";

const support = checkBoundedPtySupport();
if (support.supported) {
  const version: 2 = support.contractVersion;
  void version;
} else {
  const reason: "unsupported-platform" | "binding-unavailable" | "binding-mismatch" =
    support.reason;
  void reason;
}

export async function observeFailure(error: unknown): Promise<BoundedPtyCleanupResult | undefined> {
  if (error instanceof BoundedPtySpawnError) {
    const code: "COVE_BOUNDED_PTY_SPAWN_FAILED" = error.code;
    void code;
    return error.cleanup;
  }
  return undefined;
}
