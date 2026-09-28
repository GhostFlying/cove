import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { childPipe, hello, stopVerified } from "./pipe-harness.mjs";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const packageDir = join(repo, "packages/terminal-worker");
const tsc = join(repo, "node_modules/typescript/bin/tsc");

test("installed public package exposes declarations, ESM and compiled bin with v2 readiness", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cove-qual-consumer-"));
  let harness;
  try {
    await writeFile(
      join(temp, "package.json"),
      JSON.stringify({
        name: "cove-qualification-consumer",
        version: "1.0.0",
        private: true,
        type: "module",
        dependencies: { "@cove/terminal-worker": `link:${packageDir}` },
      }),
    );
    const install = spawnSync(
      "pnpm",
      ["install", "--offline", "--ignore-scripts", "--reporter", "append-only"],
      {
        cwd: temp,
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect({
      status: install.status,
      stderr: install.stderr,
      stdout: install.stdout,
    }).toMatchObject({ status: 0 });
    const consumer = join(temp, "consumer.mts");
    await writeFile(
      consumer,
      'import { runWorkerPipe, type WorkerPipe } from "@cove/terminal-worker/pipe";\nconst entry: typeof runWorkerPipe = runWorkerPipe;\nlet pipe: WorkerPipe | undefined;\nvoid entry; void pipe;\n',
    );
    await writeFile(
      join(temp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          types: [],
        },
        files: ["consumer.mts"],
      }),
    );
    const types = spawnSync(process.execPath, [tsc, "-p", temp], {
      cwd: temp,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect({ status: types.status, stderr: types.stderr, stdout: types.stdout }).toMatchObject({
      status: 0,
    });
    const bin = join(temp, "node_modules/.bin/cove-terminal-worker");
    const source = await readFile(join(packageDir, "dist/src/main.js"), "utf8");
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
    const moduleFile = join(temp, "consumer.mjs");
    await writeFile(moduleFile, 'export { runWorkerPipe } from "@cove/terminal-worker/pipe";\n');
    const module = await import(new URL(`file://${moduleFile}`));
    expect(typeof module.runWorkerPipe).toBe("function");
    harness = childPipe(bin, `delivery-${process.pid}`);
    harness.send(hello);
    const ready = await harness.wait((metadata) => metadata.type === "ready", "public ready");
    expect(ready.metadata).toMatchObject({
      type: "ready",
      pipeVersion: 2,
      buildVersion: "0.0.0",
      effectiveBudgets: hello.effectiveBudgets,
    });
    harness.child.stdin.end();
    expect(await harness.exit).toEqual({ code: 0, signal: null });
    expect(harness.frames.map((frame) => frame.metadata.type)).toEqual(["ready"]);
  } finally {
    if (harness) await stopVerified(harness);
    await rm(temp, { recursive: true, force: true });
  }
});
