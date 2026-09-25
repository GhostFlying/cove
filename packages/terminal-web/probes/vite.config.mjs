import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const browserRoot = fileURLToPath(new URL("./browser/", import.meta.url));
const output = fileURLToPath(new URL("../dist/browser/", import.meta.url));

export default defineConfig({
  root: browserRoot,
  base: "./",
  build: {
    outDir: output,
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("./browser/index.html", import.meta.url)) },
  },
});
