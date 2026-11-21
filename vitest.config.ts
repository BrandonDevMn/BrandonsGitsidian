import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Thin Obsidian UI glue is checked on the phone; everything else must be unit tested.
      exclude: ["src/main.ts", "src/obsidian/**"],
      reporter: ["text-summary", "text"],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
