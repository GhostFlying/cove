import { z } from "zod";
import { HEADER_BYTES, MAX_FRAME_BYTES, MAX_METADATA_BYTES } from "./provisional/frame.js";

export const M0_LIMITS = Object.freeze({
  maxRuns: 128,
  maxCols: 120,
  maxRows: 40,
  historyLines: 1000,
  listPage: 128,
  baselineVtBytes: 8 * 1024 * 1024,
  baselineTailBytes: 64 * 1024,
  baselineChunks: 129,
  recoveryDeadlineMs: 15_000,
  concurrentGenerationsPerWorker: 2,
  replayBytes: 1024 * 1024,
  replayEvents: 4096,
  postNBytes: 1024 * 1024,
  postNEvents: 4096,
  parseLowBytes: 128 * 1024,
  parseHighBytes: 512 * 1024,
  parseHardBytes: 1024 * 1024,
  inputQueueBytes: 64 * 1024,
  pendingWorkerCommands: 256,
  subscriptionCreditBytes: 256 * 1024,
  outboundConnectionBytes: 1024 * 1024,
  reservedControlBytes: 64 * 1024,
  subscriptionsPerConnection: 16,
  authenticatedSockets: 32,
  unauthenticatedSockets: 8,
  pipeQueuedBytes: 4 * 1024 * 1024,
  previewBytesPerRun: 64 * 1024,
  previewGlobalBytes: 8 * 1024 * 1024,
  previewRefreshes: 4,
  bootstrapBytes: 8 * 1024,
  rpcRequestBytes: 64 * 1024,
  rpcResponseBytes: 256 * 1024,
  rpcBatch: 16,
  rpcInflight: 32,
  operationReceipts: 4096,
  canonicalIntentBytes: 8 * 1024,
  operationRecordBytes: 4 * 1024,
  runtimeBytes: 256 * 1024 * 1024,
  workerBytes: 64 * 1024 * 1024,
  executableBytes: 4096,
  cwdBytes: 4096,
  argvCount: 64,
  argvBytes: 8 * 1024,
  capabilityCount: 32,
});
export type M0Limits = typeof M0_LIMITS;

const entries = Object.entries(M0_LIMITS) as [keyof M0Limits, number][];
export const EffectiveBudgetsSchema = z.object(
  Object.fromEntries(
    entries.map(([key, maximum]) => [key, z.number().int().min(1).max(maximum)]),
  ) as {
    [K in keyof M0Limits]: z.ZodNumber;
  },
);
export type EffectiveBudgets = z.infer<typeof EffectiveBudgetsSchema>;

export function validateEffectiveBudgets(input: unknown): EffectiveBudgets | null {
  const parsed = EffectiveBudgetsSchema.safeParse(input);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (value.parseLowBytes >= value.parseHighBytes || value.parseHighBytes >= value.parseHardBytes)
    return null;
  if (value.baselineChunks * 65_536 < value.baselineVtBytes + value.baselineTailBytes) return null;
  if (value.subscriptionCreditBytes < MAX_FRAME_BYTES) return null;
  if (value.outboundConnectionBytes < value.subscriptionCreditBytes) return null;
  if (value.reservedControlBytes < HEADER_BYTES + MAX_METADATA_BYTES) return null;
  if (value.pipeQueuedBytes < MAX_FRAME_BYTES) return null;
  if (value.previewGlobalBytes < value.maxRuns * value.previewBytesPerRun) return null;
  if (value.maxRuns < 1 || value.listPage > value.maxRuns) return null;
  return value;
}
