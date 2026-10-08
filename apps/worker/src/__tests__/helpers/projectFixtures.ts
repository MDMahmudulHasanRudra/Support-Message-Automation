import { createProjectScopedPrisma, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { maybeCurrentProjectId, withProject } from "../../project/context.js";

/**
 * Test fixtures after MULTI_PROJECT_PLAN.md Phase 3.
 *
 * The database no longer defaults `projectId` to ISP Digital — an insert that does not name a project
 * is refused — so the suites write their fixtures through this client. It is the ordinary scoped
 * client with one test-only convenience: OUTSIDE a worker project context it acts as ISP Digital,
 * which is where every pre-multi-project fixture always lived. Inside `withProject(BIZIFY, …)` it is
 * Bizify's, so a test can seed a second project the same way it seeds the first.
 *
 * Production code never sees this: the worker's own client (src/db.ts) has no such fallback and
 * throws outside a project context. `rawPrisma` is the unscoped client, for assertions that must
 * look across projects.
 */
export const ISP_DIGITAL = ORIGINAL_PROJECT_ID;

export const prisma = createProjectScopedPrisma(rawPrisma, async () => maybeCurrentProjectId() ?? ISP_DIGITAL);

export { rawPrisma };

/** Runs worker code that needs a project context (the per-project scanners) as ISP Digital. */
export function inIsp<T>(fn: () => Promise<T>): Promise<T> {
  return withProject(ISP_DIGITAL, fn);
}
