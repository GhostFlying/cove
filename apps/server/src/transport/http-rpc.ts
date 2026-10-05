import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ADMISSION_STATUS,
  negotiateBootstrap,
  LOCAL_PATHS,
  PROTOCOL_VERSION,
} from "@cove/protocol/bootstrap";
import { PROFILE } from "@cove/protocol/profile";
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

export async function rpcBody(
  core: LocalCore,
  bytes: Uint8Array,
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
  const responses = [];
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
    if (item.kind === "error") {
      responses.push(item.response);
      continue;
    }
    let response;
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
    responses.push(
      composeRpcResponse(response, encodeUtf8) ?? standard(item.id, STANDARD_RPC_ERRORS.internal),
    );
  }
  if (!responses.length) return { status: rpcHttpSuccessStatus(items) };
  const body = JSON.stringify(Array.isArray(value) ? responses : responses[0]);
  return boundRpcResponseBody(body, core.runtime.composition.budgets.rpcResponseBytes);
}

export function registerHttpRpc(
  app: FastifyInstance,
  admission: LocalAdmission,
  core: LocalCore,
): void {
  const claims = new WeakMap<FastifyRequest, { claim: { release(): void }; dispatched: boolean }>();
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  const headers = (request: FastifyRequest) =>
    actualHeaders(request.headers, request.raw.rawHeaders);
  const cors = (request: FastifyRequest, reply: FastifyReply): void => {
    const origin = header(headers(request), "origin");
    if (origin && admission.options.allowedOrigins.includes(origin))
      reply.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
  };
  for (const path of [LOCAL_PATHS.bootstrap, LOCAL_PATHS.rpc]) {
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
    app.post(
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
          const owner = { claim, dispatched: false };
          claims.set(request, owner);
          request.raw.once("aborted", () => {
            if (!owner.dispatched) claim.release();
          });
          reply.raw.once("close", () => {
            if (!owner.dispatched) claim.release();
          });
          done();
        },
        onResponse: (request, _reply, done) => {
          claims.get(request)?.claim.release();
          claims.delete(request);
          done();
        },
      },
      async (request, reply) => {
        const owner = claims.get(request);
        if (!owner) return reply.code(ADMISSION_STATUS.unavailable).send();
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
          return reply.code(status).send(outcome);
        }
        owner.dispatched = true;
        try {
          const response = await rpcBody(core, bytes);
          return reply.code(response.status).type("application/json").send(response.body);
        } finally {
          owner.claim.release();
        }
      },
    );
  }
  app.setErrorHandler((error, request, reply) => {
    claims.get(request)?.claim.release();
    const tooLarge =
      error instanceof Error && "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE";
    return reply.code(tooLarge ? 413 : 400).send();
  });
}
