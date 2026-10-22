"use server";

import { revalidatePath } from "next/cache";
import { prisma as globalPrisma } from "@support-automation/db";
import { hashPassword } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";
import { runWithTenant, tenantOfCustomer } from "@/server/tenant";
import { confirmOperatorPassword, requireOperatorAction } from "@/server/platform/auth";
import { logPlatformEvent } from "@/server/platform/log";
import { MIN_PASSWORD_LENGTH } from "@/lib/userRules";

/**
 * The one thing the platform does to a customer's people (SAAS_PLATFORM_PLAN.md §12): give a
 * locked-out owner a new password. Everything else about their people is the customer's own Main
 * Admin's business. Needs the operator's own password; signs the person out everywhere; recorded on
 * the platform AND in the customer's own System Log, so the customer can see it happened.
 */
export async function resetCustomerUserPassword(customerId: string, userId: string, formData: FormData): Promise<{ error?: string; success?: string }> {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied };
  if (!(await confirmOperatorPassword(access.operator, formData.get("operatorPassword")))) return { error: "Your platform password is not correct." };
  const password = String(formData.get("newPassword") ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) return { error: `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.` };

  const tenant = await tenantOfCustomer(customerId);
  const user = await globalPrisma.user.findFirst({ where: { id: userId, customerId: tenant, supportOperatorId: null }, select: { id: true, username: true } });
  if (!user) return { error: "That person is not one of this customer's people." };

  const now = new Date();
  await globalPrisma.$transaction([
    globalPrisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(password), failedLoginAttempts: 0, lastFailedLoginAt: null, lockedUntil: null } }),
    globalPrisma.userSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now, revokedReason: "PASSWORD_CHANGED" } }),
  ]);
  await logPlatformEvent("WARN", "Customer user's password reset", { customerId, username: user.username, by: access.operator.username }, { type: "Customer", id: customerId });
  await runWithTenant(tenant, () =>
    logSystemEvent("WARN", "auth", "PASSWORD_RESET_BY_RELQIVO_SUPPORT", { username: user.username, operator: access.operator.username }, { targetType: "User", targetId: user.id }),
  );
  revalidatePath(`/platform/customers/${customerId}`);
  return { success: `${user.username} has a new password and was signed out everywhere. Share it privately.` };
}
