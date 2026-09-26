import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: resolve(import.meta.dirname, "../../dist/view-browser"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
