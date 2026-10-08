import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { M0_LIMITS } from "@cove/protocol/budgets";
import {
  ADMISSION_STATUS,
  negotiateBootstrap,
  LOCAL_PATHS,
  PROTOCOL_VERSION,
} from "@cove/protocol/bootstrap";
import { PROFILE } from "@cove/protocol/profile";
import { boundedJsonStructure } from "@cove/protocol/terminal";
import { domainError, ERROR_CODES, type DomainError } from "@cove/protocol/errors";
import {
  classifyRpcEnvelope,
  composeRpcResponse,
  rpcHttpSuccessStatus,
  validateRpcResultForCall,
  STANDARD_RPC_ERRORS,
  STANDARD_RPC_MESSAGES,
  type RpcId,
  type RpcMethod,
} from "@cove/protocol/rpc";
import type { LocalRuntime } from "../terminal/local-runtime.js";
import type { TerminalOperations } from "../operations/terminal-operations.js";
import { actualHeaders, header, LocalAdmission } from "./local-admission.js";

export type LocalCore = {
  runtime: LocalRuntime;
  operations: TerminalOperations;
  buildVersion: string;
};
const encoder = new TextEncoder();
export const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);
const standard = (id: RpcId, code: keyof typeof STANDARD_RPC_MESSAGES) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message: STANDARD_RPC_MESSAGES[code] },
});
const domain = (id: RpcId, error: DomainError) => ({
  jsonrpc: "2.0" as const,
  id,
  error: {
    code: ERROR_CODES[error.kind],
    message: error.message,
    data: { ...error, subject: undefined },
  },
});

export async function dispatchLocalRpc(
  core: LocalCore,
  method: RpcMethod,
  params: Record<string, unknown>,
) {
  const runtime = core.runtime;
  switch (method) {
    case "server.status": {
      const pool = runtime.pool.snapshot();
      return {
        serverId: runtime.composition.serverId,
        relayInstanceId: runtime.composition.relayInstanceId,
        buildVersion: core.buildVersion,
        protocolVersion: 2,
        profile: PROFILE,
        effectiveBudgets: runtime.composition.budgets,
        workerCount: pool.workers,
        runCount: runtime.registry.count,
        admission: pool.readyWorkers ? "ready" : "unavailable",
        health: pool.readyWorkers ? "live" : "unverifiable",
      };
    }
    case "terminal.list":
      return runtime.previews.cache.list(params as { limit: number; afterRunId?: string });
    case "terminal.get": {
      const record = runtime.previews.cache.getRecord(
        params.run as Parameters<typeof runtime.previews.cache.getRecord>[0],
      );
      return record ? { record } : { error: domainError("RUN_NOT_FOUND") };
    }
    case "terminal.create":
      return core.operations.create("m0-local", params);
    case "terminal.stop":
      return core.operations.stop("m0-local", params);
    case "operation.get":
      return core.operations.get(
        "m0-local",
        params.operationId as string,
        params.expectedRelayInstanceId as string,
      );
  }
}

export function boundRpcResponseBody(body: string, responseBytes: number) {
  return Buffer.byteLength(body) <= responseBytes
    ? { status: 200, body }
    : { status: ADMISSION_STATUS["too-large"] };
}

type RpcBuffers = { scratch: Uint8Array; aggregate: Uint8Array };
function rpcBuffers(core: LocalCore): RpcBuffers {
  return {
    scratch: new Uint8Array(M0_LIMITS.rpcResponseBytes),
    aggregate: new Uint8Array(core.runtime.composition.budgets.rpcResponseBytes),
  };
}

