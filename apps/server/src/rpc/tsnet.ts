import { domainError, type DomainError, type DomainErrorKind } from "@cove/protocol/errors";
import {
  canonicalWriteIntent,
  holdsSecret,
  type OperationReceiptKey,
  type OperationRecord,
} from "@cove/protocol/rpc";
import type { TsnetLoginOutcome, TsnetLogoutOutcome, TsnetNode } from "../network/tsnet.js";
import { recordedWrite, type DatabaseWriteContext } from "../operations/database-operations.js";
import type { OperationReceipts } from "../operations/operation-receipts.js";
import { uncertainStoreOutcome } from "../store/store-errors.js";
import { capabilityUnavailable, type RpcHandler } from "./context.js";

// The server tsnet node module (server.tsnet.login/status/logout; m2 T5b, D10). The node itself
// is network/tsnet.ts; these handlers turn its control requests into operations.
//
// Login and logout are long-running writes. They cannot use the one-transaction receipt write
// (receipts.write) because their effect is outside the database and takes up to a minute, so they
// follow the terminal operations' pattern: the receipt is looked up first (a resend answers with
// the record and executes nothing), the accepted record is committed before the helper is asked
// anything, moved to running, and the helper's answer decides the terminal record. A server that
// stops or crashes in between leaves the receipt running, and the next start's receipt
// verification makes it requires_attention with RESULT_UNKNOWN (no verifier is registered for
// these methods): whether the node logged in is then read from `server tsnet status`, never
// assumed, and the request is never repeated on its own.
//
// The live answer waits up to TSNET_WRITE_TIMING.liveWaitMs for the helper; the CLI's request timeout is longer
// (apps/cli commands/_tsnet.ts). A login that takes longer (an auth-key login may take up to the
// helper's 60 s) answers with the running record and completes in the background; the CLI then
// follows the record with operation.get.
//
// Delivery of the login URL. A record that says `secretDelivery: "first-response-only"` must be
// one whose URL that first response really carried: the operator who did not get it can only
// learn from the record that it existed. So the terminal record and the live answer are decided
// together: when the helper's answer is ready while the live answer is still open, the work
// claims the live answer (it then waits for the record's commit and carries the URL); once the
// live wait has ended unclaimed, a URL that arrives is never delivered and the record is
// TSNET_LOGIN_UNCERTAIN (an interactive login was started, and whoever has its URL could still
// complete it), never succeeded. The interactive deadlines are also kept inside the live wait,
// so this happens only when the helper answers late.
//
// Secret boundary. The auth key is the call's input secret (call.secrets, never params): it goes
// to the helper inside the login frame and nowhere else. It is not in the canonical intent (the
// dispatch layer strips secrets before params reach a handler), and every record written here is
// checked for it (and for the login URL) before the commit or update, so a helper or code defect
// that echoed either into an error could not make it durable. Records hold fixed, secret-free
// errors (DomainError messages are fixed by kind) and the M2 projection alone (secretDelivery,
// remoteLogoutConfirmed). The login URL is returned only as the live answer's output secret, by
// the call that ran the login; a resend, operation.get or a background completion never has it.

// How long the live answer waits, and how long the helper may take: an auth-key login waits for
// the node to run (PROTOCOL.md login); an interactive login answers as soon as the URL is known.
// `deadlineMs` bounds the request itself (the helper's own timeout plus its answer). The
// interactive deadline is shorter than the live wait, so that its URL can still be delivered.
export type TsnetWriteTiming = {
  readonly liveWaitMs: number;
  readonly key: { readonly timeoutMs: number; readonly deadlineMs: number };
  readonly interactive: { readonly timeoutMs: number; readonly deadlineMs: number };
};
export const TSNET_WRITE_TIMING: TsnetWriteTiming = {
  liveWaitMs: 25_000,
  key: { timeoutMs: 60_000, deadlineMs: 75_000 },
  interactive: { timeoutMs: 15_000, deadlineMs: 20_000 },
};

const encoder = new TextEncoder();
const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

type WriteMethod = "server.tsnet.login" | "server.tsnet.logout";
type LiveAnswer =
  { operation: OperationRecord; secrets?: { loginUrl: string } } | { error: DomainError };

