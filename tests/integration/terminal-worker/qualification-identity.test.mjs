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
import {
  childPipe,
  admitWorkerStartup,
  hello,
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
    send: (frame) => sends.push(frame),
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
  const transient = {
    kind: "unverifiable",
    pid,
    started,
    commandLine: "(sh)",
    reason: "pre-exec-shell",
    raw: `${pid} ${started} (sh)`,
  };
  const shim = parse(`/bin/sh ${bin}`);
  const exec = parse(`node ${linuxEntry}`);
  const { harness, sends } = startupHarness(transient, [shim, exec, exec]);
  const pending = startWorkerPipe(harness, hello, { deadlineMs: 1000 });
  expect(sends).toEqual([]);
  await pending;
  expect(harness.provisionalBirth).toEqual({ pid, started });
  expect(harness.firstObservation).toEqual(transient);
  expect(harness.admittedObservation).toEqual(exec);
  expect(harness.startupSamples.map((sample) => sample.commandLine)).toEqual([
    "(sh)",
    shim.commandLine,
    exec.commandLine,
  ]);
  expect(sends).toEqual([hello]);
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
    expect(existsSync(join(directory, "launch.json"))).toBe(false);
    expect(existsSync(join(directory, "start.json"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(directory, "launcher-after-cleanup.json"), "utf8")).exitCode,
    ).toBe(0);
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
