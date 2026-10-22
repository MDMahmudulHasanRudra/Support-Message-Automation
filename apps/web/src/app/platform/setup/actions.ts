"use server";

import { redirect } from "next/navigation";
import { prisma as globalPrisma } from "@support-automation/db";
import { hostServesPlatform } from "@support-automation/shared";
import { getSession, hashPassword } from "@/server/auth";
import { currentHostScope } from "@/server/hostScope";
import { isMainAdmin } from "@/server/projectContext";
import { createOperatorSession } from "@/server/platform/auth";
import { logPlatformEvent } from "@/server/platform/log";
import { MIN_PASSWORD_LENGTH, normalizeUsername } from "@/lib/userRules";

export interface SetupState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Who may create the FIRST platform operator (SAAS_PLATFORM_PLAN.md §12): only while none exists,
 * only on an address the platform is served on, and only someone already signed in to the software
 * as a Main Admin of the original installation — the owner, on day one, with no VPS command. Once an
 * operator exists this is closed for good; further operators are created on the platform.
 */
export async function setupAllowed(): Promise<{ ok: true; username: string } | { ok: false; reason: string }> {
  if (!hostServesPlatform(await currentHostScope())) return { ok: false, reason: "The platform is not available on this address." };
  if ((await globalPrisma.platformOperator.count()) > 0) return { ok: false, reason: "The platform is already set up. Sign in on the platform." };
  const session = await getSession();
  if (!session) return { ok: false, reason: "Sign in to the software first, as a Main Admin of the original installation, then open this page again." };
  if ((session.tenant ?? null) !== null || session.support || !(await isMainAdmin(session.userId))) {
    return { ok: false, reason: "Only a Main Admin of the original installation can set up the platform." };
  }
  return { ok: true, username: session.username };
}

export async function createFirstOperator(_prev: SetupState, formData: FormData): Promise<SetupState> {
  const allowed = await setupAllowed();
  if (!allowed.ok) return { error: allowed.reason };
  const username = normalizeUsername(formData.get("username"));
  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  const password = String(formData.get("password") ?? "");
  const fieldErrors: Record<string, string> = {};
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) fieldErrors.username = "3–40 characters: letters, numbers, dots, dashes, underscores.";
  if (!name) fieldErrors.name = "Enter a name.";
  if (password.length < MIN_PASSWORD_LENGTH) fieldErrors.password = `At least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password !== String(formData.get("confirmPassword") ?? "")) fieldErrors.confirmPassword = "The passwords do not match.";
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const operator = await globalPrisma.$transaction(async (tx) => {
    // Re-checked inside the transaction, under a lock, so two people pressing at once make one.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('nexora-platform-setup'))`;
    if ((await tx.platformOperator.count()) > 0) return null;
    return tx.platformOperator.create({ data: { username, name, passwordHash: hashPassword(password), createdByUsername: `software:${allowed.username}` } });
  });
  if (!operator) return { error: "The platform was set up a moment ago. Sign in on the platform." };
  await logPlatformEvent("INFO", "PLATFORM_FIRST_OPERATOR_CREATED", { operator: username, by: allowed.username });
  await createOperatorSession(operator.id);
  redirect("/platform");
}
