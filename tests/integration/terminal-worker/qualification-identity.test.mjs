import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import {
  childPipe,
  admitWorkerStartup,
  composeWorkerReceipt,
  hello,
  observeWorkerProcess,
  parseWorkerProcessRow,
  preserveWorkerHarness,
  psIdentity,
  repo,
  sameOwnedWorker,
  signalVerifiedWorkerExec,
  startWorkerPipe,
  stopVerified,
  until,
  verifyWorkerIdentity,
  workerIdentityAnchors,
} from "./pipe-harness.mjs";

const pid = 11060;
const started = "Mon Sep 28 18:16:48 2026";
const bin = "/tmp/cove-qual-bin-example/node_modules/.bin/cove-terminal-worker";
const compiled = "/home/runner/work/cove/cove/packages/terminal-worker/dist/src/main.js";
const workerEntry = join(repo, "packages/terminal-worker/dist/src/main.js");
const linuxEntry = `${dirname(bin)}/../../../../home/runner/work/cove/cove/packages/terminal-worker/dist/src/main.js`;
const canonicalBin = "/canonical/cove-terminal-worker";
const resolverMap = new Map([
  [bin, canonicalBin],
  [workerEntry, compiled],
  [linuxEntry, compiled],
]);
const resolver = (path) => resolverMap.get(path) ?? path;
const parse = (command, expectedPid = pid) =>
  parseWorkerProcessRow(`${pid} ${started} ${command}`, expectedPid, bin, {
    resolveEntry: resolver,
  });

const controlledBin = (directory) => {
  const path = join(directory, "owned-child");
  writeFileSync(
    path,
    `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.once("end", () => process.exit(0));\n`,
  );
  chmodSync(path, 0o700);
  return path;
};

const preserve = (directory, names) => {
  const evidenceRoot = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  if (!evidenceRoot) return;
  const target = join(evidenceRoot, `identity-${process.pid}-${Date.now()}`);
  mkdirSync(target, { recursive: true });
  for (const name of names)
    if (existsSync(join(directory, name))) copyFileSync(join(directory, name), join(target, name));
};

const startupHarness = (first, sequence) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new EventEmitter();
  child.kill = () => {
    throw Error("unexpected subject signal");
  };
  const sends = [];
  let samples = 0;
  const harness = {
    child,
    bin,
    errors: [],
    stderr: [],
    firstObservation: first,
    initialObservation: first,
    observe: () => sequence[Math.min(samples++, sequence.length - 1)],
    send: (frame, _payload, onComplete) => {
      sends.push(frame);
      onComplete?.();
    },
  };
  return { harness, sends, sampleCount: () => samples };
};

test("structured worker identity accepts one owned shim-to-compiled exec and rejects ambiguity", () => {
  const shim = parse(`/bin/sh ${bin}`);
  const linux = parse(`node ${linuxEntry}`);
  const mac = parse(
    `${process.execPath} ${join(repo, "packages/terminal-worker/dist/src/main.js")}`,
  );
  expect(shim.form).toBe("installed-shim");
  expect(linux.form).toBe("compiled-entry");
  expect(mac.form).toBe("compiled-entry");
  expect(sameOwnedWorker(shim, linux)).toBe(true);
  expect(sameOwnedWorker(shim, { ...mac, started: "Mon Sep 28 18:16:49 2026" })).toBe(false);
  expect(parse(`node ${compiled}`, pid + 1).kind).toBe("unverifiable");
  expect(parse("node /wrong/packages/terminal-worker/dist/src/main.js").kind).toBe("unverifiable");
  expect(parse("node /tmp/other/main.js").kind).toBe("unverifiable");
  expect(parseWorkerProcessRow(`${pid} malformed`, pid, bin).kind).toBe("unverifiable");
  expect(parseWorkerProcessRow("", pid, bin).kind).toBe("unverifiable");
  expect(parseWorkerProcessRow(`${pid} ${started} node ${compiled}\nextra`, pid, bin).kind).toBe(
    "unverifiable",
  );
});

test("saved Darwin alias rows keep one exact installed and compiled identity", () => {
  const observedBin =
    "/var/folders/_1/sj9wh3913439fyzt6694p4hr0000gp/T/cove-qual-bin-nug2LQ/node_modules/.bin/cove-terminal-worker";
  const observedEntry =
    "/private/var/folders/_1/sj9wh3913439fyzt6694p4hr0000gp/T/cove-qual-bin-nug2LQ/node_modules/.bin/../../../../../../../../../Users/luchengxuan/WORKSPACE/cove-worktrees/m0-terminal-recovery/packages/terminal-worker/dist/src/main.js";
  const aliasResolver = (path) =>
    new Map([
      [observedBin, canonicalBin],
      [workerEntry, compiled],
      [observedEntry, compiled],
    ]).get(path) ?? path;
  const anchors = workerIdentityAnchors(observedBin, aliasResolver);
  const shim = parseWorkerProcessRow(
    `3408 Tue Sep 29 04:32:56 2026     /bin/sh ${observedBin}`,
    3408,
    observedBin,
    { resolveEntry: aliasResolver, anchors },
  );
  const exec = parseWorkerProcessRow(
    `3408 Tue Sep 29 04:32:56 2026     node ${observedEntry}`,
    3408,
    observedBin,
    { resolveEntry: aliasResolver, anchors },
  );
  expect(shim).toMatchObject({ kind: "owned", form: "installed-shim" });
  expect(exec).toMatchObject({ kind: "owned", form: "compiled-entry" });
  expect(sameOwnedWorker(shim, exec)).toBe(true);
  const wrongAnchors = { ...anchors, installed: "/canonical/another-installation" };
  expect(
    parseWorkerProcessRow(shim.raw, 3408, observedBin, {
      resolveEntry: aliasResolver,
      anchors: wrongAnchors,
    }).kind,
  ).toBe("unverifiable");
});

