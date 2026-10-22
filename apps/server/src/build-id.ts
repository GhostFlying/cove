import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { formatBuildId, isBuildId } from "@cove/protocol/bootstrap";

// The build identity of this Cove build (m2 D1, D12; format in protocol bootstrap.ts):
// `<root package version>+<16 hex>`, where the digest is a SHA-256, by relative path, over every
// compiled file of the Cove workspace packages (`apps/*/dist`, `packages/*/dist`), each such
// package's manifest (its `exports`, `bin` and dependencies decide what runs) and the lockfile.
// The server and the CLI of one build compute it over the same files, so they agree, and a change
// to compiled code, a manifest or a locked dependency gives a new ID. It is computed at run time
// rather than stamped by a build step, so every way of building (root `pnpm build`, a package's
// `tsc -b`) yields an honest ID and no build script has to run first.
//
// Excluded: type declarations, source maps and tsbuildinfo, which do not change behavior, and
// symbolic links (node_modules links are not part of a dist tree anyway). Not covered at all: the
// Node binary, native addons (better-sqlite3, node-pty) and other binaries the build runs, which
// are rebuilt or installed per machine. Two checkouts with the same ID can therefore still differ
// in those; the ID tells builds apart for diagnostics and the D12 warning, nothing more.
//
// This runtime scan is the development fallback. An installed Cove (m2 T3, D1) carries an identity
// stamped at installation over its complete closure, Node binary, native addons and cove-tsnet
// included (INSTALL_STAMP at the closure root, written by scripts/runtime-closure.mjs), and that
// stamp takes precedence: a module that finds the stamp above itself before any workspace root
// reports the stamped build and scans nothing. A stamp that cannot be read or does not hold a
// build ID gives UNIDENTIFIED_BUILD, never the scan's answer, because the closure has no workspace
// to scan. For a layout with neither, UNIDENTIFIED_BUILD is reported rather than failing startup:
// builds then compare equal, which only loses the D12 warning, never a refusal.
//
// The build ID is the install identity: it tells installed closures apart and is what install,
// restart and prune compare. The D12 warning between a CLI and a server compares the source build
// instead (computeSourceBuildId), which does not depend on the platform.
export const UNIDENTIFIED_BUILD = "unidentified";
const EXCLUDED = /(?:\.d\.ts|\.d\.mts|\.map|\.tsbuildinfo)$/;

// The stamp of an installed closure, at its root (`<home>/install/<build>/cove-install.json`).
export const INSTALL_STAMP = "cove-install.json";

// What a module of this build is part of, found by walking up from it: an installed closure (its
// stamp) or a development workspace (pnpm-workspace.yaml), whichever is nearer.
type Layout = { kind: "installed" | "workspace"; root: string } | null;
function layoutOf(from: string): Layout {
  for (let current = from; ; current = dirname(current)) {
    if (existsSync(join(current, INSTALL_STAMP))) return { kind: "installed", root: current };
    if (existsSync(join(current, "pnpm-workspace.yaml")))
      return { kind: "workspace", root: current };
    if (dirname(current) === current) return null;
  }
}

let layout: Layout | undefined;
function ownLayout(): Layout {
  if (layout === undefined) layout = layoutOf(dirname(fileURLToPath(import.meta.url)));
  return layout;
}

// The root of the installed closure this module runs from, or null for a development build.
export function installedClosureRoot(): string | null {
  const own = ownLayout();
  return own?.kind === "installed" ? own.root : null;
}

// The workspace this module was built in, or null for an installed closure.
export function workspaceRootOf(): string | null {
  const own = ownLayout();
  return own?.kind === "workspace" ? own.root : null;
}

// Where this build's `cove-tsnet` is: `bin/cove-tsnet` of an installed closure (D1), else the
// output of `pnpm tsnet:build` in the workspace this module was built in. Null when neither
// exists: the tsnet entry is then unavailable, the other entries are not affected. The server
// (network/listeners.ts) and the CLI (remote/tsnet-binary.ts, which starts the dial daemon) use
// this one lookup, so both run the executable of their own build.
export function tsnetBinaryPath(): string | null {
  const closure = installedClosureRoot();
  if (closure) {
    const installed = join(closure, "bin", "cove-tsnet");
    return existsSync(installed) ? installed : null;
  }
  const root = workspaceRootOf();
  if (!root) return null;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const built = join(
    root,
    "native",
    "tailscale",
    "dist",
    `${process.platform}-${arch}`,
    "cove-tsnet",
  );
  return existsSync(built) ? built : null;
}

