import { z } from "zod";
import {
  OpaqueIdSchema,
  RunRefSchema,
  SequenceSchema,
  WorkerRefSchema,
  sameRunRef,
  sameWorkerRef,
  workerMatchesRun,
} from "./provisional/identity.js";

export {
  OpaqueIdSchema,
  RunRefSchema,
  SequenceSchema,
  WorkerRefSchema,
  sameRunRef,
  sameWorkerRef,
  workerMatchesRun,
};
export type { RunRef, WorkerRef } from "./provisional/identity.js";

export const ConnectionRefSchema = z.object({
  connectionId: OpaqueIdSchema,
  generation: SequenceSchema,
});
export type ConnectionRef = z.infer<typeof ConnectionRefSchema>;

export const SubscriptionRefSchema = z.object({
  run: RunRefSchema,
  connection: ConnectionRefSchema,
  subscriptionId: OpaqueIdSchema,
  viewId: OpaqueIdSchema,
});
export type SubscriptionRef = z.infer<typeof SubscriptionRefSchema>;

export function sameConnectionRef(left: ConnectionRef, right: ConnectionRef): boolean {
  return left.connectionId === right.connectionId && left.generation === right.generation;
}

export function sameSubscriptionRef(left: SubscriptionRef, right: SubscriptionRef): boolean {
  return (
    sameRunRef(left.run, right.run) &&
    sameConnectionRef(left.connection, right.connection) &&
    left.subscriptionId === right.subscriptionId &&
    left.viewId === right.viewId
  );
}

export function nextCounter(value: number): number | null {
  if (!SequenceSchema.safeParse(value).success || value === Number.MAX_SAFE_INTEGER) return null;
  return value + 1;
}
