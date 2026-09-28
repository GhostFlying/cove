import { expect, test } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observeFifoReader,
  parseFifoReaderRow,
  waitFifoReaderHandshake,
  withOwnedFifoReader,
} from "./fifo-reader-ownership.mjs";
import { psIdentity, until } from "./pipe-harness.mjs";

const entry = new URL("./fixtures/reader-hold.mjs", import.meta.url).pathname;

async function controlledCase(label, setup, observe) {
  const directory = mkdtempSync(join(tmpdir(), `cove-reader-${label}-`));
  const nonce = `${label}-${process.pid}-${Date.now()}`;
  const saved = [];
  let owner;
  let resourceCleanup = 0;
  let failure;
  try {
    await withOwnedFifoReader({
      entry,
      args: [nonce],
      nonce,
      observe,
      setup: async (acquired) => {
        owner = acquired;
        return setup(acquired);
      },
      cleanupResources: async () => {
        resourceCleanup += 1;
      },
      preserve: (stage, context) => {
        const record = {
          stage,
          nonce,
          pid: context.owner?.child.pid ?? null,
          first: context.owner?.firstObservation ?? null,
          initial: context.owner?.initialObservation ?? null,
          fresh: context.owner?.cleanupObservation ?? null,
          verdict: context.owner?.cleanupVerdict ?? null,
          primary: context.primary && {
            name: context.primary.name,
            message: context.primary.message,
          },
          cleanupErrors: context.cleanupErrors.map((error) => error.message),
        };
        const name = `${stage}.json`;
        writeFileSync(join(directory, name), JSON.stringify(record, null, 2) + "\n");
        saved.push(name);
      },
    });
  } catch (error) {
    failure = error;
  }
  return {
    directory,
    nonce,
    owner,
    failure,
    resourceCleanup,
    saved,
    cleanup() {
      const evidenceRoot = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
      if (evidenceRoot) {
        const target = join(evidenceRoot, nonce);
        mkdirSync(target, { recursive: true });
        for (const name of saved)
          if (existsSync(join(directory, name)))
            copyFileSync(join(directory, name), join(target, name));
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("missing reader handshake retains timeout and closes the acquired PID", async () => {
  const result = await controlledCase("handshake-timeout", (owner) =>
    waitFifoReaderHandshake(owner, 100),
  );
  try {
    expect(result.failure.message).toContain("FIFO reader open timeout");
    expect(result.owner.initialObservation).toMatchObject({
      kind: "owned",
      pid: result.owner.child.pid,
    });
    expect(
      parseFifoReaderRow(result.owner.initialObservation.raw, {
        ...result.owner,
        args: ["wrong-nonce"],
      }).kind,
    ).toBe("unverifiable");
    expect(result.owner.cleanupVerdict).toMatchObject({ kind: "exited", signalSent: true });
    expect(await result.owner.exit).toMatchObject({ signal: "SIGTERM" });
    expect(await until(() => !psIdentity(result.owner.child.pid), 3000, "reader exit")).toBe(true);
    expect(result.resourceCleanup).toBe(1);
    expect(result.saved).toEqual(["before-cleanup.json", "after-cleanup.json"]);
    const before = JSON.parse(readFileSync(join(result.directory, "before-cleanup.json"), "utf8"));
    const after = JSON.parse(readFileSync(join(result.directory, "after-cleanup.json"), "utf8"));
    expect(before.primary.message).toContain("FIFO reader open timeout");
    expect(after.verdict).toMatchObject({ kind: "exited", signalSent: true });
  } finally {
    result.cleanup();
  }
});

test("post-acquisition setup throw retains primary cause and closes the reader", async () => {
  const result = await controlledCase("setup-throw", () => {
    throw Error("injected writer construction failure");
  });
  try {
    expect(result.failure.message).toBe("injected writer construction failure");
    expect(result.owner.cleanupVerdict).toMatchObject({ kind: "exited", signalSent: true });
    expect(await result.owner.exit).toMatchObject({ signal: "SIGTERM" });
    expect(await until(() => !psIdentity(result.owner.child.pid), 3000, "reader exit")).toBe(true);
    expect(result.resourceCleanup).toBe(1);
    const before = JSON.parse(readFileSync(join(result.directory, "before-cleanup.json"), "utf8"));
    expect(before.primary.message).toBe("injected writer construction failure");
  } finally {
    result.cleanup();
  }
});

test("changed reader birth causes zero subject signals and an uncertain cleanup verdict", async () => {
  let drift = false;
  const signals = [];
  const observe = (owner) => {
    const current = observeFifoReader(owner);
    return drift && current.kind === "owned"
      ? { ...current, started: "Mon Sep 28 18:16:49 2026" }
      : current;
  };
  const result = await controlledCase(
    "identity-drift",
    (owner) => {
      const originalKill = owner.child.kill.bind(owner.child);
      owner.child.kill = (signal) => {
        signals.push(signal);
        return originalKill(signal);
      };
      drift = true;
      throw Error("injected setup failure");
    },
    observe,
  );
  try {
    expect(result.failure).toBeInstanceOf(AggregateError);
    expect(result.failure.errors[0].message).toBe("injected setup failure");
    expect(result.owner.cleanupVerdict).toMatchObject({ kind: "unverifiable", signalSent: false });
    expect(signals).toEqual([]);
    expect(result.owner.child.signalCode).toBe(null);
    expect(result.resourceCleanup).toBe(1);
    const after = JSON.parse(readFileSync(join(result.directory, "after-cleanup.json"), "utf8"));
    expect(after.primary.message).toBe("injected setup failure");
    expect(after.cleanupErrors).toContain("FIFO reader cleanup identity uncertain");
    const independentlyObserved = observeFifoReader(result.owner);
    expect(independentlyObserved).toMatchObject({
      kind: "owned",
      pid: result.owner.initialObservation.pid,
      started: result.owner.initialObservation.started,
    });
    expect(result.owner.child.kill("SIGTERM")).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
    await until(
      () => result.owner.child.signalCode === "SIGTERM",
      3000,
      "independent reader cleanup",
    );
    expect(await result.owner.exit).toMatchObject({ signal: "SIGTERM" });
    expect(await until(() => !psIdentity(result.owner.child.pid), 3000, "reader exit")).toBe(true);
  } finally {
    const actual = observeFifoReader(result.owner);
    if (actual.kind === "owned" && actual.started === result.owner.initialObservation.started) {
      result.owner.child.kill("SIGTERM");
      await until(() => !psIdentity(result.owner.child.pid), 3000, "outer owned release");
    }
    result.cleanup();
  }
});
