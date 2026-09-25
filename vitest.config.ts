import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "protocol",
          environment: "node",
          include: ["packages/protocol/tests/**/*.test.mjs"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "tooling",
          environment: "node",
          include: ["tests/tooling/**/*.test.{ts,mjs}"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "terminal-engine-probes",
          environment: "node",
          include: ["packages/terminal-engine/probes/**/*.test.mjs"],
          testTimeout: 35_000,
          maxWorkers: 1,
        },
      },
      {
        test: {
          name: "terminal-web-probes",
          environment: "node",
          include: ["packages/terminal-web/probes/**/*.test.mjs"],
          testTimeout: 45_000,
          maxWorkers: 1,
        },
      },
    ],
  },
});
