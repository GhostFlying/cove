import { mkdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createM1Fixture } from "./fixtures.mjs";

// The compiled cove-server's entry check: it starts a server only when node was started with this
// module, compared by real path, because an installed executable is usually a symlink to it.

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

test("cove-server started through a symlinked bin serves and persists writes", async () => {
  const bin = join(fixture.root, "bin");
  await mkdir(bin);
  const linked = join(bin, "cove-server");
  await symlink(join(serverPackage, "dist/entry/main.js"), linked);
  const home = fixture.home("home");
  const target = join(fixture.root, "workspaces");
  let server = await fixture.startServerEntry(linked, home);
  await fixture.coveJson(["config", "set", "workspaceRoot", target], { home });
  expect(await fixture.coveJson(["config", "get"], { home })).toMatchObject({
    revision: 1,
    settings: { workspaceRoot: { value: target, isDefault: false } },
  });
  await fixture.stopServer(server);
  expect(await server.exited).toBe(0);
  // A second server on the same data directory reads the write back from the database.
  server = await fixture.startServerEntry(linked, home);
  expect(await fixture.coveJson(["config", "get"], { home })).toMatchObject({
    revision: 1,
    settings: { workspaceRoot: { value: target } },
  });
  await fixture.stopServer(server);
  expect(await server.exited).toBe(0);
});
