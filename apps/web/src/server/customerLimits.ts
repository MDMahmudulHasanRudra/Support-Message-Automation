import { customerProjectWhere, prisma as globalPrisma, type Prisma } from "@support-automation/db";
import { limitRefusal, type LimitKind } from "@support-automation/shared";
import { customerOfTenant, currentTenant } from "@/server/tenant";

/**
 * Plan limits (SAAS_PLATFORM_PLAN.md §10.4, §12): how many WhatsApp numbers and users a customer's
 * plan allows, across ALL the customer's workspaces. Checked INSIDE the transaction that adds the
 * thing, under a Postgres advisory lock on (customer, kind), so two clicks at once cannot both pass
 * the last free place; the count is taken after the lock, so it sees whatever the previous holder
 * committed.
 *
 * Only a customer with a current subscription is limited; the original installation (Customer #1)
 * has none until an operator gives it one. Lowering a plan never removes anything: existing numbers
 * and people keep working; only adding a new one is refused, with the reason.
 *
 *   - WHATSAPP_ACCOUNTS: numbers in every workspace of the customer.
 *   - USERS: the customer's people (its owner included; Nexora support identities never counted).
 *     Checked when a NEW login is created — giving an existing person access to another workspace
 *     adds no user.
 */

type Tx = Prisma.TransactionClient;

export async function lockAndCheckCustomerLimit(tx: Tx, projectId: string | null, kind: LimitKind): Promise<string | null> {
  const customerId = projectId ? await customerOfProject(projectId) : await customerOfTenant(await currentTenant());
  if (!customerId) return null;
  const subscription = await globalPrisma.subscription.findFirst({
    where: { customerId, endedAt: null },
    select: { planName: true, maxWhatsAppAccounts: true, maxUsers: true },
  });
  if (!subscription) return null;
  const max = kind === "WHATSAPP_ACCOUNTS" ? subscription.maxWhatsAppAccounts : subscription.maxUsers;
  if (max === null) return null;

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`saas-limit:${customerId}:${kind}`}))`;
  const customer = await globalPrisma.customer.findUnique({ where: { id: customerId }, select: { isFounding: true } });
  const current =
    kind === "WHATSAPP_ACCOUNTS"
      ? await globalPrisma.whatsAppAccount.count({ where: { project: await customerProjectWhere(globalPrisma, customerId) } })
      : await globalPrisma.user.count({ where: { customerId: customer?.isFounding ? null : customerId, isActive: true, supportOperatorId: null } });
  return limitRefusal(kind, current, max, subscription.planName);
}

/** The customer of a project: its own, or the founding customer for the original installation's projects. */
async function customerOfProject(projectId: string): Promise<string | null> {
  const project = await globalPrisma.project.findUnique({ where: { id: projectId }, select: { customerId: true } });
  if (!project) return null;
  return project.customerId ?? (await globalPrisma.customer.findFirst({ where: { isFounding: true }, select: { id: true } }))?.id ?? null;
}

/** Thrown inside a transaction to abandon it with the plain reason. */
export class CustomerLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerLimitError";
  }
}
