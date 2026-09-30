export interface ByteReservation {
  readonly bytes: number;
  release(): void;
}

// Control capacity is part of the total, never additional memory.
export class RuntimeRetainedBytes {
  private total = 0;
  private ordinary = 0;
  private readonly backings = new Map<ArrayBufferLike, { users: number; control: boolean; lease: ByteReservation }>();

  constructor(readonly limit: number, readonly controlReserve: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(controlReserve) ||
        controlReserve < 0 || controlReserve > limit) throw new Error("Invalid byte limits");
  }

  reserve(bytes: number, control = false): ByteReservation | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.total ||
        (!control && bytes > this.limit - this.controlReserve - this.ordinary)) return null;
    this.total += bytes;
    if (!control) this.ordinary += bytes;
    let owned = true;
    return { bytes, release: () => {
      if (!owned) return;
      owned = false;
      this.total -= bytes;
      if (!control) this.ordinary -= bytes;
    } };
  }

  retainBacking(bytes: Uint8Array, control = false): ByteReservation | null {
    const backing = bytes.buffer;
    let record = this.backings.get(backing);
    if (!record) {
      const lease = this.reserve(backing.byteLength + 256, control);
      if (!lease) return null;
      record = { users: 0, control, lease };
      this.backings.set(backing, record);
    }
    if (record.control && !control) return null;
    record.users++;
    const owner = record;
    let owned = true;
    return { bytes: backing.byteLength, release: () => {
      if (!owned) return;
      owned = false;
      if (--owner.users === 0) {
        this.backings.delete(backing);
        owner.lease.release();
      }
    } };
  }

  snapshot(): { total: number; ordinary: number; limit: number; controlReserve: number } {
    return { total: this.total, ordinary: this.ordinary, limit: this.limit,
      controlReserve: this.controlReserve };
  }
}
