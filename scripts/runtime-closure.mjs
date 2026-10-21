// Builds the runtime closure of this checkout's Cove build (m2 D1, T3): the directory
// `cove server install` puts at `<home>/install/<build>/`. Layout and stamp: apps/cli/src/install/
// closure.ts.
//
//   node scripts/runtime-closure.mjs assemble --out DIR   production packages, native addons, Node
//   node scripts/runtime-closure.mjs seal DIR             build ID, cove-tsnet, stamp
//   node scripts/runtime-closure.mjs build --out DIR      both
//
// Prerequisites: `pnpm build` and `pnpm native:prepare` in this checkout, pnpm on PATH (or
// COVE_PNPM), Go per scripts/tsnet-build.mjs (COVE_GO or `go` on PATH), and this script run by the
// pinned Node (.node-version), whose executable is the one copied into the closure.
//
// Assembling and sealing are separate so that a closure can be assembled once and sealed after a
// change (tests seal variants of one assembly); an assembled but unsealed directory has no stamp
// and `cove server install` refuses it.
//
// Identity. The build ID is computed over the assembled closure itself (every file but the stamp
// and cove-tsnet: the pnpm deploy output, the Node binary, the native addons) plus cove-tsnet as
// built with a fixed placeholder ID, and then cove-tsnet is built again with `--build <ID>`. The
// final binary cannot be part of the digest it embeds; the placeholder build stands for it. It is
// the same build but for the ID string (scripts/tsnet-build.mjs, reproducible: -trimpath, static),
// so it reflects every input that shapes the binary: the Go sources and toolchain, the build
// flags and tags of the build script, GOAMD64/GOARM64 and the rest of the Go environment, and the
// VCS information Go embeds (the commit, and whether the checkout was modified). Listing those
// inputs instead would silently miss any that a later Go or build script adds. The stamp also
// records a digest of the final contents, cove-tsnet included, which `cove server install
// --closure` checks before it installs a copy. Two checkouts of one commit at different paths get
// different IDs: pnpm names its virtual store entries of workspace packages after their source
// paths. That only costs a second install directory, never a wrong match.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const closureModule = join(root, "apps/cli/dist/install/closure.js");

function fail(message) {
  throw new Error(message);
}

// Tool output goes to stderr: stdout carries only this script's JSON answer.
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ["ignore", 2, 2], ...options });
  if (result.error) fail(`cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args[0]} exited ${result.status ?? result.signal}`);
  return result;
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) fail(`cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${command} ${args.join(" ")} exited ${result.status ?? result.signal}: ${result.stderr}`);
  return result.stdout;
}

async function closureLib() {
  if (!existsSync(closureModule)) fail("apps/cli is not built; run `pnpm build` first");
  return import(pathToFileURL(closureModule).href);
}

// The virtual store entry (node_modules/.pnpm/<name>) of a package, by name prefix.
function storeEntry(nodeModules, prefix) {
  const names = readdirSync(join(nodeModules, ".pnpm")).filter((name) => name.startsWith(prefix));
  if (names.length !== 1) fail(`expected one ${prefix}* in ${nodeModules}/.pnpm, found ${names}`);
  return names[0];
}

