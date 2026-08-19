"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import { createSession, verifyPassword } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

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

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!username || !password) {
    return { error: "Username and password are required." };
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    return { error: GENERIC_ERROR };
  }

  // Checked before the password itself — never reveal "locked" vs. "wrong password" to the client.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await logSystemEvent("WARN", "auth", "LOGIN_BLOCKED_LOCKED_OUT", { username });
    return { error: GENERIC_ERROR };
  }

  if (!verifyPassword(password, user.passwordHash)) {
    const settings = await prisma.securitySettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
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

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lastFailedLoginAt: null, lockedUntil: null, lastLoginAt: new Date() },
  });

  const meta = await readRequestMeta();
  await createSession(user.id, meta);
  await logSystemEvent("INFO", "auth", "LOGIN_SUCCESS", { username });
  redirect("/overview");
}
