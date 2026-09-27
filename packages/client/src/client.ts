import {
  BUSINESS_HEADERS,
  LOCAL_PATHS,
  M0_CAPABILITIES,
  PROTOCOL_VERSION,
  type BootstrapSuccess,
} from "@cove/protocol/bootstrap";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError, type DomainError } from "@cove/protocol/errors";
import { nextCounter, OpaqueIdSchema } from "@cove/protocol/identity";
import { BASELINE_ENCODING, PROFILE } from "@cove/protocol/profile";
import { canonicalOperationIntent, RPC_METHODS, type RpcMethod } from "@cove/protocol/rpc";
import {
  agreeBootstraps,
  checkBootstrap,
  createBootstrapRequest,
  createTerminalBootstrap,
  decodeBootstrap,
  validOffer,
  type FrozenOffer,
  type NegotiatedConnection,
  type NegotiationField,
} from "./connection-session.js";
import {
  checkRpcResponse,
  prepareCall,
  rpcErrorProvesWriteNotAccepted,
  type ParamsFor,
  type ResultFor,
  type RpcBinding,
} from "./rpc-calls.js";
import type {
  CancellationHandle,
  ClientCredentials,
  CredentialSupplier,
  Disposable,
  HttpPort,
  Scheduler,
  TerminalConnection,
  TerminalPort,
  TransferDisposition,
  Utf8Codec,
} from "./transport-ports.js";

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const MAX_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const MAX_RPC_TIMEOUT_MS = 30_000;
const MAX_AUTHORIZATION_BYTES = 1_024;

export type ClientStatus =
  "idle" | "connecting" | "connected" | "unverifiable" | "incompatible" | "disposed";

export type LocalErrorReason =
  | "invalid-options"
  | "invalid-state"
  | "invalid-request"
  | "disposed"
  | "capacity"
  | "credential"
  | "timeout"
  | "transport"
  | "invalid-response"
  | "response-too-large"
  | "instance-binding"
  | "operation-conflict";

export type ClientError =
  | { readonly category: "local"; readonly reason: LocalErrorReason }
  | {
      readonly category: "negotiation";
      readonly reason: "invalid-bootstrap" | "channel-disagreement";
      readonly field: NegotiationField | "remote-failure";
    }
  | {
      readonly category: "remote-bootstrap";
      readonly reason:
        | "BOOTSTRAP_UNSUPPORTED"
        | "PROTOCOL_MISMATCH"
        | "INSTANCE_MISMATCH"
        | "CAPABILITY_UNAVAILABLE"
        | "PROFILE_UNSUPPORTED"
        | "INVALID_SIZE";
    };

export type ConnectOutcome =
  | { readonly ok: true; readonly connection: NegotiatedConnection }
  | { readonly ok: false; readonly error: ClientError };

export interface OperationReference {
  readonly method: "terminal.create" | "terminal.stop";
  readonly operationId: string;
  readonly relayInstanceId: string;
}

export type CallOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: "local-error"; readonly error: ClientError }
  | { readonly ok: false; readonly kind: "rpc-error"; readonly error: DomainError | RpcError }
  | {
      readonly ok: false;
      readonly kind: "operation-not-sent";
      readonly operation: OperationReference;
    }
  | {
      readonly ok: false;
      readonly kind: "operation-unknown";
      readonly operation: OperationReference;
      readonly error: DomainError;
    };

export interface RpcError {
  readonly code: number;
  readonly message: string;
}

export interface ClientSnapshot {
  readonly status: ClientStatus;
  readonly generation: number;
  readonly connection?: NegotiatedConnection;
  readonly pendingRpcCount: number;
  readonly peakPendingRpcCount: number;
  readonly listenerCount: number;
  readonly lastError?: ClientError;
}

export interface ClientOptions {
  readonly expectedServerId: string;
  readonly expectedRelayInstanceId: string;
  readonly buildVersion: string;
  readonly capabilities?: readonly string[];
  readonly profiles?: readonly string[];
  readonly encodings?: readonly string[];
  readonly credentials: CredentialSupplier;
  readonly codec: Utf8Codec;
  readonly createOpaqueId: () => string;
  readonly scheduler: Scheduler;
  readonly http: HttpPort;
  readonly terminal: TerminalPort;
  readonly connectionTimeoutMs?: number;
  readonly rpcTimeoutMs?: number;
}

