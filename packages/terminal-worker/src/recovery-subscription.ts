import type { EngineBaselineResult } from "@cove/terminal-engine";
import type { EffectiveBudgets } from "@cove/protocol/budgets";
import {
  sameSubscriptionRef,
  type RunRef,
  type SubscriptionRef,
  type WorkerRef,
} from "@cove/protocol/identity";
import type { PipeCommand, PipeEvent, PipeResult } from "@cove/protocol/pipe";
import { validateBaselineDescriptor } from "@cove/protocol/terminal";
import type { ReplaySlice, ReplayWindow, RetainedFact } from "./replay-window.js";
import type { RetainedLease } from "./worker-retained-bytes.js";

type RecoveryCommand = Extract<PipeCommand, { type: "subscribe" | "recover" }>;
type RouteCommand = Extract<
  PipeCommand,
  { type: "unsubscribe" | "applied-ack" | "baseline-progress" }
>;
type Failure =
  | "BUSY"
  | "RESYNC_REQUIRED"
  | "RECOVERY_EXPIRED"
  | "RECOVERY_UNAVAILABLE"
  | "OPERATION_ID_CONFLICT"
  | "COUNTER_EXHAUSTED";
type Outcome = { readonly result: PipeResult } | { readonly failure: Failure };
const HEADER_BYTES = 16;
const ROUTE_RECORD_BYTES = 128 + 2 * 4096;
const empty = new Uint8Array();
const encoder = new TextEncoder();

interface OwnedFact extends RetainedFact {
  readonly lease: RetainedLease;
  readonly charge: number;
}

interface TransferFrame {
  readonly event: PipeEvent;
  readonly payload: Uint8Array;
  readonly ordinal: number;
  readonly charge: number;
}

interface Route {
  readonly key: string;
  readonly ref: SubscriptionRef;
  readonly run: RunRef;
  readonly lease: RetainedLease;
  token: number;
  mode: "baseline" | "replay";
  state: "preparing" | "transfer" | "installed" | "tombstone" | "retiring";
  failure?: "RESYNC_REQUIRED" | "RECOVERY_EXPIRED";
  markerRequestId?: string | undefined;
  atSeq: number;
  appliedSeq: number;
  sentSeq: number;
  replay?: ReplaySlice | undefined;
  baselineLease?: RetainedLease | undefined;
  baselineId?: string;
  frames: TransferFrame[];
  nextFrame: number;
  parsedOrdinal: number;
  logicalDebt: number;
  sent: { seq: number; charge: number }[];
  postN: OwnedFact[];
  postNBytes: number;
  deadlineAt: number | undefined;
  retireRequestId?: string;
}

export interface RecoveryDelivery {
  enqueue(event: PipeEvent, payload: Uint8Array, token: number): number | false;
  cancelUnsent(token: number): void;
}

export interface RecoverySource {
  readonly run: RunRef;
  readonly replay: ReplayWindow;
  captureBaseline(reserveDetached: (bytes: number) => boolean): Promise<EngineBaselineResult>;
}

function keyOf(ref: SubscriptionRef): string {
  return JSON.stringify([
    ref.run.serverId,
    ref.run.relayInstanceId,
    ref.run.runId,
    ref.connection.connectionId,
    ref.connection.generation,
    ref.viewId,
    ref.subscriptionId,
  ]);
}

function connectionKey(ref: SubscriptionRef): string {
  return JSON.stringify([ref.connection.connectionId, ref.connection.generation]);
}

function framedBytes(event: PipeEvent, payload: Uint8Array): number {
  return HEADER_BYTES + encoder.encode(JSON.stringify(event)).byteLength + payload.byteLength;
}

