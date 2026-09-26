// A fixed buffer bounds physical chunk metadata as well as raw payload retention.
export class BoundedRecoveryTail {
  readonly cap: number;
  #buffer: Uint8Array | null = null;
  #length = 0;
  #available = true;

  constructor(cap: number) {
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 64 * 1024)
      throw new Error("Recovery tail cap must be between 1 and 65536 bytes");
    this.cap = cap;
  }

  append(bytes: Uint8Array): void {
    if (!this.#available || bytes.byteLength === 0) return;
    if (bytes.byteLength > this.cap - this.#length) {
      this.#buffer = null;
      this.#length = 0;
      this.#available = false;
      return;
    }
    this.#buffer ??= new Uint8Array(this.cap);
    this.#buffer.set(bytes, this.#length);
    this.#length += bytes.byteLength;
  }

  get available(): boolean {
    return this.#available;
  }
  get retainedBytes(): number {
    return this.#length;
  }
  get allocatedBytes(): number {
    return this.#buffer?.byteLength ?? 0;
  }
  snapshot(): Uint8Array {
    if (!this.#available) throw new Error("Recovery unavailable: raw tail exceeded cap");
    return this.#buffer?.slice(0, this.#length) ?? new Uint8Array();
  }

  resetAfterProvedCheckpoint(): void {
    this.#buffer = null;
    this.#length = 0;
    this.#available = true;
  }
}
