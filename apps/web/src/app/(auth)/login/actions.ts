"use server";

import { globalPrisma as prisma } from "@/server/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createSession, verifyPassword } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";
import { currentHostScope, requestHostname } from "@/server/hostScope";
import { runWithTenant, tenantOfCustomer } from "@/server/tenant";
import { tenantSingletonId } from "@support-automation/db";
import type { HostScope } from "@support-automation/shared";

export interface LoginState {
  error?: string;
}

const GENERIC_ERROR = "Invalid username or password.";

async function readRequestMeta(): Promise<{ ipAddress: string | null; userAgent: string | null }> {
  const store = await headers();
  const forwardedFor = store.get("x-forwarded-for");
  const ipAddress = forwardedFor ? forwardedFor.split(",")[0]?.trim() ?? null : null;
  return { ipAddress, userAgent: store.get("user-agent") };
}

/**
 * Whether this person may sign in on this address (SAAS_PLATFORM_PLAN.md §3.3, §12). With hostname
 * routing off every address is OPEN: unchanged — anybody signs in as before. A customer's address
 * takes that customer's people only (their own Main Admin included); the platform address takes no
 * customer's people (the platform has its own sign-in); an unknown address takes nobody. Refused
 * with the SAME message as a wrong password: an address must not reveal who has an account elsewhere.
 */
async function mayUseThisAddress(userTenant: string | null, scope: HostScope): Promise<boolean> {
  if (scope.kind === "OPEN") return true;
  if (scope.kind !== "CUSTOMER") return false;
  return (await tenantOfCustomer(scope.customerId)) === userTenant;
}

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!username || !password) {
    return { error: "Username and password are required." };
  }

  // Usernames are unique across the platform; which customer the person belongs to is checked below.
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    return { error: GENERIC_ERROR };
  }
  // Every log line and setting from here on is the person's own customer's.
  const tenant = await tenantOfCustomer(user.customerId);
  return runWithTenant(tenant, () => signIn(user, tenant, password));
}

async function signIn(
  user: { id: string; username: string; passwordHash: string; isActive: boolean; lockedUntil: Date | null; lastFailedLoginAt: Date | null; failedLoginAttempts: number; supportOperatorId: string | null },
  tenant: string | null,
  password: string,
): Promise<LoginState> {
  const username = user.username;
  // A Nexora support identity has no password that works: it is entered only through support access.
  if (user.supportOperatorId) {
    await logSystemEvent("WARN", "auth", "LOGIN_BLOCKED_SUPPORT_IDENTITY", { username });
    return { error: GENERIC_ERROR };
  }

  // Checked before the password itself — never reveal "locked" vs. "wrong password" to the client.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await logSystemEvent("WARN", "auth", "LOGIN_BLOCKED_LOCKED_OUT", { username });
    return { error: GENERIC_ERROR };
  }

  if (!verifyPassword(password, user.passwordHash)) {
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
      await logSystemEvent("WARN", "auth", "LOGIN_LOCKED_OUT", { username, attempts: attemptsInWindow });
    } else {
      await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: attemptsInWindow, lastFailedLoginAt: now } });
      await logSystemEvent("WARN", "auth", "LOGIN_FAILURE", { username });
    }
    return { error: GENERIC_ERROR };
  }

  if (!user.isActive) {
    // Deliberately the same generic message — an inactive account must not be distinguishable
    // from a wrong password to an unauthenticated caller.
    await logSystemEvent("WARN", "auth", "LOGIN_BLOCKED_INACTIVE", { username });
    return { error: GENERIC_ERROR };
  }

  const scope = await currentHostScope();
  if (!(await mayUseThisAddress(tenant, scope))) {
    await logSystemEvent("WARN", "auth", "LOGIN_BLOCKED_WRONG_ADDRESS", { username, host: await requestHostname(), scope: scope.kind });
    return { error: GENERIC_ERROR };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lastFailedLoginAt: null, lockedUntil: null, lastLoginAt: new Date() },
  });

  const meta = await readRequestMeta();
  await createSession(user.id, meta);
  await logSystemEvent("INFO", "auth", "LOGIN_SUCCESS", { username });
  // Into the project the user last opened (or their only one) — /open decides.
  redirect("/open");
}
