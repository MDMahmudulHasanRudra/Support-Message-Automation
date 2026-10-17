import { dhakaToday } from "@support-automation/shared";
import { prisma } from "@/server/db";
import type { Session } from "@/server/auth";
import { clientViewerCaps } from "@/server/clientModule";
import { listLinkableAccounts } from "@/server/clientChatLinks";
import type { ClientFormContext } from "@/app/p/[project]/(dashboard)/clients/ClientForm";

/**
 * What the Add/Edit Client form needs beyond the roster (CLIENTS_V3.md §6): the project's required
 * fields and default country, its currencies and services as suggestions, and the accounts to pick a
 * WhatsApp group from — the accounts only for someone allowed to link one. Never a QR or a token.
 */
export async function loadClientFormContext(session: Session): Promise<ClientFormContext> {
  const caps = await clientViewerCaps(session);
  const [currencies, services, accounts] = await Promise.all([
    prisma.clientBillingCurrency.findMany({ where: { enabled: true }, select: { code: true }, orderBy: { code: "asc" } }),
    caps.subscriptions ? prisma.clientSubscription.findMany({ distinct: ["service"], select: { service: true }, orderBy: { service: "asc" }, take: 200 }) : Promise.resolve([]),
    caps.canLinkGroups ? listLinkableAccounts() : Promise.resolve([]),
  ]);
  return {
    requiredFields: caps.settings.requiredFields,
    defaultCountry: caps.settings.defaultCountry,
    currencies: currencies.map((c) => c.code),
    services: services.map((s) => s.service),
    accounts: accounts.map((a) => ({ id: a.id, label: a.label, phoneNumber: a.phoneNumber, status: a.status })),
    canLinkGroups: caps.canLinkGroups,
    canSellSubscriptions: caps.canManageSubscriptions,
    today: dhakaToday(new Date()),
  };
}
