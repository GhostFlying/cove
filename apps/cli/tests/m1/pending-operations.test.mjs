import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { publishPending } from "../../dist/commands/_pending.js";
import { createM1Fixture } from "./fixtures.mjs";

// The CLI's pending records (relay-protocol §11.2): a reused operation ID sends the request saved
// for it and nothing else. A command whose request differs from the saved one is refused before
// anything is sent, so the server never executes a request that `operation resend` cannot
// reproduce.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

const REFUSED =
  /already has a saved request with another server, method or parameters; nothing was sent\. Use a fresh --operation-id/;

test("a reused operation ID with another expectedRevision is refused locally", async () => {
  const home = fixture.home("home");
  const rootA = join(fixture.root, "root-a");
  await fixture.coveJson(["server", "init", "--workspace-root", rootA], { home });
  await fixture.startServer(home);
  const target = join(fixture.root, "root-b");
  const set = (revision, operationId = "cfg") =>
    fixture.cove(
      [
        "config",
        "set",
        "workspaceRoot",
        target,
        "--expected-revision",
        String(revision),
        "--operation-id",
        operationId,
      ],
      { home },
    );
  const noReceipt = async (id) =>
    expect((await fixture.cove(["operation", "get", id], { home })).code).not.toBe(0);

  // Rejected by the server without a receipt (the configuration is at revision 1).
  const stale = await set(0);
  expect(stale.code).not.toBe(0);
  expect(stale.stderr).toContain("REVISION_CONFLICT");
  await noReceipt("cfg");

  // Correcting the revision under the same ID would change the saved intent: nothing is sent.
  const corrected = await set(1);
  expect(corrected.code).not.toBe(0);
  expect(corrected.stderr).toMatch(REFUSED);
  await noReceipt("cfg");
  expect(await fixture.coveJson(["config", "get"], { home })).toMatchObject({ revision: 1 });

  // The same command again sends the saved request, and so does resend.
  expect((await set(0)).stderr).toContain("REVISION_CONFLICT");
  const resent = await fixture.cove(["operation", "resend", "cfg"], { home });
  expect(resent.code).not.toBe(0);
  expect(resent.stderr).toContain("REVISION_CONFLICT");

  // A fresh operation ID carries the corrected request.
  const fresh = await set(1, "cfg-fresh");
  expect(fresh.code).toBe(0);
  expect(JSON.parse(fresh.stdout)).toMatchObject({ state: "succeeded" });
  expect(await fixture.coveJson(["config", "get"], { home })).toMatchObject({
    revision: 2,
    settings: { workspaceRoot: { value: target } },
  });
});

test("request B under the ID of unsent request A is refused, and resend sends A", async () => {
  const home = fixture.home("home");
  const server = await fixture.startServer(home);
  const rootA = join(fixture.root, "root-a");
  const rootB = join(fixture.root, "root-b");
  // A was saved by a command that died before sending it.
  await publishPending(home, {
    version: 1,
    serverId: server.record.serverId,
    method: "config.set",
    params: { operationId: "ab", patch: { workspaceRoot: rootA } },
    // Recent: a record past the 30-day retention is never resent (m2 D13).
    savedAtMs: Date.now(),
  });

  const b = await fixture.cove(["config", "set", "workspaceRoot", rootB, "--operation-id", "ab"], {
    home,
  });
  expect(b.code).not.toBe(0);
  expect(b.stderr).toMatch(REFUSED);
  expect((await fixture.cove(["operation", "get", "ab"], { home })).code).not.toBe(0);
  expect(await fixture.coveJson(["config", "get"], { home })).toMatchObject({ revision: 0 });

  const resent = await fixture.coveJson(["operation", "resend", "ab"], { home });
  expect(resent).toMatchObject({ operationId: "ab", method: "config.set", state: "succeeded" });
  expect(await fixture.coveJson(["config", "get"], { home })).toMatchObject({
    revision: 1,
    settings: { workspaceRoot: { value: rootA } },
  });
  // Rebuilding A itself under the same ID returns the same record without a second change.
  expect(
    await fixture.coveJson(["config", "set", "workspaceRoot", rootA, "--operation-id", "ab"], {
      home,
    }),
  ).toEqual(resent);
  expect(await fixture.coveJson(["config", "get"], { home })).toMatchObject({ revision: 1 });
});

test("of concurrent publications under one ID exactly one is saved and returned to both", async () => {
  const home = fixture.home("race-home");
  const request = (root) => ({
    version: 1,
    serverId: "server",
    method: "config.set",
    params: { operationId: "race", patch: { workspaceRoot: join(fixture.root, root) } },
    savedAtMs: 1,
  });
  for (let round = 0; round < 20; round += 1) {
    const params = { operationId: `race-${round}` };
    const [a, b] = await Promise.all([
      publishPending(home, { ...request("a"), params: { ...request("a").params, ...params } }),
      publishPending(home, { ...request("b"), params: { ...request("b").params, ...params } }),
    ]);
    expect(a).toEqual(b);
    const file = join(home, "cli", "operations", `race-${round}.json`);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(a);
  }
  // No temporary file is left behind.
  const names = await readdir(join(home, "cli", "operations"));
  expect(names.filter((name) => !name.endsWith(".json"))).toEqual([]);
});
