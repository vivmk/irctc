import { defineConfig } from "vitest/config";

// Unit tests: no database, Redis or server needed. Everything outside the file under test is faked.
export default defineConfig({
  test: {
    include: ["unit/**/*.test.ts"],
    environment: "node",
    clearMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/migrate.ts", "src/seed.ts", "src/stress.ts"],
    },
  },
});
