import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

// The store runs in a worker thread (D6 B) whose entry is a separate compiled module,
// dist/store/store-worker.js, located from the store module's own URL. server-entry.test.mjs
// starts the compiled cove-server through a symlinked executable outside the package, which also
// proves that the worker entry is found from there.

const serverPackage = dirname(createRequire(import.meta.url).resolve("@cove/server/package.json"));

test("the compiled store worker entry ships beside the store module", async () => {
  const store = join(serverPackage, "dist/store");
  const files = await readdir(store);
  expect(files).toEqual(expect.arrayContaining(["database.js", "store-worker.js"]));
  const client = await readFile(join(store, "database.js"), "utf8");
  expect(client).toMatch(/new URL\("\.\/store-worker\.js", import\.meta\.url\)/);
});
