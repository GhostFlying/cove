import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fstatSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import tty from "node:tty";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const { UnixTerminal } = require("node-pty/lib/unixTerminal.js");
const fixture = resolve(import.meta.dirname, "fixtures/native-write-child.mjs");

async function until(predicate, label) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out awaiting ${label}`);
    await new Promise((done) => setTimeout(done, 5));
  }
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

function childAbsent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}

async function verifyRollback(phase) {
  const fork = pty.native.fork;
  const read = tty.ReadStream;
  const forward = UnixTerminal.prototype._forwardEvents;
  const ownForward = Object.hasOwn(UnixTerminal.prototype, "_forwardEvents");
  let nativeResult;
  let unexpected;
  let failure;
  try {
    pty.native.fork = (...args) => {
      nativeResult = fork(...args);
      return nativeResult;
    };
    if (phase.includes("read adoption")) {
      function FaultRead(fd) {
        if (phase === "after read adoption") Reflect.apply(read, this, [fd]);
        throw new Error(`synthetic ${phase}`);
      }
      FaultRead.prototype = Object.create(read.prototype);
      tty.ReadStream = FaultRead;
    } else {
      UnixTerminal.prototype._forwardEvents = () => {
        throw new Error(`synthetic ${phase}`);
      };
    }
    try {
      unexpected = pty.spawn(process.execPath, [fixture, randomUUID()], {
        cols: 80,
        rows: 24,
        encoding: null,
        boundedWrite: { maxAllocatedBytes: 8, maxTasks: 1 },
      });
    } catch (error) {
      failure = error;
    }
  } finally {
    pty.native.fork = fork;
    tty.ReadStream = read;
    if (ownForward) UnixTerminal.prototype._forwardEvents = forward;
    else delete UnixTerminal.prototype._forwardEvents;
  }
  let verificationError;
  try {
    assert.match(String(failure), new RegExp(`synthetic ${phase}`));
    assert.ok(nativeResult);
    await until(() => closed(nativeResult.fd), "reader rollback close");
    await until(() => closed(nativeResult.writeFd), "writer rollback close");
    await until(() => childAbsent(nativeResult.pid), "rollback child reap");
    assert.equal(nativeResult.stopOwnedChild(9), false);
  } catch (error) {
    verificationError = error;
  } finally {
    if (unexpected) {
      unexpected.destroy();
      unexpected._boundedOwnedStop(9);
    }
    if (nativeResult && !childAbsent(nativeResult.pid)) {
      try {
        nativeResult.stopOwnedChild(9);
        await until(() => childAbsent(nativeResult.pid), "faulted rollback child cleanup");
      } catch (error) {
        verificationError ??= error;
      }
    }
  }
  if (verificationError) throw verificationError;
  return {
    readerClosed: closed(nativeResult.fd),
    writerClosed: closed(nativeResult.writeFd),
    childReaped: childAbsent(nativeResult.pid),
  };
}

test("bounded constructor rollback before read adoption closes both descriptors and reaps", async () => {
  expect(await verifyRollback("before read adoption")).toEqual({
    readerClosed: true,
    writerClosed: true,
    childReaped: true,
  });
});

test("bounded constructor rollback after read adoption closes both descriptors and reaps", async () => {
  expect(await verifyRollback("after read adoption")).toEqual({
    readerClosed: true,
    writerClosed: true,
    childReaped: true,
  });
});

test("bounded constructor rollback after writer adoption closes both descriptors and reaps", async () => {
  expect(await verifyRollback("after both adoptions")).toEqual({
    readerClosed: true,
    writerClosed: true,
    childReaped: true,
  });
});