// The build ID an install stamp names, or null when the text is not a stamp of a build.
export function stampedBuild(text: string): string | null {
  try {
    const stamp = JSON.parse(text) as { type?: unknown; build?: unknown } | null;
    return stamp?.type === "cove-install" && isBuildId(stamp.build) ? stamp.build : null;
  } catch {
    return null;
  }
}

function distFiles(directory: string, into: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) distFiles(path, into);
    else if (entry.isFile() && !EXCLUDED.test(entry.name)) into.push(path);
  }
}

// The files the development build ID covers (see the module comment), absolute.
function workspaceFiles(root: string): string[] {
  const files: string[] = [];
  for (const group of ["apps", "packages"]) {
    const parent = join(root, group);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dist = join(parent, entry.name, "dist");
      if (existsSync(dist) && lstatSync(dist).isDirectory()) distFiles(dist, files);
      const manifest = join(parent, entry.name, "package.json");
      if (existsSync(manifest) && lstatSync(manifest).isFile()) files.push(manifest);
    }
  }
  const lockfile = join(root, "pnpm-lock.yaml");
  if (existsSync(lockfile)) files.push(lockfile);
  return files;
}

// The Go sources of cove-tsnet (native/tailscale): every non-test `.go` file, go.mod and go.sum,
// not its build outputs (dist/) or documentation.
function goSources(directory: string, into: string[], top = true): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!(top && entry.name === "dist")) goSources(path, into, false);
    } else if (
      entry.isFile() &&
      ((entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) ||
        (top && (entry.name === "go.mod" || entry.name === "go.sum")))
    )
      into.push(path);
  }
}

// The ID over `files`, named relative to `root`.
function digestId(root: string, files: string[]): string {
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

// The build ID of the workspace checked out at `root`.
export function computeBuildId(root: string): string {
  return digestId(root, workspaceFiles(root));
}

// The source build of the workspace at `root` (#175): what the D12 build comparison between a CLI
// and a server uses. The development build ID's files plus cove-tsnet's Go sources, since the
// client's dial daemon and the server's node talk across machines. Like the development ID it
// covers no Node, native addon or other per-machine binary and no absolute path, so one commit
// built anywhere, on any OS or architecture, has one source build; the install identity
// (buildId of an installed closure) differs per platform and stays what installs compare.
export function computeSourceBuildId(root: string): string {
  const files = workspaceFiles(root);
  const native = join(root, "native", "tailscale");
  if (existsSync(native) && lstatSync(native).isDirectory()) goSources(native, files);
  return digestId(root, files);
}

// The source build an install stamp records (`source`, written by scripts/runtime-closure.mjs
// from the checkout the closure was assembled from), or null.
export function stampedSource(text: string): string | null {
  try {
    const stamp = JSON.parse(text) as { type?: unknown; source?: unknown } | null;
    return stamp?.type === "cove-install" && isBuildId(stamp.source) ? stamp.source : null;
  } catch {
    return null;
  }
}

let cachedSource: string | null | undefined;
// This process's source build, computed once on first use; null when it is unknown (a stamp
// without one, an unreadable tree, neither layout). A null source build is left out of the
// identity, and the D12 comparison then falls back to the build IDs.
export function sourceBuildId(): string | null {
  if (cachedSource === undefined) {
    const own = ownLayout();
    let id: string | null = null;
    try {
      if (own?.kind === "installed")
        id = stampedSource(readFileSync(join(own.root, INSTALL_STAMP), "utf8"));
      else if (own) id = computeSourceBuildId(own.root);
    } catch {
      id = null;
    }
    cachedSource = id;
  }
  return cachedSource;
}

let cached: string | undefined;
// This process's build ID, computed once on first use: a CLI command that never connects to a
// server never hashes anything.
export function buildId(): string {
  if (cached === undefined) {
    const own = ownLayout();
    let id = UNIDENTIFIED_BUILD;
    try {
      if (own?.kind === "installed")
        id = stampedBuild(readFileSync(join(own.root, INSTALL_STAMP), "utf8")) ?? id;
      else if (own) id = computeBuildId(own.root);
    } catch {
      // An unreadable stamp or tree identifies nothing; see UNIDENTIFIED_BUILD.
    }
    cached = id;
  }
  return cached;
}
