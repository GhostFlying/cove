import { request as httpRequest } from "node:http";
import { createWebPorts } from "@cove/client/web-ports";
import type {
  CancellationHandle,
  HttpCallbacks,
  HttpPort,
  HttpRequest,
  TerminalPort,
  TransferDisposition,
} from "@cove/client";

// Node's built-in fetch always sends `Sec-Fetch-Mode: cors`, which the server correctly
// treats as a browser request that must carry an approved Origin. A CLI is not a browser,
// so Node uses node:http for RPC and keeps the standard WebSocket for the terminal channel.
export function createNodeHttpPort(endpoint: string): HttpPort {
  const base = new URL(endpoint);
  return {
    post(request: HttpRequest, callbacks: HttpCallbacks): CancellationHandle {
      // Non-delivery is proven only while the TCP connection is still being established:
      // node:http buffers the body until connect, so no byte can have reached the server.
      // From connect onward any byte may already be on the wire, so an interrupted request
      // is "unknown"; a response proves "handed-off". Once settled, the reported disposition
      // is final and a later cancel() repeats it rather than contradicting it.
      let connected = false;
      let responded = false;
      let final: TransferDisposition | undefined;
      const current = (): TransferDisposition =>
        responded ? "handed-off" : connected ? "unknown" : "not-sent";
      const fail = (reason: "transport" | "response-too-large") => {
        if (final) return;
        final = current();
        callbacks.onFailure({ disposition: final, reason });
      };
      const req = httpRequest(
        new URL(request.path, base),
        { method: "POST", headers: { ...request.headers }, agent: false },
        (res) => {
          responded = true;
          callbacks.onDisposition("handed-off");
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > request.maxResponseBytes) {
              res.destroy();
              fail("response-too-large");
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (final) return;
            final = "handed-off";
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(res.headers))
              if (typeof value === "string") headers[name] = value;
            callbacks.onResponse({
              status: res.statusCode ?? 0,
              headers,
              body: new Uint8Array(Buffer.concat(chunks, total)),
            });
          });
          res.on("error", () => fail("transport"));
          // A connection dropped mid-body ends with close but no end event.
          res.on("close", () => fail("transport"));
        },
      );
      req.on("socket", (socket) => {
        // agent: false always yields a fresh socket; treat an already-open one as written.
        if (!socket.connecting) connected = true;
        else socket.once("connect", () => (connected = true));
      });
      req.on("error", () => fail("transport"));
      req.end(request.body);
      return {
        cancel(): TransferDisposition {
          if (final) return final;
          final = current();
          req.destroy();
          return final;
        },
      };
    },
  };
}

export function createNodePorts(endpoint: string): { http: HttpPort; terminal: TerminalPort } {
  return { http: createNodeHttpPort(endpoint), terminal: createWebPorts({ endpoint }).terminal };
}
