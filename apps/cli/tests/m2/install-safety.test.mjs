import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createM1Fixture } from "../m1/fixtures.mjs";
import { installLayout } from "../../dist/install/layout.js";

// m2 T3 safety of the installation commands, against the compiled CLI and modules, without a
// service manager or a runtime closure (S1 and S2 cover those):
// - the install lock is an OS lock: of contenders for a lock whose holder was killed, exactly
//   one wins.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

const contender = join(import.meta.dirname, "install-lock-contender.mjs");

function contend(home, holdMs) {
  const child = spawn(process.execPath, [contender, home, String(holdMs)], {
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal, out: out.trim(), err })),
  );
  const said = (word) =>
    new Promise((done, fail) => {
      const check = () => out.includes(word) && done();
      child.stdout.on("data", check);
      child.once("exit", () =>
        out.includes(word) ? done() : fail(new Error(`no ${word}: ${err}`)),
      );
      check();
    });
  return { child, exited, said };
}

test("of the contenders for an install lock whose holder was killed, exactly one acquires it", async () => {
  const home = fixture.home("locked");
  await mkdir(home, { recursive: true });
  const lock = installLayout(home).lock;

  const holder = contend(home, 600_000);
  await holder.said("acquired");
  expect((await contend(home, 0).exited).out).toBe("refused");

  // The holder dies without releasing anything; its lock file stays behind.
  holder.child.kill("SIGKILL");
  expect((await holder.exited).signal).toBe("SIGKILL");
  expect(existsSync(lock)).toBe(true);

  for (let round = 0; round < 5; round++) {
    const contenders = [0, 1, 2].map(() => contend(home, 1_500));
    const outcomes = await Promise.all(contenders.map(({ exited }) => exited));
    expect(outcomes.map(({ code }) => code)).toEqual([0, 0, 0]);
    expect(outcomes.map(({ out }) => out).sort()).toEqual(["acquired", "refused", "refused"]);
  }
  // Released by its last holder's exit: free again.
  const last = contend(home, 0);
  expect((await last.exited).out).toBe("acquired");
  expect(existsSync(lock)).toBe(true);
}, 120_000);
