// Future owned Node HTTP parser / registered WS carriers; syntax checks launch nothing.
import http from "node:http";
import { createHash } from "node:crypto";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function observer(persist) {
  const errors = [];
  return {
    errors,
    record(row) {
      try {
        persist(row);
      } catch (error) {
        errors.push(error);
      }
    },
  };
}
function refuse(primary, errors, label) {
  if (errors.length) throw new AggregateError([...(primary ? [primary] : []), ...errors], label);
  if (primary) throw primary;
}
function redact(raw) {
  const out = [...raw];
  for (let i = 0; i < out.length; i += 2)
    if (String(out[i]).toLowerCase() === "authorization") out[i + 1] = "<private-slot-redacted>";
  return out;
}
export async function realHttp(endpoint, path, rawHeaders, fixedBody, persist) {
  const trace = observer(persist),
    listeners = [];
  let req,
    res,
    agent,
    primary,
    result,
    handoff = false,
    requestClosed,
    requestCloseResolve;
  requestClosed = new Promise((resolve) => {
    requestCloseResolve = resolve;
  });
  const listen = (target, event, fn, once = false) => {
    listeners.push({ target, event, fn });
    if (once) target.once(event, fn);
    else target.on(event, fn);
  };
  try {
    const url = new URL(path, endpoint);
    trace.record({
      kind: "http.request",
      method: "POST",
      path,
      headers: redact(rawHeaders),
      bytes: fixedBody.byteLength,
      sha256: hash(fixedBody),
    });
    agent = new http.Agent({ keepAlive: false }); // All transport sockets belong to this request.
    result = await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      try {
        req = http.request(url, { method: "POST", headers: rawHeaders, agent }, (response) => {
          res = response;
          const chunks = [];
          let size = 0;
          try {
            listen(res, "error", (error) => {
              trace.record({ kind: "http.response-error", name: error.name });
              fail(error);
            });
            listen(res, "data", (bytes) => {
              try {
                size += bytes.byteLength;
                trace.record({
                  kind: "http.response-chunk",
                  bytes: bytes.byteLength,
                  sha256: hash(bytes),
                });
                if (size > 262144) {
                  const error = new Error("Original response cap exceeded");
                  fail(error);
                  res.destroy(error);
                  return;
                }
                chunks.push(bytes);
              } catch (error) {
                fail(error);
                res.destroy(error);
              }
            });
            listen(
              res,
              "end",
              () => {
                try {
                  const body = Buffer.concat(chunks);
                  trace.record({
                    kind: "http.response",
                    status: res.statusCode,
                    headers: res.rawHeaders,
                    bytes: body.length,
                    sha256: hash(body),
                    raw: body.toString("base64"),
                  });
                  if (!settled) {
                    settled = true;
                    resolve({ status: res.statusCode, headers: res.rawHeaders, body });
                  }
                } catch (error) {
                  fail(error);
                }
              },
              true,
            );
            listen(res, "aborted", () => fail(new Error("Actual response aborted")), true);
            listen(
              res,
              "close",
              () => trace.record({ kind: "http.response-original-close" }),
              true,
            );
          } catch (error) {
            fail(error);
            res.destroy(error);
          }
        });
        listen(req, "error", (error) => {
          trace.record({ kind: "http.error", handoff, name: error.name });
          fail(error);
        });
        listen(
          req,
          "close",
          () => {
            trace.record({ kind: "http.request-original-close", handoff });
            requestCloseResolve();
          },
          true,
        );
        req.end(fixedBody, (error) => {
          trace.record({
            kind: "http.original-write-callback",
            bytes: fixedBody.byteLength,
            error: error?.name,
          });
          if (error) fail(error);
          else handoff = true;
        });
      } catch (error) {
        fail(error);
      }
    });
  } catch (error) {
    primary = error;
  } finally {
    // Real owned dispose, never a fabricated close/response/write callback.
    try {
      if (res && !res.destroyed) res.destroy();
    } catch (error) {
      trace.errors.push(error);
    }
    try {
      if (req && !req.destroyed) req.destroy();
    } catch (error) {
      trace.errors.push(error);
    }
    try {
      agent?.destroy();
    } catch (error) {
      trace.errors.push(error);
    }
    if (req)
      try {
        await requestClosed;
      } catch (error) {
        trace.errors.push(error);
      }
    trace.record({
      kind: "http.finally",
      handoff,
      responseComplete: res?.complete,
      requestDestroyed: req?.destroyed,
      responseDestroyed: res?.destroyed,
    });
    for (const { target, event, fn } of listeners) {
      // Keep owned error/close observers through the actual late close/error event.
      if (event === "error" || event === "close") continue;
      try {
        target.removeListener(event, fn);
      } catch (error) {
        trace.errors.push(error);
      }
    }
  }
  refuse(primary, trace.errors, "HTTP primary/observer/dispose failure");
  return result;
}
export function realWebSocket(WebSocket, endpoint, headers, persist) {
  const trace = observer(persist),
    listeners = [];
  let ws,
    closeResolve,
    closeReject,
    disposed = false;
  const closed = new Promise((resolve, reject) => {
    closeResolve = resolve;
    closeReject = reject;
  });
  void closed.catch(() => {});
  const listen = (event, fn, once = false) => {
    listeners.push({ event, fn });
    if (once) ws.once(event, fn);
    else ws.on(event, fn);
  };
  const removeAll = () => {
    for (const { event, fn } of listeners)
      try {
        ws.removeListener(event, fn);
      } catch (error) {
        trace.errors.push(error);
      }
  };
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      try {
        ws?.close();
      } catch (error) {
        trace.errors.push(error);
      }
    }
    return closed;
  };
  try {
    const url = new URL("/terminal", endpoint);
    url.protocol = "ws:";
    ws = new WebSocket(url, { headers, perMessageDeflate: false, maxPayload: 69648 });
    listen("error", (error) => trace.record({ kind: "ws.actual-error", name: error.name }));
    listen(
      "close",
      (code, reason) => {
        try {
          trace.record({ kind: "ws.actual-close", code, reason: reason.toString("base64") });
        } catch (error) {
          trace.errors.push(error);
        }
        removeAll();
        if (trace.errors.length)
          closeReject(new AggregateError([...trace.errors], "WS observer/close failure"));
        else closeResolve({ code, reason });
      },
      true,
    );
    listen("message", (bytes, binary) => {
      try {
        trace.record({
          kind: "ws.original-message",
          binary,
          bytes: bytes.byteLength,
          sha256: hash(bytes),
          raw: bytes.toString("base64"),
        });
      } catch (error) {
        trace.errors.push(error);
        void dispose();
      }
    });
    listen("unexpected-response", (_request, response) => {
      // Consume this actual HTTP refusal without synthesizing a WS result.
      const chunks = [];
      let size = 0;
      const failResponse = (error) => {
        trace.errors.push(error);
        try {
          response.destroy();
        } catch (cleanup) {
          trace.errors.push(cleanup);
        }
        void dispose();
      };
      response.on("error", (error) => {
        trace.record({ kind: "ws.upgrade-response-error", name: error.name });
        void dispose();
      });
      response.on("data", (bytes) => {
        try {
          size += bytes.byteLength;
          if (size > 262144) {
            failResponse(new Error("Original response cap exceeded"));
            return;
          }
          chunks.push(bytes);
        } catch (error) {
          failResponse(error);
        }
      });
      response.once("end", () => {
        try {
          const body = Buffer.concat(chunks);
          trace.record({
            kind: "ws.actual-http-upgrade-refusal",
            status: response.statusCode,
            headers: response.rawHeaders,
            bytes: body.length,
            sha256: hash(body),
            raw: body.toString("base64"),
          });
          void dispose();
        } catch (error) {
          failResponse(error);
        }
      });
    });
    return { ws, closed, dispose, observerErrors: trace.errors };
  } catch (primary) {
    // Partial registration retains an error listener until the actual owned close.
    try {
      ws?.on("error", () => {});
    } catch (error) {
      trace.errors.push(error);
    }
    try {
      ws?.close();
    } catch (error) {
      trace.errors.push(error);
    }
    removeAll();
    refuse(primary, trace.errors, "WS setup/observer/dispose failure");
  }
}
export function sendOneFragmentedMessage(ws, first, second, persist) {
  const trace = observer(persist),
    tickets = [],
    callbackErrors = [],
    closeErrors = [];
  return new Promise((resolve, reject) => {
    let primary,
      hasPrimary = false,
      issued = false,
      closeRequested = false,
      closing = false,
      closeSeen = false,
      detached = false,
      detaching = false,
      finished = false;
    const failing = () =>
      hasPrimary || callbackErrors.length || trace.errors.length || closeErrors.length;
    const requestClose = () => {
      if (closeRequested) return;
      closeRequested = true;
      closing = true;
      try {
        ws.close();
      } catch (error) {
        closeErrors.push(error);
      } finally {
        closing = false;
      }
    };
    const finish = () => {
      if (!issued || closing || detaching || finished) return;
      if (failing()) requestClose();
      if (tickets.some((ticket) => !ticket.callback) || (failing() && !closeSeen)) return;
      if (!detached) {
        detached = true;
        detaching = true;
        try {
          ws.removeListener("close", onClose);
        } catch (error) {
          closeErrors.push(error);
        } finally {
          detaching = false;
        }
        if (failing()) requestClose();
        if (failing() && !closeSeen) return;
      }
      finished = true;
      if (hasPrimary && !callbackErrors.length && !trace.errors.length && !closeErrors.length) {
        reject(primary);
        return;
      }
      if (
        !hasPrimary &&
        callbackErrors.length === 1 &&
        !trace.errors.length &&
        !closeErrors.length
      ) {
        reject(callbackErrors[0]);
        return;
      }
      const errors = [
        ...(hasPrimary ? [primary] : []),
        ...callbackErrors,
        ...trace.errors,
        ...closeErrors,
      ];
      if (errors.length) {
        const failure = new AggregateError(
          errors,
          "Fragment primary/callback/observer/close failure",
        );
        Object.assign(failure, {
          primary,
          hasPrimary,
          callbackErrors: [...callbackErrors],
          persistenceErrors: [...trace.errors],
          closeErrors: [...closeErrors],
        });
        reject(failure);
      } else resolve();
    };
    const onClose = (code, reason) => {
      closeSeen = true;
      trace.record({ kind: "fragment.original-close", code, reason });
      finish();
    };
    const send = (bytes, fin, label) => {
      const ticket = { returned: false, callback: false, error: undefined };
      const done = (error) => {
        ticket.callback = true;
        ticket.error = error;
        trace.record({ kind: label, error: error?.name, sendReturned: ticket.returned });
        if (ticket.returned && error) callbackErrors.push(error);
        finish();
      };
      ws.send(bytes, { binary: true, fin }, done);
      // A synchronous callback is retained, but an obligation exists only after real return.
      ticket.returned = true;
      tickets.push(ticket);
      if (ticket.callback && ticket.error) callbackErrors.push(ticket.error);
    };
    ws.once("close", onClose);
    try {
      send(first, false, "fragment1.original-send-callback");
      send(second, true, "fragment2.original-send-callback");
    } catch (error) {
      primary = error;
      hasPrimary = true;
    }
    issued = true;
    finish();
  });
}
