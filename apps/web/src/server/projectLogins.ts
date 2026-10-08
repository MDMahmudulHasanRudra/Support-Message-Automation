import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";

/**
 * Active dashboard logins that can enter the current project: those given access to it, and Main
 * Admins (who may enter every project). Used to link a roster member to their login.
 */
export async function loginsForProject(): Promise<{ id: string; name: string; username: string }[]> {
  const projectId = await activeProjectId();
  return prisma.user.findMany({
    where: {
      isActive: true,
      OR: [
        { projectAccess: { some: { projectId } } },
        { permissionModule: { permissions: { some: { permission: { key: "projects.manage" } } } } },
      ],
    },
    select: { id: true, name: true, username: true },
    orderBy: { name: "asc" },
  });
}
