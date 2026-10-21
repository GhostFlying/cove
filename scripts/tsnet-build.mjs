// Builds and tests cove-tsnet (native/tailscale) with the pinned Go toolchain.
//
//   node scripts/tsnet-build.mjs build [--goos darwin|linux] [--goarch arm64|amd64] [--build ID] [--out PATH]
//   node scripts/tsnet-build.mjs test [go test args...]
//   node scripts/tsnet-build.mjs testcontrol --out PATH
//
// The Go binary is taken from COVE_GO, else `go` on PATH, and must report exactly the
// version on go.mod's `go` line: GOTOOLCHAIN=local stops Go from downloading another
// toolchain behind our back. Builds are static (CGO_ENABLED=0) and reproducible
// (-trimpath), and tests use the same feature tags as the shipped binary.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const moduleDir = join(root, "native/tailscale");
const buildVar = "github.com/GhostFlying/cove/native/tailscale/internal/buildinfo.Build";

// Tailscale features compiled out of cove-tsnet. peerapiserver is required, not an
// optimization: it would otherwise serve the PeerAPI on every node, and neither node
// may listen on anything but the ports Cove asks for (M2 threat model, S8/S9).
// logtail and netlog are omitted so no logs are uploaded to Tailscale; c2n so the control
// plane cannot query the node over the control connection; oauthkey and
// identityfederation so an auth key is only ever used as given. The rest are features
// Cove does not use (SSH, Taildrop, Drive, the web client, peer relay, exit nodes and
// subnet routes, OS integration, TPM-sealed state); leaving them out shrinks the binary
// and the reachable surface. `serve` and `acme` stay because tsnet itself requires them.
// A feature can only be omitted together with every feature that depends on it
// (tailscale.com/feature/featuretags).
export const omittedFeatures = Object.freeze([
  "advertiseexitnode",
  "advertiseroutes",
  "androidbin",
  "androiddns",
  "appconnectors",
  "aws",
  "bird",
  "c2n",
  "capture",
  "clientupdate",
  "colorable",
  "completion",
  "completion_scripts",
  "conn25",
  "dbus",
  "debugeventbus",
  "debugportmapper",
  "desktop_sessions",
  "doctor",
  "drive",
  "favorites",
  "flashappliance",
  "hujsonconf",
  "identityfederation",
  "iptables",
  "kube",
  "linuxdnsfight",
  "logtail",
  "netlog",
  "networkmanager",
  "oauthkey",
  "osrouter",
  "outboundproxy",
  "peerapiserver",
  "portlist",
  "posture",
  "qrcodes",
  "relayserver",
  "remoteconfig",
  "resolved",
  "sdnotify",
  "serviceclientprefs",
  "ssh",
  "synology",
  "syslog",
  "systray",
  "taildrop",
  "tap",
  "tpm",
  "tundevstats",
  "wakeonlan",
  "webbrowser",
  "webclient",
]);

export const buildIdPattern = /^[A-Za-z0-9.+_-]{1,128}$/;
const testBuildId = "0.0.0-e2e+tsnet_test.1";

export const buildTags = omittedFeatures.map((feature) => `ts_omit_${feature}`).join(",");

export function pinnedGoVersion() {
  const mod = readFileSync(join(moduleDir, "go.mod"), "utf8");
  const match = /^go (\d+\.\d+\.\d+)$/m.exec(mod);
  if (!match) throw new Error("native/tailscale/go.mod has no exact `go x.y.z` line");
  return `go${match[1]}`;
}

function goEnv(extra = {}) {
  return { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: "-mod=readonly", ...extra };
}

function run(go, args, env) {
  const result = spawnSync(go, args, { cwd: moduleDir, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`go ${args[0]} exited ${result.status ?? result.signal}`);
  }
}

function checkedGo() {
  const go = process.env.COVE_GO || "go";
  const result = spawnSync(go, ["env", "GOVERSION"], {
    cwd: moduleDir,
    env: goEnv(),
    encoding: "utf8",
  });
  if (result.error) throw new Error(`cannot run ${go}: ${result.error.message}`);
  const version = result.stdout.trim();
  const pinned = pinnedGoVersion();
  if (result.status !== 0 || version !== pinned) {
    throw new Error(
      `cove-tsnet needs Go ${pinned}; ${go} reports ${version || result.stderr.trim()}`,
    );
  }
  return go;
}

