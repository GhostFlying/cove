// Support only. Original receiver/arguments/value/Promise/throw are forwarded once.
export function observeMethods(entries, persist) {
  const undo = [],
    failures = [],
    listeners = [],
    ids = new WeakMap();
  let next = 0,
    ordinal = 0,
    restored = false;
  const id = (value) =>
    value && (typeof value === "object" || typeof value === "function")
      ? ids.has(value)
        ? ids.get(value)
        : (ids.set(value, `external-object-${++next}`), ids.get(value))
      : null;
  const safely = (fn) => {
    try {
      return fn();
    } catch (error) {
      failures.push(error);
      return { observerFailure: true };
    }
  };
  const record = (kind, value) => safely(() => persist({ ordinal: ++ordinal, kind, ...value }));
  const scope = {
    listen(target, event, listener, once = false) {
      const forwardedListener = function (...args) {
        safely(() => Reflect.apply(listener, this, args));
      };
      const owned = { target, event, listener: forwardedListener };
      listeners.push(owned);
      try {
        if (once) target.once(event, forwardedListener);
        else target.on(event, forwardedListener);
      } catch (error) {
        failures.push(error);
      }
    },
  };
  const restoreAll = () => {
    if (restored) return;
    restored = true;
    for (const { target, event, listener } of listeners.reverse()) {
      try {
        target.removeListener(event, listener);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const restore of undo.reverse()) {
      try {
        restore();
      } catch (error) {
        failures.push(error);
      }
    }
  };
  try {
    for (const { object, method, before, after } of entries) {
      const descriptor = Object.getOwnPropertyDescriptor(object, method);
      const original = object[method];
      if (typeof original !== "function") throw new Error(`Unavailable public method ${method}`);
      function forwarded(...args) {
        record(`${method}.call`, {
          receiver: id(this),
          args: safely(() => before?.(this, args, scope) ?? []),
        });
        let result;
        try {
          result = Reflect.apply(original, this, args);
        } catch (error) {
          record(`${method}.throw`, { receiver: id(this), errorId: id(error), name: error?.name });
          throw error;
        }
        record(`${method}.return`, {
          receiver: id(this),
          resultId: id(result),
          actual: safely(() => after?.(this, result)),
        });
        if (result instanceof Promise) {
          safely(() =>
            Promise.prototype.then.call(
              result,
              (value) =>
                record(`${method}.settled`, {
                  receiver: id(this),
                  resultId: id(result),
                  actual: safely(() => after?.(this, value)),
                }),
              (error) =>
                record(`${method}.rejected`, {
                  receiver: id(this),
                  resultId: id(result),
                  errorId: id(error),
                  name: error?.name,
                }),
            ),
          );
        }
        return result;
      }
      // Register rollback before the assignment, including partially successful accessors.
      undo.push(() => {
        const current = object[method];
        if (current !== forwarded && current !== original)
          throw new Error(`Observer ownership changed: ${method}`);
        if (descriptor) Object.defineProperty(object, method, descriptor);
        else delete object[method];
      });
      object[method] = forwarded;
      if (object[method] !== forwarded) throw new Error(`Observer installation failed: ${method}`);
    }
  } catch (primary) {
    restoreAll();
    if (failures.length)
      throw new AggregateError([primary, ...failures], "Observer setup/rollback failed");
    throw primary;
  }
  return {
    record,
    failures,
    restore() {
      restoreAll();
      if (failures.length)
        throw new AggregateError([...failures], "Observer persistence/cleanup failed");
    },
  };
}