test("real filesystem alias and parent traversal resolve only the expected entry", () => {
  const directory = mkdtempSync(join(tmpdir(), "cove-qual-entry-alias-"));
  try {
    const packageDir = join(directory, "real", "package");
    const otherDir = join(directory, "other");
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(otherDir);
    const target = join(packageDir, "main.js");
    const other = join(otherDir, "main.js");
    const shim = join(directory, "cove-terminal-worker");
    writeFileSync(target, "// expected\n");
    writeFileSync(other, "// unrelated\n");
    writeFileSync(shim, "#!/bin/sh\n");
    symlinkSync(packageDir, join(directory, "alias"));
    const observed = `${directory}/alias/../real/package/main.js`;
    const anchors = { installed: realpathSync(shim), compiled: realpathSync(target) };
    const row = (script) => `${pid} ${started} node ${script}`;
    expect(parseWorkerProcessRow(row(observed), pid, shim, { anchors })).toMatchObject({
      kind: "owned",
      form: "compiled-entry",
      canonical: anchors.compiled,
    });
    expect(parseWorkerProcessRow(row(other), pid, shim, { anchors })).toMatchObject({
      kind: "unverifiable",
      reason: "unrelated-argv",
    });
    expect(
      parseWorkerProcessRow(row(join(directory, "missing", "main.js")), pid, shim, { anchors }),
    ).toMatchObject({ kind: "unverifiable", reason: "candidate-resolution-failed" });
    const denied = (path) => {
      if (path === observed) throw Object.assign(Error("denied"), { code: "EACCES" });
      return realpathSync(path);
    };
    expect(
      parseWorkerProcessRow(row(observed), pid, shim, { anchors, resolveEntry: denied }),
    ).toMatchObject({ kind: "unverifiable", reason: "candidate-resolution-failed" });
    expect(parseWorkerProcessRow(row(`${observed} --extra`), pid, shim, { anchors }).kind).toBe(
      "unverifiable",
    );
    const missingAnchors = workerIdentityAnchors(join(directory, "missing-bin"));
    expect(
      parseWorkerProcessRow(row(observed), pid, shim, { anchors: missingAnchors }),
    ).toMatchObject({ kind: "unverifiable", reason: "expected-anchor-unavailable" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real SIGTERM branch signals once only for a fresh matching compiled birth", () => {
  const initial = parse(`/bin/sh ${bin}`);
  const matching = parse(`node ${linuxEntry}`);
  const signals = [];
  let fresh = matching;
  const harness = {
    child: { pid, kill: (signal) => signals.push(signal) },
    bin,
    initialObservation: initial,
    observe: () => fresh,
  };
  expect(signalVerifiedWorkerExec(harness, "SIGTERM")).toEqual(matching);
  expect(signals).toEqual(["SIGTERM"]);
  fresh = { ...matching, started: "Mon Sep 28 18:16:49 2026" };
  expect(() => signalVerifiedWorkerExec(harness, "SIGTERM")).toThrow("worker identity uncertain");
  expect(signals).toEqual(["SIGTERM"]);
});

test("bounded admission waits through transient shell and shim before caller hello", async () => {
  const transient = parse("(sh)");
  const bash = parse("(bash)");
  expect(bash).toMatchObject({ kind: "unverifiable", pid, started, reason: "pre-exec-shell" });
  const shim = parse(`/bin/sh ${bin}`);
  const exec = parse(`node ${linuxEntry}`);
  const { harness, sends } = startupHarness(transient, [shim, bash, exec, exec]);
  const observe = harness.observe;
  harness.observe = (...args) => {
    expect(sends).toEqual([]);
    return observe(...args);
  };
  const pending = startWorkerPipe(harness, hello, { deadlineMs: 1000 });
  expect(sends).toEqual([]);
  await pending;
  expect(harness.provisionalBirth).toEqual({ pid, started });
  expect(harness.firstObservation).toEqual(transient);
  expect(harness.admittedObservation).toEqual(exec);
  expect(harness.startupSamples.map((sample) => sample.commandLine)).toEqual([
    "(sh)",
    shim.commandLine,
    "(bash)",
    exec.commandLine,
  ]);
  expect(sends).toEqual([hello]);
});

test("only exact known shell titles remain pending during startup", async () => {
  const shim = parse(`/bin/sh ${bin}`);
  const exec = parse(`node ${linuxEntry}`);
  for (const title of [
    "(node)",
    "(zsh)",
    "(arbitrary)",
    "(bash) --extra",
    `/bin/bash ${bin}`,
    "/bin/sh /wrong/wrapper",
  ]) {
    const rejected = parse(title);
    expect(rejected).toMatchObject({ kind: "unverifiable", reason: "unrelated-argv" });
    const { harness, sends, sampleCount } = startupHarness(shim, [rejected, exec]);
    await expect(startWorkerPipe(harness, hello)).rejects.toThrow(
      "worker startup identity rejected",
    );
    expect(sampleCount()).toBe(1);
    expect(sends).toEqual([]);
    expect(harness.startupFailureObservation).toEqual(rejected);
  }
  const wrongPid = parse("(bash)", pid + 1);
  expect(wrongPid).toMatchObject({ kind: "unverifiable", reason: "malformed-or-wrong-pid" });
  const { harness, sends } = startupHarness(wrongPid, [exec]);
  await expect(startWorkerPipe(harness, hello)).rejects.toThrow("worker startup identity rejected");
  expect(sends).toEqual([]);
});

test("bash transient cannot authorize changed birth, wrong entry, hello or signals", async () => {
  const bash = parse("(bash)");
  const exec = parse(`node ${linuxEntry}`);
  expect(sameOwnedWorker(exec, bash)).toBe(false);
  const changed = { ...exec, started: "Mon Sep 28 18:16:49 2026" };
  const birth = startupHarness(bash, [changed]);
  await expect(startWorkerPipe(birth.harness, hello)).rejects.toThrow("worker birth changed");
  expect(birth.sends).toEqual([]);
  expect(birth.harness.startupFailureObservation).toEqual(changed);

  const wrongEntry = parse("node /wrong/main.js");
  const entry = startupHarness(bash, [wrongEntry, exec]);
  await expect(startWorkerPipe(entry.harness, hello)).rejects.toThrow(
    "worker startup identity rejected",
  );
  expect(entry.sampleCount()).toBe(1);
  expect(entry.sends).toEqual([]);

  const fresh = startupHarness(exec, [bash]);
  await expect(startWorkerPipe(fresh.harness, hello)).rejects.toThrow("worker identity uncertain");
  expect(fresh.sends).toEqual([]);
  expect(fresh.harness.helloWrite.attempted).toBe(false);
  expect(fresh.harness.startupFailureObservation).toEqual(bash);

  const signals = [];
  fresh.harness.child.kill = (signal) => signals.push(signal);
  expect(() => signalVerifiedWorkerExec(fresh.harness, "SIGTERM")).toThrow(
    "worker identity uncertain",
  );
  expect(signals).toEqual([]);
});

test("direct expected compiled entry admits before caller hello", async () => {
  const exec = parse(`node ${linuxEntry}`);
  const { harness, sends } = startupHarness(exec, [exec]);
  await startWorkerPipe(harness, hello);
  expect(harness.startupSamples).toEqual([exec]);
  expect(sends).toEqual([hello]);
});

test("final pre-hello proof rejects a same-birth shim and records terminal failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cove-qual-prehello-"));
  const exec = parse(`node ${linuxEntry}`);
  const shim = parse(`/bin/sh ${bin}`);
  const { harness, sends } = startupHarness(exec, [shim]);
  try {
    await expect(startWorkerPipe(harness, hello)).rejects.toThrow("worker exec identity uncertain");
    expect(sends).toEqual([]);
    expect(harness.admittedObservation).toEqual(exec);
    preserveWorkerHarness(harness, directory, "prehello-failure");
    const saved = JSON.parse(readFileSync(join(directory, "prehello-failure.json"), "utf8"));
    expect(saved).toMatchObject({
      startupState: "failed",
      admittedObservation: exec,
      startupFailureObservation: shim,
      startupFailure: { message: expect.stringContaining("worker exec identity uncertain") },
    });
    preserve(directory, ["prehello-failure.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed hello write is terminal and does not retry", async () => {
  const exec = parse(`node ${linuxEntry}`);
  const { harness, sends } = startupHarness(exec, [exec]);
  harness.send = () => {
    sends.push(hello);
    throw Error("controlled hello write failure");
  };
  await expect(startWorkerPipe(harness, hello)).rejects.toThrow("controlled hello write failure");
  expect(sends).toEqual([hello]);
  expect(harness.startupState).toBe("failed");
  expect(harness.startupFailure.message).toBe("controlled hello write failure");
});

test.each([
  ["async callback error", "error"],
  ["false-return completion", "success"],
  ["missing completion", "timeout"],
  ["premature close", "close"],
])(
  "owned Writable hello %s uses shared childPipe send and error wiring",
  async (_label, mode) => {
    const directory = mkdtempSync(join(tmpdir(), "cove-qual-hello-writable-"));
    const entry = controlledBin(directory);
    const nonce = `hello-write-${mode}-${process.pid}-${Date.now()}`;
    const sent = [];
    let lateComplete;
    const input = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        sent.push(Buffer.from(chunk));
        if (mode === "error")
          setImmediate(() =>
            callback(Object.assign(Error("controlled broken pipe"), { code: "EPIPE" })),
          );
        else if (mode === "success") setImmediate(() => callback());
        else if (mode === "close") setImmediate(() => input.destroy());
        else lateComplete = callback;
      },
    });
    let harness;
    let primary;
    const cleanupErrors = [];
    try {
      harness = childPipe(entry, nonce, { expectedEntry: entry, evidencePath: directory, input });
      try {
        await startWorkerPipe(harness, hello, { helloWriteMs: 80 });
      } catch (error) {
        primary = error;
      }
      expect(sent).toHaveLength(1);
      expect(harness.helloWrite.attempted).toBe(true);
      expect(harness.helloWrite.returned).toBe(false);
      expect(harness.startupState).toBe(mode === "success" ? "admitted" : "failed");
      expect(harness.helloWrite.status).toBe(mode === "success" ? "completed" : "failed");
      expect(primary?.code ?? null).toBe(
        mode === "error" ? "EPIPE" : mode === "timeout" ? "ETIMEDOUT" : null,
      );
      expect(harness.startupFailure?.phase ?? null).toBe(
        mode === "error"
          ? "write-callback"
          : mode === "timeout"
            ? "completion-timeout"
            : mode === "close"
              ? "stdin-close"
              : null,
      );
      if (lateComplete) {
        lateComplete();
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(harness.helloWrite.status).toBe(mode === "success" ? "completed" : "failed");
      let laterWaitError;
      if (mode === "success" || mode === "timeout") {
        input.emit("error", Object.assign(Error("later command failure"), { code: "EPIPE" }));
        if (mode === "success")
          try {
            await harness.wait(() => false, "later stdin error");
          } catch (error) {
            laterWaitError = error;
          }
      }
      expect(laterWaitError?.message?.includes("worker child error") === true).toBe(
        mode === "success",
      );
      expect(harness.startupState).toBe(mode === "success" ? "admitted" : "failed");
      preserveWorkerHarness(harness, directory, "after-write", primary);
      const saved = JSON.parse(readFileSync(join(directory, "after-write.json"), "utf8"));
      expect(saved.helloWrite.status).toBe(harness.helloWrite.status);
      expect(saved.startupFailure?.phase ?? null).toBe(harness.startupFailure?.phase ?? null);
      expect(saved.stdinErrors.length > 0).toBe(mode !== "close");
      expect(saved.stdinErrors.at(-1)?.phase ?? null).toBe(
        mode === "error" ? "hello-write" : mode === "close" ? null : "command-or-cleanup",
      );
      writeFileSync(
        join(directory, "main-write.json"),
        JSON.stringify(composeWorkerReceipt(harness, { nonce }, primary), null, 2) + "\n",
      );
      const main = JSON.parse(readFileSync(join(directory, "main-write.json"), "utf8"));
      expect(main.workerHarness.startupFailure?.code ?? null).toBe(
        harness.startupFailure?.code ?? null,
      );
      expect(main.workerHarness.helloWrite.failure?.phase ?? null).toBe(
        harness.helloWrite.failure?.phase ?? null,
      );
    } finally {
      try {
        if (harness) preserveWorkerHarness(harness, directory, "before-cleanup", primary);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (harness) await stopVerified(harness);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (harness) preserveWorkerHarness(harness, directory, "after-cleanup", primary);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        preserve(directory, [
          "acquired.json",
          "after-write.json",
          "main-write.json",
          "before-cleanup.json",
          "after-cleanup.json",
        ]);
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      input.destroy();
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        [...(primary ? [primary] : []), ...cleanupErrors],
        "hello cleanup failed",
      );
    expect(
      await until(() => !psIdentity(harness.child.pid), 3000, "controlled hello child exit"),
    ).toBe(true);
  },
  10000,
);

test("actual owned child pipe rejects one hello after local stdin closure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cove-qual-closed-hello-pipe-"));
  const entry = join(directory, "controlled-entry");
  writeFileSync(entry, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  chmodSync(entry, 0o700);
  let harness;
  let primary;
  const cleanupErrors = [];
  try {
    harness = childPipe(entry, `closed-hello-${process.pid}-${Date.now()}`, {
      expectedEntry: entry,
      evidencePath: directory,
    });
    await admitWorkerStartup(harness);
    harness.child.stdin.destroy();
    try {
      await startWorkerPipe(harness, hello, { helloWriteMs: 500 });
    } catch (error) {
      primary = error;
    }
    expect(primary?.code).toBe("ERR_STREAM_DESTROYED");
    expect(harness.helloWrite).toMatchObject({ attempted: true, status: "failed" });
    expect(harness.startupFailure).toMatchObject({
      code: "ERR_STREAM_DESTROYED",
      phase: "write-callback",
    });
    preserveWorkerHarness(harness, directory, "after-write", primary);
    const saved = JSON.parse(readFileSync(join(directory, "after-write.json"), "utf8"));
    expect(saved.startupFailure.code).toBe("ERR_STREAM_DESTROYED");
    expect(saved.helloWrite.attempted).toBe(true);
  } finally {
    try {
      if (harness) preserveWorkerHarness(harness, directory, "before-cleanup", primary);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (harness) await stopVerified(harness);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (harness) preserveWorkerHarness(harness, directory, "after-cleanup", primary);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      preserve(directory, [
        "acquired.json",
        "after-write.json",
        "before-cleanup.json",
        "after-cleanup.json",
      ]);
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanupErrors],
      "closed pipe cleanup failed",
    );
  expect(await until(() => !psIdentity(harness.child.pid), 3000, "closed pipe child exit")).toBe(
    true,
  );
}, 10000);

test("real-main receipt composition preserves admission failure before uncertain cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cove-qual-main-receipt-"));
  const exec = parse(`node ${linuxEntry}`);
  const shim = parse(`/bin/sh ${bin}`);
  const { harness, sends } = startupHarness(exec, [shim]);
  let primary;
  let cleanup;
  try {
    try {
      await startWorkerPipe(harness, hello);
    } catch (error) {
      primary = error;
    }
    expect(sends).toEqual([]);
    writeFileSync(
      join(directory, "before-cleanup.json"),
      JSON.stringify(composeWorkerReceipt(harness, { nonce: "main-receipt" }, primary), null, 2) +
        "\n",
    );
    preserveWorkerHarness(harness, directory, "public-before", primary);
    harness.child.stdin.destroyed = false;
    harness.child.stdin.writableEnded = false;
    harness.child.stdin.end = () => {
      harness.child.stdin.writableEnded = true;
    };
    try {
      await stopVerified(harness);
    } catch (error) {
      cleanup = error;
    }
    writeFileSync(
      join(directory, "after-cleanup.json"),
      JSON.stringify(composeWorkerReceipt(harness, { nonce: "main-receipt" }, primary), null, 2) +
        "\n",
    );
    preserveWorkerHarness(harness, directory, "public-after", primary);
    const before = JSON.parse(readFileSync(join(directory, "before-cleanup.json"), "utf8"));
    const after = JSON.parse(readFileSync(join(directory, "after-cleanup.json"), "utf8"));
    expect(JSON.parse(readFileSync(join(directory, "public-before.json"), "utf8"))).toEqual(
      before.workerHarness,
    );
    expect(JSON.parse(readFileSync(join(directory, "public-after.json"), "utf8"))).toEqual(
      after.workerHarness,
    );
    expect(before.workerHarness).toMatchObject({
      admittedObservation: exec,
      startupFailureObservation: shim,
      startupState: "failed",
      cleanupProofs: [],
      cleanupSignals: [],
      cleanupFailure: null,
    });
    expect(before.workerHarness.failure.message).toContain("worker exec identity uncertain");
    expect(cleanup?.message).toContain("cleanup identity uncertain");
    expect(after.workerHarness).toMatchObject({
      admittedObservation: exec,
      startupFailureObservation: shim,
      cleanupProofs: [{ signal: "SIGTERM", observation: shim, authorized: false }],
      cleanupSignals: [],
      cleanupFailure: { message: expect.stringContaining("cleanup identity uncertain") },
      exitObserved: false,
    });
    expect(after.workerHarness.failure).toEqual(before.workerHarness.failure);
    preserve(directory, [
      "before-cleanup.json",
      "after-cleanup.json",
      "public-before.json",
      "public-after.json",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 5000);

test("orphan handoff receipt shape carries the same worker snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cove-qual-handoff-receipt-"));
  const exec = parse(`node ${linuxEntry}`);
  const { harness } = startupHarness(exec, [exec]);
  try {
    await startWorkerPipe(harness, hello);
    writeFileSync(
      join(directory, "launch.json"),
      JSON.stringify(composeWorkerReceipt(harness, { nonce: "handoff", workerPid: pid }), null, 2) +
        "\n",
    );
    const saved = JSON.parse(readFileSync(join(directory, "launch.json"), "utf8"));
    expect(saved).toMatchObject({
      nonce: "handoff",
      workerPid: pid,
      workerHarness: {
        admittedObservation: exec,
        startupState: "admitted",
        helloWrite: { attempted: true, status: "completed" },
        cleanupProofs: [],
      },
    });
    preserve(directory, ["launch.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cleanup authorizes only a fresh compiled entry at the captured birth", async () => {
  const compiledEntry = parse(`node ${linuxEntry}`);
  const shim = parse(`/bin/sh ${bin}`);
  const changed = { ...compiledEntry, started: "Mon Sep 28 18:16:49 2026" };
  const wrong = parse("node /tmp/other/main.js");
  for (const current of [shim, changed, wrong]) {
    const { harness } = startupHarness(shim, [current]);
    harness.provisionalBirth = { pid, started };
    const signals = [];
    let eof = 0;
    harness.child.kill = (signal) => signals.push(signal);
    harness.child.stdin = {
      destroyed: false,
      writableEnded: false,
      end: () => {
        eof++;
        harness.child.exitCode = 0;
      },
    };
    await stopVerified(harness);
    expect(signals).toEqual([]);
    expect(eof).toBe(1);
    expect(harness.cleanupProofs).toMatchObject([{ signal: "SIGTERM", authorized: false }]);
  }
  const { harness } = startupHarness(shim, [compiledEntry]);
  harness.provisionalBirth = { pid, started };
  const signals = [];
  harness.child.kill = (signal) => {
    signals.push(signal);
    harness.child.signalCode = signal;
  };
  await stopVerified(harness);
  expect(signals).toEqual(["SIGTERM"]);
  expect(harness.cleanupProofs).toMatchObject([{ signal: "SIGTERM", authorized: true }]);
});

test.each([
  ["shim", parse(`/bin/sh ${bin}`), ["SIGTERM"]],
  ["changed birth", { ...parse(`node ${linuxEntry}`), started: "changed" }, ["SIGTERM"]],
  ["wrong entry", parse("node /tmp/other/main.js"), ["SIGTERM"]],
  ["compiled", parse(`node ${linuxEntry}`), ["SIGTERM", "SIGKILL"]],
])(
  "cleanup escalation resamples %s before SIGKILL",
  async (_label, second, expectedSignals) => {
    const exec = parse(`node ${linuxEntry}`);
    const { harness } = startupHarness(exec, [exec, second]);
    harness.provisionalBirth = { pid, started };
    harness.admittedObservation = exec;
    const signals = [];
    let eof = 0;
    harness.child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") harness.child.signalCode = signal;
    };
    harness.child.stdin = {
      destroyed: false,
      writableEnded: false,
      end: () => {
        eof++;
        harness.child.exitCode = 0;
      },
    };
    await stopVerified(harness);
    expect(signals).toEqual(expectedSignals);
    expect(
      harness.cleanupProofs.map(({ signal, observation, authorized }) => ({
        signal,
        observation,
        authorized,
      })),
    ).toMatchObject([
      { signal: "SIGTERM", observation: exec, authorized: true },
      { signal: "SIGKILL", observation: second, authorized: expectedSignals.length === 2 },
    ]);
    expect(eof).toBe(expectedSignals.length === 2 ? 0 : 1);
  },
  15000,
);

test("pending startup reaches fixed deadline without hello or signal", async () => {
  const transient = {
    kind: "unverifiable",
    pid,
    started,
    commandLine: "(sh)",
    reason: "pre-exec-shell",
  };
  const { harness, sends } = startupHarness(transient, [{ kind: "absent", pid }]);
  await expect(startWorkerPipe(harness, hello, { deadlineMs: 80 })).rejects.toThrow(
    "worker startup admission deadline",
  );
  expect(harness.startupState).toBe("failed");
  expect(sends).toEqual([]);
});

test("late admission uses integer observer budgets and retains the fixed deadline", async () => {
  const shim = parse(`/bin/sh ${bin}`);
  const exec = parse(`node ${linuxEntry}`);
  const accepted = startupHarness(shim, [shim, exec, exec]);
  const budgets = [];
  const original = accepted.harness.observe;
  accepted.harness.observe = (...args) => {
    if (args[2] !== undefined) budgets.push(args[2]);
    return original(...args);
  };
  await startWorkerPipe(accepted.harness, hello, { deadlineMs: 180 });
  expect(accepted.sends).toEqual([hello]);
  expect(budgets.length).toBeGreaterThanOrEqual(2);
  expect(budgets.every((value) => Number.isInteger(value) && value > 0 && value <= 180)).toBe(true);
  expect(accepted.harness.startupSamples.at(-1)).toEqual(exec);

  const timedOut = startupHarness(shim, [shim]);
  const timeoutBudgets = [];
  timedOut.harness.observe = (_pid, _bin, timeout) => {
    timeoutBudgets.push(timeout);
    return shim;
  };
  await expect(startWorkerPipe(timedOut.harness, hello, { deadlineMs: 130 })).rejects.toThrow(
    "worker startup admission deadline",
  );
  expect(timedOut.sends).toEqual([]);
  expect(
    timeoutBudgets.every((value) => Number.isInteger(value) && value > 0 && value <= 130),
  ).toBe(true);
  const evidenceRoot = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  if (evidenceRoot)
    writeFileSync(
      join(evidenceRoot, `admission-budgets-${process.pid}.json`),
      JSON.stringify({ accepted: budgets, timedOut: timeoutBudgets }, null, 2) + "\n",
    );
});

test("real ps observation normalizes fractional timeout before execFileSync", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cove-qual-observer-budget-"));
  const entry = controlledBin(directory);
  const child = spawn(entry, [], { stdio: ["pipe", "ignore", "ignore"] });
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const errors = [];
  child.on("error", (error) => errors.push(error));
  let observed;
  try {
    observed = await until(
      () => {
        const row = observeWorkerProcess(child.pid, entry, {
          timeoutMs: 250.75,
          anchors: workerIdentityAnchors(entry, realpathSync, entry),
        });
        return row.kind === "owned" ? row : null;
      },
      2000,
      "owned fractional-budget observation",
    );
    expect(observed.form).toBe("compiled-entry");
    expect(() => observeWorkerProcess(child.pid, entry, { timeoutMs: 0.5 })).toThrow(
      "invalid worker observation timeout",
    );
    const evidenceRoot = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
    if (evidenceRoot)
      writeFileSync(
        join(evidenceRoot, `actual-observer-budget-${process.pid}.json`),
        JSON.stringify({ observed, requestedTimeout: 250.75, errors: errors.length }, null, 2) +
          "\n",
      );
  } finally {
    child.stdin.end();
    await until(() => child.exitCode !== null || child.signalCode !== null, 3000, "owned exit");
    await exit;
    rmSync(directory, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
  expect(observed).toMatchObject({ kind: "owned", pid: child.pid });
});

test("changed birth and wrong full entry cannot transition into acceptance", async () => {
  const transient = {
    kind: "unverifiable",
    pid,
    started,
    commandLine: "(sh)",
    reason: "pre-exec-shell",
  };
  const changed = { ...parse(`/bin/sh ${bin}`), started: "Mon Sep 28 18:16:49 2026" };
  const one = startupHarness(transient, [changed]);
  await expect(admitWorkerStartup(one.harness, { deadlineMs: 1000 })).rejects.toThrow(
    "worker birth changed",
  );
  expect(one.sends).toEqual([]);
  const wrong = {
    kind: "unverifiable",
    pid,
    started,
    commandLine: "node /wrong/main.js",
    reason: "unrelated-argv",
  };
  const two = startupHarness(parse(`/bin/sh ${bin}`), [wrong, parse(`node ${linuxEntry}`)]);
  await expect(startWorkerPipe(two.harness, hello, { deadlineMs: 1000 })).rejects.toThrow(
    "worker startup identity rejected",
  );
  expect(two.sampleCount()).toBe(1);
  expect(two.sends).toEqual([]);
});

test("observed child exit terminates pending admission before hello", async () => {
  const shim = parse(`/bin/sh ${bin}`);
  const one = startupHarness(shim, []);
  one.harness.observe = () => {
    one.harness.child.exitCode = 1;
    one.harness.child.emit("exit", 1, null);
    return { kind: "absent", pid };
  };
  await expect(startWorkerPipe(one.harness, hello, { deadlineMs: 1000 })).rejects.toThrow(
    "worker exited or errored",
  );
  expect(one.sends).toEqual([]);
});

test("a real shell wrapper reaches its exact Node entry before any hello", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cove-qual-wrapper-entry-"));
  const nonce = `wrapper-${process.pid}-${Date.now()}`;
  const wrapper = join(directory, "installed-wrapper");
  const entry = join(directory, "controlled-entry.mjs");
  writeFileSync(
    entry,
    'process.stdin.resume();\nprocess.stdin.once("end", () => process.exit(0));\n',
  );
  writeFileSync(wrapper, `#!/bin/sh\nread gate\nexec "${process.execPath}" "${entry}"\n`);
  chmodSync(wrapper, 0o700);
  let harness;
  let primary;
  const cleanupErrors = [];
  try {
    harness = childPipe(wrapper, nonce, { expectedEntry: entry, evidencePath: directory });
    const admission = admitWorkerStartup(harness);
    void admission.catch(() => {});
    await until(
      () => {
        if (harness.startupState === "failed") throw Error(harness.startupFailure.message);
        return harness.startupSamples?.some((sample) => sample.form === "installed-shim");
      },
      3000,
      "controlled wrapper shim observation",
    );
    harness.child.stdin.write("go\n");
    expect(await admission).toMatchObject({ kind: "owned", form: "compiled-entry" });
    expect(harness.firstObservation).toBeDefined();
    expect(harness.provisionalBirth).toMatchObject({ pid: harness.child.pid });
    expect(harness.frames).toEqual([]);
  } catch (error) {
    primary = error;
  } finally {
    try {
      if (harness) preserveWorkerHarness(harness, directory, "before-cleanup", primary);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (harness) await stopVerified(harness);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (harness) preserveWorkerHarness(harness, directory, "after-cleanup", primary);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      preserve(directory, ["acquired.json", "before-cleanup.json", "after-cleanup.json"]);
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanupErrors],
      "wrapper cleanup failed",
    );
  if (primary) throw primary;
  expect(await until(() => !psIdentity(harness.child.pid), 3000, "wrapper child exit")).toBe(true);
});

test.each([
  ["EOF exit", false],
  ["unresolved EOF", true],
])(
  "pending real shim cleanup preserves timeout and %s",
  async (_label, ignoreEof) => {
    const directory = mkdtempSync(join(tmpdir(), "cove-qual-pending-shim-"));
    const wrapper = join(directory, "installed-wrapper");
    const entry = join(directory, "controlled-entry.mjs");
    writeFileSync(entry, "setInterval(() => {}, 1000);\n");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif ! read gate; then ${ignoreEof ? `exec "${process.execPath}" "${entry}"` : "exit 0"}; fi\n`,
    );
    chmodSync(wrapper, 0o700);
    let harness;
    let primary;
    let cleanup;
    let outer;
    let outerError;
    const subjectSignals = [];
    try {
      harness = childPipe(wrapper, `pending-${process.pid}-${Date.now()}`, {
        expectedEntry: entry,
        evidencePath: directory,
      });
      harness.child.kill = (signal) => {
        subjectSignals.push(signal);
        throw Error("subject must not signal a pending shim");
      };
      try {
        await startWorkerPipe(harness, hello, { deadlineMs: 250 });
      } catch (error) {
        primary = error;
      }
      expect(primary?.message).toContain("worker startup admission deadline");
      expect(harness.startupState).toBe("failed");
      preserveWorkerHarness(harness, directory, "before-cleanup", primary);
      try {
        await stopVerified(harness);
      } catch (error) {
        cleanup = error;
      }
      preserveWorkerHarness(harness, directory, "after-cleanup", primary);
      expect(subjectSignals).toEqual([]);
      expect(harness.child.stdin.writableEnded).toBe(true);
      expect(harness.cleanupProofs).toMatchObject([
        { signal: "SIGTERM", observation: { form: "installed-shim" }, authorized: false },
      ]);
      expect(cleanup?.message?.includes("cleanup identity uncertain") === true).toBe(ignoreEof);
      expect(harness.cleanupFailure?.message?.includes("cleanup identity uncertain") === true).toBe(
        ignoreEof,
      );
      expect(Boolean(harness.exitObserved || harness.child.exitCode !== null)).toBe(!ignoreEof);
      const saved = JSON.parse(readFileSync(join(directory, "after-cleanup.json"), "utf8"));
      expect(saved.startupFailure.message).toContain("worker startup admission deadline");
      expect(saved.cleanupSignals).toEqual([]);
      expect(saved.cleanupFailure?.message?.includes("cleanup identity uncertain") === true).toBe(
        ignoreEof,
      );
    } finally {
      try {
        if (harness && !harness.exitObserved && harness.child.exitCode === null) {
          const fresh = harness.observe(harness.child.pid, wrapper);
          const birth = harness.provisionalBirth;
          const verified =
            birth &&
            sameOwnedWorker({ kind: "owned", ...birth }, fresh) &&
            fresh.form === "compiled-entry" &&
            fresh.canonical === realpathSync(entry);
          outer = { pid: harness.child.pid, birth, fresh, verified, signal: null };
          if (verified) {
            process.kill(harness.child.pid, "SIGTERM");
            outer.signal = "SIGTERM";
            await until(() => harness.exitObserved, 3000, "outer owned child exit");
          } else outerError = Error("outer cleanup identity uncertain");
        }
      } catch (error) {
        outerError = error;
      }
      if (harness) {
        writeFileSync(
          join(directory, "outer-cleanup.json"),
          JSON.stringify(outer ?? null, null, 2) + "\n",
        );
        preserveWorkerHarness(harness, directory, "final", primary);
        preserve(directory, [
          "acquired.json",
          "before-cleanup.json",
          "after-cleanup.json",
          "outer-cleanup.json",
          "final.json",
        ]);
      }
      const closed =
        !harness ||
        harness.exitObserved ||
        harness.child.exitCode !== null ||
        harness.child.signalCode !== null;
      if (!closed) outerError ??= Error("outer cleanup exit uncertain");
      if (closed) rmSync(directory, { recursive: true, force: true });
    }
    if (outerError)
      throw new AggregateError(
        [primary, cleanup, outerError].filter(Boolean),
        "outer cleanup failed",
      );
    expect(outer?.verified === true).toBe(ignoreEof);
    expect(outer?.signal === "SIGTERM").toBe(ignoreEof);
  },
  10000,
);

test("owned child survives validation throw as a retained handle and exits on EOF", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cove-qual-identity-"));
  const fakeBin = controlledBin(directory);
  let harness;
  try {
    let calls = 0;
    const observe = (childPid) => {
      calls += 1;
      return calls <= 2
        ? { kind: "owned", pid: childPid, started, form: "installed-shim", raw: "controlled" }
        : { kind: "unverifiable", pid: childPid, reason: "injected-validation-failure" };
    };
    harness = childPipe(fakeBin, "identity-failure", { observe, evidencePath: directory });
    expect(() => verifyWorkerIdentity(harness)).toThrow("worker identity uncertain");
    expect(harness.child.pid).toBeGreaterThan(0);
    expect(existsSync(join(directory, "acquired.json"))).toBe(true);
    await stopVerified(harness);
    expect(await harness.exit).toEqual({ code: 0, signal: null });
    expect(psIdentity(harness.child.pid)).toBe(null);
  } finally {
    preserve(directory, ["acquired.json"]);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("launcher pre-handoff identity failure preserves receipt and cleans its owned child", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cove-qual-launcher-failure-"));
  const fakeBin = controlledBin(directory);
  const nonce = `early-${process.pid}-${Date.now()}`;
  const launcher = spawn(
    process.execPath,
    [
      new URL("./fixtures/orphan-parent.mjs", import.meta.url).pathname,
      fakeBin,
      nonce,
      directory,
      "--inject-identity-failure",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const stderr = [];
  launcher.stderr.on("data", (bytes) => stderr.push(Buffer.from(bytes)));
  try {
    const exit = await Promise.race([
      new Promise((resolve) => launcher.once("exit", (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) => setTimeout(() => reject(Error("launcher deadline")), 8000)),
    ]);
    expect(exit).toEqual({ code: 1, signal: null });
    const failure = JSON.parse(readFileSync(join(directory, "launcher-failure.json"), "utf8"));
    expect(failure).toMatchObject({ nonce, workerPid: expect.any(Number), cleanupErrors: [] });
    expect(failure.error.message).toContain("worker startup identity rejected");
    expect(failure.ptyStart).toBe(null);
    expect(failure.workerHarnessReceiptRefs).toMatchObject({
      "launcher-before-cleanup": {
        file: "launcher-before-cleanup.json",
        stage: "launcher-before-cleanup",
        nonce,
        workerPid: failure.workerPid,
      },
      "launcher-after-cleanup": {
        file: "launcher-after-cleanup.json",
        stage: "launcher-after-cleanup",
        nonce,
        workerPid: failure.workerPid,
      },
    });
    expect(existsSync(join(directory, "launch.json"))).toBe(false);
    expect(existsSync(join(directory, "start.json"))).toBe(false);
    const before = JSON.parse(
      readFileSync(join(directory, "launcher-before-cleanup.json"), "utf8"),
    );
    const after = JSON.parse(readFileSync(join(directory, "launcher-after-cleanup.json"), "utf8"));
    expect(before).toMatchObject({
      nonce,
      pid: failure.workerPid,
      startupState: "failed",
      cleanupProofs: [],
    });
    expect(after).toMatchObject({
      nonce,
      pid: failure.workerPid,
      startupState: "failed",
      cleanupProofs: [{ signal: "SIGTERM", authorized: false }],
      exitCode: 0,
    });
    expect(await until(() => !psIdentity(failure.workerPid), 3000, "pre-handoff child exit")).toBe(
      true,
    );
    expect(stderr).toEqual([]);
  } finally {
    preserve(directory, [
      "acquired.json",
      "launcher-before-cleanup.json",
      "launcher-after-cleanup.json",
      "launcher-failure.json",
    ]);
    rmSync(directory, { recursive: true, force: true });
  }
});
