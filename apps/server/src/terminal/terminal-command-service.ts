import type { TerminalCommand } from "@cove/protocol/terminal";
import { ControlArbiter } from "./control-arbiter.js";
import { LocalRuntime } from "./local-runtime.js";
import { RuntimeComposition } from "./runtime-composition.js";
import { TerminalConnectionDelivery } from "./terminal-connection-delivery.js";
import { TerminalSubscriptions } from "./terminal-subscriptions.js";

// The connection consumes commands; its shared runtime arbiter owns control order.
export class TerminalCommandService {
  readonly subscriptions: TerminalSubscriptions;
  constructor(
    composition: RuntimeComposition,
    runtime: LocalRuntime,
    delivery: TerminalConnectionDelivery,
    readonly arbiter: ControlArbiter,
    options: {
      createOpaqueId: () => string;
      now: () => number;
      identityLimit: number;
      requestLimit: number;
    },
  ) {
    if (arbiter.runtime !== runtime || arbiter.composition !== composition)
      throw new Error("Control composition mismatch");
    this.subscriptions = new TerminalSubscriptions(composition, runtime, delivery, {
      ...options,
      arbiter,
    });
  }
  handle(command: TerminalCommand, payload: Uint8Array = new Uint8Array()) {
    return this.subscriptions.handle(command, payload);
  }
  get handoff() {
    return this.subscriptions.handoff;
  }
  get closed() {
    return this.subscriptions.closed;
  }
  get previewCache() {
    return this.subscriptions.runtime.previews.cache;
  }
  close(): void {
    this.subscriptions.close();
  }
  tick(): void {
    this.subscriptions.tick();
  }
  snapshot(subscriptionId?: string) {
    return this.subscriptions.snapshot(subscriptionId);
  }
}
