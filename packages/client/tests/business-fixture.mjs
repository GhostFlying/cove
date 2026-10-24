import { LOCAL_PATHS, M0_CAPABILITIES, PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { M0_LIMITS } from "@cove/protocol/budgets";
import {
  BUSINESS_EVENT_CAPABILITY,
  businessFilterIdentity,
  businessRunId,
} from "@cove/protocol/business-events";
import { BASELINE_ENCODING, PROFILE } from "@cove/protocol/profile";
import { domainError } from "@cove/protocol/errors";
import { manualClock, settle } from "./reentry-fixture.mjs";

export { manualClock, settle };
export const codec = {
  encode: (text) => new TextEncoder().encode(text),
  decodeFatal: (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
};
export const identity = { serverId: "server-1", relayInstanceId: "instance-1" };
export const cursor = (sequence = 0, ids = identity, filter = {}) => ({
  ...ids,
  streamId: "stream-1",
  sequence,
  filter: businessFilterIdentity(filter),
});
export const config = (revision = 0, value = "/workspace") => ({
  kind: "config",
  id: "server",
  record: { revision, settings: { workspaceRoot: { value, isDefault: false } } },
});
export const repo = (id = "repo-1", revision = 0) => ({
  kind: "repo",
  id,
  record: {
    repoId: id,
    revision,
    displayName: id,
    path: `/repos/${id}`,
    mainBranch: null,
    registeredAtMs: 0,
  },
});
export const operation = (id = "op-1", revision = 1, state = "succeeded") => ({
  operationId: id,
  method: "config.set",
  revision,
  state,
});
export function history(id, lifecycle = "running", startedAtMs = 1) {
  const run = { ...identity, runId: id };
  return {
    kind: "run",
    id: businessRunId(run),
    record: {
      run,
      tabId: "tab-1",
      taskId: "task-1",
      workspaceRevision: 1,
      cwd: "/workspace",
      mounts: [],
      lifecycle,
      verification: lifecycle === "running" ? "live" : "final",
      startedAtMs,
      endedAtMs: lifecycle === "running" ? null : 5,
      lastObservedAtMs: 5,
      exitCode: lifecycle === "running" ? null : 0,
      signal: null,
    },
  };
}
export function runtime(id, status = "exited") {
  const run = { ...identity, runId: id };
  return {
    kind: "runtime",
    id: businessRunId(run),
    record: {
      run,
      status,
      geometry: { cols: 80, rows: 24 },
      controlEpoch: 0,
      controlHolder: null,
      recovery: "ready",
      exitCode: status === "exited" ? 0 : null,
      signal: null,
    },
  };
}
export const snapshot = (records = [config()], at = cursor(), id = "snapshot-1") => [
  { type: "snapshot-begin", snapshotId: id },
  { type: "snapshot-page", snapshotId: id, page: 0, records },
  {
    type: "snapshot-end",
    snapshotId: id,
    pages: 1,
    cursor: at,
    history: "latest-and-active-runs-unresolved-operations",
  },
  { type: "ready", cursor: at },
];
export const batch = (after, changes = []) => ({
  type: "changes",
  after,
  cursor: { ...after, sequence: after.sequence + 1 },
  changes,
});
export function bootstrap(
  ids = identity,
  capabilities = [...new Set([...M0_CAPABILITIES, BUSINESS_EVENT_CAPABILITY])],
  terminal = true,
) {
  return {
    type: "cove-bootstrap-result",
    bootstrapVersion: 1,
    ...ids,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: "server-build",
    capabilities,
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    effectiveBudgets: { ...M0_LIMITS },
    ...(terminal ? { connection: { connectionId: "connection-1", generation: 1 } } : {}),
  };
}
export function eventPort({ ids = identity, frames = () => undefined } = {}) {
  const connections = [];
  const port = {
    open(callbacks) {
      const owned = {
        callbacks,
        sent: [],
        closed: 0,
        cancelled: 0,
        emit: (value) => callbacks.onText(codec.encode(JSON.stringify(value))),
        connection: {
          send(text) {
            const message = JSON.parse(text);
            owned.sent.push(message);
            if (message.type === "cove-bootstrap") queueMicrotask(() => owned.emit(bootstrap(ids)));
            else if (message.type === "subscribe")
              queueMicrotask(() => {
                for (const frame of frames(message, owned) ?? []) owned.emit(frame);
              });
            return "handed-off";
          },
          close() {
            owned.closed++;
          },
          dispose() {
            owned.closed++;
          },
        },
      };
      connections.push(owned);
      callbacks.onOpen(owned.connection);
      return {
        cancel() {
          owned.cancelled++;
          return "handed-off";
        },
      };
    },
  };
  return { port, connections, latest: () => connections.at(-1) };
}
export function bindingFixture({
  ids = identity,
  frames = (request) =>
    request.since
      ? [{ type: "ready", cursor: request.since }]
      : snapshot([config()], cursor(0, ids)),
  rpc,
} = {}) {
  const clock = manualClock();
  const events = eventPort({ ids, frames });
  const calls = [];
  const terminalSent = [];
  const terminals = [];
  let credentials = 0;
  let disposed = 0;
  let requestSequence = 0;
  const headers = {
    "cove-protocol": String(PROTOCOL_VERSION),
    "cove-server-id": ids.serverId,
    "cove-instance-id": ids.relayInstanceId,
  };
  const binding = {
    identity: ids,
    events: events.port,
    client: {
      buildVersion: "fixture",
      scheduler: clock,
      codec,
      createOpaqueId: () => `request-${++requestSequence}`,
      capabilities: [...new Set([...M0_CAPABILITIES, BUSINESS_EVENT_CAPABILITY])],
      credentials() {
        credentials++;
        return { authorization: `Bearer ${"s".repeat(43)}`, terminalSecret: "s".repeat(43) };
      },
      http: {
        post(request, callbacks) {
          const message = JSON.parse(codec.decodeFatal(request.body));
          if (request.path === LOCAL_PATHS.bootstrap)
            queueMicrotask(() =>
              callbacks.onResponse({
                status: 200,
                headers,
                body: codec.encode(JSON.stringify(bootstrap(ids, message.capabilities, false))),
              }),
            );
          else {
            const response = (result) =>
              callbacks.onResponse({
                status: 200,
                headers,
                body: codec.encode(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })),
              });
            const error = (kind) => {
              const value = domainError(kind, "not-accepted");
              callbacks.onResponse({
                status: 200,
                headers,
                body: codec.encode(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: message.id,
                    error: { code: value.code, message: value.message, data: value },
                  }),
                ),
              });
            };
            const call = { message, callbacks, response, error };
            calls.push(call);
            queueMicrotask(() =>
              rpc
                ? rpc(call)
                : message.method === "operation.get"
                  ? error("OPERATION_NOT_FOUND")
                  : response({ operation: operation(message.params.operationId) }),
            );
          }
          return { cancel: () => "handed-off" };
        },
      },
      terminal: {
        open(callbacks) {
          const connection = {
            send(text) {
              if (typeof text !== "string") {
                terminalSent.push(text);
                return "handed-off";
              }
              const message = JSON.parse(text);
              terminalSent.push(message);
              queueMicrotask(() =>
                callbacks.onText(
                  codec.encode(JSON.stringify(bootstrap(ids, message.capabilities))),
                ),
              );
              return "handed-off";
            },
            close() {},
            dispose() {},
          };
          terminals.push(callbacks);
          callbacks.onOpen(connection);
          return { cancel: () => "handed-off" };
        },
      },
    },
    dispose() {
      disposed++;
    },
  };
  return {
    binding,
    clock,
    events,
    calls,
    terminalSent,
    terminals,
    get credentials() {
      return credentials;
    },
    get disposed() {
      return disposed;
    },
  };
}
