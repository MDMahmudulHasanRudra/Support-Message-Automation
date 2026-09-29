import { createProjectScopedPrisma, prisma as platformPrisma } from "@support-automation/db";
import { currentProjectId } from "./project/context.js";

/**
 * The worker's database client (MULTI_PROJECT_PLAN.md Phase 3).
 *
 * Project-scoped: every query on a project-owned table is confined to the project of the work in
 * progress (`withProject` / `withAccountProject` in project/context.ts), created rows are stamped
 * with it, and a query outside any project context THROWS instead of reading every project. Platform
 * tables (users, projects, worker health) pass straight through.
 *
 * Named `prisma` so the existing call sites are unchanged. `platformPrisma` is for the few places
 * that genuinely span projects — claiming the next row of a shared queue, listing accounts to
 * connect, boot recovery — which then enter the row's own project before touching anything else.
 */
export const prisma = createProjectScopedPrisma(platformPrisma, async () => currentProjectId());

export { platformPrisma };
