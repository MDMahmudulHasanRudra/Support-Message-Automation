"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma as globalPrisma } from "@support-automation/db";
import { logSystemEvent } from "@/server/logSystemEvent";
import { runWithTenant, tenantOfCustomer } from "@/server/tenant";
import { confirmOperatorPassword, requireOperatorAction } from "@/server/platform/auth";
import { logPlatformEvent } from "@/server/platform/log";
import { closeSupportAccess, hashSupportTicket, SUPPORT_DURATIONS, supportIdentity, TICKET_MS } from "@/server/platform/support";

/** Start and end support access from the platform (SAAS_PLATFORM_PLAN.md §12; the rules are in server/platform/support.ts). */

export async function startSupportAccess(customerId: string, formData: FormData): Promise<{ error?: string; url?: string }> {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied };
  const operator = access.operator;
  if (!operator.canSupport) return { error: "Your platform account is not allowed to enter customers' software." };
  const reason = String(formData.get("reason") ?? "").trim().replace(/\s+/g, " ").slice(0, 500);
  if (reason.length < 10) return { error: "Give the reason for this support access (at least a short sentence)." };
  const minutes = Number(formData.get("minutes"));
  if (!(SUPPORT_DURATIONS as readonly number[]).includes(minutes)) return { error: "Choose how long you need." };
  if (!(await confirmOperatorPassword(operator, formData.get("operatorPassword")))) return { error: "Your platform password is not correct." };

  const customer = await globalPrisma.customer.findUnique({
    where: { id: customerId, removedAt: null },
    select: { name: true, domains: { where: { status: { in: ["ACTIVE", "VERIFIED"] } }, orderBy: { verifiedAt: "asc" }, select: { hostname: true, status: true } } },
  });
  if (!customer) return { error: "This customer no longer exists." };
  const address = customer.domains.find((d) => d.status === "ACTIVE") ?? customer.domains[0];
  if (!address) return { error: "This customer has no verified address yet." };
  const tenant = await tenantOfCustomer(customerId);
  const identity = await supportIdentity(operator, tenant);
  if ("error" in identity) return { error: identity.error };

  const ticket = randomBytes(32).toString("base64url");
  const now = new Date();
  const session = await globalPrisma.supportAccessSession.create({
    data: {
      operatorId: operator.operatorId,
      operatorUsername: operator.username,
      customerId,
      supportUserId: identity.id,
      hostname: address.hostname,
      reason,
      ticketHash: hashSupportTicket(ticket),
      ticketExpiresAt: new Date(now.getTime() + TICKET_MS),
      expiresAt: new Date(now.getTime() + minutes * 60_000),
    },
    select: { id: true, expiresAt: true },
  });
  await logPlatformEvent("WARN", "Support access started", { customerId, operator: operator.username, reason, minutes, supportAccessSessionId: session.id }, { type: "Customer", id: customerId });
  await runWithTenant(tenant, () =>
    logSystemEvent("WARN", "support", "RELQIVO_SUPPORT_ACCESS_STARTED", { operator: operator.username, reason, until: session.expiresAt.toISOString(), supportAccessSessionId: session.id }),
  );
  revalidatePath("/platform", "layout");
  const scheme = (process.env.NEXTAUTH_URL ?? "").startsWith("http://") ? "http" : "https";
  return { url: `${scheme}://${address.hostname}/support-access/${ticket}` };
}

/** End a support session now — the operator's own, or anyone's (revoke). Its browser session dies with it. */
export async function endSupportAccess(supportAccessSessionId: string): Promise<{ error?: string; success?: string }> {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied };
  const row = await globalPrisma.supportAccessSession.findUnique({ where: { id: supportAccessSessionId }, select: { customerId: true, operatorUsername: true, endedAt: true } });
  if (!row) return { error: "This support session no longer exists." };
  if (row.endedAt) return { error: "This support session has already ended." };
  const own = row.operatorUsername === access.operator.username;
  await closeSupportAccess(supportAccessSessionId, own ? "ENDED" : "REVOKED", access.operator.username);
  revalidatePath("/platform", "layout");
  return { success: own ? "Support session ended." : `Support session of ${row.operatorUsername} revoked.` };
}

