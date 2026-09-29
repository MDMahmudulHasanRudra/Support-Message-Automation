/**
 * Refuses to let an integration test run against anything but a throwaway test database.
 *
 * Every file in this directory ending `.integration.test.ts` writes real rows through real Prisma
 * queries, and several of them — `sessionSegmentation`, `patternDetectionJob`,
 * `unknownPatternDetection` — call job functions that scan GLOBALLY by design, with no
 * per-account or per-test filter. Pointed at a live database they process real customer messages
 * as a side effect. That has already happened twice, and CLAUDE.md records it.
 *
 * The specific hazard that prompted this guard: `aiFallback.integration.test.ts` creates an
 * `AiKnowledgeItem` with `humanVerified: true` and `status: "ACTIVE"` stating a refund policy that
 * does not exist. Verified + active is the exact combination `knowledgeContext.ts` retrieves and
 * puts in front of a customer as "reference material verified by this team". Its `finally` block
 * deletes the row on assertion failure, but not on SIGINT, a killed vitest worker, or a machine
 * crash — in which case a fabricated policy stays in the knowledge base permanently, indexed,
 * verified, and quotable to real customers.
 *
 * The protection was a naming convention (`pnpm test:isolated`) and a paragraph of documentation.
 * `pnpm test` ran `vitest run` with no guard at all, inheriting whatever `DATABASE_URL` the shell
 * happened to hold — and the root `pnpm test` reaches it. A convention that is one forgotten flag
 * away from writing invented policy into production is not protection; this is.
 *
 * Deliberately NOT a vitest `globalSetup`: the pure unit tests in this directory need no database
 * at all and must keep running without one. Integration files opt in by importing this module,
 * which throws at import time — before any `beforeAll`, any fixture, any query.
 */

/** Hosts a test database may live on. A production database is not on this machine. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres-test", "host.docker.internal"]);

function fail(reason: string): never {
  throw new Error(
    [
      "",
      "═══════════════════════════════════════════════════════════════════",
      " INTEGRATION TEST BLOCKED — unsafe DATABASE_URL",
      "═══════════════════════════════════════════════════════════════════",
      ` ${reason}`,
      "",
      " These tests write real rows, and some job functions they call scan",
      " every account with no test filter. Against a live database they",
      " process real customer data and can leave fabricated, human-verified",
      " knowledge behind that the AI will quote to customers.",
      "",
      " Run them against the throwaway database instead:",
      "",
      "   docker compose -f docker-compose.test.yml up -d --wait",
      "   pnpm --filter @support-automation/web test:isolated",
      "   docker compose -f docker-compose.test.yml down -v",
      "═══════════════════════════════════════════════════════════════════",
      "",
    ].join("\n"),
  );
}

/**
 * Throws unless `DATABASE_URL` names a database that is unmistakably a throwaway: the database
 * name must contain "test", and it must be served from this machine. Both conditions, because
 * either alone is too easy to satisfy by accident — a production database could be reached
 * through an SSH tunnel on localhost, and a developer's own database could be called anything.
 */
export function requireTestDatabase(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) fail("DATABASE_URL is not set.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("DATABASE_URL is not a valid URL.");
  }

  const database = url.pathname.replace(/^\//, "");
  if (!database) fail("DATABASE_URL names no database.");
  if (!/test/i.test(database)) {
    fail(`DATABASE_URL points at database "${database}", whose name does not contain "test".`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    fail(`DATABASE_URL points at host "${url.hostname}", which is not a local test host.`);
  }
}

// Import-time enforcement: importing this module is the assertion. A file that imports it cannot
// reach its own fixtures against the wrong database, however its hooks are ordered.
requireTestDatabase();
