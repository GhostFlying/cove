import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stampedBuild } from "../../dist/build-id.js";

// m2 T3: an installed closure's stamp (cove-install.json at its root) takes precedence over the
// development scan. The compiled build-id module is copied into a closure-like layout, with the
// protocol package it imports linked beside it, and run there in a fresh process: its own
// location decides which identity it reports.

const compiled = fileURLToPath(new URL("../../dist/build-id.js", import.meta.url));
// The protocol package root: its `dist` directory's parent.
let protocol = fileURLToPath(import.meta.resolve("@cove/protocol/bootstrap"));
while (!existsSync(join(protocol, "package.json"))) protocol = dirname(protocol);
const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// A module tree at `<root>/app/lib/build-id.js` that resolves @cove/protocol.
async function layout(files) {
  const root = await mkdtemp(join(tmpdir(), "cove-stamp-"));
  directories.push(root);
  await mkdir(join(root, "app", "lib"), { recursive: true });
  await mkdir(join(root, "app", "node_modules", "@cove"), { recursive: true });
  await symlink(protocol, join(root, "app", "node_modules", "@cove", "protocol"), "dir");
  await writeFile(join(root, "app", "package.json"), JSON.stringify({ type: "module" }));
  await copyFile(compiled, join(root, "app", "lib", "build-id.js"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

function identify(root) {
  const module = join(root, "app", "lib", "build-id.js");
  const script = `const m = await import(${JSON.stringify(module)});
    console.log(JSON.stringify({ build: m.buildId(), installed: m.installedClosureRoot(), workspace: m.workspaceRootOf() }));`;
  return new Promise((done, fail) =>
    execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout) =>
      error ? fail(error) : done(JSON.parse(stdout)),
    ),
  );
}

const stamp = (build) => JSON.stringify({ type: "cove-install", version: 1, build });

describe("installed build identity", () => {
  it("reports the stamped build of the closure the module runs from", async () => {
    const root = await layout({ "cove-install.json": stamp("1.0.0+0123456789abcdef") });
    expect(await identify(root)).toEqual({
      build: "1.0.0+0123456789abcdef",
      installed: expect.stringMatching(/cove-stamp-/),
      workspace: null,
    });
  });

  it("prefers the nearer stamp over an enclosing workspace, and never scans under a stamp", async () => {
    // The closure is inside a workspace (as a staging directory could be): the stamp is nearer.
    const root = await layout({
      "pnpm-workspace.yaml": "packages: []\n",
      "package.json": JSON.stringify({ version: "9.9.9" }),
      "app/cove-install.json": "not json",
    });
    const seen = await identify(root);
    // An unreadable stamp identifies nothing; the workspace above it is not scanned instead.
    expect(seen.build).toBe("unidentified");
    expect(seen.installed).toMatch(/app$/);
  });

  it("falls back to the development scan without a stamp", async () => {
    const root = await layout({
      "pnpm-workspace.yaml": "packages: []\n",
      "package.json": JSON.stringify({ version: "2.0.0" }),
    });
    const seen = await identify(root);
    expect(seen.build).toMatch(/^2\.0\.0\+[0-9a-f]{16}$/);
    expect(seen.installed).toBeNull();
  });

  it("accepts only a stamp of a build ID", () => {
    expect(stampedBuild(stamp("1.0.0+0123456789abcdef"))).toBe("1.0.0+0123456789abcdef");
    expect(stampedBuild(stamp("author"))).toBeNull();
    expect(stampedBuild(JSON.stringify({ build: "1.0.0+0123456789abcdef" }))).toBeNull();
    expect(stampedBuild("null")).toBeNull();
  });
});
