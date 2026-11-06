import { prisma as globalPrisma, Prisma } from "@support-automation/db";
import { removeWorkspaceMediaFiles, workspacePurgePlan } from "@/server/platform/customerRemoval";

/**
 * Deleting ONE workspace permanently, from the Main Admin portal (PROJECT_DELETION.md). The same erase as
 * deleting a whole customer (CUSTOMER_REMOVAL.md), narrowed to one project: every row of every table with a
 * "projectId" column for this project, emptied in foreign-key order read from the database's own catalogue,
 * then the project row itself — one transaction, so it all goes or nothing does. The customer's logins,
 * roles, addresses and other workspaces are not touched.
 *
 * Only an ARCHIVED workspace can be deleted. Archiving is the existing, separately confirmed step that makes
 * the worker release the WhatsApp sessions (without logging them out) and hold every queue and scanner, so by
 * the time anything is erased nothing is still writing into it. A customer's last workspace is refused: its
 * people would have nowhere to sign in to.
 *
 * The action in `actions/projects.ts` checks who is asking, the typed name and their password, and that the
 * project is in the asker's own customer; this only re-checks the state under the row lock.
 */

type Refusal = { error: string };

export async function deleteProjectData(
  projectId: string,
): Promise<Refusal | { name: string; slug: string; customerId: string | null; deleted: Record<string, number>; mediaRemoved: boolean }> {
  let result: Refusal | { name: string; slug: string; customerId: string | null; deleted: Record<string, number> };
  try {
    result = await globalPrisma.$transaction(
      async (tx) => {
        // Locking the project row blocks every insert that points at it (each foreign-key check needs a share
        // lock on the row), so nothing new can land between one table being emptied and the next.
        const rows = await tx.$queryRaw<Array<{ id: string; name: string; slug: string; status: string; customerId: string | null }>>`
          SELECT "id", "name", "slug", "status"::text AS "status", "customerId" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
        const project = rows[0];
        if (!project) return { error: "That project no longer exists." };
        if (project.status !== "ARCHIVED") return { error: "Archive the project first. Only an archived project can be deleted." };
        const others = await tx.project.count({ where: { customerId: project.customerId, id: { not: projectId } } });
        if (others === 0) return { error: "This is the only project. It cannot be deleted; there must always be one to sign in to." };

        const plan = await workspacePurgePlan(tx, []);
        if ("error" in plan) return plan;
        const deleted: Record<string, number> = {};
        for (const table of plan.order) {
          const where = table === "Project" ? `"id" = $1` : `"projectId" = $1`;
          const count = await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${where}`, projectId);
          if (count > 0) deleted[table] = count;
        }
        return { name: project.name, slug: project.slug, customerId: project.customerId, deleted };
      },
      { timeout: 15 * 60_000, maxWait: 30_000 },
    );
  } catch (err) {
    // A row elsewhere that still points into this project (a key nothing here expected) refuses the whole
    // delete, and the transaction has already put everything back.
    if (err instanceof Prisma.PrismaClientKnownRequestError || err instanceof Prisma.PrismaClientUnknownRequestError) {
      console.error("[projects] deleting a project was refused by the database", err);
      return { error: "The database refused the delete, so nothing was deleted. The error is in the app's log." };
    }
    throw err;
  }
  if ("error" in result) return result;
  return { ...result, mediaRemoved: await removeWorkspaceMediaFiles([projectId]) };
}
