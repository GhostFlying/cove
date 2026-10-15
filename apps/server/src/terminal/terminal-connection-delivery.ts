import { ConnectionRefSchema, type ConnectionRef } from "@cove/protocol/identity";
import {
  encodeTerminalFrame,
  validateTerminalFrame,
  MAX_FRAME_BYTES,
  MAX_METADATA_BYTES,
  type TerminalMetadata,
  type TerminalFrameClass,
} from "@cove/protocol/terminal";
import type { ByteReservation } from "./runtime-retained-bytes.js";
import { RuntimeComposition } from "./runtime-composition.js";

export interface ExternalByteTransport {
  write(bytes: Uint8Array, settled: (error?: unknown) => void): boolean;
}
export interface DeliveryFence {
  readonly route: string;
  readonly attempt: number;
  current(): boolean;
}
export interface DeliveryAdmission {
  eligible(): boolean;
  handoff(): boolean;
}
// The overhead a prepaid result slot covers besides the encoded buffer: the record a
// dynamically admitted item reserves (512) and retainBacking's per-buffer overhead (256).
export const PREPAID_DELIVERY_OVERHEAD = 512 + 256;
const NO_BACKING: ByteReservation = Object.freeze({ bytes: 0, release() {} });
type Item = {
  bytes: Uint8Array;
  backing: ByteReservation;
  record: ByteReservation;
  control: boolean;
  fence: DeliveryFence | undefined;
  admission: DeliveryAdmission | undefined;
  owned: boolean;
  prepaid: boolean;
};

export class TerminalConnectionDelivery {
  readonly connection: Readonly<ConnectionRef>;
  private readonly arena: ByteReservation;
  private readonly queue: Item[] = [];
  private readonly handed = new Set<Item>();
  private queuedBytes = 0;
  private physicalBytes = 0;
  private ordinaryBytes = 0;
  // Prepaid items queued or awaiting their write callback, and their bytes. They are outside
  // itemLimit and the byte budgets above (see admit).
  private prepaidItems = 0;
  private prepaidBytes = 0;
  private blocked = false;
  private flushing = false;
  private encoding = false;
  private closedState = false;
  private drainGeneration = 0;
  private released = false;

  constructor(
    readonly composition: RuntimeComposition,
    private readonly options: {
      connection: ConnectionRef;
      transport: ExternalByteTransport;
      encodeUtf8: (text: string) => Uint8Array;
      itemLimit: number;
      failed?: () => void;
    },
  ) {
    if (
      !ConnectionRefSchema.safeParse(options.connection).success ||
      !Number.isSafeInteger(options.itemLimit) ||
      options.itemLimit < 5 ||
      options.itemLimit >
        composition.budgets.postNEvents + composition.budgets.pendingWorkerCommands + 4
    )
      throw new Error("Invalid connection delivery limits");
    const arena = composition.bytes.reserve(2 * MAX_FRAME_BYTES + 6 * MAX_METADATA_BYTES);
    if (!arena) throw new Error("Connection delivery capacity unavailable");
    this.arena = arena;
    this.connection = Object.freeze({ ...options.connection });
  }

  get closed(): boolean {
    return this.closedState;
  }

  // `prepaid` is a reservation the caller already holds for this item: it replaces the item's
  // record and backing, and the item stays outside itemLimit and the byte budgets, so shared
  // pressure can never refuse it (issue #96: the result of a live subscription's ACK). The
  // delivery owns the reservation from this call and releases it exactly once: on refusal, or
  // when the item is cancelled or its write callback (or transportReleased) ends it. The
  // caller bounds how many it hands out; a frame larger than the reservation covers is refused.
  admit(
    metadata: TerminalMetadata,
    payload: Uint8Array = new Uint8Array(),
    options: {
      control: boolean;
      fence?: DeliveryFence;
      prepare?: (encodedBytes: number) => DeliveryAdmission | null;
      admitted?: () => void;
      prepaid?: ByteReservation;
    },
  ): boolean {
    const prepaid = options.prepaid;
    if (
      this.closed ||
      this.encoding ||
      (options.fence && !options.fence.current()) ||
      payload.buffer.byteLength > MAX_FRAME_BYTES ||
      (!prepaid &&
        this.queue.length + this.handed.size - this.prepaidItems >= this.options.itemLimit) ||
      (!options.control &&
        this.queue.filter((item) => !item.control).length +
          [...this.handed].filter((item) => !item.control).length >=
          this.options.itemLimit - 4)
    ) {
      prepaid?.release();
      return false;
    }
    const record = prepaid ?? this.composition.bytes.reserve(512, options.control);
    if (!record) return false;
    this.encoding = true;
    let bytes: Uint8Array;
    try {
      const kind: TerminalFrameClass =
        metadata.type === "error" ? 4 : metadata.type.endsWith("-result") ? 2 : 3;
      const checked = validateTerminalFrame(
        { kind, metadata: new Uint8Array(), payload },
        metadata,
        this.connection,
      );
      if (!checked.ok) throw new Error("Invalid terminal delivery");
      const encodedMetadata = this.options.encodeUtf8(JSON.stringify(checked.value));
      const encoded = encodeTerminalFrame(kind, encodedMetadata, payload);
      if (!encoded.ok) throw new Error("Unframable terminal delivery");
      bytes = encoded.value;
    } catch {
      record.release();
      return false;
    } finally {
      this.encoding = false;
      this.releaseArena();
    }
    const budgets = this.composition.budgets;
    if (
      this.closed ||
      (options.fence && !options.fence.current()) ||
      (prepaid
        ? bytes.buffer.byteLength + PREPAID_DELIVERY_OVERHEAD > prepaid.bytes
        : bytes.byteLength >
            budgets.outboundConnectionBytes +
              budgets.reservedControlBytes -
              this.queuedBytes -
              this.physicalBytes ||
          (!options.control &&
            bytes.byteLength > budgets.outboundConnectionBytes - this.ordinaryBytes))
    ) {
      record.release();
      return false;
    }
    const backing = prepaid
      ? NO_BACKING
      : this.composition.bytes.retainBacking(bytes, options.control);
    if (!backing) {
      record.release();
      return false;
    }
    let admission: DeliveryAdmission | undefined;
    try {
      admission = options.prepare?.(bytes.byteLength) ?? undefined;
      if (
        (options.prepare && !admission) ||
        this.closed ||
        (options.fence && !options.fence.current())
      ) {
        backing.release();
        record.release();
        return false;
      }
    } catch {
      backing.release();
      record.release();
      return false;
    }
    const item: Item = {
      bytes,
      backing,
      record,
      control: options.control,
      fence: options.fence,
      admission,
      owned: true,
      prepaid: !!prepaid,
    };
    this.queue.push(item);
    if (item.prepaid) {
      this.prepaidItems++;
      this.prepaidBytes += bytes.byteLength;
    } else this.queuedBytes += bytes.byteLength;
    if (!item.control) this.ordinaryBytes += bytes.byteLength;
    try {
      options.admitted?.();
    } catch {
      this.close();
      return false;
    }
    if (this.closed || (options.fence && !options.fence.current())) {
      this.cancel(options.fence);
      return false;
    }
    this.flush();
    return !this.closed && (!options.fence || options.fence.current());
  }

