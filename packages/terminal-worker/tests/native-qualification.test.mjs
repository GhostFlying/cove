import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { spawnNativeQualificationPty } from "@cove/terminal-worker/qualification";
import { ownedStalledCommand } from "./stalled-input-identity.mjs";

const root = resolve(import.meta.dirname, "../../..");
const child = resolve(import.meta.dirname, "fixtures/raw-child.mjs");
const nativeRequire = createRequire(import.meta.resolve("@cove/terminal-worker/qualification"));
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function until(check, label, limit = 4_000, failure = () => null) {
  const deadline = performance.now() + limit;
  while (performance.now() < deadline) {
    if (failure()) throw failure();
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`Timed out awaiting ${label}`);
}

function ownedCommand(pid, mode, nonce, inspect = spawnSync, probe = process.kill) {
  const result = inspect("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.error || result.signal || result.status !== 0 || !result.stdout?.trim()) {
    try {
      probe(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return null;
      throw new Error(`Owned PID ${pid} existence could not be verified`, { cause: error });
    }
    throw new Error(`Owned PID ${pid} identity could not be verified`);
  }
  if (
    !result.stdout.includes(child) ||
    !result.stdout.split(/\s+/).includes(mode) ||
    !result.stdout.split(/\s+/).includes(nonce)
  )
    throw new Error(`Owned PID ${pid} no longer matches the fixture`);
  return result.stdout.trim();
}

function start(mode, extra = [], spawnPty) {
  const nonce = extra[0] ?? `w1-${randomUUID()}`;
  const chunks = [];
  let exit;
  const exited = new Promise((resolveExit) => {
    exit = resolveExit;
  });
  const terminal = spawnNativeQualificationPty(
    process.execPath,
    [child, mode, nonce, ...extra.slice(1)],
    root,
    (bytes) => chunks.push(bytes),
    exit,
    spawnPty,
  );
  return {
    terminal,
    nonce,
    exited,
    until: (check, label, limit) => until(check, label, limit, () => terminal.failure()),
    bytes: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString("latin1"),
  };
}

async function finish(session, mode) {
  try {
    if (ownedCommand(session.terminal.pid, mode, session.nonce)) session.terminal.kill("SIGTERM");
    await Promise.race([
      session.exited,
      sleep(3_000).then(() => {
        throw new Error(`Owned PTY ${session.terminal.pid} did not settle`);
      }),
    ]);
    await until(
      () => ownedCommand(session.terminal.pid, mode, session.nonce) === null,
      "owned PTY exit",
    );
  } finally {
    session.terminal.disposeListeners();
  }
  if (session.terminal.failure()) throw session.terminal.failure();
}

function processGroup(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status !== 0) throw new Error(`Could not verify process group for owned PID ${pid}`);
  return Number(result.stdout.trim());
}

