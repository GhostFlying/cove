import { M1_LIMITS, type TaskRecord } from "@cove/protocol/workspace";

// The read protocol's limits on a task record (relay-protocol: an RPC result is at most 4096 JSON
// tokens, boundedJsonStructure in @cove/protocol/terminal, and its response at most the effective
// rpcResponseBytes). Pure, so the store worker (store/sql/workspaces.ts) and the domain share it.
//
// - A write refuses a workspace whose task record could ever exceed one task.get response
//   (taskRecordFits, checked inside the write's transaction against the rows it would commit).
// - task.list builds pages that fit both limits (domain/workspaces.ts).
// Because every accepted record fits with RECORD_RESERVE to spare, a page always holds at least
// one task.

export const STRUCTURE_TOKENS = 4096;

// Room a single record leaves for the response around it: the JSON-RPC envelope (an ID of at
// most 128 characters, 768 bytes escaped), `{"task": ...}` or `{"tasks": [...],
// "nextAfterTaskId": ...}`, and their tokens.
export const RECORD_RESERVE = { bytes: 2048, tokens: 32 } as const;
// What the envelope of a page takes; smaller than RECORD_RESERVE.
export const PAGE_RESERVE = { bytes: 1024, tokens: 16 } as const;

export type JsonSize = { bytes: number; tokens: number };

// Encoded UTF-8 bytes of JSON.stringify(value), and its tokens counted the way
// boundedJsonStructure counts them (one per value, one more per object key).
export function jsonSize(value: unknown): JsonSize {
  return { bytes: Buffer.byteLength(JSON.stringify(value)), tokens: tokens(value) };
}

function tokens(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  let count = 1;
  if (Array.isArray(value)) for (const item of value) count += tokens(item);
  else for (const item of Object.values(value)) count += 1 + tokens(item);
  return count;
}

const LONGEST_ID = "i".repeat(40);

// The largest the record of this workspace can become without another change of its mounts: the
// longest title a rename may give it (each character escaped to six bytes), counters at their
// maximum, the longest read-time states, and every checkout shared with as many tasks as a record
// lists (M1_LIMITS.sharedTasks): other tasks mounting the same checkout grow this record without
// writing it.
function worstCase(record: TaskRecord): TaskRecord {
  return {
    ...record,
    revision: Number.MAX_SAFE_INTEGER,
    title: "\u0001".repeat(M1_LIMITS.titleChars),
    workspace: {
      ...record.workspace,
      revision: Number.MAX_SAFE_INTEGER,
      entryState: "unavailable",
      mounts: record.workspace.mounts.map((mount) => ({
        ...mount,
        state: "unavailable",
        sharedWithTaskIds:
          mount.source === "checkout"
            ? Array<string>(M1_LIMITS.sharedTasks).fill(LONGEST_ID)
            : mount.sharedWithTaskIds,
      })),
    },
  };
}

// Whether every read of this record fits one response of `responseBytes`, with RECORD_RESERVE
// to spare.
export function taskRecordFits(record: TaskRecord, responseBytes: number): boolean {
  const size = jsonSize({ task: worstCase(record) });
  return (
    size.bytes <= responseBytes - RECORD_RESERVE.bytes &&
    size.tokens <= STRUCTURE_TOKENS - RECORD_RESERVE.tokens
  );
}
