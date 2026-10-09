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
      let settled = false;
      let sent = false;
      const fail = (reason: "transport" | "response-too-large") => {
        if (settled) return;
        settled = true;
        callbacks.onFailure({ disposition: sent ? "unknown" : "not-sent", reason });
      };
      const req = httpRequest(
        new URL(request.path, base),
        { method: "POST", headers: { ...request.headers }, agent: false },
        (res) => {
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
            if (settled) return;
            settled = true;
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
      req.on("error", () => fail("transport"));
      req.end(request.body, () => {
        sent = true;
      });
      return {
        cancel(): TransferDisposition {
          if (settled) return "handed-off";
          settled = true;
          req.destroy();
          return sent ? "unknown" : "not-sent";
        },
      };
    },
  };
}

export function createNodePorts(endpoint: string): { http: HttpPort; terminal: TerminalPort } {
  return { http: createNodeHttpPort(endpoint), terminal: createWebPorts({ endpoint }).terminal };
}