  // Cancel only unhanded bytes. A stable ref alone never fences a callback.
  cancel(fence?: Pick<DeliveryFence, "route" | "attempt">): void {
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const item = this.queue[index]!;
      if (fence && (item.fence?.route !== fence.route || item.fence.attempt !== fence.attempt))
        continue;
      this.queue.splice(index, 1);
      this.unaccount(item, false);
      if (!item.control) this.ordinaryBytes -= item.bytes.byteLength;
      item.owned = false;
      item.backing.release();
      item.record.release();
    }
  }

  private next(): number {
    const seen = new Set<string>();
    for (let index = 0; index < this.queue.length; index++) {
      const item = this.queue[index]!;
      const route = item.fence?.route;
      if (route && seen.has(route)) continue;
      if (route) seen.add(route);
      if (!item.fence?.current() && item.fence) continue;
      if (!item.admission || item.admission.eligible()) return index;
    }
    return -1;
  }

  private flush(): void {
    if (this.closed || this.blocked || this.flushing) return;
    this.flushing = true;
    try {
      while (!this.closed && !this.blocked) {
        const index = this.next();
        if (index < 0) break;
        const item = this.queue.splice(index, 1)[0]!;
        if (item.admission && !item.admission.handoff()) {
          this.queue.splice(index, 0, item);
          break;
        }
        if (!item.prepaid) {
          this.queuedBytes -= item.bytes.byteLength;
          this.physicalBytes += item.bytes.byteLength;
        }
        this.handed.add(item);
        const generation = this.drainGeneration;
        try {
          const writable = this.options.transport.write(item.bytes, (error) => {
            if (!this.release(item)) return;
            if (error !== undefined && (!item.fence || item.fence.current())) this.fail();
          });
          if (!writable && generation === this.drainGeneration) this.blocked = true;
        } catch {
          this.fail();
        }
      }
    } finally {
      this.flushing = false;
      this.releaseArena();
    }
  }

  private release(item: Item): boolean {
    if (!item.owned) return false;
    item.owned = false;
    this.handed.delete(item);
    this.unaccount(item, true);
    if (!item.control) this.ordinaryBytes -= item.bytes.byteLength;
    item.backing.release();
    item.record.release();
    this.releaseArena();
    return true;
  }

  // Removes an item's bytes from the counter it is in: prepaid items have their own, others are
  // queued until handed to the transport and physical after.
  private unaccount(item: Item, handed: boolean): void {
    if (item.prepaid) {
      this.prepaidItems--;
      this.prepaidBytes -= item.bytes.byteLength;
    } else if (handed) this.physicalBytes -= item.bytes.byteLength;
    else this.queuedBytes -= item.bytes.byteLength;
  }

  wake(): void {
    this.flush();
  }
  drain(): void {
    this.drainGeneration++;
    this.blocked = false;
    this.flush();
  }
  private fail(): void {
    if (!this.closed) {
      this.close();
      this.options.failed?.();
    }
  }
  close(): void {
    if (this.closed) return;
    this.closedState = true;
    this.drainGeneration++;
    this.cancel();
    this.releaseArena();
  }
  private releaseArena(): void {
    if (!this.closed || this.handed.size || this.encoding || this.flushing || this.released) return;
    this.released = true;
    this.arena.release();
  }
  transportReleased(): void {
    this.close();
    for (const item of [...this.handed]) this.release(item);
    this.releaseArena();
  }
  snapshot() {
    return {
      queuedBytes: this.queuedBytes,
      physicalBytes: this.physicalBytes,
      ordinaryBytes: this.ordinaryBytes,
      prepaidItems: this.prepaidItems,
      prepaidBytes: this.prepaidBytes,
      queued: this.queue.length,
      handed: this.handed.size,
      closed: this.closed,
    };
  }
}