export class RecoverySubscriptions {
  readonly #worker: WorkerRef;
  readonly #budgets: EffectiveBudgets;
  readonly #reserve: (bytes: number) => RetainedLease | undefined;
  readonly #delivery: RecoveryDelivery;
  readonly #routes = new Map<string, Route>();
  readonly #connections = new Map<string, { count: number; lease: RetainedLease }>();
  readonly #captureWaiters: { runId: string; resolve: () => void }[] = [];
  #captures = 0;
  #closed = false;
  #nextToken = 0;
  #nextBaseline = 0;
  #deliveryCursor = 0;
  #deliveryScheduled = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    worker: WorkerRef,
    budgets: EffectiveBudgets,
    reserve: (bytes: number) => RetainedLease | undefined,
    delivery: RecoveryDelivery,
  ) {
    this.#worker = worker;
    this.#budgets = budgets;
    this.#reserve = reserve;
    this.#delivery = delivery;
  }

  get routeCount(): number {
    return this.#routes.size;
  }

  async capture<T>(runId: string, operation: () => Promise<T>): Promise<T | undefined> {
    if (!(await this.#acquireCapture(runId))) return undefined;
    try {
      return await operation();
    } finally {
      this.#releaseCapture(runId);
    }
  }

  async open(command: RecoveryCommand, source: RecoverySource): Promise<Outcome> {
    const key = keyOf(command.subscription);
    const prior = this.#routes.get(key);
    if (command.type === "subscribe" ? !!prior : !prior)
      return { failure: "OPERATION_ID_CONFLICT" };
    if (prior && prior.state === "tombstone")
      return { failure: prior.failure ?? "RESYNC_REQUIRED" };
    if (prior && (prior.state === "preparing" || prior.state === "retiring"))
      return { failure: "BUSY" };
    if (
      prior &&
      command.type === "recover" &&
      command.appliedSeq !== undefined &&
      (command.appliedSeq < prior.appliedSeq || command.appliedSeq > prior.sentSeq)
    )
      return { failure: "RESYNC_REQUIRED" };
    if (this.#nextToken === Number.MAX_SAFE_INTEGER) return { failure: "COUNTER_EXHAUSTED" };
    let route = prior;
    if (!route) {
      const connection = connectionKey(command.subscription);
      const entry = this.#connections.get(connection);
      if (
        this.#routes.size >=
          this.#budgets.authenticatedSockets * this.#budgets.subscriptionsPerConnection ||
        (entry?.count ?? 0) >= this.#budgets.subscriptionsPerConnection ||
        (!entry && this.#connections.size >= this.#budgets.authenticatedSockets)
      )
        return { failure: "BUSY" };
      const connectionLease = entry ? undefined : this.#reserve(ROUTE_RECORD_BYTES);
      if (!entry && !connectionLease) return { failure: "BUSY" };
      const lease = this.#reserve(ROUTE_RECORD_BYTES);
      if (!lease) {
        connectionLease?.release();
        return { failure: "BUSY" };
      }
      if (entry) entry.count++;
      else this.#connections.set(connection, { count: 1, lease: connectionLease! });
      route = {
        key,
        ref: structuredClone(command.subscription),
        run: source.run,
        lease,
        token: 0,
        mode: "baseline",
        state: "preparing",
        atSeq: 0,
        appliedSeq: 0,
        sentSeq: 0,
        frames: [],
        nextFrame: 0,
        parsedOrdinal: -1,
        logicalDebt: 0,
        sent: [],
        postN: [],
        postNBytes: 0,
        deadlineAt: undefined,
      };
      this.#routes.set(key, route);
    } else this.#fence(route);
    route.state = "preparing";
    route.token = ++this.#nextToken;
    const token = route.token;
    route.markerRequestId = command.requestId;
    route.deadlineAt = performance.now() + this.#budgets.recoveryDeadlineMs;
    route.appliedSeq =
      command.type === "subscribe" ? command.atSeq : (command.appliedSeq ?? route.appliedSeq);
    route.sentSeq = route.appliedSeq;
    this.#armTimer();
    const cursor = command.type === "subscribe" ? command.atSeq : command.appliedSeq;
    const current = source.replay.latestSeq;
    if (cursor !== undefined && cursor > current) {
      this.#fail(route, "RESYNC_REQUIRED");
      return { failure: "RESYNC_REQUIRED" };
    }
    const replay = cursor && cursor > 0 ? source.replay.select(cursor, current) : undefined;
    if (replay) {
      route.mode = "replay";
      route.replay = replay;
      route.atSeq = current;
      route.state = "transfer";
      return {
        result: this.#marker(command, "replay", current),
      };
    }
    route.mode = "baseline";
    let captured: EngineBaselineResult | undefined;
    let wakeDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = this.capture(source.run.runId, () =>
        source.captureBaseline((bytes) => {
          if (route.token !== token || route.state !== "preparing" || route.baselineLease)
            return false;
          const lease = this.#reserve(bytes);
          if (!lease) return false;
          if (route.token !== token || route.state !== "preparing") {
            lease.release();
            return false;
          }
          route.baselineLease = lease;
          return true;
        }),
      );
      const deadline = new Promise<undefined>((resolve) => {
        wakeDeadline = setTimeout(
          () => resolve(undefined),
          Math.max(0, Math.ceil(route.deadlineAt! - performance.now())),
        );
      });
      captured = await Promise.race([work, deadline]);
    } catch {
      this.#fail(route, "RESYNC_REQUIRED");
      return { failure: "RECOVERY_UNAVAILABLE" };
    } finally {
      if (wakeDeadline) clearTimeout(wakeDeadline);
    }
    if (!captured) {
      this.#fail(route, "RECOVERY_EXPIRED");
      return { failure: "RECOVERY_EXPIRED" };
    }
    if (route.token !== token || route.state !== "preparing")
      return { failure: route.failure ?? "RESYNC_REQUIRED" };
    if (captured.status !== "ready") {
      this.#fail(route, "RESYNC_REQUIRED");
      return { failure: "RECOVERY_UNAVAILABLE" };
    }
    const baseline = captured.baseline;
    if (this.#nextBaseline === Number.MAX_SAFE_INTEGER) {
      this.#fail(route, "RESYNC_REQUIRED");
      return { failure: "COUNTER_EXHAUSTED" };
    }
    const baselineId = `b${++this.#nextBaseline}`;
    const chunks: Uint8Array[] = [];
    for (const sourceBytes of [baseline.vt, baseline.tail])
      for (let offset = 0; offset < sourceBytes.byteLength; offset += 65_536)
        chunks.push(
          sourceBytes.subarray(offset, Math.min(sourceBytes.byteLength, offset + 65_536)),
        );
    const descriptor = {
      baselineId,
      run: route.run,
      subscription: route.ref,
      profile: baseline.profile,
      encoding: baseline.encoding,
      checkpointSeq: baseline.checkpointSeq,
      atSeq: baseline.atSeq,
      captureGeometry: baseline.captureGeometry,
      currentGeometry: baseline.currentGeometry,
      coverage: baseline.coverage,
      vtBytes: baseline.vt.byteLength,
      tailBytes: baseline.tail.byteLength,
      chunkCount: chunks.length,
    };
    if (!validateBaselineDescriptor(descriptor)) {
      this.#fail(route, "RESYNC_REQUIRED");
      return { failure: "RECOVERY_UNAVAILABLE" };
    }
    const start: PipeEvent = {
      type: "terminal-event",
      worker: this.#worker,
      run: route.run,
      subscription: route.ref,
      terminal: { type: "baseline-start", run: route.run, descriptor },
    };
    const frames: TransferFrame[] = [
      { event: start, payload: empty, ordinal: -1, charge: framedBytes(start, empty) },
    ];
    for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
      const event: PipeEvent = {
        type: "terminal-event",
        worker: this.#worker,
        run: route.run,
        subscription: route.ref,
        terminal: {
          type: "baseline-chunk",
          run: route.run,
          baselineId,
          subscription: route.ref,
          ordinal,
        },
      };
      frames.push({
        event,
        payload: chunks[ordinal]!,
        ordinal,
        charge: framedBytes(event, chunks[ordinal]!),
      });
    }
    const end: PipeEvent = {
      type: "terminal-event",
      worker: this.#worker,
      run: route.run,
      subscription: route.ref,
      terminal: {
        type: "baseline-end",
        run: route.run,
        baselineId,
        subscription: route.ref,
        chunkCount: chunks.length,
        totalBytes: baseline.vt.byteLength + baseline.tail.byteLength,
        atSeq: baseline.atSeq,
      },
    };
    frames.push({
      event: end,
      payload: empty,
      ordinal: chunks.length,
      charge: framedBytes(end, empty),
    });
    route.baselineLease?.shrinkTo(baseline.vt.byteLength + baseline.tail.byteLength + 4096);
    route.frames = frames;
    route.baselineId = baselineId;
    route.atSeq = baseline.atSeq;
    route.sentSeq = baseline.atSeq;
    for (const fact of route.postN.filter((fact) => fact.event.seq <= baseline.atSeq)) {
      fact.lease.release();
      route.postNBytes -= fact.charge;
    }
    route.postN = route.postN.filter((fact) => fact.event.seq > baseline.atSeq);
    route.state = "transfer";
    return { result: this.#marker(command, "baseline", baseline.atSeq) };
  }

  command(command: RouteCommand): Outcome {
    const route = this.#routes.get(keyOf(command.subscription));
    if (!route || !sameSubscriptionRef(route.ref, command.subscription))
      return { failure: "RESYNC_REQUIRED" };
    if (command.type === "unsubscribe") {
      this.#fence(route);
      route.state = "retiring";
      route.retireRequestId = command.requestId;
      return { result: this.#accepted(command) };
    }
    if (route.state === "tombstone" || route.state === "retiring")
      return { failure: route.failure ?? "RESYNC_REQUIRED" };
    if (route.state === "preparing") return { failure: "BUSY" };
    if (command.type === "baseline-progress") {
      if (
        route.mode !== "baseline" ||
        command.baselineId !== route.baselineId ||
        command.lastParsedOrdinal >= route.frames.length - 2 ||
        command.lastParsedOrdinal >= route.nextFrame - 1
      )
        return { failure: "RESYNC_REQUIRED" };
      if (command.lastParsedOrdinal > route.parsedOrdinal) {
        if (route.parsedOrdinal < 0) route.logicalDebt -= route.frames[0]?.charge ?? 0;
        for (const frame of route.frames)
          if (frame.ordinal > route.parsedOrdinal && frame.ordinal <= command.lastParsedOrdinal)
            route.logicalDebt -= frame.charge;
        route.parsedOrdinal = command.lastParsedOrdinal;
        this.capacity();
      }
      return { result: this.#accepted(command, { atSeq: route.atSeq }) };
    }
    if (command.appliedSeq > route.sentSeq || command.appliedSeq < route.appliedSeq)
      return { failure: "RESYNC_REQUIRED" };
    if (command.appliedSeq > route.appliedSeq) {
      for (const item of route.sent)
        if (item.seq > route.appliedSeq && item.seq <= command.appliedSeq)
          route.logicalDebt -= item.charge;
      route.sent = route.sent.filter((item) => item.seq > command.appliedSeq);
      route.appliedSeq = command.appliedSeq;
    }
    if (route.state === "transfer" && command.appliedSeq === route.atSeq) {
      if (route.mode === "baseline" && route.nextFrame < route.frames.length)
        return { failure: "RESYNC_REQUIRED" };
      if (route.mode === "replay" && route.nextFrame < (route.replay?.facts.length ?? 0))
        return { failure: "RESYNC_REQUIRED" };
      route.state = "installed";
      route.deadlineAt = undefined;
      route.logicalDebt = 0;
      route.frames = [];
      route.baselineLease?.release();
      route.baselineLease = undefined;
      route.replay?.release();
      route.replay = undefined;
      this.#armTimer();
      this.capacity();
    }
    return { result: this.#accepted(command, { atSeq: route.atSeq }) };
  }

  markerEnqueued(command: PipeCommand, response: PipeResult): void {
    if (command.type !== "subscribe" && command.type !== "recover") return;
    const route = this.#routes.get(keyOf(command.subscription));
    if (!route || route.markerRequestId !== command.requestId || response.outcome !== "accepted")
      return;
    route.markerRequestId = undefined;
    this.capacity();
  }

  responseSettled(requestId: string): void {
    for (const route of this.#routes.values())
      if (route.state === "retiring" && route.retireRequestId === requestId) this.#remove(route);
  }

  onFact(run: RunRef, fact: RetainedFact): void {
    for (const route of this.#routes.values()) {
      if (
        route.run.runId !== run.runId ||
        route.state === "tombstone" ||
        route.state === "retiring"
      )
        continue;
      if (fact.event.seq <= route.atSeq) continue;
      const payload = fact.bytes;
      const charge = 128 + (payload?.byteLength ?? 0);
      if (
        route.postN.length >= this.#budgets.postNEvents ||
        route.postNBytes + charge > this.#budgets.postNBytes
      ) {
        this.#fail(route, "RESYNC_REQUIRED");
        continue;
      }
      const lease = this.#reserve(charge);
      if (!lease) {
        this.#fail(route, "RESYNC_REQUIRED");
        continue;
      }
      route.postN.push({
        event: structuredClone(fact.event),
        ...(payload && { bytes: Uint8Array.from(payload) }),
        lease,
        charge,
      });
      route.postNBytes += charge;
    }
    this.capacity();
  }

  installed(ref: SubscriptionRef): boolean {
    return this.#routes.get(keyOf(ref))?.state === "installed";
  }

  capacity(): void {
    if (this.#deliveryScheduled) return;
    this.#deliveryScheduled = true;
    setImmediate(() => {
      this.#deliveryScheduled = false;
      this.#drain();
    });
  }

  shutdown(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    for (const route of [...this.#routes.values()]) this.#remove(route);
    for (const waiter of this.#captureWaiters.splice(0)) waiter.resolve();
  }

  #drain(): void {
    const routes = [...this.#routes.values()];
    if (!routes.length) return;
    let frames = 0;
    let bytes = 0;
    for (let offset = 0; offset < routes.length && frames < 32 && bytes < 256 * 1024; offset++) {
      const route = routes[(this.#deliveryCursor + offset) % routes.length]!;
      if (route.markerRequestId || (route.state !== "transfer" && route.state !== "installed"))
        continue;
      while (frames < 32 && bytes < 256 * 1024) {
        const next = this.#nextFrame(route);
        if (!next || route.logicalDebt + next.charge > this.#budgets.subscriptionCreditBytes) break;
        const token = route.token;
        const stateBeforeSend: Route["state"] = route.state;
        let accepted: number | false;
        try {
          accepted = this.#delivery.enqueue(next.event, next.payload, token);
        } catch {
          this.#fail(route, "RESYNC_REQUIRED");
          break;
        }
        if (route.token !== token || route.state !== stateBeforeSend) break;
        if (accepted === false) break;
        route.logicalDebt += accepted;
        frames++;
        bytes += accepted;
        next.commit();
      }
    }
    this.#deliveryCursor = (this.#deliveryCursor + 1) % routes.length;
    if (frames === 32 || bytes >= 256 * 1024) this.capacity();
  }

  #nextFrame(
    route: Route,
  ): { event: PipeEvent; payload: Uint8Array; charge: number; commit(): void } | undefined {
    if (route.state === "transfer" && route.mode === "baseline") {
      const frame = route.frames[route.nextFrame];
      if (!frame) return undefined;
      return {
        ...frame,
        commit: () => {
          route.nextFrame++;
        },
      };
    }
    if (route.state === "transfer" && route.mode === "replay") {
      const fact = route.replay?.facts[route.nextFrame];
      if (!fact) return undefined;
      const event = this.#factEvent(route, fact);
      const payload = fact.bytes ?? empty;
      const charge = framedBytes(event, payload);
      return {
        event,
        payload,
        charge,
        commit: () => {
          route.nextFrame++;
          route.sentSeq = fact.event.seq;
          route.sent.push({ seq: fact.event.seq, charge });
        },
      };
    }
    if (route.state === "installed") {
      const fact = route.postN[0];
      if (!fact) return undefined;
      const event = this.#factEvent(route, fact);
      const payload = fact.bytes ?? empty;
      const charge = framedBytes(event, payload);
      return {
        event,
        payload,
        charge,
        commit: () => {
          route.postN.shift();
          route.postNBytes -= fact.charge;
          route.sentSeq = fact.event.seq;
          route.sent.push({ seq: fact.event.seq, charge });
          fact.lease.release();
        },
      };
    }
    return undefined;
  }

  #factEvent(route: Route, fact: RetainedFact): PipeEvent {
    return {
      type: "terminal-event",
      worker: this.#worker,
      run: route.run,
      subscription: route.ref,
      terminal: fact.event,
    };
  }

  #marker(command: RecoveryCommand, mode: "baseline" | "replay", atSeq: number): PipeResult {
    return this.#accepted(command, { recoveryMode: mode, atSeq });
  }

  #accepted(command: PipeCommand, fields: Partial<PipeResult> = {}): PipeResult {
    return {
      type: "result",
      worker: command.worker,
      run: command.run,
      requestId: command.requestId,
      commandType: command.type,
      outcome: "accepted",
      ...fields,
    };
  }

  #fence(route: Route): void {
    this.#delivery.cancelUnsent(route.token);
    route.replay?.release();
    route.replay = undefined;
    route.baselineLease?.release();
    route.baselineLease = undefined;
    route.frames = [];
    route.nextFrame = 0;
    route.parsedOrdinal = -1;
    route.logicalDebt = 0;
    route.sent = [];
    for (const fact of route.postN) fact.lease.release();
    route.postN = [];
    route.postNBytes = 0;
  }

  #fail(route: Route, reason: "RESYNC_REQUIRED" | "RECOVERY_EXPIRED"): void {
    this.#fence(route);
    route.state = "tombstone";
    route.failure = reason;
    route.markerRequestId = undefined;
    route.deadlineAt = undefined;
    this.#armTimer();
  }

  #remove(route: Route): void {
    this.#fence(route);
    this.#routes.delete(route.key);
    route.lease.release();
    const key = connectionKey(route.ref);
    const connection = this.#connections.get(key);
    if (connection && --connection.count === 0) {
      connection.lease.release();
      this.#connections.delete(key);
    }
  }

  async #acquireCapture(runId: string): Promise<boolean> {
    if (this.#captures < this.#budgets.concurrentGenerationsPerWorker) {
      this.#captures++;
      return true;
    }
    if (this.#captureWaiters.length >= this.#budgets.pendingWorkerCommands) return false;
    await new Promise<void>((resolve) => this.#captureWaiters.push({ runId, resolve }));
    return !this.#closed && this.#captures <= this.#budgets.concurrentGenerationsPerWorker;
  }

  #releaseCapture(runId: string): void {
    this.#captures--;
    const alternate = this.#captureWaiters.findIndex((waiter) => waiter.runId !== runId);
    const index = alternate >= 0 ? alternate : 0;
    const next = this.#captureWaiters.splice(index, 1)[0];
    if (next) {
      this.#captures++;
      next.resolve();
    }
  }

  #armTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    const next = Math.min(...[...this.#routes.values()].flatMap((route) => route.deadlineAt ?? []));
    if (!Number.isFinite(next)) return;
    this.#timer = setTimeout(
      () => {
        const now = performance.now();
        for (const route of this.#routes.values())
          if (route.deadlineAt !== undefined && now >= route.deadlineAt)
            this.#fail(route, "RECOVERY_EXPIRED");
        this.#armTimer();
      },
      Math.max(0, Math.ceil(next - performance.now())),
    );
  }
}
