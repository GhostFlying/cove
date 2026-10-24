import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    name: "mobile-native-ports",
    environment: "node",
    include: ["apps/mobile/tests/**/*.test.mjs"],
    testTimeout: 15_000,
    maxWorkers: 1,
  },
});
