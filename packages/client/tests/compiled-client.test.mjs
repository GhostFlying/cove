import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const repository = resolve(import.meta.dirname, "../../..");
const client = process.env.COVE_CLIENT_PACKAGE_ROOT ?? join(repository, "packages/client");
const protocol = join(repository, "packages/protocol");
const compiler = join(repository, "node_modules/typescript/bin/tsc");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function isolatedConsumer(source) {
  const directory = await mkdtemp(join(tmpdir(), "cove-client-consumer-"));
  temporaryDirectories.push(directory);
  const scope = join(directory, "node_modules/@cove");
  await mkdir(scope, { recursive: true });
  await symlink(client, join(scope, "client"), "dir");
  await symlink(protocol, join(scope, "protocol"), "dir");
  await mkdir(join(directory, "node_modules"), { recursive: true });
  await symlink(join(protocol, "node_modules/zod"), join(directory, "node_modules/zod"), "dir");
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
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["consumer.mts"],
    }),
  );
  await writeFile(join(directory, "consumer.mts"), source);
  return directory;
}

function compile(directory) {
  return spawnSync(process.execPath, [compiler, "-p", directory], {
    cwd: directory,
    encoding: "utf8",
    timeout: 20_000,
  });
}

test("isolated ES-only consumer imports typed RPC and preview outcomes from public entries", async () => {
  const directory = await isolatedConsumer(`
import { createClient, type Client, type ClientOptions, type ParamsFor, type PreviewOutcome, type ResultFor } from '@cove/client';
import type { RunRef } from '@cove/protocol/identity';
declare const options: ClientOptions;
declare const run: RunRef;
const client: Client = createClient(options);
const params: ParamsFor<'terminal.list'> = { limit: 1 };
const result: Promise<{ ok: boolean }> = client.call('terminal.list', params);
const preview: Promise<PreviewOutcome> = client.getPreview(run, 1);
async function readPreview(): Promise<number> {
  const outcome: PreviewOutcome = await preview;
  if (!outcome.ok) {
    const uncertain: boolean = outcome.uncertain;
    return uncertain ? 1 : 0;
  }
  if (outcome.status === 'unchanged') return outcome.version;
  const bytes: Uint8Array = outcome.bytes;
  const atSeq: number = outcome.atSeq;
  const generatedAtMs: number = outcome.generatedAtMs;
  return bytes.byteLength + atSeq + generatedAtMs;
}
declare const typed: ResultFor<'terminal.list'>;
void typed; void result; void readPreview;
`);
  const result = compile(directory);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  expect(result.status).toBe(0);
});

