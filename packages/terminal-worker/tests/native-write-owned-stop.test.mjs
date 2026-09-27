import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { resolve } from "node:path";
import { test } from "vitest";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const fixture = resolve(import.meta.dirname, "fixtures/native-owned-stop-child.mjs");
const options = {
  cols: 80,
  rows: 24,
  encoding: null,
  boundedWrite: { maxAllocatedBytes: 8, maxTasks: 1 },
};

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(predicate, milliseconds, message) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(message);
}

function remaining(deadline, message) {
  const milliseconds = deadline - Date.now();
  if (milliseconds <= 0) throw new Error(message);
  return milliseconds;
}

function bodyWait(promise, deadline, message, limit = 2_000) {
  return within(promise, Math.min(limit, remaining(deadline, message)), message);
}

function bodyUntil(predicate, deadline, message, limit = 2_000) {
  return until(predicate, Math.min(limit, remaining(deadline, message)), message);
}

function delay(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function inspectOwned(pid, mode, nonce) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (result.status !== 0) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
    throw new Error(`Owned fixture ${pid} identity is unverifiable`);
  }
  if (!result.stdout.includes(fixture) || !result.stdout.includes(` ${mode} ${nonce}`)) {
    throw new Error(`Owned fixture ${pid} identity changed`);
  }
  return true;
}

function ownedGroup(pid, mode, nonce) {
  assert.equal(inspectOwned(pid, mode, nonce), true);
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(result.status, 0, `Owned fixture ${pid} group is unverifiable`);
  const group = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(group) && group > 0);
  assert.equal(inspectOwned(pid, mode, nonce), true);
  return group;
}

function stopVerified(pid, mode, nonce) {
  if (!inspectOwned(pid, mode, nonce)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function processAbsent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}

function start(mode) {
  const nonce = randomUUID();
  const terminal = pty.spawn(process.execPath, [fixture, mode, nonce], options);
  let text = "";
  terminal.onData((data) => {
    text += Buffer.from(data).toString("utf8");
  });
  const exited = new Promise((resolveExit) => terminal.onExit(resolveExit));
  return { terminal, nonce, exited, text: () => text, mode };
}

async function cleanup(session, helperPid) {
  if (!session) return;
  const deadline = Date.now() + 5_000;
  const failures = [];
  try {
    session.terminal.signalOwned("SIGKILL", "leader");
  } catch (error) {
    failures.push(error);
  }
  try {
    stopVerified(session.terminal.pid, session.mode, session.nonce);
  } catch (error) {
    failures.push(error);
  }
  if (helperPid !== undefined) {
    try {
      stopVerified(helperPid, "helper", session.nonce);
    } catch (error) {
      failures.push(error);
    }
  }
  const observations = [];
  try {
    session.terminal.disposeBoundedWrite();
    observations.push(
      within(
        session.terminal.boundedWriteCompletion,
        remaining(deadline, "writer cleanup expired"),
        "writer did not close",
      ),
    );
  } catch (error) {
    failures.push(error);
  }
  observations.push(
    (async () =>
      until(
        () => !inspectOwned(session.terminal.pid, session.mode, session.nonce),
        remaining(deadline, "leader cleanup expired"),
        "owned leader did not disappear",
      ))(),
  );
  if (helperPid !== undefined) {
    observations.push(
      (async () =>
        until(
          () => !inspectOwned(helperPid, "helper", session.nonce),
          remaining(deadline, "helper cleanup expired"),
          "owned helper did not disappear",
        ))(),
    );
  }
  for (const result of await Promise.allSettled(observations)) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length > 0) throw new AggregateError(failures, "Owned-stop fixture cleanup failed");
}

function preserveCleanupFailure(primary, cleanupFailure) {
  return primary
    ? new AggregateError([primary, cleanupFailure], "Owned-stop assertion and cleanup failed")
    : cleanupFailure;
}

test("real owned leader accepts HUP and reports recorded reap", async () => {
  const deadline = Date.now() + 8_000;
  let session;
  let failure;
  try {
    session = start("graceful");
    await bodyUntil(
      () => session.text().includes(`READY ${session.nonce}`),
      deadline,
      "owned leader did not become ready",
    );
    assert.deepEqual(session.terminal.signalOwned("SIGHUP", "leader"), { kind: "signaled" });
    await bodyWait(session.exited, deadline, "owned leader exit callback missing");
    assert.deepEqual(session.terminal.signalOwned("SIGKILL", "leader"), {
      kind: "already-reaped",
    });
    assert.deepEqual(
      await bodyWait(session.terminal.boundedWriteCompletion, deadline, "writer did not close"),
      { kind: "closed" },
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanup(session);
    } catch (error) {
      failure = preserveCleanupFailure(failure, error);
    }
  }
  if (failure) throw failure;
});

