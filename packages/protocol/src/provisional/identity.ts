import { z } from "zod";

export const OpaqueIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const SequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const RunRefSchema = z.object({
  serverId: OpaqueIdSchema,
  relayInstanceId: OpaqueIdSchema,
  runId: OpaqueIdSchema,
});
export type RunRef = z.infer<typeof RunRefSchema>;

export const WorkerRefSchema = z.object({
  serverId: OpaqueIdSchema,
  relayInstanceId: OpaqueIdSchema,
  workerId: OpaqueIdSchema,
  workerIncarnationId: OpaqueIdSchema,
});
export type WorkerRef = z.infer<typeof WorkerRefSchema>;

export function sameRunRef(left: RunRef, right: RunRef): boolean {
  return (
    left.serverId === right.serverId &&
    left.relayInstanceId === right.relayInstanceId &&
    left.runId === right.runId
  );
}

export function sameWorkerRef(left: WorkerRef, right: WorkerRef): boolean {
  return (
    left.serverId === right.serverId &&
    left.relayInstanceId === right.relayInstanceId &&
    left.workerId === right.workerId &&
    left.workerIncarnationId === right.workerIncarnationId
  );
}

export function workerMatchesRun(worker: WorkerRef, run: RunRef): boolean {
  return worker.serverId === run.serverId && worker.relayInstanceId === run.relayInstanceId;
}