test("isolated runtime follows the current fixture manifest, accepts optional fields, and rejects unknown required variants", async () => {
  const fixtureRoot = join(repository, "tests/fixtures/protocol/m0");
  const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));
  expect(manifest.schemaVersion).toBe(2);
  for (const [name, expected] of Object.entries(manifest.files)) {
    const actual = createHash("sha256")
      .update(await readFile(join(fixtureRoot, name)))
      .digest("hex");
    expect(actual).toBe(expected);
  }
  const journey = JSON.parse(await readFile(join(fixtureRoot, "admission-rpc.json"), "utf8"));
  const directory = await mkdtemp(join(tmpdir(), "cove-client-runtime-"));
  temporaryDirectories.push(directory);
  const scope = join(directory, "node_modules/@cove");
  await mkdir(scope, { recursive: true });
  await symlink(client, join(scope, "client"), "dir");
  await symlink(protocol, join(scope, "protocol"), "dir");
  await writeFile(
    join(directory, "runtime.mjs"),
    `
import { createClient } from '@cove/client';
import { M0_CAPABILITIES, PROTOCOL_VERSION } from '@cove/protocol/bootstrap';
import { M0_LIMITS } from '@cove/protocol/budgets';
import { BASELINE_ENCODING, PROFILE } from '@cove/protocol/profile';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const fixture = ${JSON.stringify(journey)};
let phase = 0;
const success = (terminal) => ({
  type: 'cove-bootstrap-result', bootstrapVersion: 1,
  serverId: fixture.server.serverId, relayInstanceId: fixture.server.relayInstanceId,
  protocolVersion: PROTOCOL_VERSION, buildVersion: fixture.server.buildVersion,
  capabilities: [...M0_CAPABILITIES], profile: PROFILE, encoding: BASELINE_ENCODING,
  effectiveBudgets: M0_LIMITS, futureOptionalV1: fixture.optionalField.futureOptionalV1,
  ...(terminal ? { connection: { connectionId: 'fixture-connection', generation: phase + 1 } } : {}),
});
const terminal = {
  open(callbacks) {
    const connection = {
      send() {
        const value = phase === 0 ? success(true) : { ...success(true), type: 'future-bootstrap-result' };
        callbacks.onText(encoder.encode(JSON.stringify(value)));
        return 'handed-off';
      },
      close() {}, dispose() {},
    };
    callbacks.onOpen(connection);
    return { cancel: () => 'not-sent' };
  },
};
const http = {
  post(request, callbacks) {
    callbacks.onDisposition('handed-off');
    callbacks.onResponse({ status: 200, headers: {}, body: encoder.encode(JSON.stringify(success(false))) });
    return { cancel: () => 'handed-off' };
  },
};
const client = createClient({
  expectedServerId: fixture.server.serverId,
  expectedRelayInstanceId: fixture.server.relayInstanceId,
  buildVersion: fixture.clientBuild,
  credentials: () => ({ authorization: 'fixture-private', terminalSecret: 'a'.repeat(43) }),
  codec: { encode: (text) => encoder.encode(text), decodeFatal: (bytes) => decoder.decode(bytes) },
  createOpaqueId: () => 'fixture-request',
  scheduler: { nowMs: () => 0, setTimer: () => ({ dispose() {} }), yieldTurn: async () => {} },
  http, terminal,
});
const accepted = await client.connect();
phase = 1;
const rejected = await client.reconnect();
console.log(JSON.stringify({ accepted: accepted.ok, rejected: rejected.ok, status: client.snapshot().status }));
`,
  );
  const result = spawnSync(process.execPath, [join(directory, "runtime.mjs")], {
    cwd: directory,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  expect(JSON.parse(result.stdout)).toEqual({
    accepted: true,
    rejected: false,
    status: "incompatible",
  });
});

test("emitted client declarations remain ES-only when promoted to checked source", async () => {
  const directory = await isolatedConsumer(
    `import type { ClientOptions } from '@cove/client'; declare const value: ClientOptions; void value;`,
  );
  const promoted = join(directory, "promoted");
  await mkdir(promoted);
  for (const entry of await readdir(join(client, "dist"))) {
    if (!entry.endsWith(".d.ts")) continue;
    await writeFile(
      join(promoted, entry.replace(/\.d\.ts$/, ".ts")),
      await readFile(join(client, "dist", entry), "utf8"),
    );
  }
  const config = JSON.parse(await readFile(join(directory, "tsconfig.json"), "utf8"));
  config.include.push("promoted/**/*.ts");
  await writeFile(join(directory, "tsconfig.json"), JSON.stringify(config));
  const result = compile(directory);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  expect(result.status).toBe(0);
});

test("private and host-specific imports fail through the package boundary", async () => {
  const privateConsumer = await isolatedConsumer(
    `export { createClient } from '@cove/client/src/client.js';`,
  );
  const privateResult = compile(privateConsumer);
  expect(privateResult.status).not.toBe(0);
  expect(privateResult.stdout + privateResult.stderr).toContain("TS2307");

  const hostConsumer = await isolatedConsumer(
    `import type { ClientOptions } from '@cove/client'; declare const leaked: ClientOptions & { socket: WebSocket; signal: AbortSignal }; void leaked;`,
  );
  const hostResult = compile(hostConsumer);
  expect(hostResult.status).not.toBe(0);
  expect(hostResult.stdout + hostResult.stderr).toMatch(/WebSocket|AbortSignal/);

  const untypedCall = await isolatedConsumer(`
import { createClient, type ClientOptions } from '@cove/client';
declare const options: ClientOptions;
createClient(options).call('terminal.list', { limit: 'unbounded' });
`);
  const untypedResult = compile(untypedCall);
  expect(untypedResult.status).not.toBe(0);
  expect(untypedResult.stdout + untypedResult.stderr).toContain("TS2322");
});
