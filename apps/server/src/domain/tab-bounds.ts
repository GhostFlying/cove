import type { RunHistoryRecord, TabRecord } from "@cove/protocol/workspace";
import { jsonSize, RECORD_RESERVE, STRUCTURE_TOKENS, type JsonSize } from "./record-bounds.js";

// The read protocol's limits on tab and run records (see domain/record-bounds.ts for the limits
// themselves). Pure, so the store worker (store/sql/tabs.ts) and the domain share it.
//
// A tab's recipe and cwd never change after creation, and a run's snapshot never changes after
// its start; what can still grow is counters, timestamps, the lifecycle names and the exit
// signal. A launch is refused before it commits when `tab.get` of the result could exceed one
// response at the worst values of those (tabReadFits), so every page of tab.list and tab.runs
// holds at least one record.

const LONGEST_OPAQUE_ID = "i".repeat(128);
const MAX = Number.MAX_SAFE_INTEGER;

function worstRef() {
  return {
    serverId: LONGEST_OPAQUE_ID,
    relayInstanceId: LONGEST_OPAQUE_ID,
    runId: LONGEST_OPAQUE_ID,
  };
}

export function worstTab(tab: TabRecord): TabRecord {
  return { ...tab, revision: MAX, latestRun: worstRef() };
}

export function worstRun(run: RunHistoryRecord): RunHistoryRecord {
  return {
    ...run,
    run: worstRef(),
    workspaceRevision: MAX,
    lifecycle: "stopped-with-server",
    verification: "unverifiable",
    startedAtMs: MAX,
    endedAtMs: MAX,
    lastObservedAtMs: MAX,
    exitCode: -2147483648,
    // Each character escaped to six bytes.
    signal: "\u0001".repeat(64),
  };
}

function fits(size: JsonSize, responseBytes: number): boolean {
  return (
    size.bytes <= responseBytes - RECORD_RESERVE.bytes &&
    size.tokens <= STRUCTURE_TOKENS - RECORD_RESERVE.tokens
  );
}

// Whether `tab.get` of this tab fits one response of `responseBytes` with RECORD_RESERVE to
// spare, whatever its counters and its latest run's end become.
export function tabReadFits(
  read: { tab: TabRecord; latestRun: RunHistoryRecord | null },
  responseBytes: number,
): boolean {
  return fits(
    jsonSize({
      tab: worstTab(read.tab),
      latestRun: read.latestRun ? worstRun(read.latestRun) : null,
    }),
    responseBytes,
  );
}
