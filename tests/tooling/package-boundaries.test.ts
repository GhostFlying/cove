import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const engine = join(root, "packages/terminal-engine");
const web = join(root, "packages/terminal-web");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function assertDependencyBoundary(
  engineManifest: { dependencies: Record<string, string>; exports: Record<string, unknown> },
  webManifest: { dependencies: Record<string, string>; exports: Record<string, unknown> },
  browserSource: string,
) {
  if (Object.keys(engineManifest.exports).join() !== "./probes/environment")
    throw new Error("Engine exports more than its experiment");
  if (Object.keys(webManifest.exports).join() !== "./probes/environment")
    throw new Error("Web exports more than its experiment");
  if (
    Object.keys(engineManifest.dependencies).sort().join() !==
    "@xterm/addon-serialize,@xterm/headless"
  )
    throw new Error("Engine runtime dependency escaped Node boundary");
  if (Object.keys(webManifest.dependencies).join() !== "@xterm/xterm")
    throw new Error("Web runtime dependency escaped browser boundary");
  if (/from\s+["'](?:node:|node-pty|@xterm\/headless)/.test(browserSource))
    throw new Error("Browser source imports a Node or native module");
}

test("real package graphs and browser source stay within their execution environments", async () => {
  const engineManifest = JSON.parse(await readFile(join(engine, "package.json"), "utf8"));
  const webManifest = JSON.parse(await readFile(join(web, "package.json"), "utf8"));
  const browserSource = await readFile(join(web, "probes/browser/main.ts"), "utf8");
  assertDependencyBoundary(engineManifest, webManifest, browserSource);
  expect(() =>
    assertDependencyBoundary(
      engineManifest,
      { ...webManifest, dependencies: { ...webManifest.dependencies, "node-pty": "1.1.0" } },
      browserSource,
    ),
  ).toThrow(/Web runtime dependency/);
  expect(() =>
    assertDependencyBoundary(
      engineManifest,
      webManifest,
      `${browserSource}\nimport { readFile } from "node:fs";`,
    ),
  ).toThrow(/Browser source/);
  const browserAssets = await readdir(join(web, "dist/browser/assets"));
  expect(browserAssets.some((asset) => asset.endsWith(".js"))).toBe(true);
  expect(browserAssets.some((asset) => asset.endsWith(".css"))).toBe(true);
});

test("isolated compiled consumer sees only experimental exports and emitted declarations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cove-boundary-consumer-"));
  directories.push(directory);
  const scope = join(directory, "node_modules/@cove");
  await mkdir(scope, { recursive: true });
  await symlink(engine, join(scope, "terminal-engine"), "dir");
  await symlink(web, join(scope, "terminal-web"), "dir");
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        lib: ["ES2024"],
        strict: true,
        types: [],
        noEmit: true,
      },
      include: ["consumer.mts"],
    }),
  );
  await writeFile(
    join(directory, "consumer.mts"),
    `import type { EngineProbeResult } from '@cove/terminal-engine/probes/environment';
import type { WebProbeResult } from '@cove/terminal-web/probes/environment';
declare const engine: EngineProbeResult;
declare const web: WebProbeResult;
const tuple: [string, string] = [engine.roundTrip, web.input];
void tuple;
`,
  );
  const tsc = spawnSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", directory],
    { cwd: directory, encoding: "utf8", timeout: 20_000 },
  );
  if (tsc.status !== 0) throw new Error(tsc.stderr || tsc.stdout);
  expect(tsc.status).toBe(0);
  await writeFile(
    join(directory, "consumer.mjs"),
    `import { runEnvironmentProbe as engine } from '@cove/terminal-engine/probes/environment';
import { runEnvironmentProbe as web } from '@cove/terminal-web/probes/environment';
if (typeof engine !== 'function' || typeof web !== 'function') throw new Error('Compiled exports missing');
for (const name of ['@cove/terminal-engine/probes/pty-child', '@cove/terminal-web/dist/probes/node/environment']) {
  try { await import(name); throw new Error('Private import succeeded: ' + name); }
  catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }
}
`,
  );
  const runtime = spawnSync(process.execPath, [join(directory, "consumer.mjs")], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (runtime.status !== 0) throw new Error(runtime.stderr || runtime.stdout);
  expect(runtime.status).toBe(0);
});
