import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const fixture = resolve(import.meta.dirname, "fixtures/native-write-child.mjs");

async function until(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
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

function closeOnExec(fd) {
  if (process.platform === "linux") {
    const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
    const flags = /^flags:\s*([0-7]+)/m.exec(info);
    assert.ok(flags, info);
    return (Number.parseInt(flags[1], 8) & 0o2000000) !== 0;
  }
  const inspected = spawnSync("lsof", ["-p", String(process.pid), "-a", "-d", String(fd), "+fg"], {
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(inspected.status, 0, String(inspected.error ?? inspected.stderr));
  const descriptor = inspected.stdout
    .split("\n")
    .find((line) => new RegExp(`\\s${fd}[a-z]\\s`).test(line));
  assert.ok(descriptor, inspected.stdout);
  return /[,;]CX(?:[,\s]|$)/.test(descriptor);
}

test("real bounded write reaches the child before natural exit retires both descriptors", async () => {
  const nonce = randomUUID();
  const terminal = pty.spawn(process.execPath, [fixture, nonce, "echo"], {
    cols: 80,
    rows: 24,
    encoding: null,
    boundedWrite: { maxAllocatedBytes: 3, maxTasks: 1 },
  });
  const readerFd = terminal.fd;
  const writerFd = terminal._writeStream._fd;
  let output = Buffer.alloc(0);
  let exit;
  let settlement;
  terminal.onData((chunk) => {
    output = Buffer.concat([output, Buffer.from(chunk)]);
  });
  terminal.onExit((value) => {
    exit = value;
  });
  try {
    expect(closeOnExec(writerFd)).toBe(true);
    await until(() => output.includes(Buffer.from(`READY ${nonce}`)), "child ready");
    expect(
      terminal.writeBounded(Buffer.from("AB\r"), (value) => {
        settlement = value;
      }),
    ).toMatchObject({ accepted: true, byteLength: 3 });
    await until(() => settlement !== undefined, "write settlement");
    expect(settlement).toMatchObject({ status: "written", writtenBytes: 3 });
    await until(() => output.includes(Buffer.from("SEEN 41420a")), "child readback");
    await until(() => exit !== undefined, "natural child exit");
    assert.deepEqual(exit, { exitCode: 0, signal: 0 });
    expect(await terminal.boundedWriteCompletion).toEqual({ kind: "closed" });
    expect(closed(readerFd)).toBe(true);
    expect(closed(writerFd)).toBe(true);
    assert.throws(() => process.kill(terminal.pid, 0), { code: "ESRCH" });
  } finally {
    terminal.disposeBoundedWrite();
    terminal.destroy();
    if (!exit) {
      terminal._boundedOwnedStop(9);
      await until(() => exit !== undefined, "owned child cleanup", 3_000);
    }
  }
});

test("read-stream EIO retires the writer while the owned child remains stoppable", async () => {
  const nonce = randomUUID();
  const terminal = pty.spawn(process.execPath, [fixture, nonce], {
    cols: 80,
    rows: 24,
    encoding: null,
    boundedWrite: { maxAllocatedBytes: 8, maxTasks: 1 },
  });
  const readerFd = terminal.fd;
  const writerFd = terminal._writeStream._fd;
  let output = Buffer.alloc(0);
  let exit;
  terminal.onData((chunk) => {
    output = Buffer.concat([output, Buffer.from(chunk)]);
  });
  terminal.onExit((value) => {
    exit = value;
  });
  try {
    await until(() => output.includes(Buffer.from(`READY ${nonce}`)), "child ready");
    terminal._socket.destroy(Object.assign(new Error("synthetic read failure"), { code: "EIO" }));
    expect(await terminal.boundedWriteCompletion).toEqual({ kind: "closed" });
    await until(() => closed(readerFd), "reader close");
    expect(closed(writerFd)).toBe(true);
    terminal._boundedOwnedStop(9);
    await until(() => exit !== undefined, "owned child exit");
    assert.throws(() => process.kill(terminal.pid, 0), { code: "ESRCH" });
  } finally {
    terminal.disposeBoundedWrite();
    terminal.destroy();
    if (!exit) {
      terminal._boundedOwnedStop(9);
      await until(() => exit !== undefined, "owned child cleanup", 3_000);
    }
  }
});
