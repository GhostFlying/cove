import { execFile, spawn } from "node:child_process";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { waitFor } from "../recording-view.mjs";
import { isolatedEnv } from "../test-env.mjs";
import { installLayout } from "../../dist/install/layout.js";

// Shared by the m2 S1 and S2 scenarios (install, service, restart impact): building sealed runtime
// closures, variants of them, and leaving no service unit behind.
//
// The service parts register a real user service: a LaunchAgent in this user's gui domain or a
// systemd user unit, named after the test's temporary data directory (layout.ts), so they never
// share a name with the operator's service. They run only with COVE_TEST_SERVICE_MANAGER=1,
// which CI sets after preparing the service manager; .github/workflows/check.yml.

export const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const closureScript = join(repositoryRoot, "scripts", "runtime-closure.mjs");

export const serviceTests = process.env.COVE_TEST_SERVICE_MANAGER === "1";

// The service manager the scenarios expect on this platform.
export const expectedManager = process.platform === "darwin" ? "launchd-agent" : "systemd-user";

function run(command, args, options) {
  return new Promise((done) =>
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) =>
      done({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    ),
  );
}

// The closure build runs pnpm, Go and the closure's smoke check, never Cove against a data
// directory. It keeps the operator's HOME so that pnpm and Go find their stores and caches.
function buildEnv(root, extra = {}) {
  return isolatedEnv(join(root, "build-home"), { HOME: homedir(), ...extra });
}

async function closureCommand(root, args, extraEnv = {}) {
  const result = await run(process.execPath, [closureScript, ...args], {
    env: buildEnv(root, extraEnv),
    timeout: 600_000,
  });
  if (result.code !== 0)
    throw new Error(`runtime-closure ${args[0]} failed (${result.code}): ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// A sealed closure of this checkout at `<root>/<name>`: { dir, build, schemaVersion, ... }.
export function buildClosure(root, name = "closure") {
  return closureCommand(root, ["build", "--out", join(root, name)]);
}

// Another build: a copy of `source` without its stamp, changed by `change(dir)`, sealed again
// (with `env` added to the sealing environment, which builds cove-tsnet).
export async function closureVariant(root, source, name, change, env = {}) {
  const dir = join(root, name);
  await cp(source, dir, { recursive: true, verbatimSymlinks: true });
  await rm(join(dir, "cove-install.json"));
  await change(dir);
  return { dir, ...(await closureCommand(root, ["seal", dir], env)) };
}

// A build whose server stops at the previous database schema: its last migration is removed, as
// in a build from before that migration was added.
export function olderSchemaVariant(root, source, name = "closure-older") {
  return closureVariant(root, source, name, async (dir) => {
    const path = join(dir, "app/node_modules/@cove/server/dist/store/migrations.js");
    const text = await readFile(path, "utf8");
    const older = text.replace(/\n\s*\{ version: \d+, [^\n]*\},(?=\n\]\);)/, "");
    if (older === text) throw new Error("could not remove the last migration");
    await writeFile(path, older);
  });
}

// A different build of the same code: one extra file changes the closure identity.
export function nextVariant(root, source, name = "closure-next") {
  return closureVariant(root, source, name, (dir) =>
    writeFile(join(dir, "app", "NEXT-BUILD"), `${name}\n`),
  );
}

// Removes the service unit of `home` however a scenario ended: `cove server uninstall --yes`
// first, then, if the unit is still known, directly by its unique name. Never touches another unit.
export async function removeService(fixture, home) {
  const result = await fixture.cove(["server", "uninstall", "--yes"], {
    home,
    timeoutMs: 120_000,
  });
  const layout = installLayout(home);
  if (process.platform === "darwin") {
    const target = `gui/${process.getuid()}/${layout.label}`;
    if ((await run("/bin/launchctl", ["print", target], {})).code === 0) {
      await run("/bin/launchctl", ["bootout", target], {});
      return `uninstall failed (${result.code}: ${result.stderr}); booted out ${target}`;
    }
  } else {
    const shown = await run(
      "systemctl",
      ["--user", "show", "-p", "LoadState", "--value", layout.systemdUnit],
      {},
    );
    if (shown.code === 0 && shown.stdout.trim() !== "not-found") {
      await run("systemctl", ["--user", "disable", "--now", layout.systemdUnit], {});
      await run("systemctl", ["--user", "reset-failed", layout.systemdUnit], {});
      return `uninstall failed (${result.code}: ${result.stderr}); disabled ${layout.systemdUnit}`;
    }
  }
  return result.code === 0 ? null : `uninstall exited ${result.code}: ${result.stderr}`;
}

export async function markerLines(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(Number);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// A task in a fresh repository; `tabs` running tabs whose command records its PID once in its own
// marker file and stays alive. `detach` also starts a `nohup sleep` that leaves the run's process
// group and records its PID. Returns the task and per tab { tabId, created, markers, detached }.
export async function liveRuns(fixture, home, name, count, { detach = false } = {}) {
  const clone = await fixture.gitRepo(`clones/${name}`);
  const repo = await fixture.coveJson(["repo", "register", clone.path], { home });
  const { task } = await fixture.coveJson(
    ["task", "create", name, "--checkout", repo.result.resource.id],
    { home },
  );
  const tabs = [];
  for (let index = 0; index < count; index++) {
    const markers = join(fixture.root, `${name}-${index}.markers`);
    const detached = join(fixture.root, `${name}-${index}.detached`);
    // Absolute paths: S1 runs a server whose PATH holds nothing but git.
    const script = detach
      ? `echo $$ >> '${markers}'; /usr/bin/nohup /bin/sleep 900 >/dev/null 2>&1 & echo $! > '${detached}'; exec /bin/sleep 600`
      : `echo $$ >> '${markers}'; exec /bin/sleep 600`;
    const created = await fixture.coveJson(
      [
        ...["tab", "create", task.taskId, "--operation-id", `${name}-tab-${index}`, "--"],
        ...["/bin/sh", "-c", script],
      ],
      { home },
    );
    await waitFor("the tab's command to start", async () => {
      if ((await markerLines(markers)).length !== 1) return false;
      return !detach || (await markerLines(detached)).length === 1;
    });
    for (const pid of await markerLines(markers)) await fixture.trackPid(pid);
    if (detach) for (const pid of await markerLines(detached)) await fixture.trackPid(pid);
    tabs.push({ tabId: created.operation.result.resource.id, created, markers, detached });
  }
  return { task, tabs };
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Runs `script` in a new shell that is its own process group leader, as a terminal or SSH session
// would; `kill()` ends the whole group with SIGKILL.
export function sessionShell(fixture, script) {
  const child = spawn("/bin/sh", ["-c", script], {
    env: fixture.env,
    detached: true,
    stdio: "ignore",
  });
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  return {
    pid: child.pid,
    exited,
    kill() {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    },
  };
}
