import { createHash } from "node:crypto";
import { fstatSync, readFileSync } from "node:fs";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  const lookup = () => ({
    native: { coveBoundedWriterVersion: 3 },
    checkBoundedPtySupport: () => ({ supported: true, contractVersion: 3 }),
  });
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

function binaryControlProgram(directory, bytes, exitCode = 0, tail = "") {
  return `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(resolve(directory, "birth.json"))}, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString(), argv: process.argv}));
    const pattern = Buffer.from([0,255,195,169,226,130,172,128,65]);
    for (const fd of [1,2]) {
      const data = Buffer.alloc(${bytes});
      for (let i=0; i<data.length; i++) data[i] = pattern[fd === 1 ? i % pattern.length : pattern.length - 1 - i % pattern.length];
      let offset = 0;
      while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
    }
    ${tail}
    process.exit(${exitCode});
  `;
}

async function binaryReplaySink(path, metadataFile) {
  const handle = await open(path, "wx");
  const observations = {
    chunks: 0,
    maxChunk: 0,
    backpressure: 0,
    drains: 0,
    metadataBeforeReplay: null,
  };
  const destination = new Writable({
    highWaterMark: 1024,
    write(chunk, encoding, callback) {
      if (observations.metadataBeforeReplay === null && metadataFile) {
        observations.metadataBeforeReplay = JSON.parse(readFileSync(metadataFile, "utf8"));
      }
      observations.chunks++;
      observations.maxChunk = Math.max(observations.maxChunk, chunk.length);
      (async () => {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new Error("Control replay write made no progress");
          offset += bytesWritten;
        }
      })().then(() => callback(), callback);
    },
  });
  const write = destination.write;
  destination.write = function (...args) {
    const accepted = write.apply(this, args);
    if (!accepted) observations.backpressure++;
    return accepted;
  };
  destination.on("drain", () => observations.drains++);
  return { destination, observations, close: () => handle.close() };
}

