import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/globalSetup.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false, // test files share one database, so run them one at a time
    reporters: ["default", "junit"],
    outputFile: { junit: "test-results/junit.xml" },
  },
});
