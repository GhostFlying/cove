import { z } from "zod";
import { M0_LIMITS } from "./budgets.js";
import { DomainErrorSchema, ERROR_CODES } from "./errors.js";
import { OpaqueIdSchema } from "./identity.js";
import { composeSpawnPayload } from "./pipe.js";
import { boundedJsonStructure } from "./terminal.js";
import {
  OperationRecordSchema,
  RPC_METHODS,
  validateRpcMethodParams,
  type OperationRecord,
  type RpcMethod,
} from "./rpc-methods.js";

export const JSON_RPC_VERSION = "2.0" as const;
export const STANDARD_RPC_ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
});
export const RpcIdSchema = z.union([z.string().max(128), z.number().finite(), z.null()]);
export type RpcId = z.infer<typeof RpcIdSchema>;
export const STANDARD_RPC_MESSAGES = Object.freeze({
  [-32700]: "Parse error",
  [-32600]: "Invalid Request",
  [-32601]: "Method not found",
  [-32602]: "Invalid params",
  [-32603]: "Internal error",
});
const rpcError = z
  .object({
    code: z.number().int(),
    message: z.string().min(1).max(256),
    data: DomainErrorSchema.optional(),
  })
  .refine((value) => {
    const standard = STANDARD_RPC_MESSAGES[value.code as keyof typeof STANDARD_RPC_MESSAGES];
    if (standard) return value.message === standard && value.data === undefined;
    return (
      !!value.data &&
      value.code === ERROR_CODES[value.data.kind] &&
      value.message === value.data.message
    );
  });
export const RpcRequestSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  method: z.string().min(1).max(128),
  params: z.record(z.string(), z.unknown()).optional(),
  id: RpcIdSchema.optional(),
});
export const RpcResultSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: RpcIdSchema,
  result: z.unknown(),
});
export const RpcErrorSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: RpcIdSchema,
  error: rpcError,
});
export type RpcResult = z.infer<typeof RpcResultSchema>;
export type RpcError = z.infer<typeof RpcErrorSchema>;
export type RpcResponse = RpcResult | RpcError;

function standardError(code: number, message: string, id: RpcId = null): RpcError {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}
export type RpcDisposition =
  | { kind: "call"; id: RpcId; method: RpcMethod; params: Record<string, unknown> }
  | { kind: "notification"; method: string; params: Record<string, unknown> | null }
  | { kind: "error"; response: RpcError };

export function classifyRpcItem(input: unknown): RpcDisposition {
  if (!boundedJsonStructure(input) || !input || typeof input !== "object" || Array.isArray(input))
    return {
      kind: "error",
      response: standardError(STANDARD_RPC_ERRORS.invalidRequest, "Invalid Request"),
    };
  const record = input as Record<string, unknown>;
  if (
    record.jsonrpc !== JSON_RPC_VERSION ||
    typeof record.method !== "string" ||
    record.method.length === 0 ||
    record.method.length > 128 ||
    (Object.hasOwn(record, "id") && !RpcIdSchema.safeParse(record.id).success)
  )
    return {
      kind: "error",
      response: standardError(STANDARD_RPC_ERRORS.invalidRequest, "Invalid Request"),
    };
  const notification = !Object.hasOwn(record, "id");
  if (!Object.hasOwn(RPC_METHODS, record.method))
    return notification
      ? { kind: "notification", method: record.method, params: null }
      : {
          kind: "error",
          response: standardError(
            STANDARD_RPC_ERRORS.methodNotFound,
            "Method not found",
            record.id as RpcId,
          ),
        };
  const params = record.params === undefined ? {} : record.params;
  if (!params || typeof params !== "object" || Array.isArray(params))
    return notification
      ? { kind: "notification", method: record.method, params: null }
      : {
          kind: "error",
          response: standardError(
            STANDARD_RPC_ERRORS.invalidParams,
            "Invalid params",
            record.id as RpcId,
          ),
        };
  const parsed = validateRpcMethodParams(record.method, params);
  if (!parsed) {
    if (notification) return { kind: "notification", method: record.method, params: null };
    return {
      kind: "error",
      response: standardError(
        STANDARD_RPC_ERRORS.invalidParams,
        "Invalid params",
        record.id as RpcId,
      ),
    };
  }
  return notification
    ? { kind: "notification", method: parsed.method, params: parsed.params }
    : { kind: "call", id: record.id as RpcId, method: parsed.method, params: parsed.params };
}

export function classifyRpcEnvelope(input: unknown, parseFailed = false): RpcDisposition[] {
  if (parseFailed)
    return [{ kind: "error", response: standardError(STANDARD_RPC_ERRORS.parse, "Parse error") }];
  if (!boundedJsonStructure(input))
    return [
      {
        kind: "error",
        response: standardError(STANDARD_RPC_ERRORS.invalidRequest, "Invalid Request"),
      },
    ];
  if (!Array.isArray(input)) return [classifyRpcItem(input)];
  if (input.length === 0 || input.length > M0_LIMITS.rpcBatch)
    return [
      {
        kind: "error",
        response: standardError(STANDARD_RPC_ERRORS.invalidRequest, "Invalid Request"),
      },
    ];
  return input.map(classifyRpcItem);
}

