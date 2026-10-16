import { execFile } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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

test("importing the server module from a stdin program neither throws nor starts a server", async () => {
  // node reads the program from stdin and argv[1] is "-", which resolves to no file: the module's
  // entry check must treat it as "not this executable" rather than throw on import.
  const main = pathToFileURL(join(serverPackage, "dist/entry/main.js")).href;
  const result = await new Promise((done) => {
    const child = execFile(
      process.execPath,
      ["--input-type=module", "-"],
      { cwd: fixture.root, env: fixture.env, timeout: 20_000 },
      (error, stdout, stderr) => done({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin.end(
      `const m = await import(${JSON.stringify(main)});\n` +
        `process.stdout.write(typeof m.runServerProcess + "\\n");\n`,
    );
  });
  expect(result).toEqual({ code: 0, stdout: "function\n", stderr: "" });
});