export interface Client {
  connect(): Promise<ConnectOutcome>;
  reconnect(): Promise<ConnectOutcome>;
  call<M extends RpcMethod>(method: M, params: ParamsFor<M>): Promise<CallOutcome<ResultFor<M>>>;
  getOperation(operationId: string): Promise<CallOutcome<ResultFor<"operation.get">>>;
  snapshot(): ClientSnapshot;
  onState(listener: (snapshot: ClientSnapshot) => void): Disposable;
  dispose(): void;
}

interface ConnectAttempt {
  readonly generation: number;
  readonly offer: FrozenOffer;
  readonly request: ReturnType<typeof createBootstrapRequest>;
  readonly promise: Promise<ConnectOutcome>;
  readonly resolve: (outcome: ConnectOutcome) => void;
  startedAtMs: number;
  timer?: Disposable;
  httpCancellation?: CancellationHandle;
  terminalCancellation?: CancellationHandle;
  terminalConnection?: TerminalConnection;
  httpSuccess?: BootstrapSuccess;
  terminalSuccess?: BootstrapSuccess;
  httpMessageSeen: boolean;
  terminalOpened: boolean;
  terminalMessageSeen: boolean;
  finished: boolean;
  fenced: boolean;
  committed: boolean;
}

interface PendingRpc {
  readonly generation: number;
  cancel(reason: LocalErrorReason): void;
}

function localError(reason: LocalErrorReason): ClientError {
  return Object.freeze({ category: "local", reason });
}

function immutableOperation(
  method: "terminal.create" | "terminal.stop",
  operationId: string,
  relayInstanceId: string,
): OperationReference {
  return Object.freeze({ method, operationId, relayInstanceId });
}

function validDeadline(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function copyOffer(options: ClientOptions): FrozenOffer {
  return Object.freeze({
    expectedServerId: options.expectedServerId,
    expectedRelayInstanceId: options.expectedRelayInstanceId,
    buildVersion: options.buildVersion,
    capabilities: Object.freeze([...(options.capabilities ?? M0_CAPABILITIES)]),
    profiles: Object.freeze([...(options.profiles ?? [PROFILE])]),
    encodings: Object.freeze([...(options.encodings ?? [BASELINE_ENCODING])]),
  });
}

function safeDispose(handle: Disposable | undefined): void {
  if (!handle) return;
  try {
    handle.dispose();
  } catch {
    // Cleanup is best effort and never lets an adapter exception skip later handles.
  }
}

function normalizeDisposition(value: unknown): TransferDisposition {
  return value === "not-sent" || value === "handed-off" || value === "unknown" ? value : "unknown";
}

function safeCancel(handle: CancellationHandle | undefined): TransferDisposition | undefined {
  if (!handle) return undefined;
  try {
    return normalizeDisposition(handle.cancel());
  } catch {
    return "unknown";
  }
}

function safeClose(connection: TerminalConnection | undefined): void {
  if (!connection) return;
  try {
    connection.close();
  } catch {
    // dispose below still gets a chance to release local resources.
  }
  safeDispose(connection);
}

function copyCredentials(
  credentials: ClientCredentials,
  codec: Utf8Codec,
): Readonly<ClientCredentials> | null {
  try {
    const authorization = credentials.authorization;
    const terminalSecret = credentials.terminalSecret;
    if (
      typeof authorization !== "string" ||
      authorization.length === 0 ||
      codec.encode(authorization).byteLength > MAX_AUTHORIZATION_BYTES ||
      typeof terminalSecret !== "string"
    )
      return null;
    return Object.freeze({ authorization, terminalSecret });
  } catch {
    return null;
  }
}

function headersFor(authorization: string, offer: FrozenOffer): Readonly<Record<string, string>> {
  return Object.freeze({
    Authorization: authorization,
    "Content-Type": "application/json",
    "Cove-Protocol": String(PROTOCOL_VERSION),
    "Cove-Server-Id": offer.expectedServerId,
    "Cove-Instance-Id": offer.expectedRelayInstanceId,
  });
}

function responseHeadersMatch(
  headers: Readonly<Record<string, string>>,
  binding: RpcBinding,
): boolean {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (Object.hasOwn(normalized, lower) && normalized[lower] !== value) return false;
    normalized[lower] = value;
  }
  if (Object.hasOwn(normalized, BUSINESS_HEADERS[0].toLowerCase())) return false;
  return (
    normalized[BUSINESS_HEADERS[1].toLowerCase()] === String(binding.protocolVersion) &&
    normalized[BUSINESS_HEADERS[2].toLowerCase()] === binding.serverId &&
    normalized[BUSINESS_HEADERS[3].toLowerCase()] === binding.relayInstanceId
  );
}

