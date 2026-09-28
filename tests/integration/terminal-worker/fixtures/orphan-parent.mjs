import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  childPipe,
  fixture,
  hello,
  psIdentity,
  preserveWorkerHarness,
  receipt,
  repo,
  run,
  spawnCommand,
  stopPtyIfOwned,
  stopVerified,
  verifyWorkerIdentity,
  workerExecIdentity,
} from "../pipe-harness.mjs";

const [bin, nonce, directory, probe] = process.argv.slice(2);
if (!bin || !nonce || !directory) process.exit(64);
let h;
let start;
try {
  h = childPipe(bin, nonce, {
    evidencePath: directory,
    ...(probe === "--inject-identity-failure"
      ? { observe: (pid) => ({ kind: "unverifiable", pid, reason: "injected-before-handoff" }) }
      : {}),
  });
  verifyWorkerIdentity(h);
  h.send(hello);
  await h.wait((metadata) => metadata.type === "ready", "orphan ready");
  const execIdentity = workerExecIdentity(h);
  const target = run("orphan");
  const spawn = spawnCommand(target, process.execPath, [fixture, "hold", nonce, directory], repo);
  h.send(spawn.metadata, spawn.payload);
  const reply = await h.wait(
    (metadata) => metadata.requestId === spawn.metadata.requestId,
    "orphan spawn",
  );
  if (reply.metadata.outcome !== "accepted")
    throw Error(`orphan spawn: ${JSON.stringify(reply.metadata)}`);
  start = await receipt(join(directory, "start.json"), "orphan child receipt");
  if (start.nonce !== nonce || !psIdentity(start.pid)?.includes(nonce))
    throw Error("orphan child identity unverified");
  writeFileSync(
    join(directory, "launch.json"),
    JSON.stringify(
      {
        nonce,
        parentPid: process.pid,
        workerPid: h.child.pid,
        workerInitialIdentity: h.identity,
        workerExecIdentity: execIdentity,
        ptyStart: start,
        ptyIdentity: psIdentity(start.pid),
        responses: h.frames.map(({ metadata }) => metadata),
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
} catch (error) {
  const cleanupErrors = [];
  try {
    if (h) preserveWorkerHarness(h, directory, "launcher-before-cleanup", error);
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  try {
    if (h) await stopVerified(h);
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  try {
    await stopPtyIfOwned(start, nonce);
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  try {
    if (h) preserveWorkerHarness(h, directory, "launcher-after-cleanup", error);
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  writeFileSync(
    join(directory, "launcher-failure.json"),
    JSON.stringify(
      {
        nonce,
        parentPid: process.pid,
        workerPid: h?.child.pid ?? null,
        workerInitialIdentity: h?.identity ?? null,
        workerInitialObservation: h?.initialObservation ?? null,
        workerCurrentObservation: h?.child.pid ? h.observe(h.child.pid, h.bin) : null,
        workerExitCode: h?.child.exitCode ?? null,
        workerSignalCode: h?.child.signalCode ?? null,
        ptyStart: start ?? null,
        error: { name: error.name, message: error.message, stack: error.stack },
        cleanupErrors: cleanupErrors.map((item) => ({ name: item.name, message: item.message })),
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(1);
}
