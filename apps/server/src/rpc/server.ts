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
    // How this server runs as a service (m2 T3): manager, installed and pending build, why it
    // last started. Absent for a composition without a data directory.
    ...(core.service ? { service: core.service.status(core.buildVersion) } : {}),
  };
};