export async function rpcBody(
  core: LocalCore,
  bytes: Uint8Array,
  buffers: RpcBuffers = rpcBuffers(core),
): Promise<{ status: number; body?: string }> {
  let value: unknown;
  let parseFailed = false;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    parseFailed = true;
  }
  const items =
    Array.isArray(value) && value.length > core.runtime.composition.budgets.rpcBatch
      ? classifyRpcEnvelope([])
      : classifyRpcEnvelope(value, parseFailed);
  const batch =
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= Math.min(M0_LIMITS.rpcBatch, core.runtime.composition.budgets.rpcBatch) &&
    boundedJsonStructure(value);
  const oversized = Symbol("response scratch limit");
  const encodeResponse = (text: string): Uint8Array => {
    const length = Buffer.byteLength(text);
    if (length > buffers.scratch.byteLength) throw oversized;
    encoder.encodeInto(text, buffers.scratch);
    return buffers.scratch.subarray(0, length);
  };
  let used = 0;
  let count = 0;
  let overflow = false;
  for (const item of items) {
    if (item.kind === "notification") {
      if (item.params !== null) {
        try {
          await dispatchLocalRpc(core, item.method as RpcMethod, item.params);
        } catch {
          // Notifications execute without emitting success or failure replies.
        }
      }
      continue;
    }
    let response;
    if (item.kind === "error") response = item.response;
    else {
      try {
        const result = await dispatchLocalRpc(core, item.method, item.params);
        if (result && "error" in result) response = domain(item.id, result.error);
        else
          response = validateRpcResultForCall(item.method, item.params, result)
            ? { jsonrpc: "2.0" as const, id: item.id, result }
            : standard(item.id, STANDARD_RPC_ERRORS.internal);
      } catch {
        response = standard(item.id, STANDARD_RPC_ERRORS.internal);
      }
      try {
        response =
          composeRpcResponse(response, encodeResponse) ??
          standard(item.id, STANDARD_RPC_ERRORS.internal);
      } catch (error) {
        if (error !== oversized) throw error;
        response = standard(item.id, STANDARD_RPC_ERRORS.internal);
      }
    }
    const encoded = encodeResponse(JSON.stringify(response));
    const prefix = batch ? 1 : 0;
    const suffix = batch ? 1 : 0;
    if (encoded.byteLength > buffers.aggregate.byteLength - used - prefix - suffix) overflow = true;
    if (!overflow) {
      if (batch) buffers.aggregate[used++] = count ? 44 : 91;
      buffers.aggregate.set(encoded, used);
      used += encoded.byteLength;
    }
    count++;
  }
  if (!count) return { status: rpcHttpSuccessStatus(items) };
  if (overflow) return { status: ADMISSION_STATUS["too-large"] };
  if (batch) buffers.aggregate[used++] = 93;
  return boundRpcResponseBody(
    new TextDecoder("utf-8", { fatal: true }).decode(buffers.aggregate.subarray(0, used)),
    core.runtime.composition.budgets.rpcResponseBytes,
  );
}

