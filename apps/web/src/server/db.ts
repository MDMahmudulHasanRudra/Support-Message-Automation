import { createProjectScopedPrisma, createTenantScopedPrisma, PROJECT_SCOPED_MODELS, prisma as globalPrisma, PrismaClient } from "@support-automation/db";
import { isReadOnlyProjectStatus } from "@support-automation/shared";
import { cache } from "react";
import { requireActiveProject } from "@/server/projectContext";
import { currentTenant } from "@/server/tenant";
import { getSession } from "@/server/auth";

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
/**
 * One customer's copy of the software (SAAS_PLATFORM_PLAN.md §12): every query on a customer-owned
 * table — people, roles, departments, job titles, employees, security settings, branding, projects
 * and their access, portal log entries — is confined to the request's customer, and a write naming
 * another customer is refused. Every client below is built on it.
 */
const AUDIT_WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]);
/** Per request: which kinds of change a support session has already recorded (once each is enough). */
const recordedThisRequest = cache(() => new Set<string>());

/**
 * Every change made during a RELQIVO support session is recorded in the customer's own System Log
 * (SAAS_PLATFORM_PLAN.md §12) — at the database, so no page or action can forget it: once per kind
 * of change per request, with the operator, the reason and the project. Written directly (not
 * through the clients above, which would record the record).
 */
async function recordSupportWrite(model: string, operation: string, args: unknown): Promise<void> {
  if (model === "SystemLog" || model === "UserSession") return;
  if (operation === "upsert" && Object.keys(((args as { update?: object }).update ?? {}) as object).length === 0) return;
  let session;
  try {
    session = await getSession();
  } catch {
    return; // outside a request (after(), build): nothing to attribute
  }
  if (!session?.support) return;
  const key = `${model}.${operation}`;
  const seen = recordedThisRequest();
  if (seen.has(key)) return;
  seen.add(key);
  let projectId: string | null = null;
  try {
    projectId = (await requireActiveProject()).id;
  } catch {
    projectId = null;
  }
  await globalPrisma.systemLog
    .create({
      data: {
        level: "INFO",
        scope: "support",
        message: "RELQIVO_SUPPORT_CHANGE",
        metadata: { change: key, operator: session.support.operatorUsername, reason: session.support.reason, supportAccessSessionId: session.support.id },
        projectId,
        customerId: session.tenant ?? null,
        actorUserId: session.userId,
      },
    })
    .catch((err: unknown) => console.error("[support] failed to record a support change", err));
}

const tenantScoped = createTenantScopedPrisma(globalPrisma, currentTenant).$extends({
  name: "support-audit",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const result = await query(args);
        if (AUDIT_WRITES.has(operation)) await recordSupportWrite(model, operation, args);
        return result;
      },
    },
  },
}) as unknown as PrismaClient;

const scoped = createProjectScopedPrisma(tenantScoped, async () => (await requireActiveProject()).id);

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
 * The customer's own client outside any project — its Main Admin portal, users, roles and settings.
 * Not scoped to a project, but still confined to the request's customer (the name predates
 * multi-customer and is kept so the call sites did not change). Using it on a project-owned table
 * from a project page or action is a bug.
 */
export const platformPrisma = tenantScoped;

/**
 * Unscoped: across every customer. Only for the RELQIVO platform layer (`server/platform/`), and the
 * few places that must resolve a person, project or address before a customer is known (sign-in,
 * sessions, access, hostnames). Never in a customer's page or action.
 */
export { globalPrisma };
