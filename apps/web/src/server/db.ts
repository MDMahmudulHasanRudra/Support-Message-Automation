import { createProjectScopedPrisma, PROJECT_SCOPED_MODELS, prisma as platformPrisma, PrismaClient } from "@support-automation/db";
import { isReadOnlyProjectStatus } from "@support-automation/shared";
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
const scoped = createProjectScopedPrisma(platformPrisma, async () => (await requireActiveProject()).id);

/** A project that is SUSPENDED or ARCHIVED is read-only (§8); this is what a refused write says. */
export class ProjectReadOnlyError extends Error {
  constructor(status: string) {
    super(
      status === "ARCHIVED"
        ? "This project is archived. It is read-only, so the change was not saved."
        : "This project is suspended. It is read-only until a Main Admin makes it active again, so the change was not saved.",
    );
    this.name = "ProjectReadOnlyError";
  }
}

const WRITE_OPERATIONS = new Set([
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany",
]);

/**
 * The read-only rule, enforced where every write already passes: a write on a project-owned table
 * in a SUSPENDED or ARCHIVED project is refused, whichever page or action issued it — so no action
 * can forget it. Platform tables (sign-in, sessions, users) and SystemLog are untouched, so people
 * can still sign in and look around. The one write let through is an `upsert` whose `update` is
 * empty: that is how pages read a settings row "or create it with defaults", and it changes nothing
 * that exists.
 */
export const prisma = scoped.$extends({
  name: "project-read-only",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (WRITE_OPERATIONS.has(operation) && PROJECT_SCOPED_MODELS.has(model)) {
          const readOnlyIdiom =
            operation === "upsert" && Object.keys(((args as { update?: object }).update ?? {}) as object).length === 0;
          if (!readOnlyIdiom) {
            const project = await requireActiveProject();
            if (isReadOnlyProjectStatus(project.status)) throw new ProjectReadOnlyError(project.status);
          }
        }
        return query(args);
      },
    },
  },
}) as unknown as PrismaClient;

/**
 * The unscoped client, for the few places that are genuinely about the platform rather than a
 * project: resolving the project itself, sign-in, the project chooser and the Main Admin Portal.
 * Using it on a project-owned table from a project page or action is a bug.
 */
export { platformPrisma };
