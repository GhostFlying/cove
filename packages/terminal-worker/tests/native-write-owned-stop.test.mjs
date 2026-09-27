import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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
  try {
    session.terminal.disposeBoundedWrite();
    await within(session.terminal.boundedWriteCompletion, 2_000, "writer did not close");
  } catch (error) {
    failures.push(error);
  }
  try {
    await until(
      () => !inspectOwned(session.terminal.pid, session.mode, session.nonce),
      2_000,
      "owned leader did not disappear",
    );
  } catch (error) {
    failures.push(error);
  }
  if (helperPid !== undefined) {
    try {
      await until(
        () => !inspectOwned(helperPid, "helper", session.nonce),
        2_000,
        "owned helper did not disappear",
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Owned-stop fixture cleanup failed");
}

function preserveCleanupFailure(primary, cleanupFailure) {
  return primary
    ? new AggregateError([primary, cleanupFailure], "Owned-stop assertion and cleanup failed")
    : cleanupFailure;
}

test("real owned leader accepts HUP and reports recorded reap", async () => {
  const session = start("graceful");
  let failure;
  try {
    await until(
      () => session.text().includes(`READY ${session.nonce}`),
      2_000,
      "owned leader did not become ready",
    );
    assert.deepEqual(session.terminal.signalOwned("SIGHUP", "leader"), { kind: "signaled" });
    await within(session.exited, 2_000, "owned leader exit callback missing");
    assert.deepEqual(session.terminal.signalOwned("SIGKILL", "leader"), {
      kind: "already-reaped",
    });
    assert.deepEqual(await session.terminal.boundedWriteCompletion, { kind: "closed" });
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
  const session = start("ignore-hup");
  let failure;
  try {
    await until(
      () => session.text().includes(`READY ${session.nonce}`),
      2_000,
      "owned leader did not become ready",
    );
    assert.deepEqual(session.terminal.signalOwned("SIGHUP", "leader"), { kind: "signaled" });
    assert.equal(inspectOwned(session.terminal.pid, session.mode, session.nonce), true);
    assert.deepEqual(session.terminal.signalOwned("SIGKILL", "leader"), { kind: "signaled" });
    await within(session.exited, 2_000, "owned leader exit callback missing");
    assert.deepEqual(await session.terminal.boundedWriteCompletion, { kind: "closed" });
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
  const session = start("leader-with-helper");
  let helperPid;
  let failure;
  try {
    await until(
      () => session.text().includes(`READY ${session.nonce}`),
      2_000,
      "leader and helper did not become ready",
    );
    helperPid = Number(session.text().match(new RegExp(`READY ${session.nonce} (\\d+)`))?.[1]);
    assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
    assert.equal(inspectOwned(helperPid, "helper", session.nonce), true);
    assert.throws(() => session.terminal.signalOwned("SIGKILL", "host"), TypeError);
    assert.deepEqual(session.terminal.signalOwned("SIGHUP", "initial-process-group"), {
      kind: "signaled",
    });
    await within(session.exited, 2_000, "group-signaled leader exit callback missing");
    assert.deepEqual(session.terminal.signalOwned("SIGKILL", "initial-process-group"), {
      kind: "already-reaped",
    });
    assert.deepEqual(await session.terminal.boundedWriteCompletion, { kind: "closed" });
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
}, 10_000);

test("native reap forbids a new signal while JavaScript exit delivery is held", async () => {
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
    await until(
      () => processAbsent(terminal.pid) && nativeExit !== undefined,
      2_000,
      "owned watcher did not reap before held JavaScript delivery",
    );
    assert.deepEqual(terminal.signalOwned("SIGKILL", "leader"), { kind: "already-reaped" });
    assert.deepEqual(terminal.signalOwned("SIGKILL", "initial-process-group"), {
      kind: "already-reaped",
    });
    releaseExit(...nativeExit);
    nativeExit = undefined;
    await within(exited, 2_000, "held exit delivery did not complete");
    assert.deepEqual(await terminal.boundedWriteCompletion, { kind: "closed" });
  } catch (error) {
    failure = error;
  } finally {
    pty.native.fork = originalFork;
    if (terminal) {
      try {
        if (nativeExit) releaseExit(...nativeExit);
        terminal.signalOwned("SIGKILL", "leader");
        terminal.disposeBoundedWrite();
        await within(terminal.boundedWriteCompletion, 2_000, "held writer did not close");
      } catch (error) {
        failure = preserveCleanupFailure(failure, error);
      }
    }
  }
  if (failure) throw failure;
}, 10_000);

test("missing per-instance signal method is a post-entry ownership failure", async () => {
  const originalFork = pty.native.fork;
  const nonce = randomUUID();
  let nativeResult;
  let failure;
  try {
    try {
      pty.native.fork = (...args) => {
        nativeResult = originalFork(...args);
        nativeResult.signalOwned = undefined;
        return nativeResult;
      };
      assert.throws(
        () => pty.spawn(process.execPath, [fixture, "graceful", nonce], options),
        (error) => {
          assert.ok(error instanceof pty.BoundedPtySpawnError);
          assert.match(String(error.cause), /native ownership result/);
          failure = error;
          return true;
        },
      );
    } finally {
      pty.native.fork = originalFork;
    }
    assert.ok(nativeResult);
    assert.deepEqual(await within(failure.cleanup, 4_000, "post-entry cleanup did not settle"), {
      kind: "cleanup-uncertain",
      reason: "native-result",
    });
  } catch (error) {
    failure = error;
  } finally {
    pty.native.fork = originalFork;
    try {
      if (nativeResult) nativeResult.stopOwnedChild(9);
      await until(
        () => !nativeResult || processAbsent(nativeResult.pid),
        2_000,
        "post-entry owned child did not disappear",
      );
    } catch (error) {
      failure = preserveCleanupFailure(failure, error);
    }
  }
  if (failure && !(failure instanceof pty.BoundedPtySpawnError)) throw failure;
}, 10_000);
