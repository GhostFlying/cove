import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const nonce = process.argv[2];
assert.match(nonce, /^[0-9a-f-]{36}$/);
const fixture = resolve(import.meta.dirname, "native-write-child.mjs");
const packageRoot = resolve(require.resolve("node-pty"), "../..");
const helper = resolve(packageRoot, "build/Release/spawn-helper");
const executable = process.execPath;
const environment = Object.entries(process.env).map(([key, value]) => `${key}=${value}`);
const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
const descriptorCount = () => readdirSync(descriptorDirectory).length;
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function ownedChildren(phase) {
  const inspected = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(inspected.status, 0, String(inspected.error ?? inspected.stderr));
  return inspected.stdout
    .split("\n")
    .filter((line) => line.includes(fixture) && line.includes(`${nonce}-${phase}`))
    .map((line) => Number.parseInt(line.trim(), 10));
}

function stopVerified(pid, phase) {
  const inspected = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (inspected.status !== 0) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    throw new Error(`owned fault child ${pid} identity unverifiable`);
  }
  if (!inspected.stdout.includes(fixture) || !inspected.stdout.includes(`${nonce}-${phase}`)) {
    throw new Error(`owned fault child ${pid} identity changed`);
  }
  process.kill(pid, "SIGKILL");
}

async function runFault(phase) {
  const baseline = descriptorCount();
  let nativeExitCallbacks = 0;
  let exitCallbacks = 0;
  let resolveObservedExit;
  const observedExit = new Promise((resolveObservation) => {
    resolveObservedExit = resolveObservation;
  });
  let returned;
  try {
    assert.throws(
      () => {
        returned = pty.native.fork(
          executable,
          [fixture, `${nonce}-${phase}`],
          environment,
          process.cwd(),
          80,
          24,
          -1,
          -1,
          true,
          helper,
          () => {
            nativeExitCallbacks++;
            const observe = () => {
              exitCallbacks++;
              resolveObservedExit();
            };
            // Delay only the fixture's observation to expose fixed-sleep oracles.
            if (phase === "after-watcher") setTimeout(observe, 175);
            else observe();
          },
          true,
          phase,
        );
      },
      phase === "duplicate"
        ? /Could not duplicate bounded writer fd/
        : new RegExp(`Injected failure ${phase.replace("-", " owned ")}`),
    );
    if (phase === "after-watcher") {
      let callbackWatchdog;
      try {
        await Promise.race([
          observedExit,
          new Promise((_, reject) => {
            callbackWatchdog = setTimeout(
              () =>
                reject(
                  new Error(
                    `after-watcher exit callback not observed within 3000 ms (native=${nativeExitCallbacks})`,
                  ),
                ),
              3_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(callbackWatchdog);
      }
    }
    await sleep(100);
    assert.equal(descriptorCount(), baseline, `${phase} retained a parent descriptor`);
    assert.deepEqual(ownedChildren(phase), [], `${phase} retained an owned child`);
    assert.equal(nativeExitCallbacks, phase === "after-watcher" ? 1 : 0);
    assert.equal(exitCallbacks, nativeExitCallbacks);
  } finally {
    if (returned) {
      returned.stopOwnedChild(9);
      closeSync(returned.writeFd);
      closeSync(returned.fd);
    }
    for (const pid of ownedChildren(phase)) stopVerified(pid, phase);
  }
}

const warm = pty.spawn(process.platform === "darwin" ? "/usr/bin/true" : "/bin/true", [], {
  encoding: null,
  boundedWrite: { maxAllocatedBytes: 1, maxTasks: 1 },
});
await new Promise((done) => warm.onExit(done));
warm.destroy();
assert.deepEqual(await warm.boundedWriteCompletion, { kind: "closed" });
await sleep(100);

const invalidArgs = [
  executable,
  [fixture, `${nonce}-invalid`],
  environment,
  process.cwd(),
  80,
  24,
  -1,
  -1,
  true,
  helper,
  () => {},
];
const admissionBaseline = descriptorCount();
assert.throws(
  () => pty.native.fork(...invalidArgs, false, "duplicate"),
  /Native fault requires bounded writer/,
);
assert.throws(
  () => pty.native.fork(...invalidArgs, true, "unlisted"),
  /Unknown bounded writer test fault/,
);
assert.equal(descriptorCount(), admissionBaseline);
assert.deepEqual(ownedChildren("invalid"), []);

for (const phase of ["duplicate", "before-watcher", "after-watcher"]) {
  await runFault(phase);
}
process.stdout.write(`${JSON.stringify({ platform: process.platform, phases: 3 })}\n`);
