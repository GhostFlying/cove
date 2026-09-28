export type TransferDisposition = "not-sent" | "handed-off" | "unknown";

export interface CancellationHandle {
  cancel(): TransferDisposition;
}

export interface Disposable {
  dispose(): void;
}

export interface HttpRequest {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly maxResponseBytes: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface HttpFailure {
  readonly disposition: TransferDisposition;
  readonly reason: "transport" | "response-too-large";
}

export interface HttpCallbacks {
  onDisposition(disposition: TransferDisposition): void;
  onResponse(response: HttpResponse): void;
  onFailure(failure: HttpFailure): void;
}

export interface HttpPort {
  // The adapter must enforce maxResponseBytes before buffering the complete body.
  post(request: HttpRequest, callbacks: HttpCallbacks): CancellationHandle;
}

export interface TerminalConnection extends Disposable {
  // Admission must be immediate and bounded; handed-off does not prove remote acceptance.
  send(message: string | Uint8Array): TransferDisposition;
  close(): void;
}

export interface TerminalOpenCallbacks {
  onOpen(connection: TerminalConnection): void;
  onText(message: Uint8Array): void;
  onBinary(message: Uint8Array): void;
  onClose(): void;
}

export interface TerminalPort {
  // onOpen may run synchronously. Passing the connection into the callback lets the
  // client send its first message without depending on open() having returned.
  open(callbacks: TerminalOpenCallbacks): CancellationHandle;
}

export interface Scheduler {
  nowMs(): number;
  setTimer(delayMs: number, callback: () => void): Disposable;
  yieldTurn(): Promise<void>;
}

export interface Utf8Codec {
  encode(text: string): Uint8Array;
  decodeFatal(bytes: Uint8Array): string;
}

export interface ClientCredentials {
  readonly authorization: string;
  readonly terminalSecret: string;
}

export type CredentialSupplier = () => ClientCredentials | Promise<ClientCredentials>;
