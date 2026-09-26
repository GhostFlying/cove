import { z } from "zod";
import { DomainErrorSchema } from "./errors.js";
import {
  ConnectionRefSchema,
  OpaqueIdSchema,
  RunRefSchema,
  SequenceSchema,
  SubscriptionRefSchema,
} from "./identity.js";
import {
  AppearanceSchema,
  BaselineEncodingSchema,
  GeometrySchema,
  ProfileSchema,
} from "./profile.js";

const request = { requestId: OpaqueIdSchema, run: RunRefSchema };
const subscription = { ...request, subscription: SubscriptionRefSchema };
const epoch = SequenceSchema.min(1);
const resume = z.object({
  appliedSeq: SequenceSchema,
  profile: ProfileSchema,
  encoding: BaselineEncodingSchema,
  geometry: GeometrySchema,
});
export const ResumeSchema = resume;

export const TerminalCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attach"),
    ...request,
    connection: ConnectionRefSchema,
    viewId: OpaqueIdSchema,
    profile: ProfileSchema,
    encoding: BaselineEncodingSchema,
    resume: resume.optional(),
  }),
  z.object({ type: z.literal("detach"), ...subscription }),
  z.object({
    type: z.literal("recover"),
    ...subscription,
    reason: z.enum(["gap", "released-view", "resize-context", "expired"]),
    resume: resume.optional(),
  }),
  z.object({
    type: z.literal("focus"),
    ...subscription,
    focusSeq: epoch,
    geometry: GeometrySchema,
    appearance: AppearanceSchema.optional(),
  }),
  z.object({ type: z.literal("blur"), ...subscription, epoch }),
  z.object({ type: z.literal("resize"), ...subscription, epoch, geometry: GeometrySchema }),
  z.object({ type: z.literal("appearance"), ...subscription, epoch, appearance: AppearanceSchema }),
  z.object({ type: z.literal("input"), ...subscription, epoch, inputSeq: epoch }),
  z.object({ type: z.literal("applied-ack"), ...subscription, appliedSeq: SequenceSchema }),
  z.object({
    type: z.literal("baseline-progress"),
    ...subscription,
    baselineId: OpaqueIdSchema,
    lastParsedOrdinal: z.number().int().min(0).max(128),
  }),
  z.object({ type: z.literal("preview"), ...request, knownVersion: SequenceSchema.optional() }),
]);
export type TerminalCommand = z.infer<typeof TerminalCommandSchema>;
export type TerminalCommandType = TerminalCommand["type"];

const correlated = { requestId: OpaqueIdSchema, run: RunRefSchema };
export const TerminalResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attach-result"),
    ...correlated,
    subscription: SubscriptionRefSchema,
    mode: z.enum(["replay", "baseline"]),
    atSeq: SequenceSchema,
  }),
  z.object({
    type: z.literal("detach-result"),
    ...correlated,
    subscription: SubscriptionRefSchema,
    detached: z.literal(true),
  }),
  z.object({
    type: z.literal("recover-result"),
    ...correlated,
    subscription: SubscriptionRefSchema,
    replacement: SubscriptionRefSchema,
    mode: z.enum(["replay", "baseline"]),
    atSeq: SequenceSchema,
  }),
  z.object({
    type: z.literal("focus-result"),
    ...correlated,
    subscription: SubscriptionRefSchema,
    epoch,
    atSeq: SequenceSchema,
  }),
  z.object({
    type: z.literal("blur-result"),
    ...correlated,
    subscription: SubscriptionRefSchema,
    epoch,
    atSeq: SequenceSchema,
  }),
  z.object({
    type: z.literal("resize-result"),
    ...correlated,
    subscription: SubscriptionRefSchema,
    epoch,
    atSeq: SequenceSchema,
  }),
  z.object({
    type: z.literal("appearance-result"),
    ...correlated,
    subscription: SubscriptionRefSchema,
    epoch,
    atSeq: SequenceSchema,
  }),
  z.object({
    type: z.literal("input-result"),
    ...correlated,
    subscription: SubscriptionRefSchema,
    epoch,
    inputSeq: epoch,
    status: z.literal("written"),
    writtenBytes: z.number().int().min(1).max(65_536),
  }),
  z.object({
    type: z.literal("applied-ack-result"),
    ...correlated,
    subscription: SubscriptionRefSchema,
    appliedSeq: SequenceSchema,
  }),
  z.object({
    type: z.literal("baseline-progress-result"),
    ...correlated,
    subscription: SubscriptionRefSchema,
    baselineId: OpaqueIdSchema,
    lastParsedOrdinal: z.number().int().min(0).max(128),
  }),
  z.object({
    type: z.literal("preview-result"),
    ...correlated,
    status: z.enum(["unchanged", "transfer"]),
    version: SequenceSchema,
  }),
]);
export type TerminalResult = z.infer<typeof TerminalResultSchema>;

export const TerminalErrorSchema = z.object({
  type: z.literal("error"),
  ...correlated,
  commandType: z.enum([
    "attach",
    "detach",
    "recover",
    "focus",
    "blur",
    "resize",
    "appearance",
    "input",
    "applied-ack",
    "baseline-progress",
    "preview",
  ]),
  error: DomainErrorSchema,
});
export type TerminalError = z.infer<typeof TerminalErrorSchema>;