function mergeDisposition(
  previous: TransferDisposition | undefined,
  next: unknown,
): TransferDisposition {
  next = normalizeDisposition(next);
  if (previous === "unknown" || next === "unknown") return "unknown";
  if (previous === "handed-off" || next === "handed-off") return "handed-off";
  return "not-sent";
}

class CoveClient implements Client {
  private readonly offer: FrozenOffer;
  private readonly connectionTimeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly optionsValid: boolean;
  private status: ClientStatus = "idle";
  private generation = 0;
  private attempt: ConnectAttempt | undefined;
  private connectedAttempt: ConnectAttempt | undefined;
  private connection: NegotiatedConnection | undefined;
  private lastError: ClientError | undefined;
  private readonly listeners = new Set<(snapshot: ClientSnapshot) => void>();
  private readonly pendingRpcs = new Map<string, PendingRpc>();
  // This map exists only while a write is in flight. Unknown outcomes are handed to
  // callers; retaining them here would turn the client into a second receipt ledger.
  private readonly activeOperationIntents = new Map<string, string>();
  private requestSequence = 0;
  private peakPendingRpcCount = 0;
  private suppressRpcState = false;

  constructor(private readonly options: ClientOptions) {
    this.offer = copyOffer(options);
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.optionsValid =
      validOffer(this.offer) &&
      validDeadline(this.connectionTimeoutMs, MAX_CONNECTION_TIMEOUT_MS) &&
      validDeadline(this.rpcTimeoutMs, MAX_RPC_TIMEOUT_MS);
  }

  connect(): Promise<ConnectOutcome> {
    if (this.status === "disposed")
      return Promise.resolve({ ok: false, error: localError("disposed") });
    if (!this.optionsValid)
      return Promise.resolve({ ok: false, error: localError("invalid-options") });
    if (this.attempt) return this.attempt.promise;
    if (this.status === "connected" && this.connection)
      return Promise.resolve({ ok: true, connection: this.connection });
    if (this.status !== "idle")
      return Promise.resolve({ ok: false, error: localError("invalid-state") });
    return this.beginConnect();
  }

  reconnect(): Promise<ConnectOutcome> {
    if (this.status === "disposed")
      return Promise.resolve({ ok: false, error: localError("disposed") });
    if (!this.optionsValid)
      return Promise.resolve({ ok: false, error: localError("invalid-options") });
    this.fenceConnection("invalid-state");
    this.status = "idle";
    this.lastError = undefined;
    this.emitState();
    if (this.status !== "idle")
      return Promise.resolve({
        ok: false,
        error: localError(this.status === "disposed" ? "disposed" : "invalid-state"),
      });
    return this.beginConnect();
  }

  call<M extends RpcMethod>(method: M, params: ParamsFor<M>): Promise<CallOutcome<ResultFor<M>>> {
    if (this.status === "disposed") return this.localCallFailure("disposed");
    const binding = this.connection;
    if (this.status !== "connected" || !binding) return this.localCallFailure("invalid-state");
    if (!Object.hasOwn(RPC_METHODS, method)) return this.localCallFailure("invalid-request");
    const capability = RPC_METHODS[method].capability;
    if (!binding.capabilities.includes(capability)) return this.localCallFailure("invalid-request");
    if (
      this.pendingRpcs.size >= Math.min(binding.effectiveBudgets.rpcInflight, M0_LIMITS.rpcInflight)
    )
      return this.localCallFailure("capacity");

    let suppliedRequestId: string;
    try {
      suppliedRequestId = this.options.createOpaqueId();
    } catch {
      return this.localCallFailure("invalid-request");
    }
    const requestSequence = nextCounter(this.requestSequence);
    if (!OpaqueIdSchema.safeParse(suppliedRequestId).success || requestSequence === null)
      return this.localCallFailure("invalid-request");
    this.requestSequence = requestSequence;
    const suffix = `.${this.generation}.${requestSequence}`;
    const requestId = `${suppliedRequestId.slice(0, 128 - suffix.length)}${suffix}`;
    const prepared = prepareCall(method, params, requestId, binding);
    if (!prepared) return this.localCallFailure("instance-binding");

    const writeMethod = method === "terminal.create" || method === "terminal.stop";
    const operation = writeMethod
      ? immutableOperation(
          method,
          (prepared.params as ParamsFor<"terminal.create">).operationId,
          binding.relayInstanceId,
        )
      : undefined;
    let canonicalIntent: string | undefined;
    if (writeMethod) {
      try {
        canonicalIntent =
          canonicalOperationIntent(method, prepared.params, (text) =>
            this.options.codec.encode(text),
          ) ?? undefined;
      } catch {
        return this.localCallFailure("invalid-request");
      }
      if (!canonicalIntent) return this.localCallFailure("invalid-request");
      const existing = this.activeOperationIntents.get(operation!.operationId);
      if (existing !== undefined && existing !== canonicalIntent)
        return this.localCallFailure("operation-conflict");
      if (existing !== undefined) return this.localCallFailure("invalid-state");
      this.activeOperationIntents.set(operation!.operationId, canonicalIntent);
    }

    let body: Uint8Array;
    try {
      body = new Uint8Array(this.options.codec.encode(JSON.stringify(prepared.request)));
    } catch {
      if (operation) this.activeOperationIntents.delete(operation.operationId);
      return this.localCallFailure("invalid-request");
    }
    const requestCap = Math.min(
      binding.effectiveBudgets.rpcRequestBytes,
      M0_LIMITS.rpcRequestBytes,
    );
    if (body.byteLength < 1 || body.byteLength > requestCap) {
      if (operation) this.activeOperationIntents.delete(operation.operationId);
      return this.localCallFailure("capacity");
    }
    return this.dispatchRpc(prepared, body, binding, operation);
  }

