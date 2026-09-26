import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const engine = join(root, "packages/terminal-engine");
const web = join(root, "packages/terminal-web");
const protocol = join(root, "packages/protocol");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function assertDependencyBoundary(
  engineManifest: { dependencies: Record<string, string>; exports: Record<string, unknown> },
  webManifest: { dependencies: Record<string, string>; exports: Record<string, unknown> },
  protocolManifest: { dependencies: Record<string, string>; exports: Record<string, unknown> },
) {
  if (
    Object.keys(engineManifest.exports).sort().join() !==
    ".,./probes/environment,./probes/recovery-boundaries"
  )
    throw new Error("Engine exports escaped the adapter and experiment boundary");
  if (
    Object.keys(webManifest.exports).sort().join() !== "./probes/environment,./probes/query-input"
  )
    throw new Error("Web exports more than its experiment");
  if (
    Object.keys(engineManifest.dependencies).sort().join() !==
    "@cove/protocol,@xterm/addon-serialize,@xterm/headless"
  )
    throw new Error("Engine runtime dependency escaped Node boundary");
  if (engineManifest.dependencies["@cove/protocol"] !== "workspace:*")
    throw new Error("Engine protocol dependency lost workspace linkage");
  if (
    Object.keys(webManifest.dependencies).sort().join() !== "@cove/protocol,@xterm/xterm" ||
    webManifest.dependencies["@cove/protocol"] !== "workspace:*"
  )
    throw new Error("Web runtime dependency escaped browser boundary");
  if (
    Object.keys(protocolManifest.dependencies).join() !== "zod" ||
    protocolManifest.dependencies.zod !== "catalog:"
  )
    throw new Error("Protocol runtime dependency escaped pure boundary");
  if (
    Object.keys(protocolManifest.exports).sort().join() !==
    "./bootstrap,./budgets,./errors,./identity,./pipe,./profile,./provisional/pipe,./provisional/terminal,./rpc,./runtime,./terminal,./view"
  )
    throw new Error("Protocol exports escaped the supported contract boundary");
}

test("real package manifests stay within their execution environments", async () => {
  const engineManifest = JSON.parse(await readFile(join(engine, "package.json"), "utf8"));
  const webManifest = JSON.parse(await readFile(join(web, "package.json"), "utf8"));
  const protocolManifest = JSON.parse(await readFile(join(protocol, "package.json"), "utf8"));
  assertDependencyBoundary(engineManifest, webManifest, protocolManifest);
  expect(() =>
    assertDependencyBoundary(
      engineManifest,
      {
        ...webManifest,
        dependencies: { ...webManifest.dependencies, "node-pty": "1.1.0" },
      },
      protocolManifest,
    ),
  ).toThrow(/Web runtime dependency/);
  expect(() =>
    assertDependencyBoundary(engineManifest, webManifest, {
      ...protocolManifest,
      dependencies: { zod: "catalog:", "node:fs": "1" },
    }),
  ).toThrow(/Protocol runtime dependency/);
  const browserAssets = await readdir(join(web, "dist/browser/assets"));
  expect(browserAssets.some((asset) => asset.endsWith(".js"))).toBe(true);
  expect(browserAssets.some((asset) => asset.endsWith(".css"))).toBe(true);
});