export const handle: RpcHandler<"tsnet"> = async (core, call) => {
  const tsnet = core.tsnet;
  const receipts = core.receipts;
  if (!tsnet) return capabilityUnavailable();
  switch (call.method) {
    case "server.tsnet.status": {
      const status = await tsnet.status();
      // A login or logout holds the helper's control lock: the node's state is being changed
      // and was not observed, so the caller asks again rather than get a stale one.
      return status ?? { error: domainError("BUSY") };
    }
    case "server.tsnet.login":
    case "server.tsnet.logout": {
      if (!receipts) return capabilityUnavailable();
      const authKey =
        call.method === "server.tsnet.login" && typeof call.secrets?.authKey === "string"
          ? call.secrets.authKey
          : undefined;
      return runWrite(
        tsnet,
        receipts,
        call.principalId,
        call.method,
        call.params as { operationId: string },
        authKey,
      );
    }
  }
};

// Exported with `timing` for the tests of the delivery rule above; handle uses the defaults.
export async function runWrite(
  tsnet: Pick<TsnetNode, "available" | "login" | "logout">,
  receipts: OperationReceipts,
  principalId: string,
  method: WriteMethod,
  params: { operationId: string },
  authKey: string | undefined,
  timing: TsnetWriteTiming = TSNET_WRITE_TIMING,
): Promise<LiveAnswer> {
  const context: DatabaseWriteContext = {
    serverId: receipts.composition.serverId,
    receipts,
    encodeUtf8,
  };
  const recorded = await recordedWrite(context, principalId, method, params);
  if (recorded) return recorded as LiveAnswer;
  // Not accepted when the helper cannot take the request: nothing is recorded, and the reason
  // is in `server tsnet status`.
  if (!(await tsnet.available()).ok) {
    return ((await recordedWrite(context, principalId, method, params)) ?? {
      error: domainError("ENTRY_UNAVAILABLE"),
    }) as LiveAnswer;
  }
  const intent = canonicalWriteIntent(method, params, encodeUtf8);
  if (!intent) return { error: domainError("INVALID_ARGUMENT") };
  const key: OperationReceiptKey = {
    serverId: context.serverId,
    principalId,
    operationId: params.operationId,
  };
  const secrets = authKey ? [authKey] : [];
  const preparation = await receipts.prepare(key, intent);
  if (!preparation)
    return ((await recordedWrite(context, principalId, method, params)) ?? {
      error: domainError("BUSY"),
    }) as LiveAnswer;
  const accepted: OperationRecord = {
    operationId: params.operationId,
    method,
    revision: 0,
    state: "accepted",
  };
  try {
    if (!(await preparation.commit(accepted))) {
      preparation.cancel();
      return ((await recordedWrite(context, principalId, method, params)) ?? {
        error: domainError("BUSY"),
      }) as LiveAnswer;
    }
  } catch (error) {
    preparation.cancel();
    return {
      error: uncertainStoreOutcome(error)
        ? domainError("RESULT_UNKNOWN", "unknown")
        : domainError("BUSY"),
    };
  }
  preparation.cancel();
  const running: OperationRecord = { ...accepted, revision: 1, state: "running" };
  try {
    if (!(await receipts.update(key, running))) throw new Error("refused");
  } catch {
    // The accepted receipt exists but the helper was never asked. The next start makes it
    // requires_attention; the caller learns nothing more certain now.
    return { error: domainError("RESULT_UNKNOWN", "unknown") };
  }

  // Whether the live answer is still open, was claimed by the work (it carries the work's
  // outcome) or ended with the running record; see "Delivery of the login URL".
  let live: "open" | "claimed" | "ended" = "open";
  let loginUrl: string | undefined;
  const work = (async (): Promise<OperationRecord> => {
    let terminal: OperationRecord;
    let url: string | undefined;
    if (method === "server.tsnet.login") {
      const limits = authKey ? timing.key : timing.interactive;
      const outcome = await tsnet.login(authKey, limits.timeoutMs, limits.deadlineMs);
      terminal = loginRecord(running, outcome, authKey !== undefined);
      if (outcome.kind === "answered") url = outcome.loginUrl;
    } else terminal = logoutRecord(running, await tsnet.logout());
    // Decided synchronously with the claim, so the timer cannot end the live answer in between.
    if (live === "open") live = "claimed";
    else if (url) terminal = failed(running, "TSNET_LOGIN_UNCERTAIN");
    if (live === "claimed") loginUrl = url;
    const forbidden = url ? [...secrets, url] : secrets;
    // The record is fixed by kind above; this check guards the boundary against a later change.
    if (holdsSecret(terminal, forbidden)) terminal = unknown(running);
    try {
      if (await receipts.update(key, terminal)) return terminal;
    } catch {
      // A failed store stops the server; the receipt stays running and the next start makes it
      // requires_attention.
    }
    return running;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    work,
    new Promise<null>(
      (done) =>
        (timer = setTimeout(() => {
          // A claimed answer waits for the work's commit instead.
          if (live !== "open") return;
          live = "ended";
          done(null);
        }, timing.liveWaitMs)),
    ),
  ]);
  clearTimeout(timer);
  if (!settled) return { operation: running };
  // The URL goes out only with the record that says it was delivered in this answer.
  if (settled.state === "succeeded" && settled.result?.secretDelivery && loginUrl)
    return { operation: settled, secrets: { loginUrl } };
  return { operation: settled };
}

