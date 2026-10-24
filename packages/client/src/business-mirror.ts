import {
  BUSINESS_LIMITS,
  BusinessFilterSchema,
  BusinessFrameSchema,
  businessFilterIdentity,
  businessRunId,
  normalizedBusinessKinds,
  type BusinessCursor,
  type BusinessFilter,
  type BusinessFrame,
  type BusinessKind,
  type BusinessRecord,
} from "@cove/protocol/business-events";
import { OpaqueIdSchema } from "@cove/protocol/identity";
import { sameBusinessCursor } from "./business-events.js";
import { Notifier } from "./notifier.js";
import type { Disposable, Scheduler, Utf8Codec } from "./transport-ports.js";

export interface BusinessIdentity {
  readonly serverId: string;
  readonly relayInstanceId: string;
}

export type BusinessReadonly<T> = T extends readonly (infer E)[]
  ? readonly BusinessReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: BusinessReadonly<T[K]> }
    : T;
export type ReadonlyBusinessRecord = BusinessReadonly<BusinessRecord>;
export interface BusinessMirrorSnapshot {
  readonly status: "idle" | "stale" | "snapshot" | "current" | "disposed";
  readonly version: number;
  // Identity of the retained records, which can be the PREVIOUS instance while stale.
  readonly identity: Readonly<BusinessIdentity> | null;
  readonly cursor: Readonly<BusinessCursor> | null;
  readonly records: readonly ReadonlyBusinessRecord[];
  readonly bytes: number;
  readonly stagingItems: number;
  readonly lastError: string | null;
}

export interface BusinessMirrorOptions {
  readonly scheduler: Scheduler;
  readonly codec: Utf8Codec;
  readonly filter?: BusinessFilter;
}

type Entry = { readonly value: BusinessRecord; readonly bytes: number };
type Records = Map<string, Entry>;
type Stage = { id: string; page: number; records: Records; bytes: number };
export type BusinessMirrorResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

// Own schema-parsed JSON only. Freezing prevents a view or observer from mutating facts that
// are later reused by another observer. This never walks foreign prototypes or live adapters.
export function freezeBusinessValue<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const member of Object.values(value)) freezeBusinessValue(member);
    Object.freeze(value);
  }
  return value;
}

function key(kind: BusinessKind, id: string): string {
  return JSON.stringify([kind, id]);
}
const finalOperation = (state: string): boolean =>
  ["succeeded", "failed", "cancelled"].includes(state);
const activeRun = (state: string): boolean => state === "starting" || state === "running";

/** Confirmed business facts only: HTTP observations and local UI selection never enter here. */
export class BusinessMirror implements Disposable {
  private status: BusinessMirrorSnapshot["status"] = "idle";
  private version = 0;
  private identity: BusinessIdentity | undefined;
  private target: BusinessIdentity | undefined;
  private cursor: BusinessCursor | undefined;
  private records: Records = new Map();
  private bytes = 2;
  private stage: Stage | undefined;
  private initialized = false;
  private ready = false;
  private lastError: string | undefined;
  private readonly filter: BusinessFilter;
  private readonly kinds: readonly BusinessKind[];
  private readonly notifier: Notifier<BusinessMirrorSnapshot, never>;

  constructor(private readonly options: BusinessMirrorOptions) {
    this.filter = freezeBusinessValue(BusinessFilterSchema.parse(options.filter ?? {}));
    this.kinds = normalizedBusinessKinds(this.filter);
    this.notifier = new Notifier({ scheduler: options.scheduler, snapshot: () => this.snapshot() });
  }

  snapshot(): BusinessMirrorSnapshot {
    return Object.freeze({
      status: this.status,
      version: this.version,
      identity: this.identity ?? null,
      cursor: this.cursor ?? null,
      records: Object.freeze([...this.records.values()].map((entry) => entry.value)),
      bytes: this.bytes,
      stagingItems: this.stage?.records.size ?? 0,
      lastError: this.lastError ?? null,
    });
  }

  onState(listener: (snapshot: BusinessMirrorSnapshot) => void): Disposable {
    if (this.notifier.listenerCount >= 64) throw new Error("Business mirror listener capacity");
    return this.notifier.onState(listener);
  }

