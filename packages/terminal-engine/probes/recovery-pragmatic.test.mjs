import { createRequire } from "node:module";
import { afterAll, expect, test } from "vitest";
import {
  BoundedRecoveryTail,
  createLogicalGridCheckpoint,
  observeLogicalGrid,
  observeRecovery,
  writeParsed,
} from "@cove/terminal-engine/probes/recovery-boundaries";
import { writeRecoverySuiteEvidence } from "../../../tests/fixtures/terminal/engine/recovery-evidence.mjs";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");
const bytes = (value) => new TextEncoder().encode(value);
const completed = [];

afterAll(() =>
  writeRecoverySuiteEvidence("recovery-pragmatic", completed, 3, {
    contract: "pragmatic-logical-grid-v1",
    classification: "required",
    outcome: "pass",
  }),
);

async function run(caseId, setup, tail, continuation) {
  const options = { cols: 12, rows: 4, scrollback: 10, allowProposedApi: true };
  const source = new Terminal(options);
  const receiver = new Terminal(options);
  const sourceReplies = [];
  const receiverReplies = [];
  const sourceListener = source.onData((reply) => sourceReplies.push(reply));
  const receiverListener = receiver.onData((reply) => receiverReplies.push(reply));
  try {
    await writeParsed(source, bytes(setup));
    const before = observeRecovery(source);
    const checkpoint = createLogicalGridCheckpoint(source, bytes(setup).length);
    expect(observeRecovery(source)).toEqual(before);
    expect(sourceReplies).toEqual([]);
    const rawTail = new BoundedRecoveryTail();
    rawTail.append(bytes(tail));
    await writeParsed(source, bytes(tail));
    await writeParsed(receiver, checkpoint.vt);
    await writeParsed(receiver, rawTail.snapshot());
    expect(observeLogicalGrid(receiver)).toEqual(observeLogicalGrid(source));
    await writeParsed(source, bytes(continuation));
    await writeParsed(receiver, bytes(continuation));
    expect(observeLogicalGrid(receiver)).toEqual(observeLogicalGrid(source));
    expect(receiverReplies).toEqual(sourceReplies);
    completed.push(caseId);
    return { source, receiver, sourceReplies };
  } finally {
    sourceListener.dispose();
    receiverListener.dispose();
    source.dispose();
    receiver.dispose();
  }
}

test("pragmatic normal saved position and current pen continue", async () => {
  await run(
    "normal-saved-position-pen",
    "\u001b[2;3H\u001b[31m\u001b7\u001b[4;9H\u001b[34m",
    "",
    "C\u001b8S\u001b[4;9HX",
  );
});

test("pragmatic alternate baseline preserves hidden normal on exit", async () => {
  await run(
    "alternate-normal-exit",
    "normal\u001b[2;3H\u001b7\u001b[?47hALT\u001b[32m",
    "",
    "Z\u001b[?47l\u001b8Q",
  );
});

test("pragmatic split query tail replies only through the live source sink", async () => {
  await run("split-query-tail", "ready", "\u001b[?6", "n");
});
