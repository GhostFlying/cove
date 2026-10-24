import type {
  CancellationHandle,
  HttpCallbacks,
  HttpPort,
  HttpRequest,
  TerminalConnection,
  TerminalOpenCallbacks,
  TerminalPort,
  TransferDisposition,
} from "@cove/client";
import { z } from "zod";
import { decodeBase64, encodeBase64, utf8 } from "./codec.js";

// Private native module surface. Synchronous functions perform bounded local
// admission only; the single asynchronous pull runs on a separate executor.
export interface NativeDriver {
  openEntry(peerID: string, port: number): number;
  closeEntry(entry: number): void;
  post(
    entry: number,
    id: number,
    path: string,
    headers: string,
    body: string,
    limit: number,
  ): boolean;
  openSocket(entry: number, id: number, path: string): boolean;
  send(id: number, binary: boolean, body: string): TransferDisposition;
  cancel(id: number): TransferDisposition;
  release(id: number): void;
  nextEvent(timeoutMilliseconds: number): Promise<string>;
  stop(): void;
}

const MAX_BYTES = 256 * 1024;
const disposition = z.enum(["not-sent", "handed-off", "unknown"]);
const nativeEvent = z
  .object({
    id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    type: z.enum([
      "http-response",
      "http-failure",
      "socket-open",
      "socket-close",
      "socket-text",
      "socket-binary",
    ]),
    disposition: disposition.optional(),
    status: z.number().int().min(100).max(599).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    reason: z.enum(["transport", "response-too-large"]).optional(),
  })
  .strict();
type NativeEvent = z.infer<typeof nativeEvent>;
interface Handler {
  event(value: NativeEvent): void;
  failed(): void;
}

export class NativePorts {
  private sequence = 0;
  private closed = false;
  private readonly handlers = new Map<number, Handler>();

  constructor(private readonly driver: NativeDriver) {
    void this.pump();
  }

  entry(peerID: string, port: number): NativeEntry {
    if (this.closed) throw new Error("Native transport closed");
    return new NativeEntry(this, this.driver.openEntry(peerID, port));
  }

