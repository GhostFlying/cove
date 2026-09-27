import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fstatSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const { UnixTerminal } = require("node-pty/lib/unixTerminal.js");
const fixture = resolve(import.meta.dirname, "fixtures/native-write-child.mjs");
const typeFixture = resolve(import.meta.dirname, "fixtures/native-write-spawn-consumer.ts");
const options = {
  cols: 80,
  rows: 24,
  encoding: null,
  boundedWrite: { maxAllocatedBytes: 8, maxTasks: 1 },
};
const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
const descriptorCount = () => readdirSync(descriptorDirectory).length;

function ownedChildren(nonce, ownedFixture = fixture) {
  const inspected = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(inspected.status, 0, String(inspected.error ?? inspected.stderr));
  return inspected.stdout
    .split("\n")
    .filter((line) => line.includes(ownedFixture) && line.includes(nonce))
    .map((line) => Number.parseInt(line.trim(), 10));
}

function closed(fd) {
  try {
    fstatSync(fd);
    return false;
  } catch (error) {
    if (error.code === "EBADF") return true;
    throw error;
  }
}

function assertSpawnError(error, causePattern) {
  assert.ok(error instanceof pty.BoundedPtySpawnError);
  assert.equal(error.code, "COVE_BOUNDED_PTY_SPAWN_FAILED");
  assert.match(String(error.cause), causePattern);
  assert.ok(error.cleanup instanceof Promise);
  return error;
}

function spawnFault(phase, nonce, onNativeExit = () => {}) {
  const originalFork = pty.native.fork;
  try {
    pty.native.fork = (...args) => {
      const forwarded = args.slice(0, -1);
      const originalExit = forwarded[10];
      forwarded[10] = (...exitArgs) => {
        try {
          onNativeExit(...exitArgs);
        } finally {
          originalExit(...exitArgs);
        }
      };
      return originalFork(...forwarded, phase, args.at(-1));
    };
    try {
      pty.spawn(process.execPath, [fixture, nonce], options);
    } catch (error) {
      return assertSpawnError(error, /Could not duplicate|Injected failure/);
    }
    assert.fail(`Native fault ${phase} unexpectedly returned a PTY`);
  } finally {
    pty.native.fork = originalFork;
  }
}

