import {
  nextCounter,
  sameConnectionRef,
  sameSubscriptionRef,
  type SubscriptionRef,
} from "@cove/protocol/identity";
import type { RunEvent } from "@cove/protocol/terminal";

type ControlFact = Extract<RunEvent, { type: "control" }>;

interface Grant {
  readonly ref: SubscriptionRef;
  readonly viewGeneration: number;
  readonly intent: number;
  readonly epoch: number;
  readonly atSeq: number;
}

function heldBy(ref: SubscriptionRef, fact: ControlFact): boolean {
  const holder = fact.holder;
  return (
    holder !== null &&
    sameConnectionRef(holder.connection, ref.connection) &&
    holder.viewId === ref.viewId &&
    holder.subscriptionId === ref.subscriptionId
  );
}

// A focus result is only a candidate grant until its ordered control fact is parsed.
export class TerminalControl {
  private intent = 0;
  private foreground = false;
  private target = false;
  private pending: number | undefined;
  private grant: Grant | undefined;
  private observed: ControlFact | undefined;
  private applied: ControlFact | undefined;
  private readonly canonicalFacts = new WeakMap<object, ControlFact>();
  private reconnectFocus = false;
  private exited = false;

  setTarget(foreground: boolean, target: boolean): void {
    this.foreground = foreground;
    this.target = foreground && target;
    if (!this.target) this.invalidate();
  }

  get wantsFocus(): boolean {
    return this.foreground && this.target;
  }

  get hostForeground(): boolean {
    return this.foreground;
  }

  get intentVersion(): number {
    return this.intent;
  }

  get pendingIntent(): number | undefined {
    return this.pending;
  }

  get epoch(): number | undefined {
    return this.grant?.epoch;
  }

  // True while this subscription's accepted grant is still the newest control fact it has seen,
  // whether or not the grant fact has been applied yet. Unlike ready(), this does not require the
  // grant to be usable for input; it only says that asking for focus again would add nothing.
  holds(ref: SubscriptionRef, viewGeneration: number): boolean {
    const grant = this.grant;
    const observed = this.observed;
    return (
      this.wantsFocus &&
      !this.exited &&
      !!grant &&
      sameSubscriptionRef(grant.ref, ref) &&
      grant.viewGeneration === viewGeneration &&
      (!observed || (observed.epoch === grant.epoch && heldBy(ref, observed)))
    );
  }

  beginFocus(): number | null {
    if (!this.wantsFocus || this.exited) return null;
    const next = nextCounter(this.intent);
    if (next === null) return null;
    this.intent = next;
    this.pending = next;
    this.grant = undefined;
    return next;
  }

  acceptFocus(
    intent: number,
    ref: SubscriptionRef,
    viewGeneration: number,
    epoch: number,
    atSeq: number,
  ): boolean {
    if (this.pending !== intent || !this.wantsFocus || this.exited) return false;
    if (this.observed && this.observed.epoch > epoch) return false;
    if (this.observed?.epoch === epoch && !heldBy(ref, this.observed)) return false;
    this.pending = undefined;
    this.grant = { intent, ref, viewGeneration, epoch, atSeq };
    return true;
  }

  failFocus(intent: number): void {
    if (this.pending === intent) this.pending = undefined;
  }

  observe(fact: ControlFact, ref: SubscriptionRef): boolean {
    const canonical: ControlFact = Object.freeze({
      ...fact,
      run: Object.freeze({ ...fact.run }),
      holder: fact.holder
        ? Object.freeze({
            ...fact.holder,
            connection: Object.freeze({ ...fact.holder.connection }),
          })
        : null,
      geometry: Object.freeze({ ...fact.geometry }),
    });
    const previous = this.observed;
    if (previous && canonical.epoch < previous.epoch) return false;
    if (previous && canonical.epoch === previous.epoch && canonical.seq < previous.seq)
      return false;
    this.canonicalFacts.set(fact, canonical);
    this.observed = canonical;
    if (this.grant && (canonical.epoch > this.grant.epoch || !heldBy(ref, canonical))) {
      this.grant = undefined;
      this.pending = undefined;
    }
    return true;
  }

  apply(fact: object): ControlFact | undefined {
    const canonical = this.canonicalFacts.get(fact);
    if (canonical && (!this.applied || canonical.epoch >= this.applied.epoch)) {
      this.applied = canonical;
      return canonical;
    }
    return undefined;
  }

  ready(ref: SubscriptionRef, viewGeneration: number, appliedSeq: number): boolean {
    const grant = this.grant;
    const applied = this.applied;
    const observed = this.observed;
    return (
      this.wantsFocus &&
      !this.exited &&
      !!grant &&
      sameSubscriptionRef(grant.ref, ref) &&
      grant.viewGeneration === viewGeneration &&
      appliedSeq >= grant.atSeq &&
      !!applied &&
      applied.epoch === grant.epoch &&
      heldBy(ref, applied) &&
      (!observed || (observed.epoch === grant.epoch && heldBy(ref, observed)))
    );
  }

  currentEpoch(ref: SubscriptionRef, viewGeneration: number, appliedSeq: number): number | null {
    return this.ready(ref, viewGeneration, appliedSeq) ? this.grant!.epoch : null;
  }

  invalidate(): void {
    this.intent = nextCounter(this.intent) ?? -1;
    this.pending = undefined;
    this.grant = undefined;
  }

  resetForRecovery(): void {
    this.invalidate();
    this.observed = undefined;
    this.applied = undefined;
  }

  connectionLost(): void {
    this.reconnectFocus = this.wantsFocus;
    this.resetForRecovery();
  }

  takeReconnectFocus(): boolean {
    const focus = this.reconnectFocus && this.wantsFocus;
    this.reconnectFocus = false;
    return focus;
  }

  replaceView(): void {
    this.foreground = false;
    this.target = false;
    this.reconnectFocus = false;
    this.resetForRecovery();
  }

  exit(): void {
    this.exited = true;
    this.resetForRecovery();
  }

  dispose(): void {
    this.replaceView();
    this.exited = true;
  }
}
