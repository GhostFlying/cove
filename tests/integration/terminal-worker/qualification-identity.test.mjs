import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  childPipe,
  parseWorkerProcessRow,
  psIdentity,
  repo,
  sameOwnedWorker,
  stopVerified,
  until,
  verifyWorkerIdentity,
} from "./pipe-harness.mjs";

const pid = 11060;
const started = "Mon Sep 28 18:16:48 2026";
const bin = "/tmp/cove-qual-bin-example/node_modules/.bin/cove-terminal-worker";
const compiled = "/home/runner/work/cove/cove/packages/terminal-worker/dist/src/main.js";
const resolver = (path) =>
  path.endsWith("/packages/terminal-worker/dist/src/main.js") ? compiled : path;
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

test("structured worker identity accepts one owned shim-to-compiled exec and rejects ambiguity", () => {
  const shim = parse(`/bin/sh ${bin}`);
  const linux = parse(
    `node ${dirname(bin)}/../../../../home/runner/work/cove/cove/packages/terminal-worker/dist/src/main.js`,
  );
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
    expect(failure.error.message).toContain("worker identity uncertain");
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
