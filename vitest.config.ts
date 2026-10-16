import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Safe mode is ON by default at runtime. Upstream tests exercise normal
    // behaviour, so the test runner opts out explicitly; safe-mode tests set
    // the variable themselves.
    env: { AUTOMATON_SAFE_MODE: "0" },
    testTimeout: 30_000,
    teardownTimeout: 5_000,
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/types.ts",
        "node_modules/**",
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 55,
        lines: 60,
      },
      reporter: ["text", "text-summary", "json-summary"],
    },
  },
});
