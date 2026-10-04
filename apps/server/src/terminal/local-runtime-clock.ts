export interface LocalTimer {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}
const timers: LocalTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class LocalRuntimeClock {
  private last = 0;
  private handle: unknown;
  private running = false;
  private stopped = false;
  constructor(
    private readonly tick: () => void,
    private readonly failed: () => void,
    private readonly timer: LocalTimer = timers,
    private readonly monotonic = () => performance.now(),
  ) {}
  readonly now = (): number => {
    const value = Math.floor(this.monotonic());
    if (!Number.isSafeInteger(value) || value < this.last || value < 0)
      throw new Error("Invalid local monotonic clock");
    this.last = value;
    return value;
  };
  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.schedule();
  }
  private schedule(): void {
    this.handle = this.timer.set(() => {
      if (!this.running) return;
      try {
        this.now();
        this.tick();
      } catch {
        this.stop();
        this.failed();
        return;
      }
      if (this.running) this.schedule();
    }, 25);
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    if (this.handle !== undefined) this.timer.clear(this.handle);
  }
}
