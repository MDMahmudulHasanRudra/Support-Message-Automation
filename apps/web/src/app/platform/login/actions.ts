"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma as globalPrisma } from "@support-automation/db";
import { clientAddress, platformSignInFailures, tooManyAttemptsMessage } from "@/server/authRateLimit";
import { hostServesPlatform } from "@support-automation/shared";
import { verifyPassword } from "@/server/auth";
import { currentHostScope } from "@/server/hostScope";
import { createOperatorSession, destroyOperatorSession } from "@/server/platform/auth";
import { logPlatformEvent } from "@/server/platform/log";

export interface PlatformLoginState {
  error?: string;
}

const GENERIC = "Invalid username or password.";

/** Platform operators sign in here only — never on the customer software's sign-in page, and the reverse. */
export async function platformLogin(_prev: PlatformLoginState, formData: FormData): Promise<PlatformLoginState> {
  if (!hostServesPlatform(await currentHostScope())) return { error: GENERIC };
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!username || !password) return { error: "Username and password are required." };
  // Operators have no per-account lockout, so failed attempts per address are the only brake on guessing
  // here (authRateLimit.ts). Checked before the lookup: a refusal says nothing about who exists.
  const address = clientAddress(await headers());
  const limit = platformSignInFailures.check(address);
  if (limit.limited) return { error: tooManyAttemptsMessage(limit.retryAfterSeconds) };
  const operator = await globalPrisma.platformOperator.findUnique({ where: { username } });
  if (!operator || !operator.isActive || !verifyPassword(password, operator.passwordHash)) {
    await logPlatformEvent("WARN", "PLATFORM_LOGIN_FAILURE", { username });
    const after = platformSignInFailures.recordFailure(address);
    if (after.reachedNow) await logPlatformEvent("WARN", "PLATFORM_LOGIN_RATE_LIMITED", { address, retryAfterSeconds: after.retryAfterSeconds });
    return { error: GENERIC };
  }
  await globalPrisma.platformOperator.update({ where: { id: operator.id }, data: { lastLoginAt: new Date() } });
  await createOperatorSession(operator.id);
  await logPlatformEvent("INFO", "PLATFORM_LOGIN", { username });
  redirect("/platform");
}

export async function platformLogout(): Promise<void> {
  await destroyOperatorSession();
  redirect("/platform/login");
}
