import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createNativePtyFactory } from "@cove/terminal-worker/native-adapter";
import { expect, test } from "vitest";

const fixture = resolve(import.meta.dirname, "fixtures/native-adapter-child.mjs");

function remaining(deadline, label) {
  const time = deadline - Date.now();
  if (time <= 0) throw new Error("Timed out awaiting " + label);
  return time;
}

async function within(promise, deadline, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out awaiting " + label)),
          remaining(deadline, label),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(predicate, deadline, label) {
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out awaiting " + label);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
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
  expect(inspectOwned(pid, mode, nonce)).toBe(true);
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (result.status !== 0) throw new Error(`Owned fixture ${pid} group is unverifiable`);
  expect(inspectOwned(pid, mode, nonce)).toBe(true);
  const group = Number(result.stdout.trim());
  expect(Number.isSafeInteger(group) && group > 0).toBe(true);
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

function discoverOwnedHelpers(nonce) {
  const result = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (result.status !== 0) throw new Error("Owned helper discovery is unverifiable");
  const pids = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || !match[2].includes(fixture) || !match[2].includes(` helper ${nonce}`)) continue;
    const pid = Number(match[1]);
    if (inspectOwned(pid, "helper", nonce)) pids.push(pid);
  }
  return pids;
}

function factory(overrides = {}) {
  return createNativePtyFactory({
    maxOwners: 2,
    aggregateInputBytes: 64 * 1024,
    aggregateInputTasks: 8,
    perPtyInputBytes: 64 * 1024,
    perPtyInputTasks: 4,
    earlyOutputBytes: 4 * 1024,
    ...overrides,
  });
}

function spawnOwned(nativeFactory, mode, nonce, sessions) {
  const chunks = [];
  const faults = [];
  let exit;
  const result = nativeFactory.spawn(
    {
      file: process.execPath,
      args: [fixture, mode, nonce],
      cwd: resolve(import.meta.dirname, "../../.."),
      env: process.env,
      cols: 80,
      rows: 24,
    },
    {
      onData(bytes) {
        chunks.push(bytes);
      },
      onExit(value) {
        exit = value;
      },
      onFault(value) {
        faults.push(value);
      },
    },
  );
  const session = {
    pty: result.pty,
    mode,
    nonce,
    bytes: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString("latin1"),
    faults,
    exit: () => exit,
  };
  if (result.pty) sessions.push(session);
  expect(result.kind).toBe("created");
  return session;
}

