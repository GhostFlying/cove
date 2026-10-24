import type { ServerSession, ServerSessionSnapshot } from "@cove/client";
import type { RunRef } from "@cove/protocol/identity";
import { sameRunRef } from "@cove/protocol/identity";

export interface ReadStamp {
  owner: ServerSession;
  serverId: string;
  instance: string;
  generation: number;
  version: number;
  observedAt: number;
}
export function stampRead(owner: ServerSession): ReadStamp | null {
  const state = owner.snapshot();
  return state.status === "current" && state.identity
    ? {
        owner,
        serverId: state.identity.serverId,
        instance: state.identity.relayInstanceId,
        generation: state.generation,
        version: state.mirror.version,
        observedAt: Date.now(),
      }
    : null;
}
// Object identity is essential: replacement ServerSession counters can start at the same values.
export function readIsCurrent(
  stamp: ReadStamp | null | undefined,
  owner: ServerSession | undefined,
): boolean {
  if (!stamp || owner !== stamp.owner) return false;
  const state = owner.snapshot();
  return (
    state.status === "current" &&
    state.identity?.serverId === stamp.serverId &&
    state.identity.relayInstanceId === stamp.instance &&
    state.generation === stamp.generation &&
    state.mirror.version === stamp.version
  );
}
export function runFacts(state: ServerSessionSnapshot | undefined, run: RunRef | null): string {
  if (!run) return "No run · shell activity unknown";
  if (
    state?.status !== "current" ||
    state.mirror.status !== "current" ||
    state.identity?.serverId !== run.serverId ||
    state.identity.relayInstanceId !== run.relayInstanceId
  )
    return "Run unverified · catalog stale · controller unknown · shell activity unknown";
  const history = state.mirror.records.find(
    (v) => v.kind === "run" && sameRunRef(v.record.run, run),
  );
  const runtime = state.mirror.records.find(
    (v) => v.kind === "runtime" && sameRunRef(v.record.run, run),
  );
  const durable =
    history?.kind === "run"
      ? `${history.record.lifecycle} / ${history.record.verification}`
      : "history unobserved";
  if (runtime?.kind !== "runtime")
    return `${durable} · controller unobserved · shell activity unknown`;
  const fact = runtime.record;
  return `${durable} · runtime ${fact.status} · controller ${fact.controlHolder ? fact.controlHolder.connection.connectionId : "none"} · epoch ${fact.controlEpoch} · shell activity unknown`;
}
