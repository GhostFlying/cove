import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { resolve } from "node:path";

const checkout = resolve(import.meta.dirname, "../../../..");
const evidenceDirectory = resolve(checkout, ".cache/ci/smoke/terminal-recovery");

export async function writeRecoverySuiteEvidence(suite, caseIds, minimumCases) {
  if (caseIds.length < minimumCases || new Set(caseIds).size !== caseIds.length)
    throw new Error(`${suite} did not complete its expected distinct fixtures`);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    encoding: "utf8",
  }).trim();
  const evidence = {
    suite,
    sha,
    runtime: { node: process.version, platform: platform(), arch: arch() },
    completedCaseIds: caseIds,
  };
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error(`${suite} evidence exceeds cap`);
  await mkdir(evidenceDirectory, { recursive: true });
  const path = resolve(evidenceDirectory, `${suite}.json`);
  await writeFile(path, encoded);
  const readback = JSON.parse(await readFile(path, "utf8"));
  if (
    readback.sha !== sha ||
    readback.completedCaseIds.length !== caseIds.length ||
    readback.completedCaseIds.some((id, index) => id !== caseIds[index])
  )
    throw new Error(`${suite} evidence readback diverged`);
}
