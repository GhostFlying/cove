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
    // Outbound messages withheld from the server, and the test's choice of which to withhold.
    heldOutbound: [],
    outboundHold: undefined,
    holds: () => true,
    // Hold inbound terminal frames instead of handing them to the client. `holds` picks the
    // frames to hold, e.g. one subscription's events; the others still reach the client.
    pause(holds = () => true) {
      tap.holds = holds;
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
    // Withhold outbound messages carrying a frame whose metadata matches `predicate`. The
    // client sees them as handed off, as it would for a message still in the network.
    holdOutbound(predicate) {
      tap.outboundHold = predicate;
    },
    // Send every withheld message, in order, synchronously, so messages held by several taps
    // and released together reach the server as one burst.
    releaseOutbound() {
      tap.outboundHold = undefined;
      for (const { raw, message, connection } of tap.heldOutbound.splice(0))
        if (connection === current) raw.send(message);
    },
    disconnect() {
      if (!current) throw new Error("wire tap has no open connection");
      abandonInjected(current);
      current.raw.close();
    },
    // Send one hand-built command on the live connection and resolve with its reply frame.
    // It rejects if no reply arrives within the deadline or the connection ends first.
    inject(metadata, payload = new Uint8Array(), deadlineMs = 10_000) {
      if (!current) throw new Error("wire tap has no open connection");
      const requestId = `tap-${randomUUID()}`;
      const encoded = encodeTerminalFrame(
        1,
        encoder.encode(JSON.stringify({ ...metadata, requestId })),
        payload,
      );
      if (!encoded.ok) throw new Error("wire tap could not encode a command");
      const connection = current;
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => settleInjected(connection, requestId, new Error(`no reply to ${metadata.type}`)),
          deadlineMs,
        );
        connection.injected.set(requestId, { resolve, reject, timer });
      });
      if (connection.raw.send(encoded.value) !== "handed-off") {
        settleInjected(connection, requestId, new Error("wire tap could not send a command"));
      }
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

  // Settle one pending injection with its reply frame, or reject it with an error.
  function settleInjected(connection, requestId, outcome) {
    const pending = connection.injected.get(requestId);
    if (!pending) return;
    connection.injected.delete(requestId);
    clearTimeout(pending.timer);
    if (outcome instanceof Error) pending.reject(outcome);
    else pending.resolve(outcome);
  }
  function abandonInjected(connection) {
    for (const requestId of [...connection.injected.keys()])
      settleInjected(connection, requestId, new Error("wire tap connection ended"));
  }

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
              if (message instanceof Uint8Array) {
                const frames = decodeFrames(connection.outbound, message);
                tap.outbound.push(...frames);
                if (tap.outboundHold && frames.some((frame) => tap.outboundHold(frame.metadata))) {
                  tap.heldOutbound.push({ raw, message: message.slice(), connection });
                  return "handed-off";
                }
              }
              return raw.send(message);
            },
            close() {
              abandonInjected(connection);
              raw.close();
            },
            dispose() {
              abandonInjected(connection);
              raw.dispose();
            },
          });
        },
        onText: (message) => callbacks.onText(message),
        onBinary(bytes) {
          const frames = decodeFrames(connection.inbound, bytes);
          // The server sends one frame per message, so a reply to an injected command
          // always arrives as its own message and can be withheld from the client.
          const injected = frames.find((frame) =>
            connection.injected.has(frame.metadata.requestId),
          );
          if (injected) {
            settleInjected(connection, injected.metadata.requestId, injected);
            return;
          }
          tap.inbound.push(...frames);
          if (tap.paused && frames.some((frame) => tap.holds(frame)))
            tap.held.push({ callbacks, bytes: bytes.slice(), connection });
          else callbacks.onBinary(bytes);
        },
        onClose() {
          if (current === connection) current = undefined;
          abandonInjected(connection);
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
