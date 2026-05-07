import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*_test.ts", "**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    poolOptions: {
      forks: {
        // Register tsx CJS hook so vi.hoisted require() calls can load .ts files
        execArgv: ["--require", "tsx/cjs"],
      },
    },
  },
});