test("real owned leader ignores HUP until KILL", async () => {
  const deadline = Date.now() + 8_000;
  let session;
  let failure;
  try {
    session = start("ignore-hup");
    await bodyUntil(
      () => session.text().includes(`READY ${session.nonce}`),
      deadline,
      "owned leader did not become ready",
    );
    assert.deepEqual(session.terminal.signalOwned("SIGHUP", "leader"), { kind: "signaled" });
    await bodyWait(delay(250), deadline, "HUP survival window expired", 500);
    assert.equal(inspectOwned(session.terminal.pid, session.mode, session.nonce), true);
    assert.deepEqual(session.terminal.signalOwned("SIGKILL", "leader"), { kind: "signaled" });
    await bodyWait(session.exited, deadline, "owned leader exit callback missing");
    assert.deepEqual(
      await bodyWait(session.terminal.boundedWriteCompletion, deadline, "writer did not close"),
      { kind: "closed" },
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanup(session);
    } catch (error) {
      failure = preserveCleanupFailure(failure, error);
    }
  }
  if (failure) throw failure;
});

test("group attempt never retains authority after leader reap", async () => {
  const deadline = Date.now() + 8_000;
  let session;
  let helperPid;
  let failure;
  try {
    session = start("leader-with-helper");
    await bodyUntil(
      () => session.text().includes(`READY ${session.nonce}`),
      deadline,
      "leader and helper did not become ready",
    );
    helperPid = Number(session.text().match(new RegExp(`READY ${session.nonce} (\\d+)`))?.[1]);
    assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
    assert.equal(inspectOwned(helperPid, "helper", session.nonce), true);
    assert.equal(
      ownedGroup(session.terminal.pid, session.mode, session.nonce),
      session.terminal.pid,
    );
    assert.equal(ownedGroup(helperPid, "helper", session.nonce), session.terminal.pid);
    assert.throws(() => session.terminal.signalOwned("SIGKILL", "host"), TypeError);
    assert.deepEqual(session.terminal.signalOwned("SIGHUP", "initial-process-group"), {
      kind: "signaled",
    });
    await bodyWait(session.exited, deadline, "group-signaled leader exit callback missing");
    assert.equal(inspectOwned(helperPid, "helper", session.nonce), true);
    assert.deepEqual(session.terminal.signalOwned("SIGKILL", "initial-process-group"), {
      kind: "already-reaped",
    });
    assert.equal(inspectOwned(helperPid, "helper", session.nonce), true);
    assert.deepEqual(
      await bodyWait(session.terminal.boundedWriteCompletion, deadline, "writer did not close"),
      { kind: "closed" },
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanup(session, helperPid);
    } catch (error) {
      failure = preserveCleanupFailure(failure, error);
    }
  }
  if (failure) throw failure;
});

test("native reap forbids a new signal while JavaScript exit delivery is held", async () => {
  const deadline = Date.now() + 8_000;
  const originalFork = pty.native.fork;
  let releaseExit;
  let nativeExit;
  let terminal;
  let failure;
  try {
    pty.native.fork = (...args) => {
      releaseExit = args[10];
      args[10] = (...exitArgs) => {
        nativeExit = exitArgs;
      };
      return originalFork(...args);
    };
    terminal = pty.spawn(
      process.platform === "darwin" ? "/usr/bin/true" : "/bin/true",
      [],
      options,
    );
    pty.native.fork = originalFork;
    const exited = new Promise((resolveExit) => terminal.onExit(resolveExit));
    await bodyUntil(
      () => processAbsent(terminal.pid) && nativeExit !== undefined,
      deadline,
      "owned watcher did not reap before held JavaScript delivery",
    );
    assert.deepEqual(terminal.signalOwned("SIGKILL", "leader"), { kind: "already-reaped" });
    assert.deepEqual(terminal.signalOwned("SIGKILL", "initial-process-group"), {
      kind: "already-reaped",
    });
    releaseExit(...nativeExit);
    nativeExit = undefined;
    await bodyWait(exited, deadline, "held exit delivery did not complete");
    assert.deepEqual(
      await bodyWait(terminal.boundedWriteCompletion, deadline, "held writer did not close"),
      { kind: "closed" },
    );
  } catch (error) {
    failure = error;
  } finally {
    pty.native.fork = originalFork;
    if (terminal) {
      const cleanupDeadline = Date.now() + 5_000;
      const cleanupFailures = [];
      try {
        if (nativeExit) releaseExit(...nativeExit);
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        terminal.signalOwned("SIGKILL", "leader");
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        terminal.disposeBoundedWrite();
      } catch (error) {
        cleanupFailures.push(error);
      }
      const observations = await Promise.allSettled([
        (async () =>
          within(
            terminal.boundedWriteCompletion,
            remaining(cleanupDeadline, "held writer cleanup expired"),
            "held writer did not close",
          ))(),
        (async () =>
          until(
            () => processAbsent(terminal.pid),
            remaining(cleanupDeadline, "held owner cleanup expired"),
            "held owner did not disappear",
          ))(),
      ]);
      for (const result of observations) {
        if (result.status === "rejected") cleanupFailures.push(result.reason);
      }
      if (cleanupFailures.length > 0) {
        failure = preserveCleanupFailure(
          failure,
          new AggregateError(cleanupFailures, "Held owner cleanup failed"),
        );
      }
    }
  }
  if (failure) throw failure;
});

