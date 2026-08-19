"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession, hashPassword } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { logSystemEvent } from "@/server/logSystemEvent";

const MIN_PASSWORD_LENGTH = 12;
const PERMISSION_DENIED_ERROR = "You do not have permission to perform this action.";

export interface UserFormState {
  error?: string;
}

function normalizeUsername(raw: FormDataEntryValue | null): string {
  return String(raw ?? "").trim().toLowerCase();
}

export async function createUser(_prevState: UserFormState, formData: FormData): Promise<UserFormState> {
  const session = await requireSession();
  if (!(await hasPermission(session, "users.create"))) return { error: PERMISSION_DENIED_ERROR };

  const username = normalizeUsername(formData.get("username"));
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim() || null;
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const permissionModuleId = String(formData.get("permissionModuleId") ?? "").trim() || null;

  if (!username) return { error: "Username is required." };
  if (!name) return { error: "Display name is required." };
  if (password.length < MIN_PASSWORD_LENGTH) return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  if (password !== confirmPassword) return { error: "Passwords do not match." };

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return { error: `A user named "${username}" already exists.` };

  const created = await prisma.user.create({
    data: {
      username,
      name,
      email,
      passwordHash: hashPassword(password),
      permissionModuleId,
    },
  });

  await logSystemEvent("INFO", "users", "USER_CREATED", { actorId: session.userId, targetUserId: created.id, username });
  revalidatePath("/users");
  redirect("/users");
}

export async function updateUser(id: string, _prevState: UserFormState, formData: FormData): Promise<UserFormState> {
  const session = await requireSession();
  if (!(await hasPermission(session, "users.edit"))) return { error: PERMISSION_DENIED_ERROR };

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return { error: "User not found." };

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim() || null;
  const permissionModuleId = String(formData.get("permissionModuleId") ?? "").trim() || null;

  if (!name) return { error: "Display name is required." };

  await prisma.user.update({
    where: { id },
    data: { name, email, permissionModuleId },
  });

  await logSystemEvent("INFO", "users", "USER_UPDATED", { actorId: session.userId, targetUserId: id });
  revalidatePath("/users");
  redirect("/users");
}

export async function setUserActive(id: string, isActive: boolean): Promise<{ error?: string }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "users.disable"))) return { error: PERMISSION_DENIED_ERROR };

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return { error: "User not found." };

  // A deactivating admin must never be able to lock themselves out of the app — the last active
  // Administrator-module user is protected the same way (see permissionModules.ts's delete guard).
  if (!isActive && id === session.userId) {
    return { error: "You cannot deactivate your own account." };
  }

  await prisma.user.update({ where: { id }, data: { isActive } });

  if (!isActive) {
    // Deactivating a user must reject every session they currently hold immediately, not wait for
    // natural expiry — matches "inactive users: existing sessions must be rejected."
    await prisma.userSession.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "ADMIN_REVOKED" },
    });
  }

  await logSystemEvent("INFO", "users", isActive ? "USER_ENABLED" : "USER_DISABLED", {
    actorId: session.userId,
    targetUserId: id,
  });
  revalidatePath("/users");
  return {};
}

export async function resetUserPassword(id: string, newPassword: string): Promise<{ error?: string }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "users.edit"))) return { error: PERMISSION_DENIED_ERROR };

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return { error: "User not found." };

  await prisma.user.update({ where: { id }, data: { passwordHash: hashPassword(newPassword) } });

  // Never silently keep old sessions alive after a password reset — every session for this user
  // is invalidated immediately, forcing a fresh login everywhere.
  await prisma.userSession.updateMany({
    where: { userId: id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: "PASSWORD_CHANGED" },
  });

  await logSystemEvent("WARN", "users", "PASSWORD_RESET", { actorId: session.userId, targetUserId: id });
  revalidatePath("/users");
  return {};
}
