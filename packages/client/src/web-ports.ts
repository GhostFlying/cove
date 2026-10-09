import type {
  CancellationHandle,
  HttpCallbacks,
  HttpPort,
  HttpRequest,
  Scheduler,
  TerminalConnection,
  TerminalOpenCallbacks,
  TerminalPort,
  TransferDisposition,
  Utf8Codec,
} from "./transport-ports.js";

// Structural subsets of the WHATWG fetch and WebSocket APIs. Node 26, browsers and React
// Native all provide these globals, so one adapter serves every client without a DOM lib
// dependency or a Node-only transport package.
interface FetchHeaders {
  forEach(callback: (value: string, name: string) => void): void;
}

interface FetchBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

interface FetchResponse {
  readonly status: number;
  readonly headers: FetchHeaders;
  readonly body: { getReader(): FetchBodyReader } | null;
}

interface AbortSignalLike {
  readonly aborted: boolean;
}

interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(): void;
}

export type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: Uint8Array;
    signal: AbortSignalLike;
    redirect: "error";
  },
) => Promise<FetchResponse>;

interface WebSocketMessageEvent {
  readonly data: unknown;
}

export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: WebSocketMessageEvent) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;

export interface WebPortOptions {
  // The server's `http://host:port` endpoint as published in the rendezvous record.
  readonly endpoint: string;
  readonly fetch?: FetchLike;
  readonly createWebSocket?: WebSocketFactory;
  readonly createAbortController?: () => AbortControllerLike;
  // Upper bound on bytes queued inside the socket before send() reports not-sent. The
  // client applies its own credit; this only keeps one connection from buffering without
  // limit when the peer stops reading.
  readonly maxBufferedBytes?: number;
}

export interface WebPorts {
  readonly http: HttpPort;
  readonly terminal: TerminalPort;
}

const TERMINAL_PATH = "/terminal";
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function globalValue<T>(name: string): T {
  const value = (globalThis as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`Global ${name} is unavailable`);
  return value as T;
}

interface TextEncoderLike {
  encode(text: string): Uint8Array;
}

interface TextDecoderLike {
  decode(bytes: Uint8Array): string;
}

type TimerHandle = unknown;

function timers(): {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
} {
  return {
    setTimeout: globalValue("setTimeout"),
    clearTimeout: globalValue("clearTimeout"),
  };
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function createWebPorts(options: WebPortOptions): WebPorts {
  // The endpoint is an origin only; paths come from the protocol's fixed local routes.
  const match = /^(https?):\/\/([^/?#\s]+)$/.exec(options.endpoint);
  if (!match) throw new Error("Endpoint must be an http(s) origin");
  const secure = match[1] === "https";
  const origin = options.endpoint;
  const doFetch = options.fetch ?? globalValue<FetchLike>("fetch");
  const createAbort =
    options.createAbortController ??
    (() => new (globalValue<new () => AbortControllerLike>("AbortController"))());
  const createSocket =
    options.createWebSocket ??
    ((url: string) => new (globalValue<new (url: string) => WebSocketLike>("WebSocket"))(url));
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const textEncoder = new (globalValue<new () => TextEncoderLike>("TextEncoder"))();

  const http: HttpPort = {
    post(request: HttpRequest, callbacks: HttpCallbacks): CancellationHandle {
      const abort = createAbort();
      // Once fetch() is invoked the request may already be on the wire, so any later
      // failure is "unknown" rather than "not-sent": the server may have acted on it.
      let settled = false;
      const fail = (reason: "transport" | "response-too-large") => {
        if (settled) return;
        settled = true;
        callbacks.onFailure({ disposition: "unknown", reason });
      };
      const run = async () => {
        const response = await doFetch(`${origin}${request.path}`, {
          method: "POST",
          headers: { ...request.headers },
          body: request.body,
          signal: abort.signal,
          redirect: "error",
        });
        callbacks.onDisposition("handed-off");
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = response.body?.getReader();
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            // Enforce the cap while streaming so a hostile or confused peer cannot make
            // the client buffer an unbounded body.
            if (total > request.maxResponseBytes) {
              void reader.cancel().catch(() => {});
              fail("response-too-large");
              return;
            }
            chunks.push(value);
          }
        }
        if (settled) return;
        settled = true;
        callbacks.onResponse({ status: response.status, headers, body: concat(chunks, total) });
      };
      run().catch(() => fail("transport"));
      return {
        cancel(): TransferDisposition {
          if (settled) return "handed-off";
          settled = true;
          abort.abort();
          return "unknown";
        },
      };
    },
  };

  const terminalUrl = `${secure ? "wss" : "ws"}://${match[2]}${TERMINAL_PATH}`;

  const terminal: TerminalPort = {
    open(callbacks: TerminalOpenCallbacks): CancellationHandle {
      const socket = createSocket(terminalUrl);
      socket.binaryType = "arraybuffer";
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        callbacks.onClose();
      };
      const connection: TerminalConnection = {
        send(message: string | Uint8Array): TransferDisposition {
          if (closed || socket.readyState !== WS_OPEN) return "not-sent";
          if (socket.bufferedAmount > maxBuffered) return "not-sent";
          try {
            socket.send(message);
            return "handed-off";
          } catch {
            return "unknown";
          }
        },
        close(): void {
          socket.close(1000);
        },
        dispose(): void {
          socket.close(1000);
        },
      };
      socket.addEventListener("open", () => callbacks.onOpen(connection));
      socket.addEventListener("message", (event) => {
        if (closed) return;
        const data = event.data;
        if (typeof data === "string") callbacks.onText(textEncoder.encode(data));
        else if (data instanceof ArrayBuffer) callbacks.onBinary(new Uint8Array(data));
        else if (ArrayBuffer.isView(data))
          callbacks.onBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      });
      socket.addEventListener("close", finish);
      socket.addEventListener("error", finish);
      return {
        cancel(): TransferDisposition {
          const wasOpen = socket.readyState === WS_OPEN;
          socket.close(1000);
          return wasOpen ? "unknown" : "not-sent";
        },
      };
    },
  };

  return { http, terminal };
}

export function createDefaultScheduler(): Scheduler {
  const { setTimeout, clearTimeout } = timers();
  const performance = globalValue<{ now(): number }>("performance");
  return {
    nowMs: () => performance.now(),
    setTimer(delayMs, callback) {
      const handle = setTimeout(callback, delayMs);
      return { dispose: () => clearTimeout(handle) };
    },
    yieldTurn: () => new Promise((resolve) => setTimeout(() => resolve(), 0)),
  };
}

export function createUtf8Codec(): Utf8Codec {
  const encoder = new (globalValue<new () => TextEncoderLike>("TextEncoder"))();
  const decoder = new (globalValue<
    new (label: string, options: { fatal: boolean }) => TextDecoderLike
  >("TextDecoder"))("utf-8", { fatal: true });
  return {
    encode: (text) => encoder.encode(text),
    decodeFatal: (bytes) => decoder.decode(bytes),
  };
}
