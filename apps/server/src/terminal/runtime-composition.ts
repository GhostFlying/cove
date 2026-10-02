import { validateEffectiveBudgets, type EffectiveBudgets } from "@cove/protocol/budgets";
import { OpaqueIdSchema, type RunRef } from "@cove/protocol/identity";
import { RuntimeRetainedBytes } from "./runtime-retained-bytes.js";

// Identity binds every owner to the same validated limits and aggregate account.
export class RuntimeComposition {
  readonly budgets: Readonly<EffectiveBudgets>;

  constructor(
    readonly serverId: string,
    readonly relayInstanceId: string,
    budgets: EffectiveBudgets,
    readonly bytes: RuntimeRetainedBytes,
  ) {
    const validated = validateEffectiveBudgets(budgets);
    if (
      !validated ||
      !OpaqueIdSchema.safeParse(serverId).success ||
      !OpaqueIdSchema.safeParse(relayInstanceId).success ||
      bytes.limit > validated.runtimeBytes
    )
      throw new Error("Invalid runtime composition");
    this.budgets = Object.freeze(validated);
    Object.freeze(this);
  }

  owns(ref: Pick<RunRef, "serverId" | "relayInstanceId">): boolean {
    return ref.serverId === this.serverId && ref.relayInstanceId === this.relayInstanceId;
  }
}
