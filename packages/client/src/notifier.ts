import type { Disposable, Scheduler } from "./transport-ports.js";

// Public observer delivery for the client and each terminal controller
// (docs/terminal-architecture.md 4.4.3).
//
// Observers never run on a client, controller, lane or view stack: a state change only marks the
// queue, and delivery happens in rounds that each start after `scheduler.yieldTurn()`, which the
// Scheduler contract requires to yield a real host task. A round delivers at most a fixed quantum
// of entries to a snapshot of the listeners taken when it starts; whatever observers do during a
// round is only queued, and the remainder continues FIFO in the next round on a new task. An
// observer that changes state on every notice therefore advances at most one round per task and
// cannot starve timers or I/O. Returned promises are never awaited.
//
// The queue holds three kinds of entries in one FIFO:
// - at most one undelivered state marker; it delivers the snapshot current when it is reached,
//   and a snapshot equal to the last delivered one is skipped, so idempotent reactions stop;
// - individual notices, whose producer reserved capacity for them (accepted input keeps its input
//   slot until its notice is delivered; admission rejections use a fixed pool of slots);
// - aggregates, which absorb notices produced while no slot is free. A new aggregate is opened
//   only when the tail is not already an aggregate, so an aggregate covers one consecutive run and
//   FIFO order relative to markers and notices is kept. The queue length is therefore bounded by
//   1 + reserved notices + rejection slots + (number of other entries + 1).

export const DELIVERY_QUANTUM = 64;

type Entry<N, A> =
  | { readonly kind: "state" }
  | { readonly kind: "notice"; readonly notice: N; readonly delivered?: () => void }
  | { readonly kind: "aggregate"; readonly aggregate: A };

export interface NotifierOptions<S, N, A> {
  readonly scheduler: Scheduler;
  readonly snapshot: () => S;
  readonly aggregate?: {
    readonly create: () => A;
    readonly freeze: (aggregate: A) => N;
  };
}

function consumeObserverResult(value: unknown): void {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return;
  try {
    const then = (value as { then?: unknown }).then;
    if (typeof then !== "function") return;
    const derived: unknown = then.call(
      value,
      () => undefined,
      () => undefined,
    );
    if (derived && derived !== value)
      void Promise.resolve(derived).then(undefined, () => undefined);
  } catch {
    /* A hostile observer cannot interrupt delivery. */
  }
}

function invoke<T>(listener: (value: T) => unknown, value: T): void {
  try {
    consumeObserverResult(listener(value));
  } catch {
    /* Observers do not control the notifier or its producer. */
  }
}

export class Notifier<S, N, A = never> {
  private readonly queue: Entry<N, A>[] = [];
  private readonly stateListeners = new Set<(snapshot: S) => void>();
  private readonly noticeListeners = new Set<(notice: N) => void>();
  private markerQueued = false;
  private lastDelivered: string | undefined;
  private scheduled = false;
  private closing: (() => boolean) | undefined;
  private closed = false;

  constructor(private readonly options: NotifierOptions<S, N, A>) {}

  get listenerCount(): number {
    return this.stateListeners.size;
  }

  get pending(): number {
    return this.queue.length;
  }

  onState(listener: (snapshot: S) => void): Disposable {
    return this.subscribe(this.stateListeners, listener);
  }

  onNotice(listener: (notice: N) => void): Disposable {
    return this.subscribe(this.noticeListeners, listener);
  }

  // Marks a state change. Only one marker waits in the queue; it reads the snapshot when it is
  // delivered, so later changes are coalesced into it while it keeps its earliest position.
  markState(): void {
    if (this.closed) return;
    if (!this.markerQueued) {
      this.markerQueued = true;
      this.queue.push({ kind: "state" });
    }
    this.schedule();
  }

  // Queues a notice whose capacity the producer reserved. `delivered` runs once the notice has
  // been handed to every listener of its round (or dropped by close), releasing that reservation.
  pushNotice(notice: N, delivered?: () => void): void {
    if (this.closed) {
      delivered?.();
      return;
    }
    this.queue.push(delivered ? { kind: "notice", notice, delivered } : { kind: "notice", notice });
    this.schedule();
  }

  // Folds an unreserved notice into the tail aggregate, opening one when the tail is not already
  // an aggregate. Returns the aggregate so the caller can record the folded notice in it.
  tailAggregate(): A | undefined {
    const options = this.options.aggregate;
    if (this.closed || !options) return undefined;
    const tail = this.queue[this.queue.length - 1];
    if (tail?.kind === "aggregate") return tail.aggregate;
    const aggregate = options.create();
    this.queue.push({ kind: "aggregate", aggregate });
    this.schedule();
    return aggregate;
  }

  // After dispose of the producer: listeners subscribed now still receive everything already
  // queued and everything `idle` reports as still owed; once the queue is empty and `idle()` is
  // true, the listener sets are cleared. Explicit unsubscription keeps working meanwhile.
  closeWhenIdle(idle: () => boolean): void {
    this.closing = idle;
    this.schedule();
    this.tryClose();
  }

  // Lets a producer re-check closure after settling owed work outside a round.
  poke(): void {
    if (this.closing) this.schedule();
  }

  private subscribe<T>(set: Set<(value: T) => void>, listener: (value: T) => void): Disposable {
    if (this.closed || this.closing) return Object.freeze({ dispose() {} });
    set.add(listener);
    let active = true;
    return Object.freeze({
      dispose: () => {
        if (!active) return;
        active = false;
        set.delete(listener);
      },
    });
  }

  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    let turn: Promise<void>;
    try {
      turn = Promise.resolve(this.options.scheduler.yieldTurn());
    } catch {
      turn = Promise.resolve();
    }
    void turn.then(
      () => this.round(),
      () => this.round(),
    );
  }

  private round(): void {
    this.scheduled = false;
    if (this.closed) return;
    const states = [...this.stateListeners];
    const notices = [...this.noticeListeners];
    for (let count = 0; count < DELIVERY_QUANTUM; count++) {
      const entry = this.queue.shift();
      if (!entry) break;
      if (entry.kind === "state") {
        this.markerQueued = false;
        this.deliverState(states);
      } else if (entry.kind === "notice") {
        for (const listener of notices)
          if (this.noticeListeners.has(listener)) invoke(listener, entry.notice);
        try {
          entry.delivered?.();
        } catch {
          /* Release bookkeeping never interrupts delivery. */
        }
      } else {
        const notice = this.options.aggregate!.freeze(entry.aggregate);
        for (const listener of notices)
          if (this.noticeListeners.has(listener)) invoke(listener, notice);
      }
    }
    if (this.queue.length) this.schedule();
    else this.tryClose();
  }

  private deliverState(listeners: readonly ((snapshot: S) => void)[]): void {
    let snapshot: S;
    let key: string;
    try {
      snapshot = this.options.snapshot();
      key = JSON.stringify(snapshot);
    } catch {
      return;
    }
    if (key === this.lastDelivered) return;
    this.lastDelivered = key;
    for (const listener of listeners)
      if (this.stateListeners.has(listener)) invoke(listener, snapshot);
  }

  private tryClose(): void {
    const idle = this.closing;
    if (!idle || this.closed || this.queue.length || this.scheduled) return;
    let done = false;
    try {
      done = idle();
    } catch {
      done = true;
    }
    if (!done) return;
    this.closed = true;
    this.stateListeners.clear();
    this.noticeListeners.clear();
  }
}