test("Vite rejects side-effect, dynamic, native, and transitive Node imports in isolated builds", async () => {
  const variants = [
    { name: "side-effect", main: 'import "node:fs";' },
    { name: "dynamic", main: 'await import("node:child_process");' },
    { name: "native", main: 'import "node-pty";' },
    { name: "transitive", main: 'import "./nested.ts";', nested: 'import "node:fs";' },
  ];
  for (const variant of variants) {
    const directory = await mkdtemp(join(tmpdir(), `cove-browser-${variant.name}-`));
    directories.push(directory);
    await writeFile(
      join(directory, "index.html"),
      '<script type="module" src="./main.ts"></script>',
    );
    await writeFile(join(directory, "main.ts"), variant.main);
    if (variant.nested) await writeFile(join(directory, "nested.ts"), variant.nested);
    const built = spawnSync(
      process.execPath,
      [
        join(web, "node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        join(web, "probes/vite.config.mjs"),
      ],
      {
        cwd: web,
        env: {
          ...process.env,
          COVE_PROBE_BROWSER_ROOT: directory,
          COVE_PROBE_BROWSER_OUT: join(directory, "dist"),
        },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(built.status).not.toBe(0);
    expect(`${built.stdout}${built.stderr}`).toMatch(/Browser bundle rejects Node\/native import/);
  }
});

test("isolated compiled consumer sees supported exports and ES-only Cove declarations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cove-boundary-consumer-"));
  directories.push(directory);
  const scope = join(directory, "node_modules/@cove");
  await mkdir(scope, { recursive: true });
  await symlink(engine, join(scope, "terminal-engine"), "dir");
  await symlink(web, join(scope, "terminal-web"), "dir");
  await symlink(protocol, join(scope, "protocol"), "dir");
  await mkdir(join(directory, "node_modules"), { recursive: true });
  await symlink(join(protocol, "node_modules/zod"), join(directory, "node_modules/zod"), "dir");
  const declarations = join(directory, "promoted-declarations");
  await mkdir(declarations);
  await writeFile(join(declarations, "package.json"), '{"type":"module"}');
  const declarationNames = ["errors", "frame", "identity", "pipe", "terminal"];
  const emitted = (await readdir(join(protocol, "dist/provisional")))
    .filter((name) => name.endsWith(".d.ts"))
    .sort();
  expect(emitted).toEqual(declarationNames.map((name) => `${name}.d.ts`).sort());
  for (const name of declarationNames) {
    await writeFile(
      join(declarations, `${name}.ts`),
      await readFile(join(protocol, `dist/provisional/${name}.d.ts`), "utf8"),
    );
  }
  const promotedM0 = join(declarations, "m0");
  async function promoteDeclarations(source: string, target: string): Promise<void> {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isDirectory())
        await promoteDeclarations(join(source, entry.name), join(target, entry.name));
      else if (entry.name.endsWith(".d.ts"))
        await writeFile(
          join(target, entry.name.replace(/\.d\.ts$/, ".ts")),
          await readFile(join(source, entry.name), "utf8"),
        );
    }
  }
  await promoteDeclarations(join(protocol, "dist"), promotedM0);
  const promotedEngine = join(declarations, "engine");
  await mkdir(promotedEngine);
  await writeFile(
    join(promotedEngine, "terminal-model.ts"),
    await readFile(join(engine, "dist/src/terminal-model.d.ts"), "utf8"),
  );
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
        // Zod 4.6.5's unused URL helpers require DOM types; copied Cove declarations
        // are .ts sources and remain fully checked under this setting.
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["consumer.mts", "promoted-declarations/**/*.ts"],
    }),
  );
  await writeFile(
    join(directory, "consumer.mts"),
    `import type { EngineProbeResult } from '@cove/terminal-engine/probes/environment';
import type { TerminalModel, EngineBaseline, EnginePreview, EngineState } from '@cove/terminal-engine';
import type { WebProbeResult } from '@cove/terminal-web/probes/environment';
import type { TerminalMetadata } from '@cove/protocol/provisional/terminal';
import type { PipeMetadata } from '@cove/protocol/provisional/pipe';
import type { BootstrapSuccess } from '@cove/protocol/bootstrap';
import type { EffectiveBudgets } from '@cove/protocol/budgets';
import type { DomainError } from '@cove/protocol/errors';
import type { SubscriptionRef } from '@cove/protocol/identity';
import type { PipeMetadata as SupportedPipeMetadata } from '@cove/protocol/pipe';
import type { Appearance } from '@cove/protocol/profile';
import type { OperationRecord } from '@cove/protocol/rpc';
import type { RuntimeTerminalPort } from '@cove/protocol/runtime';
import type { TerminalMetadata as SupportedTerminalMetadata } from '@cove/protocol/terminal';
import type { TerminalView } from '@cove/protocol/view';
declare const engine: EngineProbeResult;
declare const adapter: TerminalModel;
declare const adapterResults: [EngineBaseline, EnginePreview, EngineState];
void adapter;
void adapterResults;
declare const web: WebProbeResult;
const tuple: [string, string] = [engine.roundTrip, web.input];
declare const terminal: TerminalMetadata;
declare const pipe: PipeMetadata;
void terminal;
void pipe;
declare const supported: [BootstrapSuccess, EffectiveBudgets, DomainError, SubscriptionRef, SupportedPipeMetadata, Appearance, OperationRecord, RuntimeTerminalPort, SupportedTerminalMetadata, TerminalView];
void supported;
declare const result: Awaited<ReturnType<RuntimeTerminalPort['spawn']>>;
const runtime: RuntimeTerminalPort = {
  spawn: async () => result, stop: async () => result, setControl: async () => result,
  writeInput: async () => result, resize: async () => result,
  setAppearance: async () => result, openSubscription: async () => result,
  closeSubscription: async () => result, ackApplied: async () => result,
  ackBaselineProgress: async () => result, getStatus: async () => result,
  refreshPreview: async () => result, onEvent: () => ({ dispose() {} }),
};
const view: TerminalView = {
  initialize: async () => {}, beginBaseline: async () => {},
  writeBaselineChunk: async () => {}, finishBaseline: async () => {},
  applyEvent: async () => {}, measureGrid: () => ({ cols: 80, rows: 24 }),
  setAppearance() {}, setVisibility() {},
  onInputIntent: () => ({ dispose() {} }),
  onFocusIntent: () => ({ dispose() {} }),
  onFailure: () => ({ dispose() {} }), dispose() {},
};
void runtime;
void view;
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
  const terminalDeclaration = join(promotedM0, "terminal.ts");
  const original = await readFile(terminalDeclaration, "utf8");
  await writeFile(terminalDeclaration, `${original}\nexport declare const leakedHostType: URL;\n`);
  const leaked = spawnSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", directory],
    { cwd: directory, encoding: "utf8", timeout: 20_000 },
  );
  expect(leaked.status).not.toBe(0);
  expect(`${leaked.stdout}${leaked.stderr}`).toMatch(/Cannot find name 'URL'/);
  await writeFile(terminalDeclaration, original);
  await writeFile(
    join(directory, "consumer.mjs"),
    `import { runEnvironmentProbe as engine } from '@cove/terminal-engine/probes/environment';
import { createTerminalModel } from '@cove/terminal-engine';
import { runEnvironmentProbe as web } from '@cove/terminal-web/probes/environment';
import { TerminalMetadataSchema } from '@cove/protocol/provisional/terminal';
import { PipeMetadataSchema } from '@cove/protocol/provisional/pipe';
import { BootstrapRequestSchema } from '@cove/protocol/bootstrap';
import { PipeCommandSchema } from '@cove/protocol/pipe';
import { RpcRequestSchema } from '@cove/protocol/rpc';
if (typeof engine !== 'function' || typeof web !== 'function' || typeof createTerminalModel !== 'function') throw new Error('Compiled exports missing');
if (!TerminalMetadataSchema || !PipeMetadataSchema || !BootstrapRequestSchema || !PipeCommandSchema || !RpcRequestSchema) throw new Error('Protocol exports missing');
for (const name of ['@cove/terminal-engine/probes/pty-child', '@cove/terminal-web/dist/probes/node/environment', '@cove/protocol', '@cove/protocol/src/provisional/identity']) {
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

test("compiled export removal fails in an isolated consumer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cove-missing-export-"));
  directories.push(directory);
  const packagePath = join(directory, "node_modules/@cove/protocol");
  await mkdir(packagePath, { recursive: true });
  await writeFile(
    join(packagePath, "package.json"),
    JSON.stringify({
      name: "@cove/protocol",
      type: "module",
      exports: { "./provisional/terminal": "./dist/provisional/missing.js" },
    }),
  );
  await writeFile(join(directory, "consumer.mjs"), 'import "@cove/protocol/provisional/terminal";');
  const result = spawnSync(process.execPath, [join(directory, "consumer.mjs")], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/ERR_MODULE_NOT_FOUND/);
});
