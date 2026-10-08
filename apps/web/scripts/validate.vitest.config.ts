import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Runs ONLY the read-only Support Intelligence validation (scripts/validateSupportIntelligence.run.ts)
 * — a separate config so the ordinary test run can never pick it up, and so it can point at the live
 * database while every integration test refuses to. See the file itself for the read-only guard.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "server-only": fileURLToPath(new URL("../src/__tests__/helpers/serverOnly.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["scripts/validateSupportIntelligence.run.ts"],
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    hookTimeout: 60_000,
  },
});
