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

// The one rule for whether control authority known as of `fact.seq` rules out this
// subscription's grant of `epoch` at `atSeq`. The server raises the epoch on every grant and a
// blur nulls the holder within its epoch, so authority at any seq >= atSeq has an epoch >= the
// grant's and, at the grant's epoch, names this holder until the grant ends. Hence:
// - a newer epoch, or the same epoch naming another holder or none, ends the grant;
// - an older epoch is consistent only before atSeq (the grant's own fact is still ahead) and
//   contradicts the grant at or after it.
// Observed facts, baseline authority and late focus results all use this check, so no path
// can revoke a grant with an older fact or install one a known later authority rules out.
function contradicts(
  grant: { readonly epoch: number; readonly atSeq: number },
  ref: SubscriptionRef,
  fact: ControlFact,
): boolean {
  if (fact.epoch > grant.epoch) return true;
  if (fact.epoch === grant.epoch) return !heldBy(ref, fact);
  return fact.seq >= grant.atSeq;
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
  // Counts every loss of the input target. A request made while the target was wanted is
  // superseded by any later loss, even if the target is wanted again by the time it is checked.
  private targetLosses = 0;

  setTarget(foreground: boolean, target: boolean): void {
    this.foreground = foreground;
    this.target = foreground && target;
    if (!this.target) {
      this.targetLosses++;
      this.invalidate();
    }
  }

  get targetVersion(): number {
    return this.targetLosses;
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

  // The epoch this subscription holds (accepted grant) or carries across a recovery, if any. An
  // unfocus records it as the epoch to release (relay-protocol 9.1).
  get heldEpoch(): number | undefined {
    return this.grant?.epoch ?? this.carried?.epoch;
  }

  // The focus intent whose grant is held or carried, so its requested grid can be looked up.
  get heldIntent(): number | undefined {
    return this.grant?.intent ?? this.carried?.intent;
  }

  get carriesGrant(): boolean {
    return this.carried !== undefined;
  }

  // True when the authority known now proves that `epoch` is no longer this subscription's: a
  // newer epoch, or the same epoch naming another holder or none. An older epoch proves nothing
  // (the grant's own fact may still be ahead), so a blur of `epoch` is still sent then.
  rulesOut(epoch: number, ref: SubscriptionRef): boolean {
    const observed = this.observed;
    if (!observed) return false;
    return observed.epoch > epoch || (observed.epoch === epoch && !heldBy(ref, observed));
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
      // (e.g. reacquiring after another holder); an older fact before the grant's seq does not
      // contest it.
      (!observed || !contradicts(grant, ref, observed))
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
    // Includes a result that arrives after a baseline: an older epoch at B >= atSeq rules it out.
    if (this.observed && contradicts({ epoch, atSeq }, ref, this.observed)) return false;
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
    if (this.grant && contradicts(this.grant, ref, canonical)) {
      this.grant = undefined;
      this.pending = undefined;
    }
    if (this.carried && contradicts(this.carried, ref, canonical)) this.carried = undefined;
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

  // A resize-context recovery: reset like any recovery, but carry the grant or the focus still
  // awaiting its result. That focus may already be carried from an earlier resize recovery, so a
  // second recovery keeps it until its result arrives or it is explicitly invalidated.
  suspendForRecovery(): void {
    const grant = this.grant;
    const pending = this.pending ?? this.carriedIntent;
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
    // Exact (epoch, this subscription) at B reinstates the grant; an older epoch at B keeps it only
    // while its own fact is still ahead (B < A), to be applied from the ordered stream. A newer
    // fact observed after B must not contradict it either.
    if (contradicts(carried, ref, canonical) || contradicts(carried, ref, this.observed!)) return;
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