  private async pump(): Promise<void> {
    try {
      while (!this.closed) {
        const text = await this.driver.nextEvent(30_000);
        if (this.closed) return;
        if (!text) continue;
        if (text.length > 512 * 1024) throw new Error("Native event exceeded bound");
        const value = nativeEvent.parse(JSON.parse(text));
        const terminal =
          value.type === "http-response" ||
          value.type === "http-failure" ||
          value.type === "socket-close";
        try {
          this.handlers.get(value.id)?.event(value);
        } finally {
          if (terminal) {
            this.handlers.delete(value.id);
            this.driver.release(value.id);
          }
        }
      }
    } catch {
      this.dispose();
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.driver.stop();
    const pending = [...this.handlers.values()];
    this.handlers.clear();
    for (const handler of pending) handler.failed();
  }

  closeEntry(entry: number): void {
    this.driver.closeEntry(entry);
  }

  private register(handler: Handler): number {
    if (this.closed || this.handlers.size >= 32 || this.sequence === Number.MAX_SAFE_INTEGER)
      throw new Error("Native transport capacity");
    const id = ++this.sequence;
    this.handlers.set(id, handler);
    return id;
  }

  post(entry: number, request: HttpRequest, callbacks: HttpCallbacks): CancellationHandle {
    let settled = false;
    let final: TransferDisposition = "not-sent";
    let id: number | undefined;
    let invoked = false;
    const fail = (value: TransferDisposition, reason: "transport" | "response-too-large") => {
      if (settled) return;
      settled = true;
      final = value;
      callbacks.onFailure({ disposition: value, reason });
    };
    try {
      id = this.register({
        event: (value) => {
          if (settled) return;
          if (value.type === "http-response") {
            if (value.status === undefined || value.disposition !== "handed-off")
              throw new Error("Invalid native HTTP result");
            const body = decodeBase64(value.body ?? "", request.maxResponseBytes);
            settled = true;
            final = "handed-off";
            callbacks.onDisposition(final);
            callbacks.onResponse({ status: value.status, headers: value.headers ?? {}, body });
          } else if (value.type === "http-failure" && value.disposition && value.reason) {
            fail(value.disposition, value.reason);
          } else throw new Error("Invalid native HTTP event");
        },
        failed: () => fail("unknown", "transport"),
      });
      if (request.body.byteLength > 64 * 1024 || request.maxResponseBytes > MAX_BYTES)
        throw new Error("Native HTTP request exceeded bound");
      const headers = JSON.stringify(request.headers);
      const body = encodeBase64(request.body);
      invoked = true;
      if (!this.driver.post(entry, id, request.path, headers, body, request.maxResponseBytes)) {
        this.handlers.delete(id);
        fail("not-sent", "transport");
      }
    } catch {
      if (id !== undefined && !invoked) this.handlers.delete(id);
      // A bridge exception after invocation does not prove native admission
      // failed. Keep the handle drainable and never replay this request.
      fail(invoked ? "unknown" : "not-sent", "transport");
    }
    return {
      cancel: () => {
        if (settled) return final;
        settled = true;
        try {
          final = id === undefined ? "not-sent" : this.driver.cancel(id);
        } catch {
          final = "unknown";
        }
        return final;
      },
    };
  }

  socket(entry: number, path: string, callbacks: TerminalOpenCallbacks): CancellationHandle {
    let settled = false;
    let opened = false;
    let final: TransferDisposition = "not-sent";
    let id: number | undefined;
    const close = () => {
      if (!settled) {
        settled = true;
        callbacks.onClose();
      }
    };
    const connection: TerminalConnection = {
      send: (message) => {
        if (settled || !opened || id === undefined) return "not-sent";
        let data: Uint8Array;
        try {
          data = typeof message === "string" ? utf8.encode(message) : message;
        } catch {
          return "not-sent";
        }
        if (data.byteLength > MAX_BYTES) return "not-sent";
        try {
          return this.driver.send(id, typeof message !== "string", encodeBase64(data));
        } catch {
          return "unknown";
        }
      },
      close: () => {
        cancel();
      },
      dispose: () => {
        cancel();
      },
    };
    const cancel = (): TransferDisposition => {
      if (settled) return final;
      try {
        final = id === undefined ? "not-sent" : this.driver.cancel(id);
      } catch {
        final = "unknown";
      }
      close();
      return final;
    };
    try {
      id = this.register({
        event: (value) => {
          if (settled) return;
          if (value.type === "socket-open" && !opened) {
            opened = true;
            final = "handed-off";
            callbacks.onOpen(connection);
          } else if (value.type === "socket-close") close();
          else if (opened && (value.type === "socket-text" || value.type === "socket-binary")) {
            const body = decodeBase64(value.body ?? "", MAX_BYTES);
            if (value.type === "socket-text") callbacks.onText(body);
            else callbacks.onBinary(body);
          } else throw new Error("Invalid native socket event");
        },
        failed: close,
      });
      if (!this.driver.openSocket(entry, id, path)) {
        this.handlers.delete(id);
        close();
      }
    } catch {
      final = id === undefined ? "not-sent" : "unknown";
      close();
    }
    return { cancel };
  }
}

export class NativeEntry {
  readonly http: HttpPort;
  readonly terminal: TerminalPort;
  private closed = false;

  constructor(
    private readonly owner: NativePorts,
    private readonly id: number,
  ) {
    this.http = { post: (request, callbacks) => this.owner.post(this.id, request, callbacks) };
    this.terminal = this.socket("/terminal");
  }

  // Raw route adapter only: T3 owns the business event schema/session mirror.
  socket(path: "/terminal" | "/events"): TerminalPort {
    return { open: (callbacks) => this.owner.socket(this.id, path, callbacks) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.owner.closeEntry(this.id);
  }
}
