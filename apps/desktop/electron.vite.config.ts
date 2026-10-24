import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

export default defineConfig({
  main: {
    define: { __COVE_BUILD__: JSON.stringify(`0.0.0+${source.slice(0, 16)}`) },
    build: {
      outDir: "dist/main",
      externalizeDeps: false,
      rollupOptions: { input: resolve("src/main/index.ts") },
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      externalizeDeps: false,
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      outDir: resolve("dist/renderer"),
      rollupOptions: { input: resolve("src/renderer/index.html") },
    },
  },
});
