import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createNativePtyFactory } from "@cove/terminal-worker/native-adapter";
import { createRunSession } from "@cove/terminal-worker/execution";
import { expect, test } from "vitest";

const fixture = resolve(import.meta.dirname, "fixtures/native-adapter-child.mjs");

async function until(predicate, deadline) {
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out awaiting owned PTY output and exit");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

test("real PTY query reaches the bounded native writer before the ordered exit", async () => {
  const nonce = randomUUID();
  const factory = createNativePtyFactory({
    maxOwners: 1,
    aggregateInputBytes: 64 * 1024,
    aggregateInputTasks: 4,
    perPtyInputBytes: 64 * 1024,
    perPtyInputTasks: 4,
    earlyOutputBytes: 4 * 1024,
  });
  const facts = [];
  const faults = [];
  const result = createRunSession({
    run: { serverId: "server", relayInstanceId: "relay", runId: nonce },
    geometry: { cols: 40, rows: 8 },
    spawn: {
      file: process.execPath,
      args: [fixture, "engine-query", nonce],
      cwd: process.cwd(),
      env: process.env,
    },
    factory,
    onFact: (fact) => facts.push(fact),
    onFault: (fault) => faults.push(fault),
  });
  expect(result.kind).toBe("created");
  const deadline = Date.now() + 10_000;
  try {
    await until(
      () => result.session.snapshot().exited && result.session.snapshot().parsedSeq > 0,
      deadline,
    );
    expect((await result.session.barrier()).ok).toBe(true);
    const output = Buffer.concat(facts.flatMap(({ bytes }) => (bytes ? [bytes] : []))).toString();
    expect(output).toContain(`ANSWER:1b5b306e:${nonce}`);
    expect(facts.at(-1).event.type).toBe("exit");
    expect(faults).toEqual([]);
  } finally {
    const settled = await result.session.dispose();
    expect(settled?.kind).toBe("exited");
    expect(factory.snapshot().owners).toBe(0);
  }
});