function assemble(out) {
  const pinned = readFileSync(join(root, ".node-version"), "utf8").trim();
  if (process.version !== `v${pinned}`)
    fail(
      `the closure carries the Node running this script: need v${pinned}, have ${process.version}`,
    );
  for (const built of ["apps/cli/dist/main.js", "apps/server/dist/entry/main.js"])
    if (!existsSync(join(root, built))) fail(`${built} is missing; run \`pnpm build\` first`);
  if (existsSync(out)) fail(`${out} already exists`);
  // pnpm deploy needs the real path of the target: it writes relative paths that would not
  // survive a symlinked ancestor such as macOS /tmp.
  const parent = realpathSync(dirname(out));
  const target = join(parent, basename(out));
  mkdirSync(target, { mode: 0o755 });
  try {
    assembleInto(target);
  } catch (error) {
    // A failed assembly leaves nothing half made at the requested path.
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return target;
}

function assembleInto(target) {
  const app = join(target, "app");
  run(process.env.COVE_PNPM || "pnpm", ["--filter", "@cove/cli", "deploy", "--prod", app], {
    cwd: root,
  });

  // Install metadata names the checkout by absolute path and plays no part at run time.
  for (const file of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm-workspace-state-v1.json",
    "node_modules/.pnpm/lock.yaml",
  ])
    rmSync(join(app, file), { force: true });
  // The deploy copies the whole CLI package; its sources and tests are not part of the runtime.
  for (const entry of ["src", "tests", "tsconfig.json"])
    rmSync(join(app, entry), { recursive: true, force: true });
  // Workspace dependencies are copied whole as well, local caches included: terminal-web keeps the
  // Playwright browsers it downloads under .cache. Neither caches nor tests are read at run time,
  // and a cache would make the build ID depend on what this checkout happened to download.
  const store = join(app, "node_modules", ".pnpm");
  for (const entry of readdirSync(store).filter((name) => name.startsWith("@cove+"))) {
    const scope = join(store, entry, "node_modules", "@cove");
    for (const pkg of readdirSync(scope)) {
      const dir = join(scope, pkg);
      if (lstatSync(dir).isSymbolicLink()) continue;
      for (const local of [".cache", "tests"])
        rmSync(join(dir, local), { recursive: true, force: true });
    }
  }
  // The deployed manifest keeps what Node reads at run time (the module type, bin and exports);
  // its dependency specifiers point into the checkout.
  const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  writeFileSync(
    join(app, "package.json"),
    `${JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        private: true,
        type: manifest.type,
        bin: manifest.bin,
        exports: manifest.exports,
      },
      null,
      2,
    )}\n`,
  );

  // node-pty is built per machine (scripts/node-pty-install.mjs, checked by native:prepare); the
  // deploy may take a copy from pnpm's cache, so the checkout's verified build replaces it.
  const nodeModules = join(app, "node_modules");
  const pty = storeEntry(nodeModules, "node-pty@");
  const ptySource = join(root, "node_modules/.pnpm", pty, "node_modules/node-pty/build/Release");
  const ptyTarget = join(nodeModules, ".pnpm", pty, "node_modules/node-pty/build/Release");
  // node-pty builds spawn-helper on macOS only; Linux forks the PTY process from pty.node itself.
  const ptyFiles = ["pty.node", ...(process.platform === "darwin" ? ["spawn-helper"] : [])];
  for (const file of ptyFiles) {
    if (!existsSync(join(ptySource, file)))
      fail(`${ptySource}/${file} is missing; run pnpm native:prepare`);
    copyFileSync(join(ptySource, file), join(ptyTarget, file));
  }
  if (process.platform === "darwin") chmodSync(join(ptyTarget, "spawn-helper"), 0o755);

  // The pinned Node, so the service runs without Node on PATH.
  mkdirSync(join(target, "bin"));
  copyFileSync(process.execPath, join(target, "bin", "node"));
  chmodSync(join(target, "bin", "node"), 0o755);
  // The server starts its terminal worker through pnpm's bin shim
  // (@cove/server/node_modules/.bin/cove-terminal-worker), which runs `$basedir/node` when that
  // exists and otherwise whatever `node` PATH names. A relative link beside the shim makes it run
  // the closure's Node.
  const serverEntry = storeEntry(nodeModules, "@cove+server@");
  const shims = join(
    nodeModules,
    ".pnpm",
    serverEntry,
    "node_modules/@cove/server/node_modules/.bin",
  );
  if (!existsSync(join(shims, "cove-terminal-worker"))) fail(`no worker shim in ${shims}`);
  symlinkSync(relative(shims, join(target, "bin", "node")), join(shims, "node"));

  writeFileSync(
    join(target, "closure.json"),
    `${JSON.stringify(
      {
        type: "cove-closure",
        version: 1,
        packageVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
      },
      null,
      2,
    )}\n`,
  );
  smoke(target);
}

// Loads what the server needs from inside the closure with the closure's Node and a PATH without
// Node: SQLite (an in-memory database), node-pty (a spawned shell) and the worker shim.
function smoke(closure) {
  const app = join(closure, "app");
  const server = realpathSync(join(app, "node_modules/@cove/server"));
  const script = `
    import { createRequire } from "node:module";
    const server = createRequire(${JSON.stringify(join(server, "package.json"))});
    const Database = server("better-sqlite3");
    const db = new Database(":memory:");
    const version = db.prepare("select sqlite_version() as v").get().v;
    db.close();
    const worker = createRequire(${JSON.stringify(join(server, "..", "terminal-worker", "package.json"))});
    const pty = worker("node-pty");
    const child = pty.spawn("/bin/sh", ["-c", "exit 7"], {});
    const code = await new Promise((done) => child.onExit(({ exitCode }) => done(exitCode)));
    console.log(JSON.stringify({ sqlite: version, pty: code }));
  `;
  const output = capture(join(closure, "bin", "node"), ["--input-type=module", "-e", script], {
    cwd: closure,
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
  });
  const seen = JSON.parse(output);
  if (seen.pty !== 7 || !seen.sqlite) fail(`closure smoke check failed: ${output}`);
}