async function assertFaultSelector(phase, scope, expected) {
  const deadline = Date.now() + 8_000;
  const originalFork = pty.native.fork;
  let nativeResult;
  let session;
  let failure;
  try {
    pty.native.fork = (...args) => {
      nativeResult = originalFork(...args.slice(0, -1), phase, args.at(-1));
      return nativeResult;
    };
    session = start("ignore-hup");
    pty.native.fork = originalFork;
    await bodyUntil(
      () => session.text().includes(`READY ${session.nonce}`),
      deadline,
      "fault-selector leader did not become ready",
    );
    assert.deepEqual(session.terminal.signalOwned("SIGKILL", scope), expected);
    assert.equal(inspectOwned(session.terminal.pid, session.mode, session.nonce), true);
    assert.equal(nativeResult.stopOwnedChild(9), true);
    await bodyWait(session.exited, deadline, "owned rollback stop did not deliver exit");
    assert.deepEqual(
      await bodyWait(session.terminal.boundedWriteCompletion, deadline, "writer did not close"),
      { kind: "closed" },
    );
  } catch (error) {
    failure = error;
  } finally {
    pty.native.fork = originalFork;
    try {
      if (nativeResult) nativeResult.stopOwnedChild(9);
      if (session) await cleanup(session);
    } catch (error) {
      failure = preserveCleanupFailure(failure, error);
    }
  }
  if (failure) throw failure;
}

test("native kill ESRCH classifies without signaling an unowned process", async () => {
  await assertFaultSelector("owned-kill-esrch", "leader", {
    kind: "unverifiable",
    reason: "not-found",
  });
});

test("native kill EPERM classifies without signaling an unowned process", async () => {
  await assertFaultSelector("owned-kill-eperm", "leader", {
    kind: "unverifiable",
    reason: "signal-failed",
    errorCode: String(constants.errno.EPERM),
  });
});

test("native getpgid ESRCH classifies without signaling an unowned process", async () => {
  await assertFaultSelector("owned-getpgid-esrch", "initial-process-group", {
    kind: "unverifiable",
    reason: "not-found",
  });
});

test("native getpgid EPERM classifies without signaling an unowned process", async () => {
  await assertFaultSelector("owned-getpgid-eperm", "initial-process-group", {
    kind: "unverifiable",
    reason: "scope-unavailable",
    errorCode: String(constants.errno.EPERM),
  });
});

test("native unqualified group classifies without signaling an unowned process", async () => {
  await assertFaultSelector("owned-group-unqualified", "initial-process-group", {
    kind: "unverifiable",
    reason: "scope-unavailable",
  });
});

test("missing per-instance signal method is a post-entry ownership failure", async () => {
  const deadline = Date.now() + 8_000;
  const originalFork = pty.native.fork;
  const nonce = randomUUID();
  let nativeResult;
  let unexpectedTerminal;
  let observedError;
  let failure;
  try {
    try {
      pty.native.fork = (...args) => {
        nativeResult = originalFork(...args);
        nativeResult.signalOwned = undefined;
        return nativeResult;
      };
      try {
        unexpectedTerminal = pty.spawn(process.execPath, [fixture, "graceful", nonce], options);
      } catch (error) {
        observedError = error;
      }
    } finally {
      pty.native.fork = originalFork;
    }
    assert.ok(observedError instanceof pty.BoundedPtySpawnError);
    assert.match(String(observedError.cause), /native ownership result/);
    assert.ok(nativeResult);
    assert.deepEqual(
      await bodyWait(observedError.cleanup, deadline, "post-entry cleanup did not settle", 4_000),
      { kind: "cleanup-uncertain", reason: "native-result" },
    );
  } catch (error) {
    failure = error;
  } finally {
    pty.native.fork = originalFork;
    const cleanupDeadline = Date.now() + 5_000;
    const cleanupFailures = [];
    try {
      if (nativeResult) nativeResult.stopOwnedChild(9);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      unexpectedTerminal?.disposeBoundedWrite();
    } catch (error) {
      cleanupFailures.push(error);
    }
    const observations = [
      (async () =>
        until(
          () => !nativeResult || processAbsent(nativeResult.pid),
          remaining(cleanupDeadline, "post-entry owner cleanup expired"),
          "post-entry owned child did not disappear",
        ))(),
    ];
    if (unexpectedTerminal) {
      observations.push(
        (async () =>
          within(
            unexpectedTerminal.boundedWriteCompletion,
            remaining(cleanupDeadline, "post-entry writer cleanup expired"),
            "post-entry writer did not close",
          ))(),
      );
    }
    for (const result of await Promise.allSettled(observations)) {
      if (result.status === "rejected") cleanupFailures.push(result.reason);
    }
    if (cleanupFailures.length > 0) {
      failure = preserveCleanupFailure(
        failure,
        new AggregateError(cleanupFailures, "Post-entry cleanup failed"),
      );
    }
  }
  if (failure) throw failure;
});
