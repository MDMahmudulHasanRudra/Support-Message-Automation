import type { Prisma } from "@support-automation/db";
import { limitRefusal, type LimitKind } from "@support-automation/shared";

/**
 * Plan limits (SAAS_PLATFORM_PLAN.md section 10.4): how many WhatsApp numbers and users a
 * customer's plan allows. Checked INSIDE the transaction that adds the thing, under a Postgres
 * advisory lock on (project, kind), so two clicks at once cannot both pass the last free place.
 *
 * Only a project whose customer has a current subscription is limited. A project with no customer,
 * or a customer with no subscription (Customer #1 until an admin gives it one), has no limit at all.
 * Lowering a plan never removes anything: existing numbers and people keep working; only adding a
 * new one is refused, with the reason.
 */

type Tx = Prisma.TransactionClient;

/** Users counted against a plan: active logins with access to the project, Main Admins excluded. */
const COUNTED_USER = {
  isActive: true,
  NOT: { permissionModule: { permissions: { some: { permission: { key: "projects.manage" } } } } },
} satisfies Prisma.UserWhereInput;

export async function lockAndCheckCustomerLimit(tx: Tx, projectId: string, kind: LimitKind): Promise<string | null> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { customer: { select: { subscriptions: { where: { endedAt: null }, take: 1, select: { planName: true, maxWhatsAppAccounts: true, maxUsers: true } } } } },
  });
  const subscription = project?.customer?.subscriptions[0];
  if (!subscription) return null;
  const max = kind === "WHATSAPP_ACCOUNTS" ? subscription.maxWhatsAppAccounts : subscription.maxUsers;
  if (max === null) return null;

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`saas-limit:${projectId}:${kind}`}))`;
  const current =
    kind === "WHATSAPP_ACCOUNTS"
      ? await tx.whatsAppAccount.count({ where: { projectId } })
      : await tx.projectAccess.count({ where: { projectId, user: COUNTED_USER } });
  return limitRefusal(kind, current, max, subscription.planName);
}

/** Thrown inside a transaction to abandon it with the plain reason. */
export class CustomerLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerLimitError";
  }
}
