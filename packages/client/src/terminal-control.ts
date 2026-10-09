import {
  nextCounter,
  sameConnectionRef,
  sameSubscriptionRef,
  type SubscriptionRef,
} from "@cove/protocol/identity";
import type { BaselineControl, RunEvent } from "@cove/protocol/terminal";

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
  // Authority across a resize-context recovery. Every grid change in M0 requires a baseline, and
  // a baseline subsumes the grant's ordered control fact, so the grant cannot become ready the
  // usual way. The server keeps this subscription as holder across recovery (recovery never sends
  // focus or blur), so the accepted grant, or the focus still awaiting its result, is carried
  // until the baseline reports the authority at its atSeq B. Epochs only increase and blur nulls
  // the holder within an epoch, so (grant epoch, this subscription) at B proves the grant held
  // continuously from its atSeq to B; anything else drops it. Input is not carried: recovery
  // still bumps the intent version, which cancels input queued before it.
  private recovering = false;
  private carried: Grant | undefined;
  private carriedIntent: number | undefined;
  private restoredGeneration = 0;

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

  get grantAtSeq(): number | undefined {
    return this.grant?.atSeq;
  }

  // True while the grant of `epoch` is accepted or carried across a recovery.
  keepsGrant(epoch: number): boolean {
    return this.grant?.epoch === epoch || this.carried?.epoch === epoch;
  }

  // True while the focus of `intent` began before a recovery and still awaits its result.
  carriesFocus(intent: number): boolean {
    return this.carriedIntent === intent && this.wantsFocus && !this.exited;
  }

  // True while this subscription's accepted grant is not contested by any control fact it has
  // seen, whether or not the grant fact has arrived or been applied yet. Unlike ready(), this does not require the
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
      // A grant accepted from its focus result may be newer than the last observed control fact
      // (e.g. reacquiring after another holder); that older fact does not contest it. An equal
      // epoch must name this holder, and observe() drops the grant on any newer epoch.
      (!observed ||
        observed.epoch < grant.epoch ||
        (observed.epoch === grant.epoch && heldBy(ref, observed)))
    );
  }

  beginFocus(): number | null {
    if (!this.wantsFocus || this.exited) return null;
    const next = nextCounter(this.intent);
    if (next === null) return null;
    this.intent = next;
    this.pending = next;
    this.grant = undefined;
    this.carried = undefined;
    this.carriedIntent = undefined;
    return next;
  }

  acceptFocus(
    intent: number,
    ref: SubscriptionRef,
    viewGeneration: number,
    epoch: number,
    atSeq: number,
  ): boolean {
    const carried = this.carriedIntent === intent;
    if ((this.pending !== intent && !carried) || !this.wantsFocus || this.exited) return false;
    if (this.observed && this.observed.epoch > epoch) return false;
    if (this.observed?.epoch === epoch && !heldBy(ref, this.observed)) return false;
    if (carried) {
      // The result of a focus sent before the recovery: hold it for the baseline's verdict, or,
      // once the baseline is in, bind it to the view generation the baseline produced.
      this.carriedIntent = undefined;
      if (this.recovering) this.carried = { intent, ref, viewGeneration, epoch, atSeq };
      else this.grant = { intent, ref, viewGeneration: this.restoredGeneration, epoch, atSeq };
      return true;
    }
    this.pending = undefined;
    this.grant = { intent, ref, viewGeneration, epoch, atSeq };
    return true;
  }

  failFocus(intent: number): void {
    if (this.pending === intent) this.pending = undefined;
    if (this.carriedIntent === intent) this.carriedIntent = undefined;
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
    this.recovering = false;
    this.carried = undefined;
    this.carriedIntent = undefined;
  }

  // A resize-context recovery: reset like any recovery, but carry the grant or pending focus.
  suspendForRecovery(): void {
    const grant = this.grant;
    const pending = this.pending;
    this.resetForRecovery();
    if (!this.wantsFocus || this.exited) return;
    this.recovering = true;
    this.carried = grant;
    this.carriedIntent = grant ? undefined : pending;
  }

  // Installs the authority a completed baseline reports at its atSeq and settles a carried grant.
  restore(
    control: BaselineControl,
    atSeq: number,
    run: ControlFact["run"],
    geometry: ControlFact["geometry"],
    ref: SubscriptionRef,
    viewGeneration: number,
  ): void {
    const canonical: ControlFact = Object.freeze({
      type: "control",
      run: Object.freeze({ ...run }),
      seq: atSeq,
      epoch: control.epoch,
      holder: control.holder
        ? Object.freeze({
            ...control.holder,
            connection: Object.freeze({ ...control.holder.connection }),
          })
        : null,
      geometry: Object.freeze({ ...geometry }),
    });
    // Control facts after atSeq may already have been observed on arrival; keep the newer one.
    const observed = this.observed;
    if (
      !observed ||
      canonical.epoch > observed.epoch ||
      (canonical.epoch === observed.epoch && canonical.seq >= observed.seq)
    )
      this.observed = canonical;
    this.applied = canonical;
    const carried = this.carried;
    this.recovering = false;
    this.carried = undefined;
    this.restoredGeneration = viewGeneration;
    if (!carried || !this.wantsFocus || this.exited || !sameSubscriptionRef(carried.ref, ref))
      return;
    // An older epoch at B is acceptable only while the grant's own fact is still ahead (B < A):
    // it is then applied from the ordered stream and checked like any grant. An older epoch at or
    // after A contradicts the grant and drops it. The same epoch must still name this
    // subscription, at or after A.
    const kept =
      (canonical.epoch < carried.epoch && atSeq < carried.atSeq) ||
      (canonical.epoch === carried.epoch && heldBy(ref, canonical) && atSeq >= carried.atSeq);
    const latest = this.observed!;
    if (
      !kept ||
      latest.epoch > carried.epoch ||
      (latest.epoch === carried.epoch && !heldBy(ref, latest))
    )
      return;
    this.grant = { ...carried, viewGeneration };
  }

  // A recovery that ended without a baseline cannot vouch for a carried grant.
  finishRecovery(): void {
    if (!this.recovering) return;
    this.recovering = false;
    this.carried = undefined;
    this.carriedIntent = undefined;
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
