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

function ownedChildren(nonce) {
  const inspected = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(inspected.status, 0, String(inspected.error ?? inspected.stderr));
  return inspected.stdout
    .split("\n")
    .filter((line) => line.includes(fixture) && line.includes(nonce))
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

test("public preflight and pre-entry failures are side-effect-free", async () => {
  const baseline = descriptorCount();
  assert.deepEqual(pty.checkBoundedPtySupport(), { supported: true, contractVersion: 2 });
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
  const marker = pty.native.coveBoundedWriterVersion;
  try {
    pty.native.coveBoundedWriterVersion = 1;
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
  } finally {
    pty.native.coveBoundedWriterVersion = marker;
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
  let result;
  let failure;
  try {
    pty.native.fork = (...args) => {
      result = originalFork(...args);
      return result;
    };
    UnixTerminal.prototype._forwardEvents = () => {
      throw new Error("injected adoption failure");
    };
    try {
      pty.spawn(process.execPath, [fixture, randomUUID()], options);
    } catch (error) {
      failure = assertSpawnError(error, /injected adoption failure/);
    }
  } finally {
    pty.native.fork = originalFork;
    UnixTerminal.prototype._forwardEvents = originalForward;
  }
  assert.ok(result);
  assert.deepEqual(await failure.cleanup, { kind: "confirmed-clean" });
  expect(closed(result.fd)).toBe(true);
  expect(closed(result.writeFd)).toBe(true);
  expect(result.stopOwnedChild(9)).toBe(false);
});

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
  let ownedStop;
  let failure;
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
      pty.spawn(process.execPath, [fixture, randomUUID()], options);
    } catch (error) {
      failure = assertSpawnError(error, /synthetic setup failure/);
    }
  } finally {
    pty.native.fork = originalFork;
    UnixTerminal.prototype._forwardEvents = originalForward;
    if (ownedStop) ownedStop(9);
  }
  assert.deepEqual(await failure.cleanup, { kind: "cleanup-uncertain", reason: "child-stop" });
}, 7_000);
