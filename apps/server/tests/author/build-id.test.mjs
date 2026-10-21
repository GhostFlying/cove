import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBuildId } from "@cove/protocol/bootstrap";
import { buildId, computeBuildId } from "../../dist/build-id.js";

// m2 T0: the build ID is a digest of the build's compiled files (apps/server/src/build-id.ts).

let root;

async function write(path, text) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cove-build-id-"));
  await write("package.json", JSON.stringify({ version: "1.2.3" }));
  await write("pnpm-workspace.yaml", "packages: []\n");
  await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await write("apps/server/dist/entry/main.js", "console.log(1);\n");
  await write("packages/protocol/dist/rpc.js", "export {};\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("build ID", () => {
  it("names the package version and changes with any compiled file or the lockfile", async () => {
    const first = computeBuildId(root);
    expect(first).toMatch(/^1\.2\.3\+[0-9a-f]{16}$/);
    expect(isBuildId(first)).toBe(true);
    expect(computeBuildId(root)).toBe(first);
    await write("packages/protocol/dist/rpc.js", "export const x = 1;\n");
    const changed = computeBuildId(root);
    expect(changed).not.toBe(first);
    await write("pnpm-lock.yaml", "lockfileVersion: '9.1'\n");
    expect(computeBuildId(root)).not.toBe(changed);
    // A file moved to another path is another build, even with the same bytes.
    const before = computeBuildId(root);
    await rm(join(root, "packages/protocol/dist/rpc.js"));
    await write("packages/protocol/dist/rpc2.js", "export const x = 1;\n");
    expect(computeBuildId(root)).not.toBe(before);
  });

  it("changes with a package manifest alone", async () => {
    await write("apps/server/package.json", JSON.stringify({ bin: { "cove-server": "./a.js" } }));
    const first = computeBuildId(root);
    // Only the manifest changes: its exports or bin decide what runs.
    await write("apps/server/package.json", JSON.stringify({ bin: { "cove-server": "./b.js" } }));
    expect(computeBuildId(root)).not.toBe(first);
  });

  it("ignores declarations, source maps and build info", async () => {
    const first = computeBuildId(root);
    await write("apps/server/dist/entry/main.d.ts", "export {};\n");
    await write("apps/server/dist/entry/main.js.map", "{}\n");
    await write("apps/server/dist/server.tsbuildinfo", "{}\n");
    await write("apps/server/src/entry/main.ts", "source\n");
    expect(computeBuildId(root)).toBe(first);
  });

  it("identifies this checkout once per process, as the CLI and server both compute it", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const checkout = resolve(here, "../../../..");
    const id = buildId();
    expect(id).toBe(computeBuildId(checkout));
    expect(isBuildId(id)).toBe(true);
    expect(buildId()).toBe(id);
  });
});