function failed(running: OperationRecord, kind: DomainErrorKind): OperationRecord {
  return { ...running, revision: 2, state: "failed", error: domainError(kind, "accepted") };
}

function unknown(running: OperationRecord): OperationRecord {
  return {
    ...running,
    revision: 2,
    state: "requires_attention",
    error: domainError("RESULT_UNKNOWN", "unknown"),
  };
}

// The helper's answer to a login as the operation's terminal record (PROTOCOL.md error codes).
// What the helper says did not change the node fails the operation; an answer that leaves the
// effect unknown (no answer at all, a helper fault, a login cut short by shutdown) is
// requires_attention, never failure: an enrolled node's cut-short login may still complete.
function loginRecord(
  running: OperationRecord,
  outcome: TsnetLoginOutcome,
  withKey: boolean,
): OperationRecord {
  switch (outcome.kind) {
    case "answered":
      // listenFailed: the node logged in but a port did not open; status says which.
      return {
        ...running,
        revision: 2,
        state: "succeeded",
        ...(outcome.loginUrl ? { result: { secretDelivery: "first-response-only" as const } } : {}),
      };
    case "refused":
      switch (outcome.code) {
        case "IDENTITY_CHANGED":
          return failed(running, "TSNET_IDENTITY_CHANGED");
        case "LOGIN_UNCERTAIN":
          return failed(running, "TSNET_LOGIN_UNCERTAIN");
        // An auth-key login that timed out deleted a new node's partial state (an enrolled
        // node's reports LOGIN_UNCERTAIN instead). An interactive one deletes nothing and keeps
        // its node started (and an enrolled node held): the control plane may still produce a
        // login URL, so the node is not known to be as it was (no rollback, reported as it is;
        // 2026-10-21 user decision). manager.go loginInteractive.
        case "LOGIN_TIMEOUT":
          return failed(running, withKey ? "TSNET_LOGIN_FAILED" : "TSNET_LOGIN_UNCERTAIN");
        // Rejected, already running, or refused before acting: the node is as it was.
        case "LOGIN_FAILED":
        case "ALREADY_LOGGED_IN":
        case "NOT_LOGGED_IN":
        case "BAD_REQUEST":
        case "NODE_UNAVAILABLE":
          return failed(running, "TSNET_LOGIN_FAILED");
        default:
          return unknown(running);
      }
    case "lost":
      return unknown(running);
  }
}

function logoutRecord(running: OperationRecord, outcome: TsnetLogoutOutcome): OperationRecord {
  switch (outcome.kind) {
    case "answered":
      return {
        ...running,
        revision: 2,
        state: "succeeded",
        result: { remoteLogoutConfirmed: outcome.remoteLogoutConfirmed },
      };
    case "refused":
      // Queued behind a shutdown: refused without acting (PROTOCOL.md).
      return outcome.code === "SHUTTING_DOWN"
        ? failed(running, "ENTRY_UNAVAILABLE")
        : unknown(running);
    case "lost":
      return unknown(running);
  }
}
