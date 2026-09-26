import { defineConfig } from "vite";
import { resolve } from "node:path";

const forcedXtermVersion = process.env.COVE_VIEW_TEST_BUNDLED_XTERM_VERSION;

export default defineConfig({
  root: import.meta.dirname,
  plugins: forcedXtermVersion
    ? [
        {
          name: "cove-view-test-xterm-version",
          enforce: "pre",
          resolveId(source) {
            if (source === "@xterm/xterm/package.json") return "\0cove-view-xterm-manifest";
          },
          load(id) {
            if (id === "\0cove-view-xterm-manifest")
              return `export default ${JSON.stringify({ version: forcedXtermVersion })}`;
          },
        },
      ]
    : [],
  build: {
    outDir: resolve(
      process.env.COVE_VIEW_BROWSER_OUT ?? resolve(import.meta.dirname, "../../dist/view-browser"),
    ),
    emptyOutDir: true,
    sourcemap: true,
  },
});
