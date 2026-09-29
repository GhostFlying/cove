import type { RunEvent } from "@cove/protocol/terminal";
import type { RetainedLease } from "./worker-retained-bytes.js";

const FACT_RECORD_BYTES = 128;

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

  append(fact: RetainedFact): void {
    const seq = fact.event.seq;
    if (seq <= this.#latestSeq) return;
    this.#latestSeq = seq;
    const payload = fact.bytes;
    const charge = FACT_RECORD_BYTES + (payload?.byteLength ?? 0);
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
    const selected = this.#entries.filter(
      (entry) => entry.event.seq > afterSeq && entry.event.seq <= throughSeq,
    );
    if (selected.length !== throughSeq - afterSeq) return undefined;
    for (let index = 0; index < selected.length; index++)
      if (selected[index]!.event.seq !== afterSeq + index + 1) return undefined;
    for (const entry of selected) entry.refs++;
    let released = false;
    return {
      facts: selected,
      release: () => {
        if (released) return;
        released = true;
        for (const entry of selected) this.#release(entry);
      },
    };
  }

  clear(): void {
    while (this.#entries.length) this.#evict();
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