function buildTsnet(build, out) {
  run(process.execPath, [
    join(root, "scripts/tsnet-build.mjs"),
    "build",
    "--build",
    build,
    "--out",
    out,
  ]);
}

// cove-tsnet built with a placeholder ID of the final ID's length, standing for the final binary
// in the build ID (see the header). Returns its SHA-256.
function tsnetIdentity(closure, packageVersion) {
  const out = join(closure, "bin", "cove-tsnet");
  buildTsnet(`${packageVersion}+${"0".repeat(16)}`, out);
  return createHash("sha256").update(readFileSync(out)).digest("hex");
}

async function seal(dir) {
  const lib = await closureLib();
  const closure = realpathSync(dir);
  const manifest = JSON.parse(readFileSync(join(closure, "closure.json"), "utf8"));
  if (manifest.type !== "cove-closure" || manifest.platform !== process.platform)
    fail(`${closure} is not an assembled closure for ${process.platform}`);
  for (const stale of [lib.INSTALL_STAMP, join("bin", "cove-tsnet")])
    rmSync(join(closure, stale), { force: true });
  const escaping = await lib.escapingLink(closure);
  if (escaping) fail(`${escaping} leaves the closure`);
  const node = capture(join(closure, "bin", "node"), ["--version"]).trim();
  if (node !== manifest.node) fail(`bin/node is ${node}, the closure records ${manifest.node}`);
  // The schema this build's server accepts, read from its own compiled migrations.
  const migrations = join(
    realpathSync(join(closure, "app/node_modules/@cove/server")),
    "dist/store/migrations.js",
  );
  const schemaVersion = Number(
    capture(join(closure, "bin", "node"), [
      "--input-type=module",
      "-e",
      `console.log((await import(${JSON.stringify(pathToFileURL(migrations).href)})).SCHEMA_VERSION)`,
    ]).trim(),
  );
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1)
    fail(`cannot read the schema version of ${migrations}`);

  const hash = await lib.closureDigest(closure, new Set([lib.INSTALL_STAMP, "bin/cove-tsnet"]));
  hash.update(`T\0${tsnetIdentity(closure, manifest.packageVersion)}\0`);
  const digest = hash.digest("hex");
  const build = `${manifest.packageVersion}+${digest.slice(0, 16)}`;
  buildTsnet(build, join(closure, "bin", "cove-tsnet"));
  const reported = capture(join(closure, "bin", "cove-tsnet"), ["version"]);
  if (!reported.includes(`build=${build} `)) fail(`cove-tsnet reports ${reported.trim()}`);
  const stamp = {
    type: "cove-install",
    version: 1,
    build,
    schemaVersion,
    platform: manifest.platform,
    arch: manifest.arch,
    node: manifest.node,
    contentsSha256: await lib.contentsDigest(closure),
  };
  if (!lib.parseStamp(JSON.stringify(stamp))) fail(`invalid stamp ${JSON.stringify(stamp)}`);
  writeFileSync(join(closure, lib.INSTALL_STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || args[index + 1] === undefined) fail(`${name} DIR is required`);
  return resolve(args[index + 1]);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "assemble")
      console.log(JSON.stringify({ assembled: assemble(option(rest, "--out")) }));
    else if (command === "seal") {
      if (rest.length !== 1) fail("usage: runtime-closure.mjs seal DIR");
      console.log(JSON.stringify(await seal(resolve(rest[0]))));
    } else if (command === "build") {
      const out = option(rest, "--out");
      const target = assemble(out);
      try {
        console.log(JSON.stringify({ dir: target, ...(await seal(target)) }));
      } catch (error) {
        rmSync(target, { recursive: true, force: true });
        throw error;
      }
    } else fail("usage: runtime-closure.mjs assemble --out DIR | seal DIR | build --out DIR");
  } catch (error) {
    console.error(`runtime-closure: ${error.message}`);
    process.exitCode = 1;
  }
}
