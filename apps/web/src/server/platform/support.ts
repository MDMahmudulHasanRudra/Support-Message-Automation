import { createHash, randomBytes } from "node:crypto";
import { prisma as globalPrisma } from "@support-automation/db";
import { hashPassword } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";
import { runWithTenant, tenantOfCustomer } from "@/server/tenant";
import { requireOperatorPage } from "@/server/platform/auth";
import { logPlatformEvent } from "@/server/platform/log";

/**
 * Support access (SAAS_PLATFORM_PLAN.md §12): a Nexora operator enters ONE customer's software for
 * technical support — never with the customer's password, never as a hidden bypass.
 *
 *   - Started on the platform by an operator allowed to (`canSupport`), with a reason and their own
 *     password re-entered; time-limited (15 minutes to 2 hours).
 *   - Handed to the customer's OWN address by a single-use ticket: random, stored only as a hash,
 *     valid one minute. Hostname-bound sessions stay exactly as they are; the ticket is how the
 *     browser gets a session there.
 *   - Inside, the operator acts as their SUPPORT IDENTITY in that customer: a user of that customer
 *     with its Administrator role and no usable password. It belongs to the customer — their Main
 *     Admin sees it and can deactivate it, which turns support access off for them.
 *   - Visible (a banner on every page), recorded (start, every change, end — in the customer's own
 *     System Log and on the platform), and revocable from the platform at any time.
 */

export const SUPPORT_DURATIONS = [15, 30, 60, 120] as const;
export const TICKET_MS = 60_000;
export const hashSupportTicket = (ticket: string) => createHash("sha256").update(`nexora-support:${ticket}`).digest("hex");

export interface SupportSessionView {
  id: string;
  customerId: string;
  customerName: string;
  operatorUsername: string;
  hostname: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  ticketUsedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  endedByUsername: string | null;
  active: boolean;
}

export async function listSupportSessions(options: { customerId?: string; activeOnly?: boolean; take?: number } = {}): Promise<SupportSessionView[]> {
  await requireOperatorPage();
  const now = new Date();
  const rows = await globalPrisma.supportAccessSession.findMany({
    where: { ...(options.customerId ? { customerId: options.customerId } : {}), ...(options.activeOnly ? { endedAt: null, expiresAt: { gt: now } } : {}) },
    include: { customer: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: options.take ?? 50,
  });
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customerId,
    customerName: r.customer.name,
    operatorUsername: r.operatorUsername,
    hostname: r.hostname,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    ticketUsedAt: r.ticketUsedAt?.toISOString() ?? null,
    endedAt: r.endedAt?.toISOString() ?? null,
    endReason: r.endReason,
    endedByUsername: r.endedByUsername,
    active: !r.endedAt && r.expiresAt > now,
  }));
}

/** The operator's support identity inside one customer: created on first use, never given a usable password. */
export async function supportIdentity(operator: { operatorId: string; username: string; name: string }, tenant: string | null): Promise<{ id: string } | { error: string }> {
  const role = await globalPrisma.permissionModule.findFirst({ where: { customerId: tenant, name: "Administrator", isSystem: true }, select: { id: true } });
  if (!role) return { error: "This customer's Administrator role is missing. Run the deployment's seed step, then try again." };
  const existing = await globalPrisma.user.findFirst({ where: { supportOperatorId: operator.operatorId, customerId: tenant }, select: { id: true, isActive: true } });
  if (existing) {
    // The customer's own decision wins: a support identity their Main Admin deactivated stays off.
    if (!existing.isActive) return { error: "This customer has turned Nexora support access off (their Main Admin deactivated the support user)." };
    return { id: existing.id };
  }
  const user = await globalPrisma.user.create({
    data: {
      username: `nexora-support-${operator.username}-${randomBytes(3).toString("hex")}`,
      name: `Nexora Support (${operator.name})`,
      passwordHash: hashPassword(randomBytes(32).toString("base64url")),
      permissionModuleId: role.id,
      customerId: tenant,
      supportOperatorId: operator.operatorId,
    },
    select: { id: true },
  });
  return { id: user.id };
}

/** Shared by the platform and the customer-side "End support session": idempotent. */
export async function closeSupportAccess(id: string, endReason: "ENDED" | "REVOKED", by: string): Promise<void> {
  const now = new Date();
  const closed = await globalPrisma.supportAccessSession.updateMany({ where: { id, endedAt: null }, data: { endedAt: now, endReason, endedByUsername: by } });
  await globalPrisma.userSession.updateMany({ where: { supportAccessSessionId: id, revokedAt: null }, data: { revokedAt: now, revokedReason: "SUPPORT_ENDED" } });
  if (closed.count === 0) return;
  const row = await globalPrisma.supportAccessSession.findUniqueOrThrow({ where: { id }, select: { customerId: true, operatorUsername: true } });
  await logPlatformEvent("INFO", endReason === "ENDED" ? "Support access ended" : "Support access revoked", { customerId: row.customerId, operator: row.operatorUsername, by, supportAccessSessionId: id }, { type: "Customer", id: row.customerId });
  await runWithTenant(await tenantOfCustomer(row.customerId), () =>
    logSystemEvent("INFO", "support", endReason === "ENDED" ? "NEXORA_SUPPORT_ACCESS_ENDED" : "NEXORA_SUPPORT_ACCESS_REVOKED", { operator: row.operatorUsername, by, supportAccessSessionId: id }),
  );
}