export function rpcHttpSuccessStatus(items: readonly RpcDisposition[]): 200 | 204 {
  return items.length > 0 && items.every((item) => item.kind === "notification") ? 204 : 200;
}

export function validateRpcResponse(input: unknown): RpcResponse | null {
  if (!boundedJsonStructure(input) || !input || typeof input !== "object" || Array.isArray(input))
    return null;
  const hasResult = Object.hasOwn(input, "result");
  const hasError = Object.hasOwn(input, "error");
  if (hasResult === hasError) return null;
  const parsed = hasResult ? RpcResultSchema.safeParse(input) : RpcErrorSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function composeRpcResponse(
  input: unknown,
  encodeUtf8: (text: string) => Uint8Array,
): RpcResponse | null {
  const response = validateRpcResponse(input);
  if (!response) return null;
  return encodeUtf8(JSON.stringify(response)).byteLength <= M0_LIMITS.rpcResponseBytes
    ? response
    : null;
}

export function validateRpcMethodResult(method: RpcMethod, input: unknown): boolean {
  return composeRpcMethodResult(method, input) !== null;
}

export function composeRpcMethodResult(method: RpcMethod, input: unknown): unknown | null {
  if (!boundedJsonStructure(input)) return null;
  const parsed = RPC_METHODS[method].result.safeParse(input);
  return parsed.success ? parsed.data : null;
}

function sorted(value: unknown): unknown | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const elements = value.map(sorted);
    return elements.some((element, index) => element === null && value[index] !== null)
      ? null
      : elements;
  }
  if (!value || typeof value !== "object") return null;
  const object: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const canonical = sorted((value as Record<string, unknown>)[key]);
    if (canonical === null && (value as Record<string, unknown>)[key] !== null) return null;
    object[key] = canonical;
  }
  return object;
}

export function canonicalOperationIntent(
  method: "terminal.create" | "terminal.stop",
  input: unknown,
  encodeUtf8: (text: string) => Uint8Array,
): string | null {
  const parsed = validateRpcMethodParams(method, input);
  if (!parsed || parsed.method !== method) return null;
  if (method === "terminal.create" && !composeSpawnPayload(parsed.params, encodeUtf8)) return null;
  const { operationId: _operationId, ...params } = parsed.params;
  const canonical = sorted({ method, params });
  if (!canonical) return null;
  const text = JSON.stringify(canonical);
  return encodeUtf8(text).byteLength <= M0_LIMITS.canonicalIntentBytes ? text : null;
}

export const OperationReceiptKeySchema = z.object({
  serverId: OpaqueIdSchema,
  relayInstanceId: OpaqueIdSchema,
  principalId: OpaqueIdSchema,
  operationId: OpaqueIdSchema,
});
export type OperationReceiptKey = z.infer<typeof OperationReceiptKeySchema>;
export type StoredReceipt = {
  key: OperationReceiptKey;
  canonicalIntent: string;
  record: OperationRecord;
};

export function classifyReceiptAdmission(input: {
  key: OperationReceiptKey;
  canonicalIntent: string;
  existing?: StoredReceipt;
  receiptCount: number;
  receiptLimit: number;
  encodeUtf8: (text: string) => Uint8Array;
}): "existing" | "conflict" | "busy" | "reserve" | "invalid" {
  if (
    !OperationReceiptKeySchema.safeParse(input.key).success ||
    !Number.isSafeInteger(input.receiptCount) ||
    input.receiptCount < 0 ||
    !Number.isSafeInteger(input.receiptLimit) ||
    input.receiptLimit < 1 ||
    input.receiptLimit > M0_LIMITS.operationReceipts ||
    !input.canonicalIntent ||
    input.encodeUtf8(input.canonicalIntent).byteLength > M0_LIMITS.canonicalIntentBytes
  )
    return "invalid";
  if (input.existing) {
    if (
      Object.keys(input.key).some(
        (field) =>
          input.key[field as keyof OperationReceiptKey] !==
          input.existing!.key[field as keyof OperationReceiptKey],
      )
    )
      return "invalid";
    return input.existing.canonicalIntent === input.canonicalIntent ? "existing" : "conflict";
  }
  return input.receiptCount >= input.receiptLimit ? "busy" : "reserve";
}

export function validateOperationRecord(
  input: unknown,
  encodeUtf8: (text: string) => Uint8Array,
): OperationRecord | null {
  if (!boundedJsonStructure(input)) return null;
  const parsed = OperationRecordSchema.safeParse(input);
  if (!parsed.success) return null;
  return encodeUtf8(JSON.stringify(parsed.data)).byteLength <= M0_LIMITS.operationRecordBytes
    ? parsed.data
    : null;
}

export { RPC_METHODS, OperationRecordSchema, RunRecordSchema } from "./rpc-methods.js";
export type { OperationRecord, RunRecord, RpcMethod } from "./rpc-methods.js";