const goarchByNode = { arm64: "arm64", x64: "amd64" };

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!["--goos", "--goarch", "--build", "--out"].includes(name) || args[i + 1] === undefined) {
      throw new Error(`unknown or incomplete option ${name}`);
    }
    flags[name.slice(2)] = args[i + 1];
  }
  return flags;
}

export function defaultOutput(goos, goarch) {
  return join(moduleDir, "dist", `${goos}-${goarch}`, "cove-tsnet");
}

function build(args) {
  const flags = parseFlags(args);
  const goos = flags.goos ?? process.platform;
  const goarch = flags.goarch ?? goarchByNode[process.arch];
  if (!["darwin", "linux"].includes(goos) || !["arm64", "amd64"].includes(goarch)) {
    throw new Error(`unsupported target ${goos}/${goarch}`);
  }
  const out = resolve(flags.out ?? defaultOutput(goos, goarch));
  const ldflags = ["-s", "-w"];
  if (flags.build !== undefined) {
    // One token of safe characters: it is spliced into -ldflags unquoted and must match
    // proto.ValidBuild, which the binary enforces at startup.
    if (!buildIdPattern.test(flags.build)) {
      throw new Error(`--build must match ${buildIdPattern}: ${JSON.stringify(flags.build)}`);
    }
    ldflags.push(`-X ${buildVar}=${flags.build}`);
  }
  run(
    checkedGo(),
    [
      "build",
      "-trimpath",
      "-tags",
      buildTags,
      "-ldflags",
      ldflags.join(" "),
      "-o",
      out,
      "./cmd/cove-tsnet",
    ],
    goEnv({ CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch }),
  );
  console.log(`${out} (${goos}/${goarch}, ${statSync(out).size} bytes)`);
}

function checkFormatted(go) {
  const goroot = spawnSync(go, ["env", "GOROOT"], { env: goEnv(), encoding: "utf8" }).stdout.trim();
  const result = spawnSync(join(goroot, "bin", "gofmt"), ["-l", "."], {
    cwd: moduleDir,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout.trim() !== "") {
    throw new Error(`gofmt reports unformatted files:\n${result.stdout}${result.stderr}`);
  }
}

// The end-to-end tests launch the compiled binary, so `test` builds it first for the host
// and hands its path to them in COVE_TSNET_BIN.
function test(args) {
  const go = checkedGo();
  const dir = mkdtempSync(join(tmpdir(), "cove-tsnet-test-"));
  try {
    const bin = join(dir, "cove-tsnet");
    // An injected build identity lets the tests check that version and hello echo it.
    build(["--out", bin, "--build", testBuildId]);
    checkFormatted(go);
    run(go, ["vet", "-tags", buildTags, "./..."], goEnv({ CGO_ENABLED: "0" }));
    const packages = args.some((arg) => arg.startsWith("./")) ? [] : ["./..."];
    run(
      go,
      ["test", "-tags", buildTags, ...args, ...packages],
      goEnv({ CGO_ENABLED: "0", COVE_TSNET_BIN: bin, COVE_TSNET_BUILD: testBuildId }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The test tailnet command (cmd/cove-tsnet-testcontrol) for tests outside the Go module, such as
// the CLI's tsnet scenarios. Test-only: it is built only here, into the path the caller names,
// never by `build`, so it is not part of dist/ or of an installed runtime closure. Same tags as
// cove-tsnet, so the tailnet it runs matches the one the Go end-to-end tests use.
function testcontrol(args) {
  const flags = parseFlags(args);
  if (flags.out === undefined || Object.keys(flags).length !== 1) {
    throw new Error("usage: tsnet-build.mjs testcontrol --out PATH");
  }
  const out = resolve(flags.out);
  run(
    checkedGo(),
    ["build", "-trimpath", "-tags", buildTags, "-o", out, "./cmd/cove-tsnet-testcontrol"],
    goEnv({ CGO_ENABLED: "0" }),
  );
  console.log(`${out} (test control plane)`);
}

// Compare real paths: import.meta.url has symlinks resolved, so a script reached through a
// symlinked directory (macOS /tmp, for one) would otherwise do nothing and exit 0.
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "build") build(rest);
    else if (command === "test") test(rest);
    else if (command === "testcontrol") testcontrol(rest);
    else throw new Error("usage: tsnet-build.mjs build|test|testcontrol [options]");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
