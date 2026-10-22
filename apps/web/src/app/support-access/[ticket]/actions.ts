"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma as globalPrisma } from "@support-automation/db";
import { createSession } from "@/server/auth";
import { requestHostname } from "@/server/hostScope";
import { hashSupportTicket } from "@/server/platform/support";

export interface SupportTicketState {
  error?: string;
}

const INVALID = "This support link is not valid any more. Start support access again from the platform.";

/**
 * Turn a support ticket into a browser session on the customer's own address (SAAS_PLATFORM_PLAN.md
 * §12). Once only (a conditional claim), within its minute, on exactly the address it was issued
 * for, while the support access itself is still open. The session belongs to the operator's support
 * identity in that customer and ends when the support access ends.
 */
export async function consumeSupportTicket(ticket: string): Promise<SupportTicketState> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) return { error: INVALID };
  const now = new Date();
  const row = await globalPrisma.supportAccessSession.findUnique({ where: { ticketHash: hashSupportTicket(ticket) } });
  if (!row || !row.supportUserId || row.ticketUsedAt || row.endedAt || row.ticketExpiresAt <= now || row.expiresAt <= now) return { error: INVALID };
  if ((await requestHostname()) !== row.hostname) return { error: INVALID };
  const claimed = await globalPrisma.supportAccessSession.updateMany({ where: { id: row.id, ticketUsedAt: null, endedAt: null }, data: { ticketUsedAt: now } });
  if (claimed.count !== 1) return { error: INVALID };
  const h = await headers();
  await createSession(
    row.supportUserId,
    { ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: h.get("user-agent") },
    { supportAccessSessionId: row.id, expiresAt: row.expiresAt },
  );
  redirect("/open");
}
