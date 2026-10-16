import { PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { PROFILE } from "@cove/protocol/profile";
import type { RpcHandler } from "./context.js";

export const handle: RpcHandler<"server"> = (core) => {
  const runtime = core.runtime;
  const pool = runtime.pool.snapshot();
  return {
    serverId: runtime.composition.serverId,
    relayInstanceId: runtime.composition.relayInstanceId,
    buildVersion: core.buildVersion,
    protocolVersion: PROTOCOL_VERSION,
    profile: PROFILE,
    effectiveBudgets: runtime.composition.budgets,
    workerCount: pool.workers,
    runCount: runtime.registry.count,
    admission: pool.readyWorkers ? "ready" : "unavailable",
    health: pool.readyWorkers ? "live" : "unverifiable",
    // Informational overload state per live worker (issue #103); see worker-health.ts.
    workers: runtime.pool
      .sessions()
      .map((session) => session.workerStatus())
      .filter((status) => status !== undefined),
  };
};
