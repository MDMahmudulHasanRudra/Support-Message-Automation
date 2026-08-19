"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { logSystemEvent } from "@/server/logSystemEvent";

const PERMISSION_DENIED_ERROR = "You do not have permission to perform this action.";

export interface PermissionModuleFormState {
  error?: string;
}

function parsePermissionKeys(formData: FormData): string[] {
  return formData.getAll("permissionKeys").map((v) => String(v));
}

export async function createPermissionModule(
  _prevState: PermissionModuleFormState,
  formData: FormData,
): Promise<PermissionModuleFormState> {
  const session = await requireSession();
  if (!(await hasPermission(session, "permissions.create"))) return { error: PERMISSION_DENIED_ERROR };

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const keys = parsePermissionKeys(formData);

  if (!name) return { error: "Name is required." };

  const existing = await prisma.permissionModule.findUnique({ where: { name } });
  if (existing) return { error: `A Permission Module named "${name}" already exists.` };

  const permissions = keys.length
    ? await prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true } })
    : [];

  const created = await prisma.permissionModule.create({
    data: {
      name,
      description,
      permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
    },
  });

  await logSystemEvent("INFO", "permissions", "PERMISSION_MODULE_CREATED", {
    actorId: session.userId,
    permissionModuleId: created.id,
    name,
  });
  revalidatePath("/permissions");
  redirect("/permissions");
}

export async function updatePermissionModule(
  id: string,
  _prevState: PermissionModuleFormState,
  formData: FormData,
): Promise<PermissionModuleFormState> {
  const session = await requireSession();
  if (!(await hasPermission(session, "permissions.edit"))) return { error: PERMISSION_DENIED_ERROR };

  const target = await prisma.permissionModule.findUnique({ where: { id } });
  if (!target) return { error: "Permission Module not found." };

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const keys = parsePermissionKeys(formData);

  if (!name) return { error: "Name is required." };
  // A system default's permission set may still change (e.g. broadening what Administrator
  // grants as new modules are added) — only its name/identity is protected, not its contents.
  if (target.isSystem && name !== target.name) {
    return { error: `"${target.name}" is a default Permission Module and cannot be renamed.` };
  }

  const permissions = keys.length
    ? await prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true } })
    : [];

  await prisma.$transaction([
    prisma.permissionModule.update({ where: { id }, data: { name, description } }),
    prisma.permissionModulePermission.deleteMany({ where: { permissionModuleId: id } }),
    prisma.permissionModulePermission.createMany({
      data: permissions.map((p) => ({ permissionModuleId: id, permissionId: p.id })),
    }),
  ]);

  await logSystemEvent("INFO", "permissions", "PERMISSION_MODULE_UPDATED", {
    actorId: session.userId,
    permissionModuleId: id,
  });
  revalidatePath("/permissions");
  redirect("/permissions");
}

export async function deletePermissionModule(id: string): Promise<{ error?: string }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "permissions.delete"))) return { error: PERMISSION_DENIED_ERROR };

  const target = await prisma.permissionModule.findUnique({
    where: { id },
    include: { _count: { select: { users: true } } },
  });
  if (!target) return { error: "Permission Module not found." };
  if (target.isSystem) return { error: `"${target.name}" is a default Permission Module and cannot be deleted.` };

  // Pre-check for a friendly error — the schema's onDelete: Restrict on User.permissionModuleId
  // is the real backstop that makes this safe even if this check is ever bypassed.
  if (target._count.users > 0) {
    return {
      error: `"${target.name}" is still assigned to ${target._count.users} user(s). Reassign them to a different Permission Module before deleting this one.`,
    };
  }

  await prisma.permissionModule.delete({ where: { id } });
  await logSystemEvent("INFO", "permissions", "PERMISSION_MODULE_DELETED", {
    actorId: session.userId,
    permissionModuleId: id,
    name: target.name,
  });
  revalidatePath("/permissions");
  return {};
}