  getOperation(operationId: string): Promise<CallOutcome<ResultFor<"operation.get">>> {
    return this.call("operation.get", {
      operationId,
      expectedRelayInstanceId: this.offer.expectedRelayInstanceId,
    });
  }

  snapshot(): ClientSnapshot {
    return Object.freeze({
      status: this.status,
      generation: this.generation,
      ...(this.connection ? { connection: this.connection } : {}),
      pendingRpcCount: this.pendingRpcs.size,
      peakPendingRpcCount: this.peakPendingRpcCount,
      listenerCount: this.listeners.size,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    });
  }

  onState(listener: (snapshot: ClientSnapshot) => void): Disposable {
    if (this.status === "disposed") return Object.freeze({ dispose() {} });
    this.listeners.add(listener);
    let active = true;
    return Object.freeze({
      dispose: () => {
        if (!active) return;
        active = false;
        this.listeners.delete(listener);
      },
    });
  }

  dispose(): void {
    if (this.status === "disposed") return;
    this.fenceConnection("disposed");
    this.status = "disposed";
    this.lastError = undefined;
    this.emitState();
    this.listeners.clear();
    this.activeOperationIntents.clear();
  }

  private beginConnect(): Promise<ConnectOutcome> {
    const generation = nextCounter(this.generation);
    if (generation === null)
      return Promise.resolve({ ok: false, error: localError("invalid-state") });
    this.generation = generation;
    let resolve!: (outcome: ConnectOutcome) => void;
    const promise = new Promise<ConnectOutcome>((settle) => {
      resolve = settle;
    });
    let startedAtMs: number;
    try {
      startedAtMs = this.options.scheduler.nowMs();
      if (!Number.isFinite(startedAtMs)) throw new Error();
    } catch {
      return Promise.resolve({ ok: false, error: localError("invalid-options") });
    }
    const attempt: ConnectAttempt = {
      generation,
      offer: this.offer,
      request: createBootstrapRequest(this.offer),
      promise,
      resolve,
      startedAtMs,
      httpMessageSeen: false,
      terminalOpened: false,
      terminalMessageSeen: false,
      finished: false,
      fenced: false,
      committed: false,
    };
    this.attempt = attempt;
    this.status = "connecting";
    this.lastError = undefined;
    this.emitState();
    if (!this.currentAttempt(attempt)) return promise;
    try {
      const timer = this.options.scheduler.setTimer(this.connectionTimeoutMs, () => {
        this.failConnect(attempt, localError("timeout"));
      });
      attempt.timer = timer;
      if (attempt.finished) safeDispose(timer);
    } catch {
      this.failConnect(attempt, localError("invalid-options"));
      return promise;
    }
    Promise.resolve()
      .then(() => this.options.credentials())
      .then(
        (credentials) => this.startConnectTransports(attempt, credentials),
        () => this.failConnect(attempt, localError("credential")),
      );
    return promise;
  }

