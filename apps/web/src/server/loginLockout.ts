import { tenantSingletonId } from "@support-automation/db";
import { globalPrisma as prisma } from "@/server/db";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * One wrong secret — a password at sign-in, a two-step code, or the current password on My account — counted
 * toward the person's customer's lockout (SecuritySettings). Shared so a stolen session cannot guess the
 * password through My account any faster than a stranger can at the sign-in page.
 */
export async function recordFailedSecret(
  user: { id: string; username: string; failedLoginAttempts: number; lastFailedLoginAt: Date | null },
  tenant: string | null,
  event: "LOGIN_FAILURE" | "LOGIN_MFA_FAILURE" | "ACCOUNT_PASSWORD_CHECK_FAILED",
): Promise<void> {
  const settingsId = tenantSingletonId("SecuritySettings", tenant)!;
  const settings = await prisma.securitySettings.upsert({ where: { id: settingsId }, update: {}, create: { id: settingsId, customerId: tenant } });
  const windowStart = new Date(Date.now() - settings.loginLockoutWindowMinutes * 60 * 1000);
  // A failed attempt outside the lockout window resets the counter to 1 rather than compounding
  // forever — only recent attempts within loginLockoutWindowMinutes count toward the threshold.
  const attemptsInWindow = user.lastFailedLoginAt && user.lastFailedLoginAt > windowStart ? user.failedLoginAttempts + 1 : 1;
  const now = new Date();

  if (attemptsInWindow >= settings.loginLockoutThreshold) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attemptsInWindow,
        lastFailedLoginAt: now,
        lockedUntil: new Date(now.getTime() + settings.loginLockoutDurationMinutes * 60 * 1000),
      },
    });
    await logSystemEvent("WARN", "auth", "LOGIN_LOCKED_OUT", { username: user.username, attempts: attemptsInWindow, after: event }, { actorUserId: user.id });
  } else {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: attemptsInWindow, lastFailedLoginAt: now } });
    await logSystemEvent("WARN", "auth", event, { username: user.username }, { actorUserId: user.id });
  }
}
