import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The web app's test harness (added in multi-project Phase 6). Tests call the server modules
 * directly — reports, lists, navigation — inside `runWithProject(...)`, the same explicit project
 * context `after()` work uses, so no Next request is needed. Integration files must import
 * `./helpers/requireTestDatabase.js` and run only through `pnpm test:isolated`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the React Server Components build; a test is server code.
      "server-only": fileURLToPath(new URL("./src/__tests__/helpers/serverOnly.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