  private startConnectTransports(attempt: ConnectAttempt, credentials: ClientCredentials): void {
    if (!this.currentAttempt(attempt)) return;
    const credentialSnapshot = copyCredentials(credentials, this.options.codec);
    if (!credentialSnapshot) {
      this.failConnect(attempt, localError("credential"));
      return;
    }
    const terminalBootstrap = createTerminalBootstrap(
      attempt.request,
      credentialSnapshot.terminalSecret,
    );
    if (!terminalBootstrap) {
      this.failConnect(attempt, localError("credential"));
      return;
    }
    let terminalText: string;
    let httpBody: Uint8Array;
    try {
      terminalText = JSON.stringify(terminalBootstrap);
      if (this.options.codec.encode(terminalText).byteLength > M0_LIMITS.bootstrapBytes)
        throw new Error();
      httpBody = new Uint8Array(this.options.codec.encode(JSON.stringify(attempt.request)));
    } catch {
      this.failConnect(attempt, localError("invalid-options"));
      return;
    }

    try {
      const cancellation = this.options.terminal.open({
        onOpen: (connection) => {
          if (!this.currentAttempt(attempt)) {
            safeClose(connection);
            return;
          }
          if (attempt.terminalOpened) {
            safeClose(connection);
            this.failConnect(attempt, this.negotiationError("invalid-bootstrap", "connection"));
            return;
          }
          attempt.terminalOpened = true;
          attempt.terminalConnection = connection;
          let disposition: TransferDisposition;
          try {
            disposition = normalizeDisposition(connection.send(terminalText));
          } catch {
            disposition = "unknown";
          }
          if (disposition !== "handed-off") this.failConnect(attempt, localError("transport"));
        },
        onText: (message) => this.onTerminalText(attempt, message),
        onBinary: () => this.onTerminalBusinessMessage(attempt),
        onClose: () => this.onTerminalClose(attempt),
      });
      attempt.terminalCancellation = cancellation;
      if (!this.currentAttempt(attempt)) safeCancel(cancellation);
    } catch {
      this.failConnect(attempt, localError("transport"));
      return;
    }
    if (!this.currentAttempt(attempt)) return;

    try {
      const cancellation = this.options.http.post(
        {
          path: LOCAL_PATHS.bootstrap,
          headers: headersFor(credentialSnapshot.authorization, attempt.offer),
          body: httpBody,
          maxResponseBytes: M0_LIMITS.bootstrapBytes,
        },
        {
          onDisposition: () => {},
          onResponse: (response) => {
            if (!this.currentAttempt(attempt) || attempt.finished) return;
            if (attempt.httpMessageSeen) {
              this.failConnect(attempt, this.negotiationError("invalid-bootstrap", "connection"));
              return;
            }
            attempt.httpMessageSeen = true;
            if (response.body.byteLength > M0_LIMITS.bootstrapBytes) {
              this.failConnect(attempt, localError("invalid-response"));
              return;
            }
            const decoded = decodeBootstrap(response.body, (bytes) =>
              this.options.codec.decodeFatal(bytes),
            );
            if (decoded.kind === "failure") {
              this.failConnect(
                attempt,
                Object.freeze({ category: "remote-bootstrap", reason: decoded.value.kind }),
              );
              return;
            }
            if (response.status !== 200) {
              this.failConnect(attempt, localError("invalid-response"));
              return;
            }
            const checked = checkBootstrap(decoded, "http", attempt.offer);
            if (!checked.ok) {
              this.failConnect(attempt, this.negotiationError("invalid-bootstrap", checked.field));
              return;
            }
            attempt.httpSuccess = checked.value;
            this.tryCommit(attempt);
          },
          onFailure: (failure) => {
            this.failConnect(
              attempt,
              localError(
                failure.reason === "response-too-large" ? "response-too-large" : "transport",
              ),
            );
          },
        },
      );
      attempt.httpCancellation = cancellation;
      if (attempt.finished || !this.currentAttempt(attempt)) safeCancel(cancellation);
    } catch {
      this.failConnect(attempt, localError("transport"));
    }
  }

  private onTerminalText(attempt: ConnectAttempt, message: Uint8Array): void {
    if (!this.currentAttempt(attempt)) return;
    if (attempt.committed || attempt.terminalMessageSeen || !attempt.terminalOpened) {
      this.onTerminalBusinessMessage(attempt);
      return;
    }
    attempt.terminalMessageSeen = true;
    let elapsedMs: number;
    try {
      elapsedMs = this.options.scheduler.nowMs() - attempt.startedAtMs;
    } catch {
      this.failConnect(attempt, localError("invalid-options"));
      return;
    }
    if (elapsedMs < 0 || elapsedMs > this.connectionTimeoutMs || elapsedMs > 5_000) {
      this.failConnect(attempt, localError("timeout"));
      return;
    }
    const decoded = decodeBootstrap(message, (bytes) => this.options.codec.decodeFatal(bytes));
    if (decoded.kind === "failure") {
      this.failConnect(
        attempt,
        Object.freeze({ category: "remote-bootstrap", reason: decoded.value.kind }),
      );
      return;
    }
    const checked = checkBootstrap(decoded, "terminal", attempt.offer);
    if (!checked.ok) {
      this.failConnect(attempt, this.negotiationError("invalid-bootstrap", checked.field));
      return;
    }
    attempt.terminalSuccess = checked.value;
    this.tryCommit(attempt);
  }

