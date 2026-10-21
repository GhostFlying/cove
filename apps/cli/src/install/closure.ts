import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, posix } from "node:path";
import { isBuildId } from "@cove/protocol/bootstrap";
import { INSTALL_STAMP } from "@cove/server/build-id";

// The runtime closure of one Cove build (m2 D1): everything the server, the CLI, the terminal
// worker and cove-tsnet need to run, with no reference to the checkout it was built from and no
// Node on PATH. scripts/runtime-closure.mjs assembles and seals it; `cove server install` puts a
// sealed closure at `<home>/install/<build>/`, which is never modified afterwards.
//
//   bin/node              the pinned Node executable (.node-version)
//   bin/cove-tsnet        native/tailscale, built with --build <build>
//   app/                  `pnpm deploy --prod` of @cove/cli: compiled packages, production
//                         dependencies and native addons (better-sqlite3, node-pty)
//   closure.json          what the assembler recorded (platform, Node, package version)
//   cove-install.json     the stamp: the build ID and what it was computed over (INSTALL_STAMP)

export { INSTALL_STAMP };
export const CLOSURE_MANIFEST = "closure.json";
export const CLOSURE_NODE = join("bin", "node");
export const CLOSURE_TSNET = join("bin", "cove-tsnet");
export const CLOSURE_CLI = join("app", "dist", "main.js");
export const CLOSURE_SERVER = join(
  "app",
  "node_modules",
  "@cove",
  "server",
  "dist",
  "entry",
  "main.js",
);

export type InstallStamp = {
  type: "cove-install";
  version: 1;
  build: string;
  // The database schema this build's server migrates to and accepts (store/migrations.ts
  // SCHEMA_VERSION): `install --activate` refuses a build below the database's (D1).
  schemaVersion: number;
  platform: "darwin" | "linux";
  arch: string;
  node: string;
  // SHA-256 over every file of the sealed closure except this stamp (closureDigest), so that a
  // copy can be checked before it is installed.
  contentsSha256: string;
};

export function parseStamp(text: string): InstallStamp | null {
  let value: Partial<InstallStamp> | null;
  try {
    value = JSON.parse(text) as Partial<InstallStamp> | null;
  } catch {
    return null;
  }
  if (
    !value ||
    value.type !== "cove-install" ||
    value.version !== 1 ||
    !isBuildId(value.build) ||
    !Number.isSafeInteger(value.schemaVersion) ||
    (value.schemaVersion ?? 0) < 1 ||
    (value.platform !== "darwin" && value.platform !== "linux") ||
    typeof value.arch !== "string" ||
    typeof value.node !== "string" ||
    typeof value.contentsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.contentsSha256)
  )
    return null;
  return value as InstallStamp;
}

export async function readStamp(closure: string): Promise<InstallStamp | null> {
  try {
    return parseStamp(await readFile(join(closure, INSTALL_STAMP), "utf8"));
  } catch {
    return null;
  }
}

function hashFile(path: string, hash: Hash): Promise<void> {
  return new Promise((done, fail) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", fail);
    stream.once("end", () => done());
  });
}

// A digest of a directory tree: every regular file (its relative path, whether it is executable,
// its length and bytes) and every symbolic link (its path and target), in byte order of the
// relative paths, each length-prefixed so that no two trees hash the same stream. `exclude`
// names relative paths left out (the stamp, which records the digest, and during sealing the
// cove-tsnet binary, which embeds the build ID computed from it). Anything else (a socket, a
// device) makes the tree unidentifiable: the digest refuses it rather than skipping it.
export async function closureDigest(
  root: string,
  exclude: ReadonlySet<string> = new Set(),
  hash: Hash = createHash("sha256"),
): Promise<Hash> {
  const walk = async (relative: string): Promise<void> => {
    const entries = (await readdir(join(root, relative))).sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    for (const name of entries) {
      const path = relative ? `${relative}/${name}` : name;
      if (exclude.has(path)) continue;
      const absolute = join(root, path);
      const info = await lstat(absolute);
      if (info.isDirectory()) await walk(path);
      else if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        hash.update(
          `L\0${Buffer.byteLength(path)}\0${path}\0${Buffer.byteLength(target)}\0${target}\0`,
        );
      } else if (info.isFile()) {
        hash.update(
          `F\0${Buffer.byteLength(path)}\0${path}\0${info.mode & 0o111 ? "x" : "-"}\0${info.size}\0`,
        );
        await hashFile(absolute, hash);
      } else throw new Error(`${path} is neither a file, a directory nor a symbolic link`);
    }
  };
  await walk("");
  return hash;
}

// A closure must not depend on the checkout it came from or on anything outside itself: every
// symbolic link in it is relative and stays inside it. Returns the offending link, or null.
export async function escapingLink(root: string): Promise<string | null> {
  const walk = async (relative: string): Promise<string | null> => {
    for (const name of await readdir(join(root, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const info = await lstat(join(root, path));
      if (info.isDirectory()) {
        const found = await walk(path);
        if (found) return found;
      } else if (info.isSymbolicLink()) {
        const target = await readlink(join(root, path));
        const resolved = posix.normalize(posix.join(posix.dirname(path), target));
        if (posix.isAbsolute(target) || resolved === ".." || resolved.startsWith("../"))
          return path;
      }
    }
    return null;
  };
  return walk("");
}

// The digest recorded as contentsSha256: the whole sealed closure but its stamp.
export async function contentsDigest(closure: string): Promise<string> {
  return (await closureDigest(closure, new Set([INSTALL_STAMP]))).digest("hex");
}
