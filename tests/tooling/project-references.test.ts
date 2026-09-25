import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const repository = resolve(import.meta.dirname, "../..");
const compiler = join(repository, "node_modules/.bin/tsc");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cove-project-references-"));
  temporaryDirectories.push(root);
  await writeFile(
    join(root, "tsconfig.base.json"),
    await readFile(join(repository, "tsconfig.base.json")),
  );
  const files: Record<string, unknown> = {
    "tsconfig.json": {
      files: [],
      references: [{ path: "./consumer" }],
    },
    "library/package.json": {
      name: "@cove/build-fixture",
      version: "0.0.0",
      type: "module",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    },
    "consumer/package.json": { name: "build-consumer", private: true, type: "module" },
  };
  for (const name of ["library", "consumer"]) {
    await mkdir(join(root, name, "src"), { recursive: true });
    files[`${name}/tsconfig.json`] = {
      extends: "../tsconfig.base.json",
      compilerOptions: {
        rootDir: "src",
        outDir: "dist",
        tsBuildInfoFile: "dist/build.tsbuildinfo",
      },
      include: ["src/**/*.ts"],
      ...(name === "consumer" ? { references: [{ path: "../library" }] } : {}),
    };
  }
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), JSON.stringify(content));
  }
  await mkdir(join(root, "consumer/node_modules/@cove"), { recursive: true });
  await symlink(
    join(root, "library"),
    join(root, "consumer/node_modules/@cove/build-fixture"),
    "dir",
  );
  await writeFile(join(root, "library/src/index.ts"), "export const answer: number = 42;\n");
  await writeFile(
    join(root, "consumer/src/index.ts"),
    'import { answer } from "@cove/build-fixture";\nexport const result: number = answer;\n',
  );
  return root;
}

function build(root: string) {
  const result = spawnSync(compiler, ["-b", "--force"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

test("builds referenced packages and runs their exported ESM artifacts", async () => {
  const root = await fixture();
  const compiled = build(root);
  expect(compiled.output).toBe("");
  expect(compiled.status).toBe(0);
  const executed = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { result } from "./consumer/dist/index.js"; if (result !== 42) throw new Error("Unexpected result");',
    ],
    { cwd: root, encoding: "utf8", timeout: 10_000 },
  );
  expect(executed.error).toBeUndefined();
  expect(executed.stderr).toBe("");
  expect(executed.status).toBe(0);
  expect(await readFile(join(root, "library/dist/index.d.ts"), "utf8")).toContain("number");
});

test("rejects incompatible consumers and private package imports", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "consumer/src/index.ts"),
    'import { answer } from "@cove/build-fixture";\nexport const result: string = answer;\n',
  );
  const invalidType = build(root);
  expect(invalidType.status).not.toBe(0);
  expect(invalidType.output).toContain("TS2322");

  await writeFile(
    join(root, "consumer/src/index.ts"),
    'export { answer } from "@cove/build-fixture/src/index.js";\n',
  );
  const privateImport = build(root);
  expect(privateImport.status).not.toBe(0);
  expect(privateImport.output).toContain("TS2307");
  const executed = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'import "@cove/build-fixture/src/index.js";'],
    { cwd: join(root, "consumer"), encoding: "utf8", timeout: 10_000 },
  );
  expect(executed.error).toBeUndefined();
  expect(executed.status).not.toBe(0);
  expect(executed.stderr).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
});