function stopVerifiedOwnedChild(pid, nonce) {
  const inspected = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (inspected.status !== 0) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    throw new Error(`Owned spawn helper ${pid} identity is unverifiable`);
  }
  if (!inspected.stdout.includes(fixture) || !inspected.stdout.includes(nonce)) {
    throw new Error(`Owned spawn helper ${pid} identity changed`);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function observeWithin(observation, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      observation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function finiteLedger(capacity) {
  const held = new Set();
  return {
    get used() {
      return held.size;
    },
    reserve() {
      if (held.size >= capacity) return undefined;
      const ticket = { released: false };
      held.add(ticket);
      return ticket;
    },
    observe(ticket, error) {
      error.cleanup.then((result) => {
        if (result.kind === "confirmed-clean" && !ticket.released) {
          ticket.released = true;
          held.delete(ticket);
        }
      });
    },
  };
}

async function assertNoOwnedChild(nonce, childFixture = fixture) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (ownedChildren(nonce, childFixture).length === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.deepEqual(ownedChildren(nonce, childFixture), []);
}

async function cleanupAdoptionOwner(nonce, ownedStop, recordFailure) {
  if (ownedStop) {
    try {
      ownedStop(9);
    } catch (error) {
      recordFailure(error);
    }
  }
  let pids = [];
  try {
    pids = ownedChildren(nonce);
  } catch (error) {
    recordFailure(error);
  }
  for (const pid of pids) {
    try {
      stopVerifiedOwnedChild(pid, nonce);
    } catch (error) {
      recordFailure(error);
    }
  }
  try {
    await assertNoOwnedChild(nonce);
  } catch (error) {
    recordFailure(error);
  }
}

test("public preflight and pre-entry failures are side-effect-free", async () => {
  const baseline = descriptorCount();
  assert.deepEqual(pty.checkBoundedPtySupport(), { supported: true, contractVersion: 3 });
  for (let index = 0; index < 3; index++) {
    let failure;
    try {
      pty.spawn(process.execPath, "unsupported argv", options);
    } catch (error) {
      failure = assertSpawnError(error, /args as a string is not supported/);
    }
    assert.deepEqual(await failure.cleanup, { kind: "confirmed-clean" });
  }
  let invalidElement;
  try {
    pty.spawn(process.execPath, [42], options);
  } catch (error) {
    invalidElement = assertSpawnError(error, /Invalid bounded PTY spawn arguments/);
  }
  assert.deepEqual(await invalidElement.cleanup, { kind: "confirmed-clean" });
  const originalFork = pty.native.fork;
  let nativeForkCalls = 0;
  pty.native.fork = (...args) => {
    nativeForkCalls++;
    return originalFork(...args);
  };
  try {
    const marker = pty.native.coveBoundedWriterVersion;
    try {
      pty.native.coveBoundedWriterVersion = 2;
      assert.deepEqual(pty.checkBoundedPtySupport(), {
        supported: false,
        reason: "binding-mismatch",
      });
      let failure;
      try {
        pty.spawn(process.execPath, [], options);
      } catch (error) {
        failure = assertSpawnError(error, /Bounded PTY support unavailable/);
      }
      assert.deepEqual(await failure.cleanup, { kind: "confirmed-clean" });
      assert.equal(nativeForkCalls, 0);
    } finally {
      pty.native.coveBoundedWriterVersion = marker;
    }
    const originalSignalOwned = UnixTerminal.prototype.signalOwned;
    try {
      UnixTerminal.prototype.signalOwned = undefined;
      assert.deepEqual(pty.checkBoundedPtySupport(), {
        supported: false,
        reason: "binding-mismatch",
      });
      let failure;
      try {
        pty.spawn(process.execPath, [], options);
      } catch (error) {
        failure = assertSpawnError(error, /Bounded PTY support unavailable/);
      }
      assert.deepEqual(await failure.cleanup, { kind: "confirmed-clean" });
      assert.equal(nativeForkCalls, 0);
    } finally {
      UnixTerminal.prototype.signalOwned = originalSignalOwned;
    }
  } finally {
    pty.native.fork = originalFork;
  }
  assert.equal(descriptorCount(), baseline);
});

test("public bounded spawn declarations compile for an isolated consumer", () => {
  const compiler = resolve(dirname(require.resolve("typescript")), "../bin/tsc");
  const result = spawnSync(
    process.execPath,
    [
      compiler,
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "es2022",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      typeFixture,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0, String(result.error ?? result.stderr ?? result.stdout));
});

test("native no-handle rollback confirms closure after duplicate and watcher faults", async () => {
  const warm = pty.spawn(
    process.platform === "darwin" ? "/usr/bin/true" : "/bin/true",
    [],
    options,
  );
  await new Promise((resolveExit) => warm.onExit(resolveExit));
  warm.destroy();
  assert.deepEqual(await warm.boundedWriteCompletion, { kind: "closed" });
  const originalFork = pty.native.fork;
  for (const phase of ["duplicate", "before-watcher", "after-watcher"]) {
    const nonce = randomUUID();
    const baseline = descriptorCount();
    let failure;
    try {
      pty.native.fork = (...args) => originalFork(...args.slice(0, -1), phase, args.at(-1));
      try {
        pty.spawn(process.execPath, [fixture, nonce], options);
      } catch (error) {
        failure = assertSpawnError(error, /Could not duplicate|Injected failure/);
      }
    } finally {
      pty.native.fork = originalFork;
    }
    assert.deepEqual(await failure.cleanup, { kind: "confirmed-clean" }, phase);
    assert.equal(descriptorCount(), baseline, phase);
    assert.deepEqual(ownedChildren(nonce), [], phase);
  }
});

test("native ambiguous close and stop reports retain an uncertain receipt", async () => {
  const originalFork = pty.native.fork;
  for (const phase of ["rollback-close-report", "rollback-stop-report"]) {
    const nonce = randomUUID();
    const baseline = descriptorCount();
    let failure;
    try {
      pty.native.fork = (...args) => originalFork(...args.slice(0, -1), phase, args.at(-1));
      try {
        pty.spawn(process.execPath, [fixture, nonce], options);
      } catch (error) {
        failure = assertSpawnError(error, /Injected failure/);
      }
    } finally {
      pty.native.fork = originalFork;
    }
    assert.deepEqual(await failure.cleanup, {
      kind: "cleanup-uncertain",
      reason: "native-rollback",
    });
    assert.equal(descriptorCount(), baseline, phase);
    assert.deepEqual(ownedChildren(nonce), [], phase);
  }
});

test("public adoption rollback waits for reader, writer and sole reaper", async () => {
  const originalFork = pty.native.fork;
  const originalForward = UnixTerminal.prototype._forwardEvents;
  const nonce = randomUUID();
  let result;
  let ownedStop;
  let failure;
  let firstFailure;
  try {
    try {
      pty.native.fork = (...args) => {
        result = originalFork(...args);
        ownedStop = result.stopOwnedChild;
        return result;
      };
      UnixTerminal.prototype._forwardEvents = () => {
        throw new Error("injected adoption failure");
      };
      try {
        pty.spawn(process.execPath, [fixture, nonce], options);
      } catch (error) {
        failure = assertSpawnError(error, /injected adoption failure/);
      }
    } finally {
      pty.native.fork = originalFork;
      UnixTerminal.prototype._forwardEvents = originalForward;
    }
    assert.ok(result);
    assert.deepEqual(
      await observeWithin(failure.cleanup, 4_000, "adoption cleanup did not settle"),
      { kind: "confirmed-clean" },
    );
    expect(closed(result.fd)).toBe(true);
    expect(closed(result.writeFd)).toBe(true);
    expect(result.stopOwnedChild(9)).toBe(false);
  } catch (error) {
    firstFailure = error;
  } finally {
    await cleanupAdoptionOwner(nonce, ownedStop, (error) => {
      firstFailure ??= error;
    });
  }
  if (firstFailure) throw firstFailure;
}, 10_000);

test("an unreported native entry times out uncertain rather than claiming clean", async () => {
  const originalFork = pty.native.fork;
  let failure;
  const start = Date.now();
  try {
    pty.native.fork = () => {
      throw new Error("synthetic unreported native failure");
    };
    try {
      pty.spawn(process.execPath, [], options);
    } catch (error) {
      failure = assertSpawnError(error, /synthetic unreported native failure/);
    }
  } finally {
    pty.native.fork = originalFork;
  }
  const result = await failure.cleanup;
  assert.deepEqual(result, { kind: "cleanup-uncertain", reason: "timeout" });
  assert.ok(Date.now() - start >= 2_900);
  assert.deepEqual(await failure.cleanup, result);
}, 7_000);

test("adoption stop failure is uncertain and never silently frees the owner", async () => {
  const originalFork = pty.native.fork;
  const originalForward = UnixTerminal.prototype._forwardEvents;
  const nonce = randomUUID();
  let ownedStop;
  let failure;
  let firstFailure;
  try {
    try {
      pty.native.fork = (...args) => {
        const result = originalFork(...args);
        ownedStop = result.stopOwnedChild;
        result.stopOwnedChild = () => {
          throw new Error("synthetic owned stop failure");
        };
        return result;
      };
      UnixTerminal.prototype._forwardEvents = () => {
        throw new Error("synthetic setup failure");
      };
      try {
        pty.spawn(process.execPath, [fixture, nonce], options);
      } catch (error) {
        failure = assertSpawnError(error, /synthetic setup failure/);
      }
    } finally {
      pty.native.fork = originalFork;
      UnixTerminal.prototype._forwardEvents = originalForward;
    }
    assert.deepEqual(
      await observeWithin(failure.cleanup, 4_000, "adoption stop cleanup did not settle"),
      { kind: "cleanup-uncertain", reason: "child-stop" },
    );
  } catch (error) {
    firstFailure = error;
  } finally {
    await cleanupAdoptionOwner(nonce, ownedStop, (error) => {
      firstFailure ??= error;
    });
  }
  if (firstFailure) throw firstFailure;
}, 10_000);

test("finite admission releases confirmed failures exactly once after zero-cost preflight", async () => {
  const ledger = finiteLedger(2);
  assert.deepEqual(pty.checkBoundedPtySupport(), { supported: true, contractVersion: 3 });
  assert.equal(ledger.used, 0);
  let invalid;
  try {
    pty.spawn(process.execPath, "unsupported argv", options);
  } catch (error) {
    invalid = assertSpawnError(error, /args as a string is not supported/);
  }
  assert.deepEqual(await invalid.cleanup, { kind: "confirmed-clean" });
  assert.equal(ledger.used, 0);

  for (const phase of ["duplicate", "before-watcher", "after-watcher"]) {
    const ticket = ledger.reserve();
    assert.ok(ticket);
    const nonce = randomUUID();
    const failure = spawnFault(phase, nonce);
    ledger.observe(ticket, failure);
    assert.deepEqual(await failure.cleanup, { kind: "confirmed-clean" }, phase);
    assert.equal(ledger.used, 0, phase);
    assert.deepEqual(await failure.cleanup, { kind: "confirmed-clean" }, phase);
    assert.equal(ledger.used, 0, phase);
    await assertNoOwnedChild(nonce);
  }
});

test("pending rollback holds capacity and a late reap cannot release uncertainty", async () => {
  const ledger = finiteLedger(1);
  const ticket = ledger.reserve();
  assert.ok(ticket);
  const nonce = randomUUID();
  const start = Date.now();
  let nativeExitCallbacks = 0;
  let resolveNativeExit;
  const nativeExit = new Promise((resolveExit) => {
    resolveNativeExit = resolveExit;
  });
  let failure;
  let firstFailure;
  try {
    failure = spawnFault("before-watcher-held", nonce, () => {
      nativeExitCallbacks++;
      resolveNativeExit();
    });
    ledger.observe(ticket, failure);
    assert.ok(Date.now() - start < 500, "spawn must return before the cleanup deadline");
    const pending = await Promise.race([
      failure.cleanup.then(() => false),
      new Promise((resolveWait) => setTimeout(() => resolveWait(true), 50)),
    ]);
    assert.equal(pending, true);
    assert.equal(ledger.used, 1);
    assert.equal(ledger.reserve(), undefined);
    const result = await failure.cleanup;
    assert.deepEqual(result, { kind: "cleanup-uncertain", reason: "timeout" });
    assert.ok(Date.now() - start >= 2_900);
    assert.equal(nativeExitCallbacks, 0, "the watcher must reap after the receipt deadline");
    await observeWithin(nativeExit, 2_000, "late owned watcher callback did not arrive");
    assert.equal(nativeExitCallbacks, 1);
    await assertNoOwnedChild(nonce);
    assert.deepEqual(await failure.cleanup, result);
    assert.equal(ledger.used, 1);
    assert.equal(ledger.reserve(), undefined);
  } catch (error) {
    firstFailure = error;
  } finally {
    let pids = [];
    try {
      pids = ownedChildren(nonce);
    } catch (error) {
      firstFailure ??= error;
    }
    for (const pid of pids) {
      try {
        stopVerifiedOwnedChild(pid, nonce);
      } catch (error) {
        firstFailure ??= error;
      }
    }
    try {
      await observeWithin(
        nativeExit,
        Math.max(1, start + 5_500 - Date.now()),
        "owned watcher did not confirm reap after cleanup",
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      assert.equal(nativeExitCallbacks, 1);
    } catch (error) {
      firstFailure ??= error;
    }
    try {
      await assertNoOwnedChild(nonce);
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure) throw firstFailure;
}, 8_000);

test("reader and writer close ambiguity each retain finite capacity", async () => {
  const ledger = finiteLedger(2);
  for (const phase of ["rollback-reader-close-report", "rollback-writer-close-report"]) {
    const ticket = ledger.reserve();
    assert.ok(ticket);
    const nonce = randomUUID();
    const baseline = descriptorCount();
    const failure = spawnFault(phase, nonce);
    ledger.observe(ticket, failure);
    assert.deepEqual(await failure.cleanup, {
      kind: "cleanup-uncertain",
      reason: "native-rollback",
    });
    assert.equal(descriptorCount(), baseline);
    await assertNoOwnedChild(nonce);
  }
  assert.equal(ledger.used, 2);
  assert.equal(ledger.reserve(), undefined);
});

test("earlier parent cleanup ambiguity survives duplicate and watcher rollback", async () => {
  for (const phase of ["auxiliary-close-then-duplicate", "auxiliary-close-after-watcher"]) {
    const nonce = randomUUID();
    const baseline = descriptorCount();
    const failure = spawnFault(phase, nonce);
    assert.deepEqual(await failure.cleanup, {
      kind: "cleanup-uncertain",
      reason: "native-rollback",
    });
    assert.equal(descriptorCount(), baseline);
    await assertNoOwnedChild(nonce);
  }
});
