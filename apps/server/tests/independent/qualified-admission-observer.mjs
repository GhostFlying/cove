import { AsyncLocalStorage } from "node:async_hooks";
export function observePublicPorts(local, persistSync) {
  const identities = new WeakMap(),
    restored = [],
    failures = [];
  const context = new AsyncLocalStorage();
  const requestIDs = new WeakMap();
  let identity = 0,
    ordinal = 0;
  const id = (object) => {
    if (!identities.has(object)) identities.set(object, ++identity);
    return identities.get(object);
  };
  const ledger = local.core.runtime.composition.bytes;
  const record = (event, data) => {
    try {
      persistSync({
        ordinal: ++ordinal,
        event,
        ...data,
        actualFrameworkRequestID: context.getStore()?.frameworkRequestID ?? null,
        observerIdentitiesArePrivateOwnerIDs: false,
        ledger: ledger.snapshot(),
        admission: local.admission.snapshot(),
      });
    } catch (error) {
      failures.push(error);
    }
  };
  function tap(object, name, category, returned) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    const original = object[name];
    if (typeof original !== "function" || Object.isFrozen(object))
      throw new Error("Actual public observer target unavailable: " + category);
    const observerTargetID = id(object);
    const wrapped = function (...args) {
      const before = ledger.snapshot();
      const beforeAdmission = local.admission.snapshot();
      record(category + "-enter", { observerTargetID, args, before, beforeAdmission });
      let result;
      try {
        result = Reflect.apply(original, this, args);
      } catch (error) {
        record(category + "-throw", { observerTargetID, error, before });
        throw error; // Original exception identity; no fallback result.
      }
      const resultID =
        result && (typeof result === "object" || typeof result === "function") ? id(result) : null;
      record(category + "-return", {
        observerTargetID,
        resultID,
        before,
        beforeAdmission,
        resultKind: result === null ? "null" : typeof result,
      });
      try {
        returned?.(result, args, resultID);
      } catch (error) {
        failures.push(error);
      }
      try {
        if (result && typeof result.then === "function")
          result.then(
            (value) => record(category + "-resolved", { observerTargetID, resultID, value }),
            (error) => record(category + "-rejected", { observerTargetID, resultID, error }),
          );
      } catch (error) {
        failures.push(error);
      }
      return result;
    };
    Object.defineProperty(object, name, { configurable: true, writable: true, value: wrapped });
    restored.push(() => {
      if (object[name] !== wrapped) throw new Error("Public observer target changed externally");
      if (descriptor) Object.defineProperty(object, name, descriptor);
      else delete object[name];
    });
  }
  const observedLeases = new WeakSet();
  const lease = (result, args, resultID) => {
    if (!result || observedLeases.has(result)) return;
    observedLeases.add(result);
    tap(result, "release", "public-lease-release-" + resultID);
    record("public-lease-acquired", {
      observerLeaseID: resultID,
      actualBytes: result.bytes,
      requestedBytes: typeof args[0] === "number" ? args[0] : undefined,
      actualBackingBytes: args[0]?.buffer?.byteLength,
      externalPublicBackingObserverID: args[0]?.buffer ? id(args[0].buffer) : null,
      controlArgument: args[1] ?? false,
    });
  };
  tap(ledger, "reserve", "public-reserve", lease);
  tap(ledger, "retainBacking", "public-retainBacking", lease);
  tap(local.admission, "claim", "public-admission-claim", (result, args, resultID) => {
    if (!result) return;
    tap(result, "release", "public-claim-release-" + resultID);
    tap(result, "retireAdmission", "public-claim-logical-retire-" + resultID);
    record("public-admission-claim-acquired", { observerClaimID: resultID, claimKind: args[0] });
  });
  for (const method of ["create", "stop", "get"])
    tap(local.core.operations, method, "operation-" + method);
  for (const method of ["reserveRun", "cancelRunReservation", "spawn", "stop"])
    tap(local.core.runtime, method, "runtime-" + method);
  tap(local.core.runtime.pool, "snapshot", "pool-snapshot");
  local.app.addHook("onRequest", (request, _reply, done) => {
    requestIDs.set(request.raw, request.id);
    record("actual-framework-request", {
      frameworkRequestID: request.id,
      actualPublicNodeRequestObserverID: id(request.raw),
      method: request.method,
      url: request.url,
      rawHeaders: request.raw.rawHeaders,
    });
    context.run({ frameworkRequestID: request.id }, () => done());
  });
  return {
    record,
    failures,
    requestIDFor(raw) {
      return raw ? (requestIDs.get(raw) ?? null) : null;
    },
    finishObservation() {
      const cleanupErrors = [];
      while (restored.length) {
        try {
          restored.pop()();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (failures.length || cleanupErrors.length)
        throw new AggregateError(
          [...failures, ...cleanupErrors],
          "Observer/persistence failures retained",
        );
    },
  };
}
