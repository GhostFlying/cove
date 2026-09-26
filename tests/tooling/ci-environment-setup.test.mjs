import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runRecordedSetup } from "../../scripts/ci-environment-setup.mjs";
import { prepareNodePty } from "../../scripts/node-pty-install.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function isolatedDirectory() {
  const path = await mkdtemp(join(tmpdir(), "cove-setup-test-"));
  directories.push(path);
  return path;
}

test("records a failed setup command before rejecting it", async () => {
  const directory = await isolatedDirectory();
  await expect(
    runRecordedSetup(
      "install",
      process.execPath,
      ["--eval", "process.exit(7)"],
      directory,
      directory,
    ),
  ).rejects.toThrow(/exited 7/);
  const record = JSON.parse(await readFile(join(directory, "install.json"), "utf8"));
  expect(record).toMatchObject({ stage: "install", exitCode: 7, errorCode: null, timedOut: false });
});

test("records timeout and spawn errors before propagating", async () => {
  const directory = await isolatedDirectory();
  await expect(
    runRecordedSetup(
      "browser",
      process.execPath,
      ["--eval", "setInterval(() => {}, 1000)"],
      directory,
      directory,
      50,
    ),
  ).rejects.toMatchObject({ code: "ETIMEDOUT" });
  expect(JSON.parse(await readFile(join(directory, "browser.json"), "utf8"))).toMatchObject({
    timedOut: true,
    errorCode: "ETIMEDOUT",
  });
  await expect(
    runRecordedSetup("native", join(directory, "absent"), [], directory, directory),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(join(directory, "native.json"), "utf8"))).toMatchObject({
    errorCode: "ENOENT",
  });
});

test("native helper repair isolates the checkout from a hardlinked package source", async () => {
  const directory = await isolatedDirectory();
  const packageRoot = join(directory, "node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty");
  const native = join(packageRoot, "build", "Release", "pty.node");
  const helper = join(packageRoot, "build", "Release", "spawn-helper");
  const source = join(directory, "store-helper");
  await mkdir(join(packageRoot, "build", "Release"), { recursive: true });
  await mkdir(join(directory, "patches"));
  await writeFile(join(directory, "patches/node-pty@1.1.0.patch"), "native fixture patch");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: "1.1.0" }));
  await writeFile(native, "native fixture");
  await writeFile(source, "helper fixture", { mode: 0o644 });
  await link(source, helper);
  const lookup = () => ({ native: { coveBoundedWriterVersion: 1 } });
  lookup.resolve = () => join(packageRoot, "package.json");
  lookup.cache = { [await realpath(native)]: {} };
  let result;
  let failure;
  try {
    result = await prepareNodePty(lookup, directory);
  } catch (error) {
    failure = error;
  }
  if (process.platform === "darwin" && failure) throw failure;
  expect(result?.repaired).toBe(process.platform === "darwin");
  expect(failure).toBeUndefined();
  expect((await stat(source)).mode & 0o777).toBe(0o644);
  expect((await stat(helper)).ino === (await stat(source)).ino).toBe(process.platform !== "darwin");
  expect(result?.nativeSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result?.patchSha256).toMatch(/^[0-9a-f]{64}$/);
});

test("native preparation rejects a stock addon before treating it as usable", async () => {
  const directory = await isolatedDirectory();
  const packageRoot = join(directory, "node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty");
  const native = join(packageRoot, "prebuilds", "darwin-arm64", "pty.node");
  await mkdir(join(packageRoot, "prebuilds", "darwin-arm64"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: "1.1.0" }));
  await writeFile(native, "stock addon fixture");
  const lookup = () => ({ native: {} });
  lookup.resolve = () => join(packageRoot, "package.json");
  lookup.cache = { [await realpath(native)]: {} };
  await expect(prepareNodePty(lookup, directory)).rejects.toThrow(/capability/);
});