  private onTerminalBusinessMessage(attempt: ConnectAttempt): void {
    if (!this.currentAttempt(attempt)) return;
    if (attempt.committed) {
      this.loseConnectedAttempt(attempt, this.negotiationError("invalid-bootstrap", "connection"));
      return;
    }
    this.failConnect(attempt, this.negotiationError("invalid-bootstrap", "connection"));
  }

  private onTerminalClose(attempt: ConnectAttempt): void {
    if (!this.currentAttempt(attempt)) return;
    if (attempt.committed) {
      this.loseConnectedAttempt(attempt, localError("transport"));
      return;
    }
    this.failConnect(attempt, localError("transport"));
  }

  private tryCommit(attempt: ConnectAttempt): void {
    if (!this.currentAttempt(attempt) || !attempt.httpSuccess || !attempt.terminalSuccess) return;
    const agreement = agreeBootstraps(attempt.httpSuccess, attempt.terminalSuccess);
    if (!agreement.ok) {
      this.failConnect(attempt, this.negotiationError("channel-disagreement", agreement.field));
      return;
    }
    attempt.finished = true;
    attempt.committed = true;
    safeDispose(attempt.timer);
    safeCancel(attempt.httpCancellation);
    delete attempt.httpSuccess;
    delete attempt.terminalSuccess;
    delete attempt.httpCancellation;
    delete attempt.timer;
    this.attempt = undefined;
    this.connectedAttempt = attempt;
    this.connection = agreement.value;
    this.status = "connected";
    this.lastError = undefined;
    const outcome = Object.freeze({ ok: true, connection: agreement.value } as const);
    attempt.resolve(outcome);
    this.emitState();
  }

  private failConnect(attempt: ConnectAttempt, error: ClientError): void {
    if (!this.currentAttempt(attempt) || attempt.finished) return;
    attempt.finished = true;
    attempt.fenced = true;
    safeDispose(attempt.timer);
    safeCancel(attempt.httpCancellation);
    safeCancel(attempt.terminalCancellation);
    safeClose(attempt.terminalConnection);
    delete attempt.httpSuccess;
    delete attempt.terminalSuccess;
    delete attempt.httpCancellation;
    delete attempt.terminalCancellation;
    delete attempt.terminalConnection;
    delete attempt.timer;
    if (this.attempt === attempt) this.attempt = undefined;
    this.connection = undefined;
    this.status = error.category === "local" ? "unverifiable" : "incompatible";
    this.lastError = error;
    attempt.resolve(Object.freeze({ ok: false, error }));
    this.emitState();
  }

  private loseConnectedAttempt(attempt: ConnectAttempt, error: ClientError): void {
    if (!this.currentAttempt(attempt) || !attempt.committed) return;
    attempt.fenced = true;
    this.connectedAttempt = undefined;
    this.connection = undefined;
    this.status = error.category === "local" ? "unverifiable" : "incompatible";
    this.lastError = error;
    safeCancel(attempt.terminalCancellation);
    safeClose(attempt.terminalConnection);
    this.suppressRpcState = true;
    this.cancelPendingRpcs("transport");
    this.suppressRpcState = false;
    this.emitState();
  }

  private fenceConnection(reason: LocalErrorReason): void {
    const nextGeneration = nextCounter(this.generation);
    if (nextGeneration !== null) this.generation = nextGeneration;
    const attempt = this.attempt;
    if (attempt && !attempt.finished) {
      const error = localError(reason);
      attempt.finished = true;
      attempt.fenced = true;
      safeDispose(attempt.timer);
      safeCancel(attempt.httpCancellation);
      safeCancel(attempt.terminalCancellation);
      safeClose(attempt.terminalConnection);
      attempt.resolve(Object.freeze({ ok: false, error }));
    }
    this.attempt = undefined;
    const connected = this.connectedAttempt;
    if (connected) {
      connected.fenced = true;
      safeCancel(connected.terminalCancellation);
      safeClose(connected.terminalConnection);
    }
    this.connectedAttempt = undefined;
    this.connection = undefined;
    this.status = reason === "disposed" ? "disposed" : "idle";
    this.suppressRpcState = true;
    this.cancelPendingRpcs(reason);
    this.suppressRpcState = false;
  }

