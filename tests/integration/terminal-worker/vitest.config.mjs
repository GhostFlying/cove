export default {
  test: {
    include: ["tests/integration/terminal-worker/**/*.test.mjs"],
    testTimeout: 35_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
};
