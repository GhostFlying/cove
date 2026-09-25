import { builtinModules } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const browserRoot =
  process.env.COVE_PROBE_BROWSER_ROOT ?? fileURLToPath(new URL("./browser/", import.meta.url));
const output =
  process.env.COVE_PROBE_BROWSER_OUT ?? fileURLToPath(new URL("../dist/browser/", import.meta.url));
const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const installedXterm = JSON.parse(
  readFileSync(new URL("../node_modules/@xterm/xterm/package.json", import.meta.url), "utf8"),
);

function forbiddenModule(id) {
  const normalized = id.replaceAll("\\", "/");
  const bare = normalized.replace(/^node:/, "");
  return (
    nodeBuiltins.has(bare) ||
    normalized.includes("node:") ||
    /^(?:node-pty|better-sqlite3|@xterm\/(?:headless|addon-serialize))(?:\/|$)/.test(normalized) ||
    /(?:^|\/)(?:node-pty|better-sqlite3)(?:\/|$)/.test(normalized) ||
    normalized.endsWith(".node")
  );
}

function browserDependencyBoundary() {
  return {
    name: "cove-browser-dependency-boundary",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && forbiddenModule(source))
        throw new Error(`Browser bundle rejects Node/native import: ${source}`);
    },
    generateBundle() {
      for (const id of this.getModuleIds()) {
        if (forbiddenModule(id))
          throw new Error(`Browser bundle includes Node/native module: ${id}`);
        const module = this.getModuleInfo(id);
        for (const imported of [
          ...(module?.importedIds ?? []),
          ...(module?.dynamicallyImportedIds ?? []),
        ]) {
          if (forbiddenModule(imported))
            throw new Error(`Browser bundle includes Node/native import: ${imported}`);
        }
      }
    },
  };
}

export default defineConfig({
  define: {
    __COVE_BUNDLED_XTERM_VERSION__: JSON.stringify(
      process.env.COVE_PROBE_TEST_BUNDLED_XTERM_VERSION ?? installedXterm.version,
    ),
  },
  root: resolve(browserRoot),
  base: "./",
  plugins: [browserDependencyBoundary()],
  build: {
    outDir: resolve(output),
    emptyOutDir: true,
    rollupOptions: { input: resolve(browserRoot, "index.html") },
  },
});
