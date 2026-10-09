import { defineConfig } from "vite";
import { resolve } from "node:path";

// The M0 harness page is a separate static artifact. Only dist/page is served; the
// type-check output in dist/types never reaches a browser.
export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: resolve(import.meta.dirname, "dist/page"),
    emptyOutDir: true,
    sourcemap: false,
    // One small page; splitting xterm out would not help a local loopback load.
    chunkSizeWarningLimit: 1024,
  },
});
