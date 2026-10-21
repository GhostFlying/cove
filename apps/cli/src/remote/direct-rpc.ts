import type { CallOutcome, Client } from "@cove/client";
import {
  BootstrapFailureSchema,
  BUSINESS_HEADERS,
  LOCAL_PATHS,
  PROTOCOL_VERSION,
} from "@cove/protocol/bootstrap";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import {
  RPC_METHODS,
  STANDARD_RPC_ERRORS,
  validateRpcResponse,
  validateRpcResultForCall,
  type WriteRpcMethod,
} from "@cove/protocol/rpc";
import { randomUUID } from "node:crypto";
import { createNodeHttpPort } from "../node-ports.js";
import type { SessionTarget } from "../session.js";

// A client whose `call` of `method` is one JSON-RPC request of its own on the session's HTTP
// endpoint, independent of the client's terminal channel; every other member is the session
// client's. It exists for a device revoking itself (auth device revoke): the server closes all of
// the device's other connections, the client's terminal WebSocket included, before it answers,
// and the client library treats its terminal channel closing as the end of the connection and
// cancels the calls in flight, which would turn the revocation's answer into RESULT_UNKNOWN. The
// answer is checked as the library checks it: the binding headers, the request ID, the method's
// result schema, and a refusal is a proven non-acceptance only when its data says so.
export function directCallClient(
  client: Client,
  target: SessionTarget,
  authorization: () => string,
  method: WriteRpcMethod,
): Client {
  const call = (params: { operationId: string }): Promise<CallOutcome<unknown>> =>
    new Promise((settle) => {
      const operation = {
        method,
        operationId: params.operationId,
        relayInstanceId: target.relayInstanceId,
      };
      const unknown = (): void =>
        settle({
          ok: false,
          kind: "operation-unknown",
          operation,
          error: domainError("RESULT_UNKNOWN", "unknown"),
        });
      const requestId = randomUUID();
      const body = new TextEncoder().encode(
        JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      );
      createNodeHttpPort(target.endpoint).post(
        {
          path: LOCAL_PATHS.rpc,
          headers: {
            [BUSINESS_HEADERS[0]]: authorization(),
            "Content-Type": "application/json",
            [BUSINESS_HEADERS[1]]: String(PROTOCOL_VERSION),
            [BUSINESS_HEADERS[2]]: target.serverId,
            [BUSINESS_HEADERS[3]]: target.relayInstanceId,
          },
          body,
          maxResponseBytes: M0_LIMITS.rpcResponseBytes,
        },
        {
          onDisposition: () => undefined,
          onFailure: ({ disposition }) =>
            disposition === "not-sent"
              ? settle({ ok: false, kind: "operation-not-sent", operation })
              : unknown(),
          onResponse: (response) => {
            let decoded: unknown;
            try {
              decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
            } catch {
              unknown();
              return;
            }
            // An admission refusal (UNAUTHENTICATED, DEVICE_REVOKED, BUSY, ...) is answered
            // before any request is executed.
            if (response.status !== 200) {
              const failure = BootstrapFailureSchema.safeParse(decoded);
              if (!failure.success) unknown();
              else
                settle({
                  ok: false,
                  kind: "local-error",
                  error: { category: "remote-bootstrap", reason: failure.data.kind },
                });
              return;
            }
            const headers = new Map(
              Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]),
            );
            const answer = validateRpcResponse(decoded);
            if (
              headers.get(BUSINESS_HEADERS[1].toLowerCase()) !== String(PROTOCOL_VERSION) ||
              headers.get(BUSINESS_HEADERS[2].toLowerCase()) !== target.serverId ||
              headers.get(BUSINESS_HEADERS[3].toLowerCase()) !== target.relayInstanceId ||
              !answer ||
              answer.id !== requestId
            ) {
              unknown();
              return;
            }
            if ("error" in answer) {
              const notAccepted = answer.error.data
                ? answer.error.data.acceptance === "not-accepted"
                : answer.error.code === STANDARD_RPC_ERRORS.methodNotFound ||
                  answer.error.code === STANDARD_RPC_ERRORS.invalidParams;
              if (notAccepted)
                settle({
                  ok: false,
                  kind: "rpc-error",
                  error: answer.error.data ?? {
                    code: answer.error.code,
                    message: answer.error.message,
                  },
                });
              else unknown();
              return;
            }
            const result = RPC_METHODS[method].result.safeParse(answer.result);
            if (
              !validateRpcResultForCall(method, params as never, answer.result) ||
              !result.success
            )
              unknown();
            else settle({ ok: true, value: result.data });
          },
        },
      );
    });
  return new Proxy(client, {
    get(target_, property, receiver) {
      if (property !== "call") return Reflect.get(target_, property, receiver) as unknown;
      return (name: string, params: unknown) =>
        name === method
          ? call(params as { operationId: string })
          : target_.call(name as never, params as never);
    },
  });
}
