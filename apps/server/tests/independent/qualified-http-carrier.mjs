import { EventEmitter, once } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex, Writable } from "node:stream";

// This carrier proves the factory's Node request listener, not native HTTP parsing.
export function qualifiedHttpCarrier(local, row, inputBytes, rawPairs, capture) {
  const pulse = new EventEmitter();
  const pending = [];
  const delivered = [];
  let ticket = 0;
  let finished = false;
  let failure;
  let deliveredRequestBytes = 0;
  const socket = new Duplex({
    readableHighWaterMark: 65536,
    writableHighWaterMark: 1,
    read() {},
    write(raw, _encoding, completed) {
      pending.push({ raw, completed, ticket: ++ticket });
      capture("actual-lower-write-held", {
        ticket,
        raw,
        backingBytes: raw.buffer.byteLength,
        admission: local.admission.snapshot(),
        ledger: local.core.runtime.composition.bytes.snapshot(),
      });
      pulse.emit("change");
    },
    destroy(error, completed) {
      while (pending.length)
        pending.shift().completed(error ?? new Error("Owned HTTP carrier closed"));
      completed(error);
    },
  });
  const request = new IncomingMessage(socket);
  request.method = row.input.method;
  request.url = row.input.path;
  request.httpVersion = "1.1";
  request.httpVersionMajor = 1;
  request.httpVersionMinor = 1;
  request.rawHeaders = rawPairs.flat();
  request.headers = {};
  for (const [name, value] of rawPairs) {
    const key = name.toLowerCase();
    const before = request.headers[key];
    request.headers[key] =
      before === undefined ? value : [...(Array.isArray(before) ? before : [before]), value];
  }
  const response = new ServerResponse(request);
  response.assignSocket(socket);
  for (const event of ["finish", "close", "error"])
    response.on(event, (error) => {
      capture("raw-response-" + event, {
        status: response.statusCode,
        headers: response.getHeaders(),
        error,
        admission: local.admission.snapshot(),
        ledger: local.core.runtime.composition.bytes.snapshot(),
      });
      if (event === "finish") finished = true;
      if (event === "error") failure = error;
      pulse.emit("change");
    });
  for (const event of ["drain", "close", "error"])
    socket.on(event, (error) => {
      capture("original-owned-socket-" + event, { error });
      pulse.emit("change");
    });
  for (const event of ["end", "aborted", "error"])
    request.on(event, (error) => capture("actual-reader-" + event, { error }));
  const destination = new Writable({
    write(raw, _encoding, completed) {
      delivered.push(Buffer.from(raw));
      capture("real-destination-write", { raw });
      completed();
    },
  });
  destination.on("error", (error) => {
    failure = error;
    pulse.emit("change");
  });
  return {
    socket,
    request,
    response,
    beginReader(prefix = inputBytes) {
      capture("factory-node-request-before", {
        method: request.method,
        path: request.url,
        rawHeaderPairs: rawPairs,
        inputBytes,
      });
      local.app.server.emit("request", request, response);
      request.push(prefix);
      deliveredRequestBytes = prefix.length;
      capture("real-reader-prefix-written", {
        bytes: prefix,
        originalBodyBytes: inputBytes.length,
      });
    },
    endReader(tail = Buffer.alloc(0)) {
      if (tail.length) request.push(tail);
      deliveredRequestBytes += tail.length;
      if (deliveredRequestBytes !== inputBytes.length)
        throw new Error("Original body not fully delivered at lower framing end");
      request.complete = true;
      capture("lower-framing-complete", { deliveredRequestBytes, nativeHttpParserCredit: false });
      request.push(null);
      capture("real-reader-original-end", { tail });
    },
    async route() {
      capture("factory-node-request-before", {
        method: request.method,
        path: request.url,
        rawHeaderPairs: rawPairs,
        inputBytes,
      });
      local.app.server.emit("request", request, response);
      let offset = 0;
      for (const length of row.input.receiptSlices ?? [inputBytes.length]) {
        request.push(inputBytes.subarray(offset, offset + length));
        offset += length;
      }
      if (offset !== inputBytes.length) throw new Error("Original receipt slice lengths changed");
      deliveredRequestBytes = offset;
      request.complete = true;
      capture("lower-framing-complete", { deliveredRequestBytes, nativeHttpParserCredit: false });
      request.push(null);
      return this.completeResponse();
    },
    async completeResponse(onClientEnd) {
      while (!finished) {
        if (failure) throw failure;
        if (!pending.length) {
          await once(pulse, "change");
          continue;
        }
        const task = pending.shift();
        await new Promise((resolve, reject) => {
          const accepted = destination.write(task.raw, (error) => {
            capture("actual-destination-write-completion-before", { ticket: task.ticket, error });
            task.completed(error);
            capture("actual-destination-write-completion-after", {
              ticket: task.ticket,
              ledger: local.core.runtime.composition.bytes.snapshot(),
            });
            if (error) reject(error);
            else resolve();
          });
          capture("actual-destination-write-return", { ticket: task.ticket, accepted });
        });
      }
      const wire = Buffer.concat(delivered);
      capture("full-response-wire-before-guards", { wire });
      const body = responseBody(wire);
      const client = new IncomingMessage(socket);
      const ended = new Promise((resolve, reject) => {
        client.on("error", reject);
        client.once("end", () => {
          capture("real-public-client-body-end", {
            body,
            lowerPayloadReaderNotNativeHttpParser: true,
          });
          try {
            onClientEnd?.();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      client.push(body);
      client.complete = true;
      client.push(null);
      client.resume();
      await ended;
      const projection = responseHeaderProjection(wire);
      capture("completed-response-header-projection", {
        ...projection,
        serverResponseHeaders: response.getHeaders(),
        projectionOrigin: "COMPLETED_OWN_WIRE",
      });
      return {
        wire,
        body,
        status: response.statusCode,
        headers: projection.headers,
        rawHeaderPairs: projection.rawHeaderPairs,
        serverResponseHeaders: response.getHeaders(),
      };
    },
    async dispose() {
      const closed = socket.closed ? undefined : once(socket, "close");
      socket.destroy();
      if (closed) await closed;
      request.destroy();
      destination.destroy();
      capture("http-carrier-finally", {
        socketClosed: socket.closed,
        destinationDestroyed: destination.destroyed,
      });
    },
  };
}

function responseHeaderProjection(wire) {
  const boundary = wire.indexOf("\r\n\r\n");
  if (boundary < 0) throw new Error("Actual HTTP response header boundary missing");
  const [statusLine, ...lines] = wire.subarray(0, boundary).toString("latin1").split("\r\n");
  const headers = Object.create(null);
  const rawHeaderPairs = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error("Actual HTTP response header separator missing");
    const name = line.slice(0, colon);
    const rawValue = line.slice(colon + 1);
    rawHeaderPairs.push([name, rawValue]);
    const key = name.toLowerCase();
    const value = rawValue.replace(/^[ \t]+|[ \t]+$/g, "");
    const previous = headers[key];
    headers[key] =
      previous === undefined
        ? value
        : [...(Array.isArray(previous) ? previous : [previous]), value];
  }
  return { statusLine, headers, rawHeaderPairs };
}

function responseBody(wire) {
  const boundary = wire.indexOf("\r\n\r\n");
  if (boundary < 0) throw new Error("Actual HTTP response header boundary missing");
  const headers = wire.subarray(0, boundary).toString("latin1");
  const body = wire.subarray(boundary + 4);
  if (!/transfer-encoding:\s*chunked/i.test(headers)) return body;
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    const end = body.indexOf("\r\n", offset);
    if (end < 0) throw new Error("Actual HTTP chunk boundary missing");
    const length = Number.parseInt(body.subarray(offset, end).toString("ascii"), 16);
    if (!Number.isSafeInteger(length)) throw new Error("Actual HTTP chunk length invalid");
    if (length === 0) return Buffer.concat(chunks);
    chunks.push(body.subarray(end + 2, end + 2 + length));
    offset = end + 2 + length + 2;
  }
  throw new Error("Actual HTTP final chunk missing");
}