  private currentAttempt(attempt: ConnectAttempt): boolean {
    return !attempt.fenced && attempt.generation === this.generation && this.status !== "disposed";
  }

  private negotiationError(
    reason: "invalid-bootstrap" | "channel-disagreement",
    field: NegotiationField | "remote-failure",
  ): ClientError {
    return Object.freeze({ category: "negotiation", reason, field });
  }

  private dispatchRpc<M extends RpcMethod>(
    prepared: NonNullable<ReturnType<typeof prepareCall<M>>>,
    body: Uint8Array,
    binding: NegotiatedConnection,
    operation: OperationReference | undefined,
  ): Promise<CallOutcome<ResultFor<M>>> {
    const generation = this.generation;
    const requestId = prepared.request.id;
    let resolve!: (outcome: CallOutcome<ResultFor<M>>) => void;
    const promise = new Promise<CallOutcome<ResultFor<M>>>((settle) => {
      resolve = settle;
    });
    let settlement: "active" | "settling" | "settled" = "active";
    let postEntered = false;
    let postInProgress = false;
    let cancellation: CancellationHandle | undefined;
    let cancellationRequested = false;
    let cancellationStarted = false;
    let deferredUncertainReason: LocalErrorReason | undefined;
    let timer: Disposable | undefined;
    let disposition: TransferDisposition | undefined;

    const cancelOnce = (): void => {
      cancellationRequested = true;
      if (!cancellation || cancellationStarted) return;
      // Claim the handle before adapter code can synchronously reenter settlement.
      cancellationStarted = true;
      disposition = mergeDisposition(disposition, safeCancel(cancellation));
    };
    const complete = (outcome: CallOutcome<ResultFor<M>>): void => {
      safeDispose(timer);
      cancelOnce();
      this.pendingRpcs.delete(requestId);
      if (operation) this.activeOperationIntents.delete(operation.operationId);
      settlement = "settled";
      resolve(Object.freeze(outcome));
      if (!this.suppressRpcState) this.emitState();
    };
    const finish = (outcome: CallOutcome<ResultFor<M>>): void => {
      if (settlement !== "active") return;
      settlement = "settling";
      complete(outcome);
    };
    const completeUncertain = (reason: LocalErrorReason): void => {
      cancelOnce();
      if (operation) {
        // Handle absence becomes inconclusive as soon as adapter code is entered.
        const notSent = !postEntered || disposition === "not-sent";
        complete(
          notSent
            ? { ok: false, kind: "operation-not-sent", operation }
            : {
                ok: false,
                kind: "operation-unknown",
                operation,
                error: domainError("RESULT_UNKNOWN", "unknown"),
              },
        );
      } else {
        complete({ ok: false, kind: "local-error", error: localError(reason) });
      }
    };
    const uncertainOrLocal = (reason: LocalErrorReason): void => {
      if (settlement !== "active") return;
      settlement = "settling";
      safeDispose(timer);
      cancelOnce();
      if (postInProgress && !cancellation) {
        deferredUncertainReason = reason;
        return;
      }
      completeUncertain(reason);
    };
    const pending: PendingRpc = {
      generation,
      cancel: uncertainOrLocal,
    };
    this.pendingRpcs.set(requestId, pending);
    this.peakPendingRpcCount = Math.max(this.peakPendingRpcCount, this.pendingRpcs.size);
    this.emitState();

    try {
      timer = this.options.scheduler.setTimer(this.rpcTimeoutMs, () => {
        uncertainOrLocal("timeout");
      });
      if (settlement !== "active") safeDispose(timer);
    } catch {
      uncertainOrLocal("invalid-state");
      return promise;
    }

    Promise.resolve()
      .then(() => this.options.credentials())
      .then(
        (credentials) => {
          if (
            settlement !== "active" ||
            generation !== this.generation ||
            this.status !== "connected"
          )
            return;
          const credentialSnapshot = copyCredentials(credentials, this.options.codec);
          if (!credentialSnapshot) {
            uncertainOrLocal("credential");
            return;
          }
          const responseCap = Math.min(
            binding.effectiveBudgets.rpcResponseBytes,
            M0_LIMITS.rpcResponseBytes,
          );
          try {
            if (
              settlement !== "active" ||
              generation !== this.generation ||
              this.status !== "connected"
            )
              return;
            // This boundary is monotonic even when post() reenters or throws.
            postEntered = true;
            postInProgress = true;
            const returnedCancellation = this.options.http.post(
              {
                path: LOCAL_PATHS.rpc,
                headers: headersFor(credentialSnapshot.authorization, this.offer),
                body,
                maxResponseBytes: responseCap,
              },
              {
                onDisposition: (next) => {
                  if (settlement === "settled") return;
                  disposition = mergeDisposition(disposition, next);
                },
                onResponse: (response) => {
                  if (
                    settlement !== "active" ||
                    generation !== this.generation ||
                    this.status !== "connected"
                  )
                    return;
                  disposition = mergeDisposition(disposition, "handed-off");
                  if (response.body.byteLength > responseCap) {
                    uncertainOrLocal("response-too-large");
                    return;
                  }
                  if (response.status !== 200 || !responseHeadersMatch(response.headers, binding)) {
                    uncertainOrLocal("instance-binding");
                    return;
                  }
                  let decoded: unknown;
                  try {
                    decoded = JSON.parse(
                      this.options.codec.decodeFatal(new Uint8Array(response.body)),
                    );
                  } catch {
                    uncertainOrLocal("invalid-response");
                    return;
                  }
                  const checked = checkRpcResponse(
                    prepared.method,
                    prepared.params,
                    requestId,
                    decoded,
                    binding,
                  );
                  if (checked.kind === "invalid") {
                    uncertainOrLocal("invalid-response");
                    return;
                  }
                  if (checked.kind === "rpc-error") {
                    const error = checked.response.error;
                    if (operation && !rpcErrorProvesWriteNotAccepted(checked.response)) {
                      finish({
                        ok: false,
                        kind: "operation-unknown",
                        operation,
                        error: domainError("RESULT_UNKNOWN", "unknown"),
                      });
                    } else {
                      finish({
                        ok: false,
                        kind: "rpc-error",
                        error:
                          error.data ?? Object.freeze({ code: error.code, message: error.message }),
                      });
                    }
                    return;
                  }
                  finish({ ok: true, value: checked.value });
                },
                onFailure: (failure) => {
                  if (settlement === "settled") return;
                  disposition = mergeDisposition(disposition, failure.disposition);
                  uncertainOrLocal(
                    failure.reason === "response-too-large" ? "response-too-large" : "transport",
                  );
                },
              },
            );
            postInProgress = false;
            cancellation = returnedCancellation;
            if (cancellationRequested || settlement !== "active") cancelOnce();
            if (deferredUncertainReason) {
              const reason = deferredUncertainReason;
              deferredUncertainReason = undefined;
              completeUncertain(reason);
            }
          } catch {
            postInProgress = false;
            disposition = mergeDisposition(disposition, "unknown");
            if (deferredUncertainReason) {
              const reason = deferredUncertainReason;
              deferredUncertainReason = undefined;
              completeUncertain(reason);
            } else {
              uncertainOrLocal("transport");
            }
          }
        },
        () => uncertainOrLocal("credential"),
      );
    return promise;
  }

