import type { DomainError } from "@cove/protocol/errors";
import type {
  ClientError,
  TerminalInputNotice,
  TerminalInputRejectionClass,
  TerminalInputRejectionGroup,
  TerminalInputRejectionSource,
} from "./client.js";

// Rejection aggregates (docs/terminal-architecture.md 4.4.3). Inputs rejected at admission were
// never handed to the connection. While individual rejection slots are free each gets its own
// notice; beyond that they are folded into an aggregate at the tail of the notice queue. The
// aggregate keeps only finite, caller-independent fields: the source and error class are closed
// enums (anything unrecognized maps to "malformed"/"other"), so its size has a fixed bound
// whatever the caller passes, and every count saturates at Number.MAX_SAFE_INTEGER.

export const REJECTION_SLOTS = 32;

const SOURCES: readonly TerminalInputRejectionSource[] = [
  "keyboard",
  "paste",
  "mouse",
  "renderer",
  "malformed",
];
const LOCAL_CLASSES: readonly TerminalInputRejectionClass[] = [
  "invalid-request",
  "invalid-state",
  "disposed",
  "capacity",
  "timeout",
];

function saturatingAdd(a: number, b: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, a + b);
}

export function rejectionSource(source: unknown): TerminalInputRejectionSource {
  return source === "keyboard" || source === "paste" || source === "mouse" ? source : "malformed";
}

export function rejectionClass(error: ClientError | DomainError): TerminalInputRejectionClass {
  if ("category" in error) {
    const reason = error.category === "local" ? error.reason : undefined;
    return LOCAL_CLASSES.find((known) => known === reason) ?? "other";
  }
  if (error.kind === "COUNTER_EXHAUSTED") return "counter-exhausted";
  if (error.kind === "INPUT_REJECTED") return "input-rejected";
  return "other";
}

interface MutableGroup {
  count: number;
  knownBytes: number;
  unknownLengthCount: number;
}

export class RejectionAggregate {
  private count = 0;
  private readonly groups = new Map<string, MutableGroup>();

  // `bytes` is undefined when the length is not known (renderer and malformed rejections); a
  // length is never invented.
  add(
    source: TerminalInputRejectionSource,
    error: TerminalInputRejectionClass,
    bytes: number | undefined,
  ): void {
    this.count = saturatingAdd(this.count, 1);
    const key = `${source}/${error}`;
    let group = this.groups.get(key);
    if (!group) {
      group = { count: 0, knownBytes: 0, unknownLengthCount: 0 };
      this.groups.set(key, group);
    }
    group.count = saturatingAdd(group.count, 1);
    if (bytes === undefined) group.unknownLengthCount = saturatingAdd(group.unknownLengthCount, 1);
    else group.knownBytes = saturatingAdd(group.knownBytes, bytes);
  }

  freeze(): TerminalInputNotice {
    const groups: TerminalInputRejectionGroup[] = [];
    for (const source of SOURCES)
      for (const error of [
        ...LOCAL_CLASSES,
        "counter-exhausted",
        "input-rejected",
        "other",
      ] as const) {
        const group = this.groups.get(`${source}/${error}`);
        if (group) groups.push(Object.freeze({ source, error, ...group }));
      }
    return Object.freeze({
      kind: "input-rejections",
      count: this.count,
      groups: Object.freeze(groups),
    });
  }
}
