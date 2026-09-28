import { createProjectScopedPrisma, prisma as platformPrisma } from "@support-automation/db";
import { requireActiveProject } from "@/server/projectContext";

/**
 * The database client every page, action, report and route in the web app uses.
 *
 * It is the packages/db client with the project scope applied (MULTI_PROJECT_PLAN.md §5): every
 * query on a project-owned table is confined to the project in the request's URL, which the
 * signed-in user must have access to; with no project, or without access, the query throws rather
 * than reading other projects. Platform tables (users, sessions, roles, permissions) pass through.
 *
 * Named `prisma` on purpose, so the existing call sites did not change — only their import did.
 */
export const prisma = createProjectScopedPrisma(platformPrisma, async () => (await requireActiveProject()).id);

/**
 * The unscoped client, for the few places that are genuinely about the platform rather than a
 * project: resolving the project itself, sign-in, and the project chooser. Using it on a
 * project-owned table from a page or action is a bug.
 */
export { platformPrisma };
