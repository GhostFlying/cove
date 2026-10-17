import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { composeSpawnPayload } from "@cove/protocol/pipe";
import { DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { createWorkerExecution } from "@cove/terminal-worker/execution";

// #120: a real PTY started by the worker sees exactly the Cove identity its spawn carried, over
// the worker's inherited environment. The command prints only this test's own fixture variables,
// so nothing of a real terminal or of the developer's environment is asserted on.

const worker = {
  serverId: "server",
  relayInstanceId: "relay",
  workerId: "worker",
  workerIncarnationId: "one",
};
const encode = (text) => new TextEncoder().encode(text);
const PRINT =
  'printf "<%s|%s|%s>" "${COVE_TASK_ID-unset}" "${COVE_TAB_ID-unset}" "${COVE_FIXTURE_MARK-unset}"';

// Spawns `/bin/sh -c PRINT` on a worker whose inherited environment is `inherited`, with the
// spawn env `env` (omitted when undefined), and returns the PTY output once the run exited.
async function printedEnvironment(inherited, env) {
  const facts = [];
  const execution = createWorkerExecution({
    worker,
    effectiveBudgets: M0_LIMITS,
    env: inherited,
    onFact: (fact) => facts.push(fact),
  });
  try {
    const composed = composeSpawnPayload(
      { executable: "/bin/sh", argv: ["-c", PRINT], cwd: "/", ...(env && { env }) },
      encode,
    );
    expect(composed).not.toBeNull();
    const result = await execution.execute(
      {
        type: "spawn",
        worker,
        run: { serverId: "server", relayInstanceId: "relay", runId: "run-1" },
        requestId: "spawn-1",
        operationId: "op-1",
        geometry: { cols: 80, rows: 4 },
        profile: PROFILE,
        appearance: DEFAULT_APPEARANCE,
        effectiveBudgets: M0_LIMITS,
        spawnPayloadBytes: composed.bytes.length,
      },
      composed.bytes,
    );
    expect(result).toMatchObject({ type: "result", commandType: "spawn", outcome: "accepted" });
    const deadline = Date.now() + 10_000;
    while (!facts.some((fact) => fact.event.type === "exit")) {
      if (Date.now() >= deadline) throw new Error("Timed out awaiting the run's exit");
      await new Promise((settle) => setTimeout(settle, 10));
    }
    return Buffer.concat(facts.flatMap(({ bytes }) => (bytes ? [bytes] : []))).toString();
  } finally {
    await execution.shutdown("test");
  }
}

test("a real PTY sees the spawn identity over the inherited environment and never a stale one", async () => {
  const nonce = randomUUID();
  // The worker inherited an identity of some other tab (a server started inside a Cove tab).
  const inherited = {
    PATH: process.env.PATH,
    COVE_FIXTURE_MARK: `mark-${nonce}`,
    COVE_TASK_ID: `stale-task-${nonce}`,
    COVE_TAB_ID: `stale-tab-${nonce}`,
  };
  const identity = { COVE_TASK_ID: `task-${nonce}`, COVE_TAB_ID: `tab-${nonce}` };
  // A tab's run: both identity keys are this spawn's; the rest of the environment is inherited.
  expect(await printedEnvironment(inherited, identity)).toContain(
    `<task-${nonce}|tab-${nonce}|mark-${nonce}>`,
  );
  // A key the spawn does not set is removed rather than inherited.
  expect(await printedEnvironment(inherited, { COVE_TASK_ID: `task-${nonce}` })).toContain(
    `<task-${nonce}|unset|mark-${nonce}>`,
  );
  // A run that belongs to no tab (terminal.create) carries no identity at all.
  expect(await printedEnvironment(inherited, undefined)).toContain(`<unset|unset|mark-${nonce}>`);
});

test("a spawn payload with an environment key outside the identity is refused and starts nothing", async () => {
  const execution = createWorkerExecution({ worker, effectiveBudgets: M0_LIMITS });
  try {
    // Written by hand, as no conforming sender can compose it.
    const forged = encode(
      JSON.stringify({
        executable: "/bin/sh",
        argv: ["-c", "exit 0"],
        cwd: "/",
        env: { COVE_TASK_ID: "task-fixture", LD_PRELOAD: "/tmp/fixture.so" },
      }),
    );
    const result = await execution.execute(
      {
        type: "spawn",
        worker,
        run: { serverId: "server", relayInstanceId: "relay", runId: "run-1" },
        requestId: "spawn-1",
        operationId: "op-1",
        geometry: { cols: 80, rows: 4 },
        profile: PROFILE,
        appearance: DEFAULT_APPEARANCE,
        effectiveBudgets: M0_LIMITS,
        spawnPayloadBytes: forged.length,
      },
      forged,
    );
    expect(result).toMatchObject({
      type: "error",
      error: { kind: "INPUT_REJECTED", acceptance: "not-accepted" },
    });
    expect(execution.snapshot()).toMatchObject({ runIds: 0, runs: [], sessions: [] });
  } finally {
    await execution.shutdown("test");
  }
});
