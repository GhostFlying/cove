import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installedBin, psIdentity, until } from "./pipe-harness.mjs";

const DEADLINE_MS = 8_000;
const markerEntry = new URL("./fixtures/native-spawn-marker.mjs", import.meta.url).pathname;

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`timeout: ${label}`)), DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function record(root, name, value) {
  const evidence = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    join(evidence, `${name}-${root.nonce}.json`),
    JSON.stringify(value, null, 2) + "\n",
  );
}

function ownerFacts(factory) {
  const state = factory.snapshot();
  return {
    owners: state.owners,
    provisionalOwners: state.provisionalOwners,
    rollbackPendingOwners: state.rollbackPendingOwners,
    activeOwners: state.activeOwners,
    tombstones: state.tombstones,
    inputBytes: state.aggregateInput.allocatedBytes,
    inputTasks: state.aggregateInput.tasks,
  };
}

function clean(factory) {
  return Object.values(ownerFacts(factory)).every((value) => value === 0);
}

function spawnObserved(factory, spec) {
  const observation = { chunks: [], faults: [], exits: [] };
  const result = factory.spawn(spec, {
    onData: (bytes) => observation.chunks.push(Buffer.from(bytes).toString("hex")),
    onFault: (fault) => observation.faults.push(fault),
    onExit: (exit) => observation.exits.push(exit),
  });
  return { result, observation };
}

async function closeCreated(pty, observation) {
  let stop;
  if (!observation.exits.length) {
    try {
      await until(() => observation.exits.length === 1, DEADLINE_MS, "native target exit");
    } catch {
      stop = await bounded(pty.stop(), "native target stop");
    }
  }
  const writer = await bounded(pty.writerCompletion, "native writer completion");
  return { stop, writer, pid: pty.pid, identityAfter: psIdentity(pty.pid) };
}

async function verifyInvalidOutcome(owned) {
  const result = owned.result;
  if (result.kind === "failed") {
    const receipt = await bounded(result.cleanup, "typed spawn rollback");
    if (receipt.kind !== "confirmed-clean")
      throw Error(`native rollback unverified: ${receipt.kind}`);
    return { cause: String(result.cause), cleanup: receipt };
  }
  expect(result.kind).toBe("created");
  if (result.kind !== "created") throw Error(`unexpected invalid spawn result: ${result.kind}`);
  const closed = await closeCreated(result.pty, owned.observation);
  expect(owned.observation.exits).toHaveLength(1);
  expect(owned.observation.exits[0]).toMatchObject({ exitCode: 1 });
  expect(closed.writer.kind).toBe("closed");
  expect(closed.identityAfter).toBeNull();
  return closed;
}

async function verifyControlOutcome(owned, marker, nonce, factory) {
  expect(owned.result.kind).toBe("created");
  if (owned.result.kind !== "created") throw Error(`control spawn result: ${owned.result.kind}`);
  await until(() => existsSync(marker), DEADLINE_MS, "valid control marker");
  const receipt = JSON.parse(readFileSync(marker, "utf8"));
  expect(receipt).toMatchObject({ nonce, pid: owned.result.pty.pid });
  const closed = await closeCreated(owned.result.pty, owned.observation);
  expect(owned.observation.exits).toHaveLength(1);
  expect(owned.observation.exits[0]).toMatchObject({ exitCode: 0 });
  expect(closed.writer.kind).toBe("closed");
  expect(closed.identityAfter).toBeNull();
  await until(() => clean(factory), DEADLINE_MS, "control owner release");
  return closed;
}

for (const mode of ["missing-executable", "missing-cwd"]) {
  test(`public native factory accounts for ${mode} and reuses its slot`, async () => {
    const delivery = installedBin();
    const publicFile = join(delivery.consumerRoot, `spawn-failure-${mode}.mjs`);
    writeFileSync(
      publicFile,
      'export { createNativePtyFactory } from "@cove/terminal-worker/native-adapter";\n',
    );
    const { createNativePtyFactory } = await import(pathToFileURL(publicFile).href);
    const temp = mkdtempSync(join(tmpdir(), "cove-spawn-failure-"));
    const root = { nonce: randomUUID(), mode };
    const marker = join(temp, "invalid-child-start.json");
    const controlMarker = join(temp, "control-start.json");
    const nonexistent = join(temp, "not-present");
    const factory = createNativePtyFactory({
      maxOwners: 1,
      aggregateInputBytes: 64 * 1024,
      aggregateInputTasks: 8,
      perPtyInputBytes: 64 * 1024,
      perPtyInputTasks: 4,
      earlyOutputBytes: 4 * 1024,
    });
    const base = {
      args: [markerEntry, root.nonce, marker],
      env: process.env,
      cols: 80,
      rows: 24,
      inputBytes: 4096,
      inputTasks: 2,
    };
    const invalidSpec = {
      ...base,
      file: mode === "missing-executable" ? nonexistent : process.execPath,
      cwd: mode === "missing-cwd" ? nonexistent : temp,
    };
    let invalid;
    let invalidClosure;
    let control;
    let controlClosure;
    let primary;
    const cleanupErrors = [];
    try {
      invalid = spawnObserved(factory, invalidSpec);
      invalidClosure = await verifyInvalidOutcome(invalid);
      expect(existsSync(marker)).toBe(false);
      await until(() => clean(factory), DEADLINE_MS, "native owner release");
      expect(ownerFacts(factory)).toEqual({
        owners: 0,
        provisionalOwners: 0,
        rollbackPendingOwners: 0,
        activeOwners: 0,
        tombstones: 0,
        inputBytes: 0,
        inputTasks: 0,
      });
      control = spawnObserved(factory, {
        ...base,
        file: process.execPath,
        args: [markerEntry, `${root.nonce}-control`, controlMarker],
        cwd: temp,
      });
      controlClosure = await verifyControlOutcome(
        control,
        controlMarker,
        `${root.nonce}-control`,
        factory,
      );
    } catch (error) {
      primary = error;
    } finally {
      for (const owned of [invalid, control]) {
        if (owned?.result.kind !== "created" || owned.observation.exits.length) continue;
        try {
          await bounded(owned.result.pty.stop(), "finally owned stop");
          await bounded(owned.result.pty.writerCompletion, "finally writer completion");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      record(root, mode, {
        invalid: invalid && { kind: invalid.result.kind, observation: invalid.observation },
        invalidClosure,
        control: control && { kind: control.result.kind, observation: control.observation },
        controlClosure,
        markerExists: existsSync(marker),
        finalAccounting: ownerFacts(factory),
        primary: primary && { name: primary.name, message: primary.message },
        cleanupErrors: cleanupErrors.map((error) => error.message),
      });
      delivery.cleanup();
      if (!cleanupErrors.length && !primary) rmSync(temp, { recursive: true, force: true });
    }
    if (cleanupErrors.length)
      throw new AggregateError([...(primary ? [primary] : []), ...cleanupErrors]);
    if (primary) throw primary;
  });
}
