"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { platformPrisma } from "@/server/db";
import { createSession } from "@/server/auth";
import { createUserWithAccess } from "@/server/adminUsers";
import { currentHostScope } from "@/server/hostScope";
import { hashInvitationToken } from "@/server/saasBilling";
import { logSystemEvent } from "@/server/logSystemEvent";
import { forgetProjectAccessDecisions } from "@/server/projectContext";

/**
 * Accepting an owner invitation (SAAS_PLATFORM_PLAN.md section 10.5). The link is single-use: it is
 * CLAIMED by one conditional update before the login is created, so two people opening the same
 * link cannot both succeed; if creating the login then fails, the claim is released. The new user's
 * only access is the customer's project, as its Lead, with no global role. On a customer's address
 * only that customer's invitations work; on an admin or unknown address none do.
 */

export interface InviteState {
  error?: string;
}

export interface InvitationCheck {
  ok: boolean;
  name?: string;
  email?: string | null;
  customerName?: string;
  reason?: string;
}

async function findUsable(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const invitation = await platformPrisma.userInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    include: { customer: { select: { name: true } } },
  });
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) return null;
  const scope = await currentHostScope();
  if (scope.kind === "UNKNOWN" || scope.kind === "ADMIN") return null;
  if (scope.kind === "CUSTOMER" && scope.customerId !== invitation.customerId) return null;
  return invitation;
}

/** For the page: whether the link can still be used, without revealing anything about a bad one. */
export async function checkInvitation(token: string): Promise<InvitationCheck> {
  const invitation = await findUsable(token);
  if (!invitation) return { ok: false, reason: "This invitation link is not valid any more. It may have been used, revoked or expired. Ask for a new one." };
  return { ok: true, name: invitation.name, email: invitation.email, customerName: invitation.customer.name };
}

export async function acceptInvitation(token: string, _prev: InviteState, formData: FormData): Promise<InviteState> {
  const invitation = await findUsable(token);
  if (!invitation) return { error: "This invitation link is not valid any more. Ask for a new one." };

  const now = new Date();
  const claimed = await platformPrisma.userInvitation.updateMany({
    where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { acceptedAt: now },
  });
  if (claimed.count !== 1) return { error: "This invitation link was just used. Ask for a new one." };

  const result = await createUserWithAccess(platformPrisma, {
    username: formData.get("username"),
    name: invitation.name,
    email: invitation.email,
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
    permissionModuleId: null,
    employee: null,
    access: [{ projectId: invitation.projectId, level: "FULL", isLead: true }],
  });
  if (!result.ok) {
    // Release the claim so they can correct the form and try again.
    await platformPrisma.userInvitation.updateMany({ where: { id: invitation.id, acceptedUserId: null }, data: { acceptedAt: null } });
    return { error: result.error };
  }
  await platformPrisma.userInvitation.update({ where: { id: invitation.id }, data: { acceptedUserId: result.userId } });
  await platformPrisma.subscriptionEvent.create({
    data: { customerId: invitation.customerId, kind: "OWNER_ACCEPTED", detail: { userId: result.userId, username: String(formData.get("username") ?? "") } },
  });
  await logSystemEvent("INFO", "users", "OWNER_INVITATION_ACCEPTED", { customerId: invitation.customerId, userId: result.userId });
  forgetProjectAccessDecisions();

  const h = await headers();
  await createSession(result.userId, { ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: h.get("user-agent") });
  redirect("/open");
}