  /** Only a complete retained view of this instance can be resumed. */
  resumeCursor(target: BusinessIdentity): BusinessCursor | undefined {
    return this.cursor?.serverId === target.serverId &&
      this.cursor.relayInstanceId === target.relayInstanceId
      ? this.cursor
      : undefined;
  }

  begin(target: BusinessIdentity, since?: BusinessCursor): BusinessMirrorResult {
    if (this.status === "disposed") return { ok: false, reason: "disposed" };
    if (
      !OpaqueIdSchema.safeParse(target.serverId).success ||
      !OpaqueIdSchema.safeParse(target.relayInstanceId).success
    )
      return this.fail("identity");
    const resumable = this.resumeCursor(target);
    if (since && (!resumable || !sameBusinessCursor(since, resumable))) return this.fail("cursor");
    this.target = Object.freeze({ ...target });
    this.cursor = since ? freezeBusinessValue({ ...since }) : undefined;
    this.stage = undefined;
    this.initialized = !!since;
    this.ready = false;
    this.status = "stale";
    this.lastError = undefined;
    this.changed();
    return { ok: true };
  }

  stale(reason = "disconnected", discardCursor = false): void {
    if (this.status === "disposed") return;
    this.status = "stale";
    this.stage = undefined;
    this.ready = false;
    this.lastError = reason;
    if (discardCursor) this.cursor = undefined;
    this.changed();
  }

  accept(input: BusinessFrame): BusinessMirrorResult {
    if (this.status === "disposed") return { ok: false, reason: "disposed" };
    if (!this.target) return this.fail("identity");
    const parsed = BusinessFrameSchema.safeParse(input);
    if (!parsed.success) return this.fail("frame");
    const frame = parsed.data;
    if (frame.type === "reset" || frame.type === "error") return this.fail(frame.reason);
    if ("cursor" in frame && !this.bound(frame.cursor)) return this.fail("cursor");
    try {
      if (frame.type === "snapshot-begin") {
        if (this.initialized || this.stage) return this.fail("snapshot-order");
        this.stage = { id: frame.snapshotId, page: 0, records: new Map(), bytes: 2 };
        this.status = "snapshot";
      } else if (frame.type === "snapshot-page") {
        const stage = this.stage;
        if (!stage || stage.id !== frame.snapshotId || stage.page !== frame.page)
          return this.fail("snapshot-order");
        for (const value of frame.records) {
          if (!this.validRecord(value) || stage.records.has(key(value.kind, value.id)))
            return this.fail("snapshot-record");
          const bytes = this.options.codec.encode(JSON.stringify(value)).byteLength;
          stage.bytes += bytes + (stage.records.size ? 1 : 0);
          stage.records.set(key(value.kind, value.id), {
            value: freezeBusinessValue(value),
            bytes,
          });
          if (
            stage.records.size > BUSINESS_LIMITS.snapshotItems ||
            stage.bytes > BUSINESS_LIMITS.snapshotBytes
          )
            return this.fail("capacity");
        }
        stage.page++;
      } else if (frame.type === "snapshot-end") {
        const stage = this.stage;
        if (!stage || stage.id !== frame.snapshotId || stage.page !== frame.pages)
          return this.fail("snapshot-order");
        // Nothing touches confirmed maps until the complete paged view has passed all checks.
        this.records = stage.records;
        this.bytes = stage.bytes;
        this.identity = this.target;
        this.stage = undefined;
        this.initialized = true;
        this.cursor = freezeBusinessValue(frame.cursor);
        this.status = "stale";
      } else if (frame.type === "changes") {
        if (
          !this.initialized ||
          !this.cursor ||
          !sameBusinessCursor(frame.after, this.cursor) ||
          frame.cursor.sequence !== this.cursor.sequence + 1 ||
          !sameBusinessCursor({ ...frame.cursor, sequence: this.cursor.sequence }, this.cursor)
        )
          return this.fail("gap");
        const next = new Map(this.records);
        for (const change of frame.changes) {
          if (change.type === "delete") {
            if (!this.kinds.includes(change.kind)) return this.fail("filter");
            next.delete(key(change.kind, change.id));
          } else {
            const value = change.value;
            if (!this.validRecord(value)) return this.fail("record");
            const previous = next.get(key(value.kind, value.id))?.value.record;
            if (
              previous &&
              "revision" in previous &&
              "revision" in value.record &&
              previous.revision > value.record.revision
            )
              continue;
            next.set(key(value.kind, value.id), {
              value: freezeBusinessValue(value),
              bytes: this.options.codec.encode(JSON.stringify(value)).byteLength,
            });
          }
        }
        this.pruneHistory(next);
        const bytes =
          2 +
          Math.max(0, next.size - 1) +
          [...next.values()].reduce((total, entry) => total + entry.bytes, 0);
        if (next.size > BUSINESS_LIMITS.snapshotItems || bytes > BUSINESS_LIMITS.snapshotBytes)
          return this.fail("capacity");
        this.records = next;
        this.bytes = bytes;
        this.cursor = freezeBusinessValue(frame.cursor);
      } else if (frame.type === "ready") {
        if (
          this.ready ||
          !this.initialized ||
          !this.cursor ||
          !sameBusinessCursor(frame.cursor, this.cursor)
        )
          return this.fail("ready");
        this.ready = true;
        this.status = "current";
      }
    } catch {
      return this.fail("invalid-state");
    }
    this.changed();
    return { ok: true };
  }