async function cleanupAll(sessions, helpers) {
  const deadline = Date.now() + 5_000;
  const failures = [];
  const observations = [];
  for (const session of sessions) {
    try {
      session.pty.retireInput();
    } catch (error) {
      failures.push(error);
    }
    try {
      observations.push(within(session.pty.stop(), deadline, "owned stop settlement"));
    } catch (error) {
      failures.push(error);
    }
    try {
      stopVerified(session.pty.pid, session.mode, session.nonce);
    } catch (error) {
      failures.push(error);
    }
    observations.push(within(session.pty.writerCompletion, deadline, "writer close"));
    observations.push(
      until(
        () => !inspectOwned(session.pty.pid, session.mode, session.nonce),
        deadline,
        "owned leader absence",
      ),
    );
  }
  for (const helper of helpers) {
    try {
      stopVerified(helper.pid, "helper", helper.nonce);
    } catch (error) {
      failures.push(error);
    }
    observations.push(
      until(
        () => !inspectOwned(helper.pid, "helper", helper.nonce),
        deadline,
        "owned helper absence",
      ),
    );
  }
  for (const result of await Promise.allSettled(observations)) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  // A body failure before the helper PID appears in output still owns its nonce.
  for (const session of sessions.filter((value) => value.mode === "leader-with-helper")) {
    try {
      const discovered = discoverOwnedHelpers(session.nonce);
      for (const pid of discovered) stopVerified(pid, "helper", session.nonce);
      await Promise.all(
        discovered.map((pid) =>
          until(
            () => !inspectOwned(pid, "helper", session.nonce),
            deadline,
            "discovered helper absence",
          ),
        ),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Owned adapter fixture cleanup failed");
}

async function runOwned(body) {
  const sessions = [];
  const helpers = [];
  const deadline = Date.now() + 8_000;
  let failure;
  try {
    await body({ sessions, helpers, deadline });
  } catch (error) {
    failure = error;
  }
  try {
    await cleanupAll(sessions, helpers);
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "Body and cleanup failed") : error;
  }
  if (failure) throw failure;
}

test("real adapter preserves raw bytes, split UTF-8 input, and exit ordering", async () => {
  await runOwned(async ({ sessions, deadline }) => {
    const nativeFactory = factory({ maxOwners: 1 });
    const nonce = randomUUID();
    const session = spawnOwned(nativeFactory, "bytes", nonce, sessions);
    const settlements = [];
    await until(() => session.text().includes("READY:" + nonce), deadline, "raw child ready");
    expect(session.bytes().subarray(0, 7)).toEqual(
      Buffer.from([0x41, 0x00, 0x80, 0xff, 0xe2, 0x82, 0xac]),
    );
    expect(
      session.pty.submit(Buffer.from([0x00, 0x80, 0xff, 0xe2]), (value) => settlements.push(value)),
    ).toMatchObject({ kind: "accepted", byteLength: 4 });
    expect(
      session.pty.submit(Buffer.from([0x82, 0xac, 0x51]), (value) => settlements.push(value)),
    ).toMatchObject({ kind: "accepted", byteLength: 3 });
    await until(() => session.text().includes("RECEIPT:0080ffe282ac51"), deadline, "raw receipt");
    await until(() => session.exit() !== undefined, deadline, "raw exit");
    await expect(within(session.pty.writerCompletion, deadline, "writer close")).resolves.toEqual({
      kind: "closed",
    });
    expect(settlements).toHaveLength(2);
    expect(settlements.every((value) => value.kind === "written")).toBe(true);
    expect(session.faults).toEqual([]);
    expect(nativeFactory.snapshot()).toMatchObject({ owners: 0, activeOwners: 0 });
  });
});

test("real bounded reader accepts configured input while a second PTY progresses", async () => {
  await runOwned(async ({ sessions, deadline }) => {
    const nativeFactory = factory({
      aggregateInputBytes: 65_538,
      aggregateInputTasks: 3,
      perPtyInputTasks: 2,
    });
    const slowNonce = randomUUID();
    const queryNonce = randomUUID();
    const slow = spawnOwned(nativeFactory, "slow", slowNonce, sessions);
    const query = spawnOwned(nativeFactory, "query", queryNonce, sessions);
    const settlements = [];
    await until(() => slow.text().includes("READY:" + slowNonce), deadline, "slow child ready");
    await until(() => query.text().includes("READY:" + queryNonce), deadline, "query child ready");
    const payload = Buffer.alloc(65_536, 0x61);
    const offer = Array.from({ length: 16 }, () =>
      slow.pty.submit(payload, (value) => settlements.push(value)),
    );
    expect(offer.filter((value) => value.kind === "accepted")).toHaveLength(1);
    expect(offer.filter((value) => value.kind === "rejected")).toHaveLength(15);
    expect(offer.slice(1).every((value) => value.reason === "pty-byte-limit")).toBe(true);
    query.pty.automaticOutputSink({ atSeq: 1, kind: "query", bytes: Buffer.from("Q\r") });
    await until(() => query.text().includes("QUERY:51"), deadline, "second PTY query progress");
    await until(() => slow.text().includes("DIGEST:"), deadline, "slow input digest");
    const expected = createHash("sha256").update(payload).digest("hex");
    expect(slow.text()).toContain("DIGEST:" + expected);
    await until(
      () => slow.exit() !== undefined && query.exit() !== undefined,
      deadline,
      "both exits",
    );
    expect(settlements).toMatchObject([{ kind: "written", originalBytes: 65_536 }]);
    expect(slow.faults).toEqual([]);
    expect(query.faults).toEqual([]);
  });
});

test("real owned leader exits after graceful HUP and closes its writer", async () => {
  await runOwned(async ({ sessions, deadline }) => {
    const nativeFactory = factory({ maxOwners: 1 });
    const session = spawnOwned(nativeFactory, "live-hup", randomUUID(), sessions);
    await until(
      () => session.text().includes("READY:" + session.nonce),
      deadline,
      "live HUP ready",
    );
    const stop = session.pty.stop();
    expect(session.pty.stop()).toBe(stop);
    const result = await within(stop, deadline, "graceful owned stop");
    expect(result).toMatchObject({ kind: "exited", cleanup: { verified: false } });
    expect(session.exit()).toEqual(result.exit);
    expect(result.cleanup.force).toMatchObject({ kind: "not-attempted" });
    await expect(within(session.pty.writerCompletion, deadline, "writer close")).resolves.toEqual({
      kind: "closed",
    });
    expect(nativeFactory.snapshot().owners).toBe(0);
  });
});

test("real owned leader ignores HUP and exits after bounded KILL", async () => {
  await runOwned(async ({ sessions, deadline }) => {
    const session = spawnOwned(factory({ maxOwners: 1 }), "live-force", randomUUID(), sessions);
    await until(
      () => session.text().includes("READY:" + session.nonce),
      deadline,
      "live force ready",
    );
    const start = performance.now();
    const result = await within(session.pty.stop(), deadline, "forced owned stop");
    expect(performance.now() - start).toBeGreaterThanOrEqual(1_850);
    expect(result).toMatchObject({ kind: "exited", cleanup: { verified: false } });
    expect(result.cleanup.force.kind).not.toBe("not-attempted");
    expect(session.exit()).toEqual(result.exit);
    await expect(within(session.pty.writerCompletion, deadline, "writer close")).resolves.toEqual({
      kind: "closed",
    });
  });
});

test("leader release does not wait for a same-group HUP-resistant helper", async () => {
  await runOwned(async ({ sessions, helpers, deadline }) => {
    const nativeFactory = factory({ maxOwners: 1 });
    const session = spawnOwned(nativeFactory, "leader-with-helper", randomUUID(), sessions);
    await until(
      () => session.text().includes("READY:" + session.nonce + ":"),
      deadline,
      "helper ready",
    );
    const helperPid = Number(
      session.text().match(new RegExp(`READY:${session.nonce}:(\\d+)`))?.[1],
    );
    expect(Number.isSafeInteger(helperPid) && helperPid > 0).toBe(true);
    helpers.push({ pid: helperPid, nonce: session.nonce });
    expect(ownedGroup(session.pty.pid, session.mode, session.nonce)).toBe(
      ownedGroup(helperPid, "helper", session.nonce),
    );
    const result = await within(session.pty.stop(), deadline, "leader stop with helper");
    expect(result).toMatchObject({ kind: "exited", cleanup: { verified: false } });
    expect(inspectOwned(helperPid, "helper", session.nonce)).toBe(true);
    await expect(within(session.pty.writerCompletion, deadline, "writer close")).resolves.toEqual({
      kind: "closed",
    });
    expect(nativeFactory.snapshot().owners).toBe(0);
    const next = spawnOwned(nativeFactory, "live-hup", randomUUID(), sessions);
    await until(() => next.text().includes("READY:" + next.nonce), deadline, "next owner ready");
    expect((await within(next.pty.stop(), deadline, "next owner stop")).kind).toBe("exited");
  });
});

test("fixture cleanup preserves a body failure and continues after one stop failure", async () => {
  const nativeFactory = factory();
  let first;
  let second;
  let originalStop;
  const primary = new Error("second spawn failed after first owner was created");
  let caught;
  try {
    await runOwned(async ({ sessions, deadline }) => {
      first = spawnOwned(nativeFactory, "live-hup", randomUUID(), sessions);
      second = spawnOwned(nativeFactory, "live-hup", randomUUID(), sessions);
      await until(
        () => first.text().includes("READY:" + first.nonce),
        deadline,
        "first owner ready",
      );
      await until(
        () => second.text().includes("READY:" + second.nonce),
        deadline,
        "second owner ready",
      );
      originalStop = first.pty.stop;
      first.pty.stop = () => {
        throw new Error("injected first stop failure");
      };
      throw primary;
    });
  } catch (error) {
    caught = error;
  } finally {
    if (first && originalStop) first.pty.stop = originalStop;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect(caught.errors[0]).toBe(primary);
  expect(
    caught.errors[1].errors.some((error) => /injected first stop failure/.test(String(error))),
  ).toBe(true);
  expect(inspectOwned(first.pty.pid, first.mode, first.nonce)).toBe(false);
  expect(inspectOwned(second.pty.pid, second.mode, second.nonce)).toBe(false);
});
