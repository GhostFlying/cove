import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBuildId } from "@cove/protocol/bootstrap";
import {
  buildId,
  computeBuildId,
  computeSourceBuildId,
  sourceBuildId,
  stampedSource,
} from "../../dist/build-id.js";

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

// #175: the source build, which the D12 warning compares (a CLI and a server of one commit on
// different machines, OSes or paths must match).
describe("source build", () => {
  it("covers the build ID's files and cove-tsnet's Go sources, not their outputs or tests", async () => {
    await write("native/tailscale/go.mod", "module x\n");
    await write("native/tailscale/go.sum", "");
    await write("native/tailscale/cmd/cove-tsnet/main.go", "package main\n");
    const first = computeSourceBuildId(root);
    expect(first).toMatch(/^1\.2\.3\+[0-9a-f]{16}$/);
    expect(first).not.toBe(computeBuildId(root));
    // Build outputs, tests and documentation of the Go module change nothing.
    await write("native/tailscale/dist/linux-amd64/cove-tsnet", "binary");
    await write("native/tailscale/cmd/cove-tsnet/main_test.go", "package main\n");
    await write("native/tailscale/PROTOCOL.md", "doc\n");
    expect(computeSourceBuildId(root)).toBe(first);
    // A Go source, go.sum or a compiled file of a package does.
    await write("native/tailscale/cmd/cove-tsnet/main.go", "package main // changed\n");
    const go = computeSourceBuildId(root);
    expect(go).not.toBe(first);
    await write("native/tailscale/go.sum", "x v1 h1:\n");
    const sum = computeSourceBuildId(root);
    expect(sum).not.toBe(go);
    await write("apps/server/dist/entry/main.js", "console.log(2);\n");
    expect(computeSourceBuildId(root)).not.toBe(sum);
  });

  it("does not depend on where the checkout is", async () => {
    await write("native/tailscale/go.mod", "module x\n");
    await write("native/tailscale/internal/a/a.go", "package a\n");
    const other = await mkdtemp(join(tmpdir(), "cove-build-id-elsewhere-"));
    try {
      const copy = join(other, "a", "deeper", "checkout");
      await cp(root, copy, { recursive: true });
      expect(computeSourceBuildId(copy)).toBe(computeSourceBuildId(root));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("is read from an install stamp only when the stamp records a valid one", () => {
    const stamp = { type: "cove-install", build: "0.0.0+0123456789abcdef" };
    expect(stampedSource(JSON.stringify({ ...stamp, source: "0.0.0+fedcba9876543210" }))).toBe(
      "0.0.0+fedcba9876543210",
    );
    expect(stampedSource(JSON.stringify(stamp))).toBeNull();
    expect(stampedSource(JSON.stringify({ ...stamp, source: "not a build" }))).toBeNull();
    expect(stampedSource("{")).toBeNull();
  });

  it("is this checkout's for a development build", () => {
    const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    expect(sourceBuildId()).toBe(computeSourceBuildId(checkout));
  });
});
