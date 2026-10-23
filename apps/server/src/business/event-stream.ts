import {
  BUSINESS_LIMITS,
  BusinessChangeSchema,
  BusinessRecordSchema,
  businessFilterIdentity,
  normalizedBusinessKinds,
  type BusinessChange,
  type BusinessCursor,
  type BusinessFilter,
  type BusinessFrame,
  type BusinessRecord,
  type BusinessResetReason,
} from "@cove/protocol/business-events";

type Batch = { sequence: number; changes: BusinessChange[]; bytes: number };
type Subscriber = {
  filter: BusinessFilter;
  cursor: BusinessCursor;
  emit(frame: BusinessFrame): void;
};
export type BusinessWindowLimits = { bytes: number; items: number; subscriptions: number };
const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

// The only owner of the business publication order. Both a Store.receive commit notification
// and its snapshot barrier run synchronously on this thread. No await may appear between
// capturing immutable DB records, runtime facts and the cursor returned by capture().
export class BusinessEventStream {
  private streamId: string;
  private sequence = 0;
  private bytes = 0;
  private readonly window: Batch[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private unavailable = false;
  constructor(
    private readonly identity: { serverId: string; relayInstanceId: string },
    private readonly createId: () => string,
    private readonly limits: BusinessWindowLimits = {
      bytes: BUSINESS_LIMITS.windowBytes,
      items: BUSINESS_LIMITS.windowItems,
      subscriptions: BUSINESS_LIMITS.subscriptions,
    },
  ) {
    if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new Error("Invalid business event limits");
    this.streamId = createId();
  }
  cursor(filter: BusinessFilter): BusinessCursor {
    return {
      // Callers may pass RuntimeComposition structurally; its budgets/byte owner are not wire
      // identity. Project named fields instead of leaking those properties into strict cursors.
      serverId: this.identity.serverId,
      relayInstanceId: this.identity.relayInstanceId,
      streamId: this.streamId,
      sequence: this.sequence,
      filter: businessFilterIdentity(filter),
    };
  }
  capture(
    records: readonly BusinessRecord[],
    runtime: readonly BusinessRecord[],
    filter: BusinessFilter,
  ) {
    if (this.unavailable) throw new Error("Business authority unavailable");
    const kinds = normalizedBusinessKinds(filter);
    const kept = [...records, ...runtime].filter((value) => kinds.includes(value.kind));
    const immutable = kept.map((value) => BusinessRecordSchema.parse(value));
    return { records: immutable, cursor: this.cursor(filter) };
  }
  publish(input: readonly BusinessChange[]): void {
    if (this.unavailable || input.length === 0) return;
    try {
      const changes = input.map((value) => BusinessChangeSchema.parse(value));
      const bytes = encodedBytes(changes);
      // One oversized transaction is already committed. It may invalidate readers, but must
      // neither roll back a business write nor publish a cursor over omitted changes.
      if (
        changes.length > BUSINESS_LIMITS.journalItems ||
        bytes > Math.min(this.limits.bytes, BUSINESS_LIMITS.frameBytes - 2048) ||
        this.sequence === Number.MAX_SAFE_INTEGER
      ) {
        this.invalidate("overflow");
        return;
      }
      const batch = { sequence: ++this.sequence, changes, bytes };
      this.window.push(batch);
      this.bytes += bytes;
      while (this.window.length > this.limits.items || this.bytes > this.limits.bytes)
        this.bytes -= this.window.shift()!.bytes;
      for (const subscriber of [...this.subscribers]) this.deliver(subscriber, batch);
    } catch {
      this.invalidate("publication-uncertain");
    }
  }
  private deliver(subscriber: Subscriber, batch: Batch): void {
    const kinds = normalizedBusinessKinds(subscriber.filter);
    const after = subscriber.cursor;
    const cursor = { ...after, sequence: batch.sequence };
    const changes = batch.changes.filter((change) =>
      kinds.includes(change.type === "upsert" ? change.value.kind : change.kind),
    );
    subscriber.cursor = cursor;
    // Empty frames are intentional: the cursor is global, so filters cannot create unexplained
    // gaps. A failed transport drops this subscriber, never other subscribers' committed facts.
    try {
      subscriber.emit({ type: "changes", after, cursor, changes });
    } catch {
      this.subscribers.delete(subscriber);
    }
  }
  subscribe(
    filter: BusinessFilter,
    since: BusinessCursor,
    emit: Subscriber["emit"],
  ): { dispose(): void } | BusinessResetReason | "busy" {
    if (this.unavailable) return "unavailable";
    if (
      since.serverId !== this.identity.serverId ||
      since.relayInstanceId !== this.identity.relayInstanceId
    )
      return "identity";
    if (since.streamId !== this.streamId) return "generation";
    if (since.filter !== businessFilterIdentity(filter)) return "filter";
    if (
      since.sequence > this.sequence ||
      since.sequence < (this.window[0]?.sequence ?? this.sequence + 1) - 1
    )
      return "gap";
    if (this.subscribers.size >= this.limits.subscriptions) return "busy";
    const subscriber: Subscriber = { filter, cursor: { ...since }, emit };
    // No asynchronous gap between replay and registration. Later publish calls cannot interleave
    // here; emit must only enqueue a bounded frame, never re-enter domain mutations.
    this.subscribers.add(subscriber);
    for (const batch of this.window) {
      if (!this.subscribers.has(subscriber)) break;
      if (batch.sequence > since.sequence) this.deliver(subscriber, batch);
    }
    return {
      dispose: () => {
        this.subscribers.delete(subscriber);
      },
    };
  }
  invalidate(reason: BusinessResetReason, unavailable = false): void {
    const previous = [...this.subscribers];
    this.subscribers.clear();
    this.window.length = 0;
    this.bytes = 0;
    this.sequence = 0;
    this.streamId = this.createId();
    this.unavailable ||= unavailable;
    for (const subscriber of previous) {
      try {
        subscriber.emit({ type: "reset", reason });
      } catch {
        /* Already disconnected. */
      }
    }
  }
  close(): void {
    this.invalidate("unavailable", true);
  }
  get retained() {
    return { bytes: this.bytes, items: this.window.length, subscriptions: this.subscribers.size };
  }
}
