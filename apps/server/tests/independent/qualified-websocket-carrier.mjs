import { EventEmitter, once } from "node:events";
import { Writable } from "node:stream";

// Complete lower messages reach the same factory handler; this is not WS reassembly.
export function qualifiedWebSocketCarrier(peerID, capture, held = false) {
  const messages = new EventEmitter();
  const writes = [];
  const pending = [];
  const closeCodes = [];
  let sendTicket = 0;
  const transport = new Writable({
    write(raw, _encoding, completed) {
      writes.push(Buffer.from(raw));
      const ticket = ++sendTicket;
      capture("ws-real-write", { peerID, ticket, raw });
      if (held) pending.push({ completed, ticket });
      else completed();
    },
  });
  for (const event of ["finish", "close", "error", "drain"])
    transport.on(event, (error) => {
      capture("ws-owned-transport-" + event, { peerID, error });
      if (event === "close") messages.emit("close");
      if (event === "error") messages.emit("error");
    });
  const socket = {
    on(event, callback) {
      return messages.on(event, callback);
    },
    send(raw, callback) {
      capture("ws-send-before", { peerID, raw });
      const accepted = transport.write(raw, (error) => {
        capture("ws-actual-send-completion-before", { peerID, error });
        callback(error);
        capture("ws-actual-send-completion-after", { peerID });
      });
      capture("ws-real-write-return", { peerID, accepted });
    },
    close(code) {
      closeCodes.push(code);
      capture("ws-close-request", { peerID, code });
      transport.destroy();
    },
  };
  return {
    socket,
    transport,
    writes,
    closeCodes,
    message(bytes, binary) {
      capture("ws-original-message-before", { peerID, bytes, binary });
      messages.emit("message", bytes, binary);
      capture("ws-original-message-after", { peerID });
    },
    async settle() {
      await new Promise((resolve) => process.nextTick(resolve));
      capture("ws-current-turn-completed", { peerID, closed: transport.closed });
    },
    async lateWriteCompletion() {
      for (const task of pending.splice(0)) {
        capture("ws-genuine-lower-completion-before", { peerID, ticket: task.ticket });
        task.completed();
        capture("ws-genuine-lower-completion-after", { peerID, ticket: task.ticket });
      }
      await this.settle();
    },
    async dispose() {
      const closed = transport.closed ? undefined : once(transport, "close");
      transport.destroy();
      if (closed) await closed;
      await this.lateWriteCompletion();
      capture("ws-carrier-finally", {
        peerID,
        actualClosed: transport.closed,
        pendingWrites: pending.length,
      });
    },
  };
}
