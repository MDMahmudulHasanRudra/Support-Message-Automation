import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every integration test exercises the same shared Postgres outbound-message
    // queue (no isolated test DB provisioned yet — see pipeline.integration.test.ts's
    // own doc comment) via processOne()'s globally-scoped claim query. Running test
    // files in parallel would let one file's processOne() steal another file's row.
    // Sequential execution keeps each test's fixtures isolated in practice.
    fileParallelism: false,
    // Every integration test here talks to a real Postgres in a container, several round trips per
    // test. Vitest's 5s default is comfortable on an idle machine and too tight on a busy one —
    // the suite has been seen to take 45s of test time in one run and 70s in the next, and the
    // slow runs failed on the timeout rather than on any assertion. A generous ceiling costs
    // nothing when tests pass and stops a loaded laptop from reading as a broken build.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
