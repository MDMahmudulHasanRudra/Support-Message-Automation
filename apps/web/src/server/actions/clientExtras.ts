"use server";

import { revalidatePath } from "next/cache";
import {
  CLIENT_SUB_MODULES,
  clampRenewalWindow,
  isListKey,
  normalizeCountryCode,
  normalizeRequiredFields,
  sanitizeColumns,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { recordClientActivity } from "@/server/clientRecords";
import { clientViewerCaps, columnNeeds } from "@/server/clientModule";
import { saveClientPhoto } from "@/server/clientPhotoStore";

/**
 * The smaller Client Management actions (CLIENTS_V3.md): profile photos, the project's module settings
 * and each person's list columns. Each checks its own key.
 */

export interface SimpleResult {
  ok: boolean;
  message: string;
}

// ── Photos ──────────────────────────────────────────────────────────────────────────────────────

/** Replaces a client's photo with the uploaded picture (already shrunk by the browser; checked again here). */
export async function uploadClientPhoto(clientId: string, formData: FormData): Promise<SimpleResult> {
  const granted = await checkPermission("clients.update");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const client = await prisma.client.findFirst({ where: { id: clientId }, select: { status: true } });
  if (!client) return { ok: false, message: "That client no longer exists." };
  if (client.status === "ARCHIVED") return { ok: false, message: "This client is archived. Restore it first." };
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose a picture." };
  const saved = await prisma.$transaction((tx) => saveClientPhoto(tx, clientId, file, granted.session.userId));
  if (!saved.ok) return saved;
  revalidatePath(await projectPath(`/clients/${clientId}`));
  revalidatePath(await projectPath("/clients"));
  return { ok: true, message: "Photo saved." };
}

export async function removeClientPhoto(clientId: string): Promise<SimpleResult> {
  const granted = await checkPermission("clients.update");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const done = await prisma.$transaction(async (tx) => {
    const removed = await tx.clientPhoto.deleteMany({ where: { clientId } });
    if (removed.count === 0) return false;
    await tx.client.update({ where: { id: clientId }, data: { photoUpdatedAt: new Date() } });
    await recordClientActivity(tx, clientId, granted.session.userId, { type: "PHOTO_REMOVED", summary: "Profile photo removed" });
    return true;
  });
  if (!done) return { ok: false, message: "There is no photo to remove." };
  revalidatePath(await projectPath(`/clients/${clientId}`));
  revalidatePath(await projectPath("/clients"));
  return { ok: true, message: "Photo removed." };
}

// ── Module settings ─────────────────────────────────────────────────────────────────────────────

export interface ModuleSettingsInput {
  subscriptions: boolean;
  billing: boolean;
  payments: boolean;
  whatsappGroups: boolean;
  requiredFields: string[];
  renewalWindowDays: number;
  defaultCountry: string;
}

export async function saveClientModuleSettings(input: ModuleSettingsInput): Promise<SimpleResult> {
  const granted = await checkPermission("clients.manage_settings");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const flag = (key: (typeof CLIENT_SUB_MODULES)[number]) => input?.[key] === true;
  const country = String(input?.defaultCountry ?? "").trim();
  const defaultCountry = country ? normalizeCountryCode(country) : null;
  if (country && !defaultCountry) return { ok: false, message: "Choose a country from the list, or none." };
  const data = {
    subscriptionsEnabled: flag("subscriptions"),
    billingEnabled: flag("billing"),
    // Payments without Billing is meaningless; stored as chosen, read as off (resolveClientModuleSettings).
    paymentsEnabled: flag("payments"),
    whatsappGroupLinksEnabled: flag("whatsappGroups"),
    requiredFields: normalizeRequiredFields(Array.isArray(input?.requiredFields) ? input.requiredFields : []),
    renewalWindowDays: clampRenewalWindow(input?.renewalWindowDays),
    defaultCountry,
    updatedById: granted.session.userId,
  };
  const projectId = await activeProjectId();
  await prisma.clientModuleSettings.upsert({ where: { projectId }, create: data, update: data });
  await logSystemEvent("INFO", "clients", "Client module settings changed", { ...data, updatedById: undefined }, { actorUserId: granted.session.userId });
  for (const path of ["/settings/clients", "/clients", "/clients/dues", "/clients/subscriptions", "/clients/payments"]) revalidatePath(await projectPath(path));
  return { ok: true, message: "Settings saved. They apply to everyone in this project at once." };
}

// ── List columns ────────────────────────────────────────────────────────────────────────────────

/**
 * Saves which columns THIS person shows on a list, in order. Only columns they may see are kept: the
 * preference can never widen what the server reads for them.
 */
export async function saveListColumns(list: string, columns: string[]): Promise<SimpleResult & { columns?: string[] }> {
  if (!isListKey(list)) return { ok: false, message: "Unknown list." };
  const granted = await checkPermission(list === "billing" ? "clients.view_billing" : "clients.view");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const caps = await clientViewerCaps(granted.session);
  const clean = sanitizeColumns(list, Array.isArray(columns) ? columns.slice(0, 60) : [], columnNeeds(caps));
  const projectId = await activeProjectId();
  await prisma.listViewPreference.upsert({
    where: { projectId_userId_listKey: { projectId, userId: granted.session.userId, listKey: list } },
    create: { userId: granted.session.userId, listKey: list, columns: clean },
    update: { columns: clean },
  });
  return { ok: true, message: "Columns saved for you.", columns: clean };
}

export async function resetListColumns(list: string): Promise<SimpleResult> {
  if (!isListKey(list)) return { ok: false, message: "Unknown list." };
  const granted = await checkPermission(list === "billing" ? "clients.view_billing" : "clients.view");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  await prisma.listViewPreference.deleteMany({ where: { userId: granted.session.userId, listKey: list } });
  return { ok: true, message: "Back to the default columns." };
}

// ── Picking a client for a new bill ─────────────────────────────────────────────────────────────

export interface ClientBrief {
  id: string;
  code: string;
  name: string;
  companyName: string | null;
  preferredCurrency: string | null;
}

/** Up to 15 current clients by name, code, company or number, for the Billing List's "Create bill". Refuses as an empty list. */
export async function searchClientsBrief(query: string): Promise<ClientBrief[]> {
  const granted = await checkPermission("clients.edit_billing");
  if ("denied" in granted) return [];
  const q = String(query ?? "").trim().slice(0, 80);
  const digits = q.replace(/\D/g, "");
  return prisma.client.findMany({
    where: {
      status: { not: "ARCHIVED" },
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { code: { contains: q, mode: "insensitive" } },
              { companyName: { contains: q, mode: "insensitive" } },
              ...(digits.length >= 5 ? [{ channels: { some: { normalizedValue: { contains: digits } } } }] : []),
            ],
          }
        : {}),
    },
    select: { id: true, code: true, name: true, companyName: true, preferredCurrency: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 15,
  });
}