test("N01 compiled native factory preserves raw output and Buffer input including split UTF-8", async () => {
  const session = start("bytes");
  try {
    await session.until(() => session.text().includes("READY"), "raw child ready");
    const output = session.bytes();
    expect(output.subarray(0, 7)).toEqual(Buffer.from([0x41, 0x00, 0x80, 0xff, 0xe2, 0x82, 0xac]));
    session.terminal.writeBytes(Buffer.from([0x00, 0x80, 0xff, 0xe2]));
    session.terminal.writeBytes(Buffer.from([0x82, 0xac, 0x51]));
    await session.until(
      () => session.text().includes("RECEIPT:0080ffe282ac51"),
      "raw input receipt",
    );
    expect(await session.exited).toMatchObject({ exitCode: 23 });
    const ptyManifest = JSON.parse(await readFile(nativeRequire.resolve("node-pty/package.json")));
    expect(ptyManifest.version).toBe("1.1.0");
    const nativePath = Object.keys(nativeRequire.cache).find((path) => path.endsWith("pty.node"));
    expect(nativePath).toBeDefined();
    const evidence = {
      pid: session.terminal.pid,
      exitCode: 23,
      rawOutputHex: output.subarray(0, 7).toString("hex"),
      inputReceiptHex: "0080ffe282ac51",
      nodeAbi: process.versions.modules,
      nativePath,
      nativeSha256: createHash("sha256")
        .update(await readFile(nativePath))
        .digest("hex"),
    };
    const evidenceDir = resolve(root, ".cache/ci/smoke");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      resolve(evidenceDir, "worker-native.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  } finally {
    await finish(session, "bytes");
  }
  const faulty = start("bytes", [], (...args) => {
    const real = nativeRequire("node-pty").spawn(...args);
    let injected = false;
    return {
      pid: real.pid,
      onData(listener) {
        return real.onData((value) => {
          listener(injected ? value : "injected decoded data");
          injected = true;
        });
      },
      onExit: real.onExit.bind(real),
      write: real.write.bind(real),
      pause: real.pause.bind(real),
      resume: real.resume.bind(real),
      kill: real.kill.bind(real),
    };
  });
  try {
    await expect(
      faulty.until(() => faulty.text().includes("READY"), "fault injection"),
    ).rejects.toThrow(/did not deliver raw Buffer data/);
  } finally {
    await expect(finish(faulty, "bytes")).rejects.toThrow(/did not deliver raw Buffer data/);
  }
  expect(ownedCommand(faulty.terminal.pid, "bytes", faulty.nonce)).toBeNull();
});

test("N02 public pause and resume defer raw child output without XON/XOFF writes", async () => {
  const session = start("pause");
  try {
    await session.until(() => session.text().includes("BEGIN"), "pause marker");
    session.terminal.pause();
    await sleep(270);
    expect(session.text()).not.toContain("AFTER");
    session.terminal.resume();
    await session.until(() => session.text().includes("AFTER"), "resumed marker");
    expect(await session.exited).toMatchObject({ exitCode: 0 });
  } finally {
    await finish(session, "pause");
  }
});

test("N03 owned child and helper identities are verified and cleaned separately", async () => {
  const nonce = `w1-${process.pid}-${Date.now()}`;
  const directory = await mkdtemp(join(tmpdir(), "cove-worker-descendant-"));
  const pidFile = join(directory, "helper.pid");
  const session = start("descendant", [nonce, pidFile]);
  let helperPid;
  let group;
  let helperAfterLeaderExit;
  let primaryError;
  const cleanupErrors = [];
  try {
    await session.until(() => session.text().includes("HELPER:"), "helper identity");
    helperPid = Number(session.text().match(/HELPER:(\d+)/)?.[1]);
    expect(Number.isSafeInteger(helperPid)).toBe(true);
    expect(ownedCommand(session.terminal.pid, "descendant", nonce)).toContain(nonce);
    expect(ownedCommand(helperPid, "helper", nonce)).toContain(nonce);
    group = processGroup(session.terminal.pid);
    expect(group).toBe(session.terminal.pid);
    expect(processGroup(helperPid)).toBe(group);
    session.terminal.kill("SIGHUP");
    await Promise.race([
      session.exited,
      sleep(3_000).then(() => {
        throw new Error("Owned PTY leader did not exit after SIGHUP");
      }),
    ]);
    helperAfterLeaderExit = ownedCommand(helperPid, "helper", nonce) !== null;
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      if (helperPid === undefined) {
        const savedPid = await readFile(pidFile, "utf8");
        helperPid = Number(savedPid);
      }
      if (!Number.isSafeInteger(helperPid) || helperPid <= 0)
        cleanupErrors.push(new Error("Owned helper identity is invalid or unavailable"));
      else {
        if (ownedCommand(helperPid, "helper", nonce)) process.kill(helperPid, "SIGTERM");
        await until(() => ownedCommand(helperPid, "helper", nonce) === null, "owned helper exit");
      }
    } catch (error) {
      cleanupErrors.push(
        new Error("Owned helper identity or cleanup is unverifiable", { cause: error }),
      );
    }
    try {
      await finish(session, "descendant");
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (helperPid && group && cleanupErrors.length === 0) {
      try {
        const evidenceDir = resolve(root, ".cache/ci/smoke");
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(
          resolve(evidenceDir, "worker-descendant.json"),
          `${JSON.stringify({ leaderPid: session.terminal.pid, helperPid, verifiedGroup: group, helperAfterLeaderExit, leaderAbsent: ownedCommand(session.terminal.pid, "descendant", nonce) === null, helperAbsent: ownedCommand(helperPid, "helper", nonce) === null }, null, 2)}\n`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length === 0) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (primaryError && cleanupErrors.length)
    throw new AggregateError([primaryError, ...cleanupErrors], "Native fixture and cleanup failed");
  if (primaryError) throw primaryError;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Native fixture cleanup failed");
  const otherNonce = "another-task-nonce";
  const wrongIdentity = () => ({
    status: 0,
    stdout: `${process.execPath} ${child} helper ${otherNonce}\n`,
  });
  expect(() => ownedCommand(123, "helper", nonce, wrongIdentity, () => {})).toThrow(
    /no longer matches/,
  );
  const inspectionFailed = () => ({ status: null, error: new Error("ps failed") });
  expect(() => ownedCommand(123, "helper", nonce, inspectionFailed, () => {})).toThrow(
    /identity could not be verified/,
  );
  const absent = Object.assign(new Error("missing"), { code: "ESRCH" });
  expect(
    ownedCommand(123, "helper", nonce, inspectionFailed, () => {
      throw absent;
    }),
  ).toBeNull();
});

test("stalled diagnostic requires its exact nonce and fails closed on live inspection errors", () => {
  const nonce = `w1-stall-${randomUUID()}`;
  const line = `${process.execPath} ${child} stall ${nonce}\n`;
  const inspect = () => ({ status: 0, stdout: line });
  expect(ownedStalledCommand(123, child, nonce, inspect, () => {})).toBe(line.trim());
  expect(() => ownedStalledCommand(123, child, `${nonce}-other`, inspect, () => {})).toThrow(
    /no longer matches/,
  );
  expect(() => ownedStalledCommand(123, `${child}-other`, nonce, inspect, () => {})).toThrow(
    /no longer matches/,
  );
  expect(() =>
    ownedStalledCommand(
      123,
      child,
      nonce,
      () => ({ status: 0, stdout: line.replace("stall", "helper") }),
      () => {},
    ),
  ).toThrow(/no longer matches/);
  const inspectionFailed = () => ({ status: null, error: new Error("ps failed") });
  expect(() => ownedStalledCommand(123, child, nonce, inspectionFailed, () => {})).toThrow(
    /identity could not be verified/,
  );
  const absent = Object.assign(new Error("missing"), { code: "ESRCH" });
  expect(
    ownedStalledCommand(123, child, nonce, inspectionFailed, () => {
      throw absent;
    }),
  ).toBeNull();
});
