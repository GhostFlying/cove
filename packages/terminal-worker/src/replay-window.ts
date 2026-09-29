import type { RunEvent } from "@cove/protocol/terminal";
import type { RetainedLease } from "./worker-retained-bytes.js";

const FACT_RECORD_BYTES = 256;
const SELECTED_REFERENCE_BYTES = 64;

// JSON's code-unit length bounds cloned string content even when UTF-8 is shorter.
export function retainedFactCharge(fact: RetainedFact): number {
  const paletteObjects =
    fact.event.type === "appearance" ? 64 * fact.event.appearance.palette.length : 0;
  return (
    FACT_RECORD_BYTES +
    2 * JSON.stringify(fact.event).length +
    paletteObjects +
    (fact.bytes?.byteLength ?? 0)
  );
}

export interface RetainedFact {
  readonly event: RunEvent;
  readonly bytes?: Uint8Array;
}

interface Entry extends RetainedFact {
  readonly lease: RetainedLease;
  refs: number;
  inWindow: boolean;
  readonly charge: number;
}

export interface ReplaySlice {
  readonly facts: readonly RetainedFact[];
  release(): void;
}

export interface ReplayPin {
  readonly fact: RetainedFact;
  release(): void;
}

// The ring owns one reference; a selected replay pins only its finite selected entries.
export class ReplayWindow {
  readonly #maxBytes: number;
  readonly #maxEvents: number;
  readonly #reserve: (bytes: number) => RetainedLease | undefined;
  readonly #entries: Entry[] = [];
  #bytes = 0;
  #latestSeq = 0;

  constructor(
    maxBytes: number,
    maxEvents: number,
    reserve: (bytes: number) => RetainedLease | undefined,
  ) {
    this.#maxBytes = maxBytes;
    this.#maxEvents = maxEvents;
    this.#reserve = reserve;
  }

  get latestSeq(): number {
    return this.#latestSeq;
  }

  get retainedBytes(): number {
    return this.#bytes;
  }

  get retainedEvents(): number {
    return this.#entries.length;
  }

  pin(seq: number): ReplayPin | undefined {
    const entry = this.#entries.findLast((item) => item.event.seq === seq);
    if (!entry) return undefined;
    entry.refs++;
    let released = false;
    return {
      fact: entry,
      release: () => {
        if (released) return;
        released = true;
        this.#release(entry);
      },
    };
  }

  append(fact: RetainedFact): void {
    const seq = fact.event.seq;
    if (seq <= this.#latestSeq) return;
    this.#latestSeq = seq;
    const payload = fact.bytes;
    const charge = retainedFactCharge(fact);
    if (charge > this.#maxBytes) {
      this.clear();
      return;
    }
    while (
      this.#entries.length &&
      (this.#entries.length >= this.#maxEvents || this.#bytes + charge > this.#maxBytes)
    )
      this.#evict();
    let lease = this.#reserve(charge);
    while (!lease && this.#entries.length) {
      this.#evict();
      lease = this.#reserve(charge);
    }
    if (!lease) return;
    try {
      const entry: Entry = {
        event: structuredClone(fact.event),
        ...(payload && { bytes: Uint8Array.from(payload) }),
        lease,
        refs: 1,
        inWindow: true,
        charge,
      };
      this.#entries.push(entry);
      this.#bytes += charge;
    } catch {
      lease.release();
    }
  }

  select(afterSeq: number, throughSeq: number): ReplaySlice | undefined {
    if (afterSeq > throughSeq || throughSeq > this.#latestSeq) return undefined;
    if (afterSeq === throughSeq) return { facts: [], release: () => {} };
    const count = throughSeq - afterSeq;
    if (count > this.#maxEvents) return undefined;
    let expected = afterSeq + 1;
    for (const entry of this.#entries) {
      if (entry.event.seq <= afterSeq) continue;
      if (entry.event.seq > throughSeq) break;
      if (entry.event.seq !== expected) return undefined;
      if (entry.event.type === "resize" && entry.event.requiresBaseline) return undefined;
      expected++;
    }
    if (expected !== throughSeq + 1) return undefined;
    const references = this.#reserve(64 + SELECTED_REFERENCE_BYTES * count);
    if (!references) return undefined;
    let selected: Entry[];
    try {
      selected = this.#entries.filter(
        (entry) => entry.event.seq > afterSeq && entry.event.seq <= throughSeq,
      );
    } catch (error) {
      references.release();
      throw error;
    }
    for (const entry of selected) entry.refs++;
    let released = false;
    return {
      facts: selected,
      release: () => {
        if (released) return;
        released = true;
        for (const entry of selected) this.#release(entry);
        references.release();
      },
    };
  }

  clear(): void {
    while (this.#entries.length) this.#evict();
  }

  evictOldest(): boolean {
    if (!this.#entries.length) return false;
    this.#evict();
    return true;
  }

  evictOldestUnpinned(): boolean {
    const index = this.#entries.findIndex((entry) => entry.refs === 1);
    if (index < 0) return false;
    const entry = this.#entries[index]!;
    this.#entries.splice(index, 1);
    entry.inWindow = false;
    this.#bytes -= entry.charge;
    this.#release(entry);
    return true;
  }

  #evict(): void {
    const entry = this.#entries.shift();
    if (!entry) return;
    entry.inWindow = false;
    this.#bytes -= entry.charge;
    this.#release(entry);
  }

  #release(entry: Entry): void {
    entry.refs--;
    if (entry.refs === 0) entry.lease.release();
  }
}
