import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  childPipe,
  fixture,
  hello,
  psIdentity,
  receipt,
  repo,
  run,
  spawnCommand,
  workerExecIdentity,
} from "../pipe-harness.mjs";

const [bin, nonce, directory] = process.argv.slice(2);
if (!bin || !nonce || !directory) process.exit(64);
let h;
try {
  h = childPipe(bin, nonce);
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
  const start = await receipt(join(directory, "start.json"), "orphan child receipt");
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
  writeFileSync(
    join(directory, "launcher-failure.json"),
    JSON.stringify(
      {
        nonce,
        parentPid: process.pid,
        workerPid: h?.child.pid ?? null,
        workerInitialIdentity: h?.identity ?? null,
        error: { name: error.name, message: error.message, stack: error.stack },
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(1);
}
