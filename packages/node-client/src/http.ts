import { request as httpRequest } from "node:http";

// One JSON POST before any credential is involved: the pre-authentication identity of a business
// or pairing port, and the pairing redemption. Bounded in time and size; node:http rather than
// fetch, which would mark the request as a browser's (Sec-Fetch-Mode) and be refused.
// `disposition` tells a failure before anything was sent (`not-sent`: the connection was never
// established) from one after the request may have been delivered (`unknown`).
export type JsonResponse = { status: number; body: unknown };

export class TransportFailure extends Error {
  constructor(readonly disposition: "not-sent" | "unknown") {
    super(disposition === "not-sent" ? "could not connect" : "the connection failed");
  }
}

export function postJson(
  endpoint: string,
  path: string,
  body: unknown,
  { maxResponseBytes, timeoutMs }: { maxResponseBytes: number; timeoutMs: number },
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    let connected = false;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new TransportFailure(connected ? "unknown" : "not-sent"));
    };
    const req = httpRequest(
      new URL(path, endpoint),
      {
        method: "POST",
        agent: false,
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(text),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxResponseBytes) {
            res.destroy();
            fail();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          let parsed: unknown;
          try {
            parsed = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
            );
          } catch {
            parsed = undefined;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on("error", fail);
        res.on("close", fail);
      },
    );
    req.on("socket", (socket) => {
      if (!socket.connecting) connected = true;
      else socket.once("connect", () => (connected = true));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", fail);
    req.end(text);
  });
}
