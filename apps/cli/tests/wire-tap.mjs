import { randomUUID } from "node:crypto";
import { createClient } from "@cove/client";
import { createDefaultScheduler, createUtf8Codec } from "@cove/client/web-ports";
import { createTerminalDecoder, encodeTerminalFrame } from "@cove/protocol/terminal";
import { createNodePorts } from "../dist/node-ports.js";
import { CLI_BUILD_VERSION } from "../dist/session.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeFrames(frameDecoder, bytes) {
  const frames = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const read = frameDecoder.read(bytes.subarray(offset));
    if (read.status === "error" || read.consumedBytes === 0)
      throw new Error("wire tap could not decode a terminal frame");
    offset += read.consumedBytes;
    for (const frame of read.frames)
      frames.push({
        kind: frame.kind,
        metadata: JSON.parse(decoder.decode(frame.metadata)),
        payload: frame.payload.slice(),
      });
  }
  return frames;
}

// A client whose terminal channel runs through a test-side tap on the injectable
// TerminalPort. The tap records decoded frames in both directions, can hold inbound frames
// to model a client that stops consuming, can drop the connection like a network loss, and
// can send hand-built commands whose replies it keeps away from the client. Nothing here
// touches the server: every effect is something a real peer could do on the wire.
export function createTappedClient(record) {
  const base = createNodePorts(record.endpoint);
  let current;
  const tap = {
    inbound: [],
    outbound: [],
    held: [],
    paused: false,
    // Hold inbound terminal frames instead of handing them to the client.
    pause() {
      tap.paused = true;
    },
    // Hand held frames to the client one macrotask apart so the client parses at its own
    // pace, as a consumer that has caught up again would.
    async resume() {
      tap.paused = false;
      while (tap.held.length && !tap.paused) {
        const { callbacks, bytes, connection } = tap.held.shift();
        if (connection === current) callbacks.onBinary(bytes);
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    disconnect() {
      if (!current) throw new Error("wire tap has no open connection");
      current.raw.close();
    },
    // Send one hand-built command on the live connection and resolve with its reply frame.
    inject(metadata, payload = new Uint8Array()) {
      if (!current) throw new Error("wire tap has no open connection");
      const requestId = `tap-${randomUUID()}`;
      const encoded = encodeTerminalFrame(
        1,
        encoder.encode(JSON.stringify({ ...metadata, requestId })),
        payload,
      );
      if (!encoded.ok) throw new Error("wire tap could not encode a command");
      const reply = new Promise((resolve) => current.injected.set(requestId, resolve));
      if (current.raw.send(encoded.value) !== "handed-off")
        throw new Error("wire tap could not send a command");
      return reply;
    },
    // Input payloads the client itself sent, decoded as text, per subscription id.
    sentInput(subscriptionId) {
      return tap.outbound
        .filter(
          (frame) =>
            frame.metadata.type === "input" &&
            frame.metadata.subscription.subscriptionId === subscriptionId,
        )
        .map((frame) => decoder.decode(frame.payload))
        .join("");
    },
  };

  const terminal = {
    open(callbacks) {
      const connection = {
        raw: undefined,
        injected: new Map(),
        inbound: createTerminalDecoder(),
        outbound: createTerminalDecoder(),
      };
      current = connection;
      return base.terminal.open({
        onOpen(raw) {
          connection.raw = raw;
          callbacks.onOpen({
            send(message) {
              if (message instanceof Uint8Array)
                tap.outbound.push(...decodeFrames(connection.outbound, message));
              return raw.send(message);
            },
            close: () => raw.close(),
            dispose: () => raw.dispose(),
          });
        },
        onText: (message) => callbacks.onText(message),
        onBinary(bytes) {
          const frames = decodeFrames(connection.inbound, bytes);
          // The tap sends whole frames per message, so a reply to an injected command
          // always arrives as its own message and can be withheld from the client.
          const injected = frames.find((frame) =>
            connection.injected.has(frame.metadata.requestId),
          );
          if (injected) {
            const resolve = connection.injected.get(injected.metadata.requestId);
            connection.injected.delete(injected.metadata.requestId);
            resolve(injected);
            return;
          }
          tap.inbound.push(...frames);
          if (tap.paused) tap.held.push({ callbacks, bytes: bytes.slice(), connection });
          else callbacks.onBinary(bytes);
        },
        onClose() {
          if (current === connection) current = undefined;
          callbacks.onClose();
        },
      });
    },
  };

  const client = createClient({
    expectedServerId: record.serverId,
    expectedRelayInstanceId: record.relayInstanceId,
    buildVersion: CLI_BUILD_VERSION,
    credentials: () => ({
      authorization: `Bearer ${record.secret}`,
      terminalSecret: record.secret,
    }),
    codec: createUtf8Codec(),
    createOpaqueId: () => randomUUID(),
    scheduler: createDefaultScheduler(),
    http: base.http,
    terminal,
  });
  return { client, tap };
}
