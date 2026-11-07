import { prisma as globalPrisma } from "@support-automation/db";
import { DEFAULT_PASSWORD_LENGTH } from "@/lib/userRules";
import { tenantOfCustomer } from "@/server/tenant";

/**
 * How long a new password must be. A customer sets its own (Settings → Security), a project's Lead may set one for
 * that project (Project Members), and a new password is checked against the one that applies. Existing passwords
 * keep working: this is only asked when one is chosen. Platform operators have their own, fixed rule.
 */

export async function customerPasswordLength(tenant: string | null): Promise<number> {
  const row = await globalPrisma.securitySettings.findFirst({ where: { customerId: tenant }, select: { minPasswordLength: true } });
  return row?.minPasswordLength ?? DEFAULT_PASSWORD_LENGTH;
}

/** The project's own length, or else its customer's. */
export async function projectPasswordLength(projectId: string): Promise<number> {
  const project = await globalPrisma.project.findUnique({ where: { id: projectId }, select: { minPasswordLength: true, customerId: true } });
  if (project?.minPasswordLength) return project.minPasswordLength;
  return customerPasswordLength(await tenantOfCustomer(project?.customerId ?? null));
}

/** Somebody in exactly one project follows that project; anybody else, their customer. */
export async function passwordLengthForUser(userId: string): Promise<number> {
  const user = await globalPrisma.user.findUnique({
    where: { id: userId },
    select: { customerId: true, projectAccess: { select: { projectId: true } } },
  });
  const projects = user?.projectAccess ?? [];
  if (projects.length === 1) return projectPasswordLength(projects[0]!.projectId);
  return customerPasswordLength(await tenantOfCustomer(user?.customerId ?? null));
}