async function preserveBinaryControl(name, directory, observations) {
  let record;
  try {
    record = JSON.parse(await readFile(resolve(directory, "execution.json"), "utf8"))[0];
  } catch {
    try {
      record = JSON.parse(await readFile(resolve(directory, "check.json"), "utf8"));
    } catch {
      record = observations.attempt;
    }
  }
  observations.descriptors = {};
  for (const stream of ["stdout", "stderr"]) {
    const fd = record?.outputCapture?.[stream]?.fd;
    if (fd === null || fd === undefined) continue;
    try {
      fstatSync(fd);
      observations.descriptors[stream] = { fd, state: "OPEN" };
    } catch (error) {
      observations.descriptors[stream] = { fd, errorCode: error.code };
    }
  }
  if (record?.childPid > 0) {
    try {
      process.kill(record.childPid, 0);
      observations.child = { pid: record.childPid, state: "LIVE" };
    } catch (error) {
      observations.child = { pid: record.childPid, errorCode: error.code };
    }
  }
  await writeFile(
    resolve(directory, "observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
  if (process.env.COVE_CI_CAPTURE_CONTROL_OUTPUT) {
    const target = resolve(process.env.COVE_CI_CAPTURE_CONTROL_OUTPUT, name);
    await mkdir(dirname(target), { recursive: true });
    await cp(directory, target, { recursive: true, errorOnExist: true, force: false });
  }
}

function binaryControlExpected(bytes, reverse = false) {
  const pattern = [0, 255, 195, 169, 226, 130, 172, 128, 65];
  return Buffer.from(
    Array.from({ length: bytes }, (_, i) => pattern[reverse ? 8 - (i % 9) : i % 9]),
  );
}

function assertCapturedDescriptorsClosed(capture) {
  for (const stream of ["stdout", "stderr"]) {
    expect(capture[stream].closed).toBe(true);
    expect(() => fstatSync(capture[stream].fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  }
}

test("outer check retains full large binary output before propagating its actual nonzero exit", async () => {
  const directory = await isolatedDirectory();
  const metadataFile = join(directory, "check.json");
  const stdout = await binaryReplaySink(join(directory, "replayed.stdout.bin"), metadataFile);
  const stderr = await binaryReplaySink(join(directory, "replayed.stderr.bin"), metadataFile);
  let failure;
  try {
    await runRecordedSetup(
      "check",
      process.execPath,
      ["--eval", binaryControlProgram(directory, 786432, 7)],
      directory,
      directory,
      120_000,
      { stdout: stdout.destination, stderr: stderr.destination },
    );
  } catch (error) {
    failure = error;
  } finally {
    await stdout.close();
    await stderr.close();
    await preserveBinaryControl("setup-large-exit7", directory, {
      error: { message: failure?.message },
      stdout: stdout.observations,
      stderr: stderr.observations,
    });
  }
  expect(failure.message).toBe("check exited 7");
  const record = JSON.parse(await readFile(metadataFile, "utf8"));
  expect(record).toMatchObject({ exitCode: 7, errorCode: null, timedOut: false });
  const expected = Buffer.concat([
    binaryControlExpected(786432),
    binaryControlExpected(786432, true),
  ]);
  expect(await readFile(join(directory, "check.log"))).toEqual(expected);
  expect(record.log).toMatchObject({
    bytes: 1572864,
    sha256: createHash("sha256").update(expected).digest("hex"),
  });
  assertCapturedDescriptorsClosed(record.outputCapture);
  for (const [stream, sink] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ]) {
    expect(await readFile(join(directory, `replayed.${stream}.bin`))).toEqual(
      binaryControlExpected(786432, stream === "stderr"),
    );
    expect(sink.observations.metadataBeforeReplay.outputCapture[stream].bytes).toBe(786432);
    expect(sink.observations.maxChunk).toBeLessThanOrEqual(65536);
    expect(sink.observations.backpressure).toBeGreaterThan(0);
  }
});

test("outer check and inner ordinary Vitest preserve four MiB per binary stream with real bounded replay", async () => {
  const directory = await isolatedDirectory();
  const inner = join(directory, "inner");
  await mkdir(inner);
  const gateUrl = pathToFileURL(
    resolve(import.meta.dirname, "../../scripts/ci-test-gate.mjs"),
  ).href;
  const program = `
    import { recordedCommand } from ${JSON.stringify(gateUrl)};
    const result = await recordedCommand('vitest', process.execPath, ['--eval', ${JSON.stringify(binaryControlProgram(inner, 4194304))}], ${JSON.stringify(join(inner, "execution.json"))}, 120000, {fileCapture:true});
    if (result.status !== 0) process.exit(result.status ?? 1);
  `;
  const metadataFile = join(directory, "check.json");
  const stdout = await binaryReplaySink(join(directory, "replayed.stdout.bin"), metadataFile);
  const stderr = await binaryReplaySink(join(directory, "replayed.stderr.bin"), metadataFile);
  let record;
  try {
    record = await runRecordedSetup(
      "check",
      process.execPath,
      ["--input-type=module", "--eval", program],
      directory,
      directory,
      120_000,
      { stdout: stdout.destination, stderr: stderr.destination },
    );
  } finally {
    await stdout.close();
    await stderr.close();
    await preserveBinaryControl("setup-nested-four-mib", directory, {
      stdout: stdout.observations,
      stderr: stderr.observations,
    });
  }
  expect(record).toMatchObject({ exitCode: 0, errorCode: null, timedOut: false });
  const [innerRecord] = JSON.parse(await readFile(join(inner, "execution.json"), "utf8"));
  expect(innerRecord).toMatchObject({ exitCode: 0, errorCode: null });
  const expected = Buffer.concat([
    binaryControlExpected(4194304),
    binaryControlExpected(4194304, true),
  ]);
  expect(await readFile(join(directory, "check.log"))).toEqual(expected);
  expect(record.log).toMatchObject({
    bytes: 8388608,
    sha256: createHash("sha256").update(expected).digest("hex"),
  });
  assertCapturedDescriptorsClosed(record.outputCapture);
  for (const [stream, sink] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ]) {
    const bytes = binaryControlExpected(4194304, stream === "stderr");
    expect(await readFile(join(inner, `vitest.${stream}.bin`))).toEqual(bytes);
    expect(await readFile(join(directory, `check.${stream}.bin`))).toEqual(bytes);
    expect(await readFile(join(directory, `replayed.${stream}.bin`))).toEqual(bytes);
    expect(record.outputCapture[stream]).toMatchObject({
      complete: true,
      bytes: 4194304,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(sink.observations.maxChunk).toBeLessThanOrEqual(65536);
    expect(sink.observations.backpressure).toBeGreaterThan(0);
    expect(sink.observations.drains).toBeGreaterThan(0);
  }
});

test("outer file-backed check preserves original timeout and absent binary errors", async () => {
  const directory = await isolatedDirectory();
  const stdout = await binaryReplaySink(
    join(directory, "replayed.stdout.bin"),
    join(directory, "check.json"),
  );
  const stderr = await binaryReplaySink(
    join(directory, "replayed.stderr.bin"),
    join(directory, "check.json"),
  );
  let failure;
  try {
    await runRecordedSetup(
      "check",
      process.execPath,
      [
        "--eval",
        `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(resolve(directory, "birth.json"))}, JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));fs.writeSync(1, Buffer.from([0,255,1,2]));setInterval(() => {}, 1000)`,
      ],
      directory,
      directory,
      50,
      { stdout: stdout.destination, stderr: stderr.destination },
    );
  } catch (error) {
    failure = error;
  } finally {
    await stdout.close();
    await stderr.close();
    await preserveBinaryControl("setup-timeout50", directory, {
      error: { code: failure?.code, message: failure?.message },
    });
  }
  expect(failure).toMatchObject({
    code: "ETIMEDOUT",
    ciOutputAttempt: { timedOut: true, timeoutMs: 50 },
  });
  expect(await readFile(join(directory, "check.log"))).toEqual(Buffer.from([0, 255, 1, 2]));
  assertCapturedDescriptorsClosed(failure.ciOutputAttempt.outputCapture);
  const absentDirectory = await isolatedDirectory();
  let absent;
  try {
    await runRecordedSetup(
      "check",
      join(absentDirectory, "absent"),
      [],
      absentDirectory,
      absentDirectory,
      50,
    );
  } catch (error) {
    absent = error;
  }
  await preserveBinaryControl("setup-enoent", absentDirectory, {
    error: { code: absent?.code, message: absent?.message },
  });
  expect(absent).toMatchObject({
    code: "ENOENT",
    ciOutputAttempt: { timedOut: false, errorCode: "ENOENT" },
  });
  assertCapturedDescriptorsClosed(absent.ciOutputAttempt.outputCapture);
});

test("outer check keeps its original exit primary when full log custody fails", async () => {
  const directory = await isolatedDirectory();
  await mkdir(join(directory, "check.log"));
  const stdout = await binaryReplaySink(
    join(directory, "replayed.stdout.bin"),
    join(directory, "check.json"),
  );
  const stderr = await binaryReplaySink(
    join(directory, "replayed.stderr.bin"),
    join(directory, "check.json"),
  );
  let failure;
  try {
    await runRecordedSetup(
      "check",
      process.execPath,
      ["--eval", binaryControlProgram(directory, 4, 7)],
      directory,
      directory,
      120_000,
      { stdout: stdout.destination, stderr: stderr.destination },
    );
  } catch (error) {
    failure = error;
  } finally {
    await stdout.close();
    await stderr.close();
    await preserveBinaryControl("setup-log-failure", directory, {
      error: { message: failure?.message },
      custodyErrors: failure?.custodyErrors,
    });
  }
  expect(failure.message).toBe("check exited 7");
  expect(failure.custodyErrors).toEqual(
    expect.arrayContaining([expect.objectContaining({ phase: "check-log" })]),
  );
  expect(failure.ciOutputAttempt.outputCapture.stdout).toMatchObject({ complete: true, bytes: 4 });
  expect(await readFile(join(directory, "replayed.stdout.bin"))).toEqual(binaryControlExpected(4));
});

test("outer check preserves actual exit and binary bytes when metadata cannot be published", async () => {
  const directory = await isolatedDirectory();
  await mkdir(join(directory, "check.json"));
  const stdout = await binaryReplaySink(join(directory, "replayed.stdout.bin"));
  const stderr = await binaryReplaySink(join(directory, "replayed.stderr.bin"));
  let failure;
  try {
    await runRecordedSetup(
      "check",
      process.execPath,
      ["--eval", binaryControlProgram(directory, 4, 7)],
      directory,
      directory,
      120_000,
      { stdout: stdout.destination, stderr: stderr.destination },
    );
  } catch (error) {
    failure = error;
  } finally {
    await stdout.close();
    await stderr.close();
    await preserveBinaryControl("setup-metadata-failure", directory, {
      error: { message: failure?.message },
      attempt: failure?.ciOutputAttempt,
      custodyErrors: failure?.custodyErrors,
    });
  }
  expect(failure.message).toBe("check exited 7");
  expect(failure.ciOutputAttempt).toMatchObject({ exitCode: 7, errorCode: null });
  expect(failure.custodyErrors).toEqual(
    expect.arrayContaining([expect.objectContaining({ phase: "metadata" })]),
  );
  expect(await readFile(join(directory, "check.log"))).toEqual(
    Buffer.concat([binaryControlExpected(4), binaryControlExpected(4, true)]),
  );
});

test("outer check preserves the fixed 786432-byte successful binary streams", async () => {
  const directory = await isolatedDirectory();
  const stdout = await binaryReplaySink(
    join(directory, "replayed.stdout.bin"),
    join(directory, "check.json"),
  );
  const stderr = await binaryReplaySink(
    join(directory, "replayed.stderr.bin"),
    join(directory, "check.json"),
  );
  let record;
  try {
    record = await runRecordedSetup(
      "check",
      process.execPath,
      ["--eval", binaryControlProgram(directory, 786432)],
      directory,
      directory,
      120_000,
      { stdout: stdout.destination, stderr: stderr.destination },
    );
  } finally {
    await stdout.close();
    await stderr.close();
    await preserveBinaryControl("setup-large-success", directory, {
      stdout: stdout.observations,
      stderr: stderr.observations,
    });
  }
  expect(record).toMatchObject({ exitCode: 0, errorCode: null, timedOut: false });
  const expected = Buffer.concat([
    binaryControlExpected(786432),
    binaryControlExpected(786432, true),
  ]);
  expect(await readFile(join(directory, "check.log"))).toEqual(expected);
  expect(record.log).toMatchObject({
    bytes: 1572864,
    sha256: createHash("sha256").update(expected).digest("hex"),
  });
  for (const [stream, sink] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ]) {
    expect(await readFile(join(directory, `replayed.${stream}.bin`))).toEqual(
      binaryControlExpected(786432, stream === "stderr"),
    );
    expect(record.outputCapture[stream]).toMatchObject({ complete: true, bytes: 786432 });
    expect(sink.observations.maxChunk).toBeLessThanOrEqual(65536);
    expect(sink.observations.backpressure).toBeGreaterThan(0);
  }
});
