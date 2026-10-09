import { configDefaults, defineConfig } from "vitest/config";

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
          name: "client",
          environment: "node",
          include: ["packages/client/tests/**/*.test.mjs"],
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "server",
          environment: "node",
          include: ["apps/server/tests/**/*.test.mjs"],
          testTimeout: 30_000,
          maxWorkers: 1,
        },
      },
      {
        test: {
          name: "cli",
          environment: "node",
          include: ["apps/cli/tests/**/*.test.mjs"],
          testTimeout: 60_000,
          hookTimeout: 30_000,
          maxWorkers: 1,
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
          name: "terminal-engine",
          environment: "node",
          include: ["packages/terminal-engine/tests/**/*.test.mjs"],
          testTimeout: 35_000,
          maxWorkers: 1,
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
          name: "terminal-worker",
          environment: "node",
          include: [
            "packages/terminal-worker/tests/**/*.test.mjs",
            "tests/integration/terminal-worker/**/*.test.mjs",
          ],
          testTimeout: 15_000,
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
      {
        test: {
          name: "terminal-web-unit",
          environment: "node",
          include: ["packages/terminal-web/tests/unit/**/*.test.mjs"],
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "terminal-web",
          environment: "node",
          include: ["packages/terminal-web/tests/**/*.test.mjs"],
          // Browser-free unit tests run in their own project: this one carries per-case browser
          // cleanup evidence for exactly the three V1 browser suites.
          exclude: [...configDefaults.exclude, "packages/terminal-web/tests/unit/**"],
          testTimeout: 45_000,
          maxWorkers: 1,
        },
      },
    ],
  },
});
