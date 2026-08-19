"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { logSystemEvent } from "@/server/logSystemEvent";

const MIN_SESSION_LIFETIME_HOURS = 1;
const MAX_SESSION_LIFETIME_HOURS = 720; // 30 days — this app's safe maximum, per spec

export interface SecuritySettingsFormState {
  error?: string;
  success?: boolean;
}

export async function updateSecuritySettings(
  _prevState: SecuritySettingsFormState,
  formData: FormData,
): Promise<SecuritySettingsFormState> {
  const session = await requireSession();
  if (!(await hasPermission(session, "security_settings.edit"))) {
    return { error: "You do not have permission to perform this action." };
  }

  const sessionLifetimeHours = Number(formData.get("sessionLifetimeHours"));
  const loginLockoutThreshold = Number(formData.get("loginLockoutThreshold"));
  const loginLockoutWindowMinutes = Number(formData.get("loginLockoutWindowMinutes"));
  const loginLockoutDurationMinutes = Number(formData.get("loginLockoutDurationMinutes"));

  if (
    !Number.isFinite(sessionLifetimeHours) ||
    sessionLifetimeHours < MIN_SESSION_LIFETIME_HOURS ||
    sessionLifetimeHours > MAX_SESSION_LIFETIME_HOURS
  ) {
    return { error: `Session lifetime must be between ${MIN_SESSION_LIFETIME_HOURS} and ${MAX_SESSION_LIFETIME_HOURS} hours.` };
  }
  if (!Number.isFinite(loginLockoutThreshold) || loginLockoutThreshold < 1) {
    return { error: "Login lockout threshold must be at least 1." };
  }
  if (!Number.isFinite(loginLockoutWindowMinutes) || loginLockoutWindowMinutes < 1) {
    return { error: "Login lockout window must be at least 1 minute." };
  }
  if (!Number.isFinite(loginLockoutDurationMinutes) || loginLockoutDurationMinutes < 1) {
    return { error: "Login lockout duration must be at least 1 minute." };
  }

  await prisma.securitySettings.upsert({
    where: { id: "global" },
    update: {
      sessionLifetimeHours,
      loginLockoutThreshold,
      loginLockoutWindowMinutes,
      loginLockoutDurationMinutes,
    },
    create: {
      id: "global",
      sessionLifetimeHours,
      loginLockoutThreshold,
      loginLockoutWindowMinutes,
      loginLockoutDurationMinutes,
    },
  });

  // Applies to NEW sessions only — createSession() reads this at creation time and bakes an
  // absolute expiresAt into the row; already-issued sessions keep their original expiry.
  await logSystemEvent("INFO", "security", "SECURITY_SETTINGS_UPDATED", {
    actorId: session.userId,
    sessionLifetimeHours,
  });
  revalidatePath("/settings/security");
  return { success: true };
}
