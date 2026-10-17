import {
  resolveClientModuleSettings,
  sanitizeColumns,
  subModuleRefusal,
  type ClientModuleSettingsValue,
  type ClientSubModule,
  type ColumnNeed,
  type ListKey,
} from "@support-automation/shared";
import { dhakaToday } from "@support-automation/shared";
import { prisma } from "@/server/db";
import type { ClientFilterContext } from "@/lib/clientFilters";
import { hasPermission } from "@/server/permissions";
import type { Session } from "@/server/auth";

/**
 * The Client module's per-project settings and what the current viewer may see (CLIENTS_V3.md §7).
 * Not a "use server" file: nothing here is an endpoint. Reads go through the project-scoped client.
 */

/** This project's choices; no row = everything on, nothing required. Never throws on a missing row. */
export async function getClientModuleSettings(): Promise<ClientModuleSettingsValue> {
  const row = await prisma.clientModuleSettings.findFirst();
  return resolveClientModuleSettings(row);
}

/** For an action: the sentence to return when the sub-module is switched off in this project, else null. */
export async function subModuleOff(module: ClientSubModule): Promise<string | null> {
  return subModuleRefusal(await getClientModuleSettings(), module);
}

export interface ClientViewerCaps {
  settings: ClientModuleSettingsValue;
  /** May see amounts: holds clients.view_billing AND billing is on. */
  billing: boolean;
  subscriptions: boolean;
  groups: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canEditBilling: boolean;
  canRecordPayments: boolean;
  canManageSubscriptions: boolean;
  canLinkGroups: boolean;
  canManageSettings: boolean;
  canOpenChat: boolean;
}

/** One read of the settings plus every permission the Client pages branch on. */
export async function clientViewerCaps(session: Session): Promise<ClientViewerCaps> {
  const [settings, viewBilling, editBilling, create, update, subs, linkGroups, manageSettings, viewMessages] = await Promise.all([
    getClientModuleSettings(),
    hasPermission(session, "clients.view_billing"),
    hasPermission(session, "clients.edit_billing"),
    hasPermission(session, "clients.create"),
    hasPermission(session, "clients.update"),
    hasPermission(session, "clients.manage_subscriptions"),
    hasPermission(session, "clients.link_whatsapp_group"),
    hasPermission(session, "clients.manage_settings"),
    hasPermission(session, "messages.view"),
  ]);
  return {
    settings,
    billing: viewBilling && settings.billing,
    subscriptions: settings.subscriptions,
    groups: settings.whatsappGroups,
    canCreate: create,
    canUpdate: update,
    canEditBilling: editBilling && settings.billing,
    canRecordPayments: editBilling && settings.payments,
    canManageSubscriptions: subs && settings.subscriptions,
    canLinkGroups: linkGroups && settings.whatsappGroups,
    canManageSettings: manageSettings,
    // The "Open chat" link only; the chat page makes its own checks (messages.view + its feature).
    canOpenChat: viewMessages,
  };
}

export function columnNeeds(caps: Pick<ClientViewerCaps, "billing" | "subscriptions" | "groups">): Partial<Record<ColumnNeed, boolean>> {
  return { billing: caps.billing, subscriptions: caps.subscriptions, groups: caps.groups };
}

/** This person's saved columns for a list, made safe against what they may see now. */
export async function getColumnPreference(userId: string, list: ListKey, caps: Pick<ClientViewerCaps, "billing" | "subscriptions" | "groups">): Promise<{ columns: string[]; customised: boolean }> {
  const row = await prisma.listViewPreference.findFirst({ where: { userId, listKey: list }, select: { columns: true } });
  return { columns: sanitizeColumns(list, row?.columns ?? null, columnNeeds(caps)), customised: Boolean(row) };
}

/** What the list filters are evaluated against for this viewer: today in Dhaka, the project's renewal window, billing visibility. */
export async function clientFilterContext(session: Session): Promise<ClientFilterContext> {
  const caps = await clientViewerCaps(session);
  return { today: dhakaToday(new Date()), renewalWindowDays: caps.settings.renewalWindowDays, billing: caps.billing };
}
