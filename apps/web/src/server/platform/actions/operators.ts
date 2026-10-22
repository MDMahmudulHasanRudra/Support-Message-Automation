"use server";

import { revalidatePath } from "next/cache";
import { prisma as globalPrisma } from "@support-automation/db";
import { hashPassword } from "@/server/auth";
import { confirmOperatorPassword, requireOperatorAction } from "@/server/platform/auth";
import { logPlatformEvent } from "@/server/platform/log";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { MIN_PASSWORD_LENGTH, normalizeUsername } from "@/lib/userRules";

/**
 * The people who run the Nexora platform (SAAS_PLATFORM_PLAN.md §12). Every change needs the acting
 * operator's own password, and nobody can lock the platform out: the last active operator cannot be
 * deactivated, and an operator cannot deactivate themselves.
 */

export interface OperatorActionResult {
  error?: string;
  success?: string;
  fieldErrors?: Record<string, string>;
}

async function authorised(formData: FormData) {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied } as const;
  if (!(await confirmOperatorPassword(access.operator, formData.get("operatorPassword")))) return { error: "Your platform password is not correct." } as const;
  return { operator: access.operator } as const;
}

export async function createOperator(_prev: OperatorActionResult, formData: FormData): Promise<OperatorActionResult> {
  const auth = await authorised(formData);
  if ("error" in auth) return { error: auth.error };
  const username = normalizeUsername(formData.get("username"));
  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  const password = String(formData.get("password") ?? "");
  const fieldErrors: Record<string, string> = {};
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) fieldErrors.username = "3–40 characters: letters, numbers, dots, dashes, underscores.";
  if (!name) fieldErrors.name = "Enter a name.";
  if (password.length < MIN_PASSWORD_LENGTH) fieldErrors.password = `At least ${MIN_PASSWORD_LENGTH} characters.`;
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  try {
    await globalPrisma.platformOperator.create({
      data: { username, name, email: String(formData.get("email") ?? "").trim() || null, passwordHash: hashPassword(password), canSupport: formData.get("canSupport") === "on", createdByUsername: auth.operator.username },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { fieldErrors: { username: "That username is taken." } };
    throw err;
  }
  await logPlatformEvent("WARN", "Platform operator created", { username, canSupport: formData.get("canSupport") === "on", by: auth.operator.username });
  revalidatePath("/platform/operators");
  return { success: `${username} can now sign in to the platform. Share the password privately.` };
}

export async function setOperatorActive(operatorId: string, active: boolean, formData: FormData): Promise<OperatorActionResult> {
  const auth = await authorised(formData);
  if ("error" in auth) return { error: auth.error };
  if (!active && operatorId === auth.operator.operatorId) return { error: "You cannot deactivate yourself." };
  const updated = await globalPrisma.$transaction(async (tx) => {
    if (!active && (await tx.platformOperator.count({ where: { isActive: true, id: { not: operatorId } } })) === 0) return null;
    const row = await tx.platformOperator.update({ where: { id: operatorId }, data: { isActive: active }, select: { username: true } });
    if (!active) await tx.platformOperatorSession.updateMany({ where: { operatorId, revokedAt: null }, data: { revokedAt: new Date() } });
    return row;
  });
  if (!updated) return { error: "The last active operator cannot be deactivated." };
  await logPlatformEvent("WARN", active ? "Platform operator reactivated" : "Platform operator deactivated", { username: updated.username, by: auth.operator.username });
  revalidatePath("/platform/operators");
  return { success: active ? `${updated.username} can sign in again.` : `${updated.username} is deactivated and signed out.` };
}

export async function resetOperatorPassword(operatorId: string, formData: FormData): Promise<OperatorActionResult> {
  const auth = await authorised(formData);
  if ("error" in auth) return { error: auth.error };
  const password = String(formData.get("newPassword") ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) return { error: `At least ${MIN_PASSWORD_LENGTH} characters.` };
  const row = await globalPrisma.platformOperator.update({ where: { id: operatorId }, data: { passwordHash: hashPassword(password) }, select: { username: true } });
  if (operatorId !== auth.operator.operatorId) {
    await globalPrisma.platformOperatorSession.updateMany({ where: { operatorId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  await logPlatformEvent("WARN", "Platform operator password changed", { username: row.username, by: auth.operator.username });
  revalidatePath("/platform/operators");
  return { success: `Password for ${row.username} changed.` };
}
