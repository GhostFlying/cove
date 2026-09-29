import { MAX_TIMING_TRACE_POINTS } from "./worker-timing-bounds.mjs";

const BOUNDARIES = new Set([
  "native-delivery-to-fact",
  "native-submit-to-settlement",
  "pipe-block-to-drain",
  "stop-to-owner-release",
]);

export function nearestRank(values, proportion) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return sorted[Math.ceil(proportion * sorted.length) - 1].toString();
}

export function summarizeTimingTrace(trace) {
  if (!Array.isArray(trace) || trace.length > MAX_TIMING_TRACE_POINTS)
    throw Error("timing trace count exceeds bound");
  const pairs = new Map();
  const groups = new Map();
  for (const point of trace) {
    if (
      !BOUNDARIES.has(point.boundary) ||
      !["start", "end", "outcome"].includes(point.phase) ||
      !point.sampleId ||
      !point.runId ||
      !point.os ||
      !point.clock ||
      !Number.isInteger(point.pid)
    )
      throw Error("timing point identity invalid");
    if (!/^\d+$/.test(point.tick)) throw Error("timing tick invalid");
    const key = `${point.boundary}\0${point.os}\0${point.runId}\0${point.sampleId}`;
    const pair = pairs.get(key) ?? {
      boundary: point.boundary,
      os: point.os,
      runId: point.runId,
      sampleId: point.sampleId,
      pid: point.pid,
      clock: point.clock,
    };
    if (pair.pid !== point.pid || pair.clock !== point.clock) throw Error("timing clock mismatch");
    if (pair[point.phase]) throw Error("duplicate timing endpoint");
    pair[point.phase] = point;
    pairs.set(key, pair);
  }
  for (const pair of pairs.values()) {
    if (!pair.start || Boolean(pair.end) === Boolean(pair.outcome))
      throw Error("missing or conflicting timing endpoint");
    const key = `${pair.boundary}\0${pair.os}`;
    const group = groups.get(key) ?? {
      boundary: pair.boundary,
      os: pair.os,
      successful: [],
      nonSuccess: [],
    };
    if (pair.end) {
      if (pair.boundary === "native-delivery-to-fact") {
        const start = pair.start.detail;
        const end = pair.end.detail;
        if (
          !Number.isSafeInteger(start?.begin) ||
          !Number.isSafeInteger(start?.end) ||
          start.end - start.begin !== start.bytes ||
          end?.intervalEnd !== start.end ||
          end.parsedBytes < start.end ||
          !Number.isSafeInteger(end.finalFactSeq) ||
          !/^[0-9a-f]{64}$/.test(start.digest)
        )
          throw Error("native byte interval join invalid");
      }
      if (pair.boundary === "native-submit-to-settlement") {
        const admission = pair.start.detail?.admission;
        const settlement = pair.end.detail?.settlement;
        if (
          admission?.kind !== "accepted" ||
          settlement?.kind !== "written" ||
          admission.ticket !== settlement.ticket ||
          admission.byteLength !== settlement.writtenBytes ||
          pair.start.detail.length !== settlement.writtenBytes
        )
          throw Error("native input ticket join invalid");
      }
      if (
        pair.boundary === "pipe-block-to-drain" &&
        (pair.start.detail?.blockedSnapshot?.blocked !== true ||
          !pair.end.detail?.after ||
          (pair.end.detail.after.blocked === true
            ? !pair.end.detail.reblockedBy || pair.end.detail.reblockedBy === pair.sampleId
            : pair.end.detail.after.blocked !== false || pair.end.detail.reblockedBy !== null))
      )
        throw Error("pipe blocked epoch join invalid");
      if (
        pair.boundary === "stop-to-owner-release" &&
        (pair.end.detail?.receipt?.ownershipEvidence !== "closure-proven" ||
          pair.end.detail?.receipt?.writer?.kind !== "closed" ||
          pair.end.detail?.receipt?.leader?.kind !== "exit-observed")
      )
        throw Error("owner release join invalid");
      const delta = BigInt(pair.end.tick) - BigInt(pair.start.tick);
      if (delta < 0n) throw Error("negative timing interval");
      group.successful.push({
        runId: pair.runId,
        sampleId: pair.sampleId,
        t0: pair.start.tick,
        t1: pair.end.tick,
        durationNs: delta.toString(),
        ...(pair.start.detail && { startDetail: pair.start.detail }),
        ...(pair.end.detail && { endDetail: pair.end.detail }),
      });
    } else {
      if (!pair.outcome.outcome || pair.outcome.outcome === "success")
        throw Error("invalid non-success timing outcome");
      group.nonSuccess.push({
        runId: pair.runId,
        sampleId: pair.sampleId,
        t0: pair.start.tick,
        observedTick: pair.outcome.tick,
        outcome: pair.outcome.outcome,
        detail: pair.outcome.detail ?? null,
      });
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const values = group.successful.map((sample) => BigInt(sample.durationNs));
    return {
      ...group,
      count: values.length,
      nonSuccessCount: group.nonSuccess.length,
      p50Ns: nearestRank(values, 0.5),
      p95Ns: nearestRank(values, 0.95),
      p99Ns: nearestRank(values, 0.99),
      maxNs: nearestRank(values, 1),
    };
  });
}
