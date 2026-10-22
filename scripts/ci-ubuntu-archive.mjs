import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const officialArchive = "https://archive.ubuntu.com/ubuntu/";
const mirrorUri = "mirror+file:/etc/apt/apt-mirrors.txt";
const knownUris = new Set([
  mirrorUri,
  "http://azure.archive.ubuntu.com/ubuntu/",
  "https://azure.archive.ubuntu.com/ubuntu/",
  "http://archive.ubuntu.com/ubuntu/",
  officialArchive,
  "http://security.ubuntu.com/ubuntu/",
  "https://security.ubuntu.com/ubuntu/",
]);

// Only the public Ubuntu source file is supported, not arbitrary repositories or apt config.
// Retaining all other bytes preserves suites, pockets, components and signature verification.
export function officialUbuntuSource(source, mirrors, osRelease, arch) {
  if (
    !/^ID=ubuntu$/m.test(osRelease) ||
    !/^VERSION_ID="?24\.04"?$/m.test(osRelease) ||
    !/^VERSION_CODENAME=noble$/m.test(osRelease) ||
    arch !== "x64"
  ) {
    throw new Error("Unsupported Ubuntu archive route: requires Ubuntu 24.04 amd64");
  }
  const pockets = new Set();
  let mirrored = false;
  const allowedFields = new Set([
    "Types",
    "URIs",
    "Suites",
    "Components",
    "Signed-By",
    "Architectures",
  ]);
  const stanzas = source.trim().split(/\n\s*\n/);
  if (!stanzas.length) throw new Error("Unsupported empty Ubuntu source");
  for (const stanza of stanzas) {
    const fields = new Map();
    for (const line of stanza.split("\n")) {
      if (line.startsWith("#")) continue;
      const match = /^([A-Za-z-]+):[ \t]+([^\r\n]+)$/.exec(line);
      if (!match || !allowedFields.has(match[1]) || fields.has(match[1])) {
        throw new Error("Unsupported Ubuntu deb822 source layout");
      }
      fields.set(match[1], match[2].trim());
    }
    // deb822 files can contain comment-only paragraphs between source stanzas.
    if (!fields.size) continue;
    const uri = fields.get("URIs");
    if (
      !knownUris.has(uri) ||
      !/^deb(?: deb-src)?$/.test(fields.get("Types") ?? "") ||
      fields.get("Signed-By") !== "/usr/share/keyrings/ubuntu-archive-keyring.gpg" ||
      (fields.has("Architectures") && fields.get("Architectures") !== "amd64")
    ) {
      throw new Error("Unsupported Ubuntu source fields or archive URI");
    }
    mirrored ||= uri === mirrorUri;
    const suites = (fields.get("Suites") ?? "").split(/\s+/);
    if (
      !suites.every((suite) =>
        ["noble", "noble-updates", "noble-backports", "noble-security"].includes(suite),
      )
    ) {
      throw new Error("Unsupported Ubuntu source suites");
    }
    for (const suite of suites) pockets.add(suite);
    const components = (fields.get("Components") ?? "").split(/\s+/);
    if (
      !components.every((component) =>
        ["main", "restricted", "universe", "multiverse"].includes(component),
      )
    ) {
      throw new Error("Unsupported Ubuntu source components");
    }
  }
  if (!pockets.has("noble") || !pockets.has("noble-security")) {
    throw new Error("Unsupported Ubuntu source: missing base/security pocket");
  }
  if (mirrored) {
    const expected = [
      "http://azure.archive.ubuntu.com/ubuntu/ priority:1",
      "https://archive.ubuntu.com/ubuntu/ priority:2",
      "https://security.ubuntu.com/ubuntu/ priority:3",
    ];
    const lines = mirrors
      .trim()
      .split("\n")
      .map((line) => line.trim().replace(/\s+/g, " "));
    if (JSON.stringify(lines) !== JSON.stringify(expected)) {
      throw new Error("Unsupported Ubuntu runner mirror list");
    }
  }
  return source.replace(/^URIs:[ \t]+[^\r\n]+$/gm, `URIs: ${officialArchive}`);
}

export async function prepareUbuntuArchive(evidenceDirectory) {
  if (process.platform !== "linux" || process.env.CI !== "true") return;
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("Ubuntu archive mitigation is restricted to a fresh GitHub-hosted runner");
  }
  const sourcePath = "/etc/apt/sources.list.d/ubuntu.sources";
  const source = await readFile(sourcePath, "utf8");
  let mirrors = "";
  if (source.includes(mirrorUri)) mirrors = await readFile("/etc/apt/apt-mirrors.txt", "utf8");
  const osRelease = await readFile("/etc/os-release", "utf8");
  // Validate before recording: unsupported input might contain unrelated private repository URLs.
  // On refusal leave the original files intact and report the unsupported layout, never dump auth.
  let effective;
  try {
    effective = officialUbuntuSource(source, mirrors, osRelease, process.arch);
  } catch (error) {
    await writeFile(
      join(evidenceDirectory, "ubuntu-archive.json"),
      `${JSON.stringify(
        {
          status: "unsupported",
          sourcePath,
          originalSourceSha256: createHash("sha256").update(source).digest("hex"),
          originalMirrorsSha256: createHash("sha256").update(mirrors).digest("hex"),
          reason: error.message,
          originals: "unchanged; unknown content not copied into artifacts",
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    throw error;
  }
  const evidence = {
    status: "in-progress",
    platform: process.platform,
    arch: process.arch,
    release: "Ubuntu 24.04 noble",
    sourcePath,
    originalSource: source,
    originalMirrors: mirrors || null,
    effectiveSource: effective,
    route: officialArchive,
    cause: "UNKNOWN; official archive route mitigation only",
  };
  const evidencePath = join(evidenceDirectory, "ubuntu-archive.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  console.log(
    `Ubuntu dependency route mitigation: ${officialArchive} (prior network cause UNKNOWN)`,
  );
  const result = spawnSync("sudo", ["-n", "tee", sourcePath], {
    input: effective,
    stdio: ["pipe", "ignore", "inherit"],
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    evidence.status = "failed";
    evidence.exitCode = result.status;
    evidence.errorCode = result.error?.code ?? null;
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    throw result.error ?? new Error(`Ubuntu archive source write exited ${result.status}`);
  }
  if ((await readFile(sourcePath, "utf8")) !== effective)
    throw new Error("Ubuntu archive source readback differs");
  evidence.status = "applied";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function main() {
  await prepareUbuntuArchive(join(root, ".cache/ci/setup"));
  // Keep the pinned package's browser/cache checks and its complete --with-deps installation.
  const result = spawnSync(
    "pnpm",
    ["--filter", "@cove/terminal-web", "--fail-if-no-match", "browser:install"],
    {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