export function registerHttpRpc(
  app: FastifyInstance,
  admission: LocalAdmission,
  core: LocalCore,
): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  const headers = (request: FastifyRequest) =>
    actualHeaders(request.headers, request.raw.rawHeaders);
  const cors = (request: FastifyRequest, reply: FastifyReply): void => {
    const origin = header(headers(request), "origin");
    if (origin && admission.options.allowedOrigins.includes(origin))
      reply
        .header("Access-Control-Allow-Origin", origin)
        .header("Access-Control-Expose-Headers", "Cove-Protocol, Cove-Server-Id, Cove-Instance-Id")
        .header("Vary", "Origin");
  };
  // Origin approval is independent of authentication, quota and body parsing.
  // Let an approved browser observe those failures without approving a hostile
  // or ambiguous Origin and without reflecting any authentication input.
  app.addHook("onRequest", (request, reply, done) => {
    cors(request, reply);
    done();
  });
  app.setErrorHandler((error, request, reply) => {
    cors(request, reply);
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const malformed = new Set([
      "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
      "FST_ERR_CTP_INVALID_JSON_BODY",
      "FST_ERR_CTP_EMPTY_JSON_BODY",
      "FST_ERR_CTP_INVALID_MEDIA_TYPE",
      "COVE_HTTP_BODY_CLOSED",
    ]);
    // Unexpected allocation/setup/invariant failures belong to infrastructure,
    // never the client's malformed-request class. Do not send raw error text.
    return reply
      .code(code === "FST_ERR_CTP_BODY_TOO_LARGE" ? 413 : malformed.has(String(code)) ? 400 : 500)
      .send();
  });
  for (const path of [LOCAL_PATHS.bootstrap, LOCAL_PATHS.rpc, LOCAL_PATHS.terminal]) {
    app.options(path, (request, reply) => {
      const result = admission.http("OPTIONS", path, headers(request), 0);
      if (result !== "accepted") return reply.code(ADMISSION_STATUS[result]).send();
      cors(request, reply);
      return reply
        .header("Access-Control-Allow-Methods", "POST")
        .header(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, Cove-Protocol, Cove-Server-Id, Cove-Instance-Id",
        )
        .code(ADMISSION_STATUS.accepted)
        .send();
    });
  }
  app.register(async (http) => {
    type Owner = {
      claim: { retireAdmission(): void; release(): void };
      physical: { release(): void } | undefined;
      input: Uint8Array | undefined;
      bootstrapOutput: Uint8Array | undefined;
      buffers: RpcBuffers | undefined;
      requestLimit: number;
      handlerStarted: boolean;
      domainPending: boolean;
      readerPending: boolean;
      readerFailed: boolean;
      logicalClosed: boolean;
      logicalRetired: boolean;
      carrierSettled: boolean;
      retired: boolean;
      detach(): void;
    };
    const claims = new WeakMap<FastifyRequest, Owner>();
    const retire = (request: FastifyRequest, owner: Owner): void => {
      if (
        !owner.logicalRetired &&
        !owner.domainPending &&
        !owner.readerPending &&
        (owner.handlerStarted || owner.logicalClosed || owner.readerFailed)
      ) {
        owner.logicalRetired = true;
        owner.claim.retireAdmission();
      }
      if (owner.retired || !owner.carrierSettled || owner.domainPending || owner.readerPending)
        return;
      owner.retired = true;
      if (claims.get(request) === owner) claims.delete(request);
      owner.detach();
      owner.input = undefined;
      owner.bootstrapOutput = undefined;
      owner.buffers = undefined;
      request.body = undefined;
      owner.physical?.release();
      owner.claim.release();
    };
    const settle = (request: FastifyRequest, owner: Owner): void => {
      owner.logicalClosed = true;
      owner.carrierSettled = true;
      retire(request, owner);
    };
    http.removeAllContentTypeParsers();
    http.addContentTypeParser("*", (request, payload, done) => {
      const owner = claims.get(request);
      if (!owner?.input) {
        done(new Error("HTTP reader owner unavailable"));
        return;
      }
      owner.readerPending = true;
      const input = owner.input;
      const contentLength = Number(request.headers["content-length"]);
      let received = 0;
      let completed = false;
      const finish = (error?: Error): void => {
        if (completed) return;
        completed = true;
        payload.off("data", onData);
        payload.off("end", onEnd);
        payload.off("error", onError);
        payload.off("close", onClose);
        owner.readerPending = false;
        owner.readerFailed = error !== undefined;
        try {
          if (error) done(error);
          else done(null, input.subarray(0, received));
        } finally {
          retire(request, owner);
        }
      };
      const tooLarge = () =>
        Object.assign(new Error("Request body is too large"), {
          code: "FST_ERR_CTP_BODY_TOO_LARGE",
          statusCode: 413,
        });
      const onData = (chunk: Buffer): void => {
        if (chunk.byteLength > owner.requestLimit - received) {
          finish(tooLarge());
          return;
        }
        input.set(chunk, received);
        received += chunk.byteLength;
      };
      const onEnd = (): void => {
        if (!Number.isNaN(contentLength) && received !== contentLength) {
          finish(
            Object.assign(new Error("Request body size did not match Content-Length"), {
              code: "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
              statusCode: 400,
            }),
          );
        } else finish();
      };
      const onError = (error: Error): void => finish(error);
      const onClose = (): void =>
        finish(
          Object.assign(new Error("HTTP body closed before end"), {
            code: "COVE_HTTP_BODY_CLOSED",
          }),
        );
      if (contentLength > owner.requestLimit) {
        finish(tooLarge());
        return;
      }
      payload.on("data", onData);
      payload.on("end", onEnd);
      payload.on("error", onError);
      payload.once("close", onClose);
      payload.resume();
    });
    for (const path of [LOCAL_PATHS.bootstrap, LOCAL_PATHS.rpc]) {
      http.post(
        path,
        {
          bodyLimit:
            path === LOCAL_PATHS.bootstrap
              ? admission.budgets.bootstrapBytes
              : admission.budgets.rpcRequestBytes,
          onRequest: (request, reply, done) => {
            const result = admission.http("POST", path, headers(request), 0);
            if (result !== "accepted") {
              reply.code(ADMISSION_STATUS[result]).send();
              return;
            }
            if (path === LOCAL_PATHS.rpc)
              reply
                .header("Cove-Protocol", String(PROTOCOL_VERSION))
                .header("Cove-Server-Id", admission.identity.serverId)
                .header("Cove-Instance-Id", admission.identity.relayInstanceId);
            const claim = admission.claim("rpc");
            if (!claim) {
              reply.code(ADMISSION_STATUS.busy).send();
              return;
            }
            const physicalBytes =
              path === LOCAL_PATHS.rpc
                ? M0_LIMITS.rpcResponseBytes + 3 * admission.budgets.rpcResponseBytes + 3 * 256
                : Math.max(
                    0,
                    admission.budgets.bootstrapBytes - admission.budgets.rpcRequestBytes,
                  ) +
                  3 * M0_LIMITS.bootstrapBytes +
                  2 * 256;
            const physical = core.runtime.composition.bytes.reserve(physicalBytes);
            if (!physical) {
              claim.release();
              reply.code(ADMISSION_STATUS.busy).send();
              return;
            }
            const requestLimit =
              path === LOCAL_PATHS.bootstrap
                ? admission.budgets.bootstrapBytes
                : admission.budgets.rpcRequestBytes;
            let input: Uint8Array;
            let bootstrapOutput: Uint8Array | undefined;
            let buffers: RpcBuffers | undefined;
            try {
              input = new Uint8Array(requestLimit);
              if (path === LOCAL_PATHS.bootstrap)
                bootstrapOutput = new Uint8Array(M0_LIMITS.bootstrapBytes);
              if (path === LOCAL_PATHS.rpc) buffers = rpcBuffers(core);
            } catch (error) {
              physical?.release();
              claim.release();
              throw error;
            }
            const owner: Owner = {
              claim,
              physical,
              input,
              bootstrapOutput,
              buffers,
              requestLimit,
              handlerStarted: false,
              domainPending: false,
              readerPending: false,
              readerFailed: false,
              logicalClosed: false,
              logicalRetired: false,
              carrierSettled: false,
              retired: false,
              detach: () => {},
            };
            claims.set(request, owner);
            const socket = request.raw.socket;
            const onSocketClose = () => settle(request, owner);
            const onFinish = () => settle(request, owner);
            const onResponseClose = () => {
              owner.logicalClosed = true;
              retire(request, owner);
            };
            const onAbort = () => {
              if (!owner.handlerStarted) owner.logicalClosed = true;
              retire(request, owner);
            };
            owner.detach = () => {
              socket.off("close", onSocketClose);
              reply.raw.off("finish", onFinish);
              reply.raw.off("close", onResponseClose);
              request.raw.off("aborted", onAbort);
            };
            socket.once("close", onSocketClose);
            reply.raw.once("finish", onFinish);
            reply.raw.once("close", onResponseClose);
            request.raw.once("aborted", onAbort);
            done();
          },
          onResponse: (_request, _reply, done) => {
            done();
          },
        },
        async (request, reply) => {
          const owner = claims.get(request);
          if (!owner) return reply.code(ADMISSION_STATUS.unavailable).send();
          if (owner.logicalClosed) return reply;
          owner.handlerStarted = true;
          owner.domainPending = true;
          try {
            const bytes = request.body instanceof Uint8Array ? request.body : new Uint8Array();
            // The admitted reader already owns its slot; its own full-cap claim is eligible.
            const result = admission.http("POST", path, headers(request), bytes.byteLength, true);
            if (result !== "accepted") return reply.code(ADMISSION_STATUS[result]).send();
            cors(request, reply);
            if (path === LOCAL_PATHS.bootstrap) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
              } catch {
                return reply.code(400).send();
              }
              const outcome = negotiateBootstrap(parsed, {
                ...admission.identity,
                buildVersion: core.buildVersion,
                effectiveBudgets: admission.budgets,
              });
              const status =
                outcome.type === "cove-bootstrap-result"
                  ? ADMISSION_STATUS.accepted
                  : outcome.kind === "PROTOCOL_MISMATCH" || outcome.kind === "INSTANCE_MISMATCH"
                    ? ADMISSION_STATUS.mismatch
                    : ADMISSION_STATUS.malformed;
              const text = JSON.stringify(outcome);
              const length = Buffer.byteLength(text);
              const output = owner.bootstrapOutput!;
              if (length > output.byteLength)
                throw new Error("Bootstrap response exceeded closed-schema bound");
              encoder.encodeInto(text, output);
              return reply
                .code(status)
                .type("application/json; charset=utf-8")
                .send(output.subarray(0, length));
            }
            const response = await rpcBody(core, bytes, owner.buffers);
            if (owner.logicalClosed) return reply;
            const body =
              response.body === undefined
                ? undefined
                : owner.buffers!.aggregate.subarray(0, Buffer.byteLength(response.body));
            return reply
              .code(response.status)
              .type(body === undefined ? "application/json" : "application/json; charset=utf-8")
              .send(body);
          } finally {
            owner.domainPending = false;
            retire(request, owner);
          }
        },
      );
    }
  });
}
