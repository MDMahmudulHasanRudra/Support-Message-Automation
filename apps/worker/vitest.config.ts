import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every integration test exercises the same shared Postgres outbound-message
    // queue (no isolated test DB provisioned yet — see pipeline.integration.test.ts's
    // own doc comment) via processOne()'s globally-scoped claim query. Running test
    // files in parallel would let one file's processOne() steal another file's row.
    // Sequential execution keeps each test's fixtures isolated in practice.
    fileParallelism: false,
  },
});
