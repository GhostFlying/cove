import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, copyFile, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRequire = createRequire(join(root, "packages/terminal-engine/package.json"));

export async function prepareNodePty(lookup = packageRequire, checkout = root) {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`B0 native probe is unsupported on ${process.platform}`);
  }
  const manifestPath = lookup.resolve("node-pty/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== "1.1.0")
    throw new Error(`Unexpected node-pty version ${manifest.version}`);
  const packageRoot = await realpath(dirname(manifestPath));
  lookup("node-pty");
  const nativeBinary = Object.keys(lookup.cache).find(
    (path) => path.startsWith(`${packageRoot}${sep}`) && path.endsWith(".node"),
  );
  if (!nativeBinary) throw new Error("node-pty native binary did not load");
  const resolvedNative = await realpath(nativeBinary);
  if (!resolvedNative.startsWith(`${packageRoot}${sep}`))
    throw new Error("Loaded native binary escaped the exact node-pty package");
  const packageStore = join(await realpath(checkout), "node_modules", ".pnpm") + sep;
  if (!resolvedNative.startsWith(packageStore))
    throw new Error("Native binary is outside this checkout's install");
  if (process.platform === "linux") {
    return {
      version: manifest.version,
      nativeBinary: resolvedNative,
      helper: null,
      helperMode: null,
      repaired: false,
    };
  }
  const helper = join(dirname(resolvedNative), "spawn-helper");
  const current = await stat(helper);
  if (!current.isFile()) throw new Error("node-pty spawn-helper is missing");
  let repaired = false;
  if ((current.mode & 0o111) === 0) {
    // The published macOS 1.1.0 tarball omits +x; replace the pnpm hardlink before changing mode.
    const temporary = `${helper}.cove-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
      await copyFile(helper, temporary, constants.COPYFILE_EXCL);
      await chmod(temporary, 0o755);
      await rename(temporary, helper);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    repaired = true;
  }
  const mode = (await stat(helper)).mode & 0o777;
  if ((mode & 0o111) === 0) throw new Error("node-pty spawn-helper remains non-executable");
  const helperSha256 = createHash("sha256")
    .update(await readFile(helper))
    .digest("hex");
  return {
    version: manifest.version,
    nativeBinary: resolvedNative,
    helper,
    helperMode: mode.toString(8),
    helperSha256,
    repaired,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareNodePty()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
