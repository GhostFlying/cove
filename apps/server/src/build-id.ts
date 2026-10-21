import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { formatBuildId } from "@cove/protocol/bootstrap";

// The build identity of this Cove build (m2 D1, D12; format in protocol bootstrap.ts):
// `<root package version>+<16 hex>`, where the digest is a SHA-256 over every compiled file of the
// Cove workspace packages (`apps/*/dist`, `packages/*/dist`) and the lockfile, by relative path.
// The server and the CLI of one build compute it over the same files, so they agree, and any
// change to compiled code or locked dependencies gives a new ID. It is computed at run time
// rather than stamped by a build step, so every way of building (root `pnpm build`, a package's
// `tsc -b`) yields an honest ID and no build script has to run first.
//
// Excluded: type declarations, source maps and tsbuildinfo, which do not change behavior, and
// symbolic links (node_modules links are not part of a dist tree anyway). Native addons are not
// hashed; they are rebuilt per machine and identified by the Node ABI instead.
//
// A layout without a workspace root (an install closure T3 has not defined yet) yields
// UNIDENTIFIED_BUILD rather than failing startup: builds then compare equal, which only loses
// the D12 warning, never a refusal.
export const UNIDENTIFIED_BUILD = "unidentified";
const EXCLUDED = /(?:\.d\.ts|\.d\.mts|\.map|\.tsbuildinfo)$/;

function workspaceRoot(from: string): string | null {
  for (let current = from; ; current = dirname(current)) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    if (dirname(current) === current) return null;
  }
}

function distFiles(directory: string, into: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) distFiles(path, into);
    else if (entry.isFile() && !EXCLUDED.test(entry.name)) into.push(path);
  }
}

// The build ID of the workspace checked out at `root`.
export function computeBuildId(root: string): string {
  const files: string[] = [];
  for (const group of ["apps", "packages"]) {
    const parent = join(root, group);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const dist = join(parent, entry.name, "dist");
      if (entry.isDirectory() && existsSync(dist) && lstatSync(dist).isDirectory())
        distFiles(dist, files);
    }
  }
  const lockfile = join(root, "pnpm-lock.yaml");
  if (existsSync(lockfile)) files.push(lockfile);
  // Paths use "/" whatever the platform, so one build has one ID everywhere.
  const named = files
    .map((path) => ({ path, name: relative(root, path).split(sep).join("/") }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = createHash("sha256");
  for (const { path, name } of named) {
    const bytes = readFileSync(path);
    // Length-prefixed, so no two different file sets hash the same byte stream.
    hash.update(`${name}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  return formatBuildId(typeof version === "string" ? version : "0.0.0", hash.digest("hex"));
}

let cached: string | undefined;
// This process's build ID, computed once on first use: a CLI command that never connects to a
// server never hashes anything.
export function buildId(): string {
  if (cached === undefined) {
    const root = workspaceRoot(dirname(fileURLToPath(import.meta.url)));
    let id = UNIDENTIFIED_BUILD;
    if (root)
      try {
        id = computeBuildId(root);
      } catch {
        // An unreadable tree identifies nothing; see UNIDENTIFIED_BUILD.
      }
    cached = id;
  }
  return cached;
}
