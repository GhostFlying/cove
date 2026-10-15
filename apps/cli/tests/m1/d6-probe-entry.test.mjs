import { mkdir, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createM1Fixture } from "./fixtures.mjs";

// The D6 probe's memory backend is not durable: a config write acknowledged in memory mode is lost
// on restart. Only the separate probe entry may enable it; the normal cove-server executable must
// ignore COVE_D6_PROBE_DIR (docs/milestones/m1.md D6).

const serverPackage = dirname(createRequire(import.meta.url).resolve("@cove/server/package.json"));

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

test("the cove-server executable ignores COVE_D6_PROBE_DIR", async () => {
  const manifest = JSON.parse(await readFile(join(serverPackage, "package.json"), "utf8"));
  expect(manifest.bin).toEqual({ "cove-server": "./dist/entry/main.js" });
  // The normal entry does not load the instrumentation at all.
  const main = await readFile(join(serverPackage, "dist/entry/main.js"), "utf8");
  expect(main).not.toMatch(/import[^;]*d6-probe/);

  const probeDirectory = join(fixture.root, "probe");
  await mkdir(probeDirectory);
  fixture.env.COVE_D6_PROBE_DIR = probeDirectory;
  const home = fixture.home("home");
  const target = join(fixture.root, "root");
  const server = await fixture.startServer(home);
  await fixture.coveJson(["config", "set", "workspaceRoot", target], { home });
  await fixture.stopServer(server);
  // No measurements are written, and the write is durable.
  expect(await readdir(probeDirectory)).toEqual([]);
  await fixture.startServer(home);
  expect(await fixture.coveJson(["config", "get"], { home })).toMatchObject({
    revision: 1,
    settings: { workspaceRoot: { value: target } },
  });
});

test("the probe entry refuses to start without COVE_D6_PROBE_DIR", async () => {
  delete fixture.env.COVE_D6_PROBE_DIR;
  await expect(
    fixture.startServerEntry(
      join(serverPackage, "dist/entry/d6-probe-main.js"),
      fixture.home("home"),
    ),
  ).rejects.toThrow(/COVE_D6_PROBE_DIR is required/);
});
