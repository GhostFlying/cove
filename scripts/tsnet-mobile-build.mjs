// Build the actual gomobile package, independently of server/CLI artifacts.
// Usage: node scripts/tsnet-mobile-build.mjs android|ios|ios-simulator [--out PATH]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTags, moduleDir, pinnedGoVersion } from "./tsnet-build.mjs";

const mobileVersion = "v0.0.0-20260908204917-8b95e45f8d3e";
const outputRoot = join(moduleDir, "dist/mobile");

function run(command, args, env, capture = false) {
  const result = spawnSync(command, args, {
    cwd: moduleDir,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args[0]} exited ${result.status ?? result.signal}`);
  }
  return result.stdout?.trim();
}

export function buildMobile(args) {
  const [target, ...flags] = args;
  if (!["android", "ios", "ios-simulator"].includes(target))
    throw new Error("usage: tsnet-mobile-build.mjs android|ios|ios-simulator [--out PATH]");
  if (flags.length !== 0 && (flags.length !== 2 || flags[0] !== "--out"))
    throw new Error("only --out PATH is supported");
  const extension = target === "android" ? ".aar" : ".xcframework";
  const output = resolve(flags[1] ?? join(outputRoot, target, `CoveTsnet${extension}`));
  if (!output.endsWith(extension)) throw new Error(`output must end in ${extension}`);
  const go = process.env.COVE_GO ?? "go";
  const tools = join(outputRoot, "tools");
  const env = {
    ...process.env,
    GOTOOLCHAIN: "local",
    GOMAXPROCS: "2",
    GOFLAGS: "-p=1",
    CGO_ENABLED: "1",
    GOPATH: join(outputRoot, "gopath"),
    PATH: [tools, ...(go.includes("/") ? [dirname(resolve(go))] : []), process.env.PATH ?? ""].join(
      delimiter,
    ),
  };
  if (run(go, ["env", "GOVERSION"], env, true) !== pinnedGoVersion())
    throw new Error(`mobile build requires ${pinnedGoVersion()}`);
  if (
    run(go, ["list", "-m", "-f", "{{.Version}}", "golang.org/x/mobile"], env, true) !==
    mobileVersion
  )
    throw new Error(`mobile build requires golang.org/x/mobile ${mobileVersion}`);
  const mod = readFileSync(join(moduleDir, "go.mod"), "utf8");
  for (const tool of ["gomobile", "gobind"]) {
    if (!mod.includes(`golang.org/x/mobile/cmd/${tool}`))
      throw new Error(`go.mod must declare the ${tool} tool`);
  }
  mkdirSync(tools, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  // Build both from the module's exact pin; never pick an unrelated globally
  // installed gobind because it happens to precede ours on PATH.
  for (const tool of ["gomobile", "gobind"])
    run(
      go,
      ["build", "-trimpath", "-o", join(tools, tool), `golang.org/x/mobile/cmd/${tool}`],
      env,
    );
  const options =
    target === "android"
      ? ["-target=android/arm64", "-androidapi=31", "-javapkg=com.ghostflying.cove"]
      : [
          `-target=${target === "ios" ? "ios/arm64" : "iossimulator/arm64"}`,
          "-iosversion=16.0",
          "-prefix=Cove",
        ];
  run(
    join(tools, "gomobile"),
    [
      "bind",
      ...options,
      "-tags",
      buildTags,
      "-trimpath",
      "-ldflags=-s -w",
      "-o",
      output,
      "./mobile",
    ],
    env,
  );
  console.log(output);
}

const invoked =
  process.argv[1] !== undefined &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    buildMobile(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