  private cancelPendingRpcs(reason: LocalErrorReason): void {
    for (const pending of [...this.pendingRpcs.values()]) pending.cancel(reason);
  }

  private localCallFailure<T>(reason: LocalErrorReason): Promise<CallOutcome<T>> {
    return Promise.resolve(
      Object.freeze({ ok: false, kind: "local-error", error: localError(reason) }),
    );
  }

  private emitState(): void {
    const snapshot = this.snapshot();
    // Snapshotting the listener set makes reentrant unsubscribe/dispose deterministic:
    // each listener present at publication is invoked at most once for that publication.
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Application listener failures are isolated from connection cleanup and peers.
      }
    }
  }
}

export function createClient(options: ClientOptions): Client {
  return new CoveClient(options);
}

export type { ParamsFor, ResultFor } from "./rpc-calls.js";
export type { NegotiatedConnection } from "./connection-session.js";
export type { RpcMethod } from "@cove/protocol/rpc";
export type {
  CancellationHandle,
  ClientCredentials,
  CredentialSupplier,
  Disposable,
  HttpCallbacks,
  HttpFailure,
  HttpPort,
  HttpRequest,
  HttpResponse,
  Scheduler,
  TerminalConnection,
  TerminalOpenCallbacks,
  TerminalPort,
  TransferDisposition,
  Utf8Codec,
} from "./transport-ports.js";
