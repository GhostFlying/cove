import { ActionError } from "./action-error.js";
import type { ServerSession, RpcMethod } from "@cove/client";
import {
  canonicalWriteIntent,
  isWriteRpcMethod,
  validateRpcMethodParams,
  OperationRecordSchema,
} from "@cove/protocol/rpc";
import { LocalStore, type Profile, type Journal } from "./local-store.js";
import { utf8 } from "./codec.js";

export class Operations {
  constructor(
    private readonly store: LocalStore,
    private readonly uuid: () => string,
    private readonly digest: (intent: string) => Promise<string>,
  ) {}
  async write(
    profile: Profile,
    session: ServerSession,
    method: RpcMethod,
    params: Record<string, unknown>,
    summary: string,
  ) {
    if (!isWriteRpcMethod(method)) throw new ActionError("Expected an explicit write");
    const state = session.snapshot();
    if (state.status !== "current" || state.identity?.serverId !== profile.serverId)
      throw new ActionError("Connect and verify server first");
    const operationId = this.uuid();
    const parsed = validateRpcMethodParams(method, { ...params, operationId });
    const intent = parsed && canonicalWriteIntent(method, parsed.params, utf8.encode);
    if (!parsed || !intent) throw new ActionError("Check the entered fields");
    // The public canonical digest identifies this immutable request. The display summary is
    // deliberately not an exact request copy, and there is no journal-to-dispatch path.
    const row: Journal = {
      profileId: profile.id,
      serverId: profile.serverId,
      relayInstanceId: state.identity.relayInstanceId,
      operationId,
      method,
      digest: await this.digest(intent),
      summary,
      state: "pending",
      observation: "unqueried",
      createdAt: Date.now(),
    };
    await this.store.putOperation(row, true);
    // Background/forget while durable admission waited cannot dispatch against a new owner.
    const currentProfile = (await this.store.profiles()).find((p) => p.id === profile.id);
    if (currentProfile?.state !== "ready" || session.snapshot().generation !== state.generation) {
      await this.store.putOperation({ ...row, state: "not-sent" });
      throw new ActionError("Connection changed before dispatch; nothing sent");
    }
    const outcome = await session.call(parsed.method, parsed.params as never);
    const record =
      outcome.ok && outcome.value && typeof outcome.value === "object"
        ? OperationRecordSchema.safeParse((outcome.value as { operation?: unknown }).operation)
        : undefined;
    const observed =
      record?.success && record.data.operationId === operationId && record.data.method === method
        ? record.data
        : undefined;
    await this.store.putOperation({
      ...row,
      state: observed
        ? "observed"
        : !outcome.ok &&
            (outcome.kind === "operation-not-sent" ||
              outcome.kind === "local-error" ||
              (outcome.kind === "rpc-error" &&
                "acceptance" in outcome.error &&
                outcome.error.acceptance === "not-accepted"))
          ? "not-sent"
          : "unknown",
      observation: observed ? "record" : "unqueried",
      ...(observed ? { record: observed } : {}),
    });
    return outcome;
  }
  async reconcile(profile: Profile, session: ServerSession, operationId: string): Promise<void> {
    const row = (await this.store.operations()).find((v) => v.operationId === operationId);
    if (!row || row.profileId !== profile.id || row.serverId !== profile.serverId)
      throw new ActionError("Original credential slot is required");
    const generation = session.snapshot().generation;
    const outcome = await session.call("operation.get", { operationId });
    if (session.snapshot().generation !== generation) return;
    if (outcome.ok && outcome.value.operation.method === row.method) {
      await this.store.putOperation({
        ...row,
        state: "observed",
        observation: "record",
        record: outcome.value.operation,
      });
    } else {
      const missing =
        !outcome.ok &&
        outcome.kind === "rpc-error" &&
        "kind" in outcome.error &&
        outcome.error.kind === "OPERATION_NOT_FOUND";
      await this.store.putOperation({
        ...row,
        state: row.state === "pending" ? "unknown" : row.state,
        observation: missing ? "not-found" : "unavailable",
      });
    }
  }
  async acknowledge(session: ServerSession | undefined, id: string): Promise<void> {
    if (session?.snapshot().operations.some((v) => v.reference.operationId === id)) {
      await session.reconcileOperations();
      if (!session.forgetOperation(id))
        throw new ActionError("Session operation remains unresolved");
    }
    await this.store.acknowledge(id);
  }
}