  dispose(): void {
    if (this.status === "disposed") return;
    this.status = "disposed";
    this.stage = undefined;
    this.cursor = undefined;
    this.records.clear();
    this.bytes = 2;
    this.changed();
    this.notifier.closeWhenIdle(() => true);
  }

  private bound(cursor: BusinessCursor): boolean {
    return (
      cursor.serverId === this.target!.serverId &&
      cursor.relayInstanceId === this.target!.relayInstanceId &&
      cursor.filter === businessFilterIdentity(this.filter)
    );
  }

  private validRecord(value: BusinessRecord): boolean {
    if (!this.kinds.includes(value.kind)) return false;
    if (value.kind === "run" || value.kind === "runtime")
      return (
        value.id === businessRunId(value.record.run) &&
        value.record.run.serverId === this.target!.serverId &&
        (value.kind === "run" || value.record.run.relayInstanceId === this.target!.relayInstanceId)
      );
    if (value.kind === "repo") return value.id === value.record.repoId;
    if (value.kind === "task") return value.id === value.record.taskId;
    if (value.kind === "tab") return value.id === value.record.tabId;
    if (value.kind === "operation") return value.id === value.record.operationId;
    return true;
  }

  private pruneHistory(records: Records): void {
    const latest = new Map<string, string>();
    const newest = new Map<string, Extract<BusinessRecord, { kind: "run" }>>();
    for (const { value } of records.values()) {
      if (value.kind === "tab" && value.record.latestRun)
        latest.set(value.id, businessRunId(value.record.latestRun));
      if (value.kind === "run" && value.record.tabId) {
        const prior = newest.get(value.record.tabId);
        if (!prior || value.record.startedAtMs >= prior.record.startedAtMs)
          newest.set(value.record.tabId, value);
      }
    }
    // A run-only filter has no tab rows; keep its latest observed run per tab instead.
    for (const [tab, value] of newest) if (!latest.has(tab)) latest.set(tab, value.id);
    for (const [id, { value }] of records) {
      if (value.kind === "operation" && finalOperation(value.record.state)) records.delete(id);
      if (
        value.kind === "run" &&
        !activeRun(value.record.lifecycle) &&
        (!value.record.tabId || latest.get(value.record.tabId) !== value.id)
      ) {
        records.delete(id);
        records.delete(key("runtime", value.id));
      }
    }
  }

  private fail(reason: string): BusinessMirrorResult {
    this.stale(reason, true);
    return { ok: false, reason };
  }
  private changed(): void {
    this.version++;
    this.notifier.markState();
  }
}

export function createBusinessMirror(options: BusinessMirrorOptions): BusinessMirror {
  return new BusinessMirror(options);
}
