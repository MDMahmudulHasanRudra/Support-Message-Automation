import { prisma, resolveWhatsAppAccount, isResolutionError } from "@support-automation/db";
import type { WhatsAppServiceKey } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { Alert, Card, PageHeader, SectionHeader } from "@/components/ui";
import { ServiceRouteRow, type ServiceRouteAccountOption, type ServiceRouteRowData } from "./ServiceRouteRow";

// The only two real WhatsApp-sending call sites in the app today (see WhatsAppServiceKey in
// schema.prisma). Add a row here only once a feature actually resolves an account and sends —
// never speculatively, per the audit that scoped this feature.
const SERVICES: Array<{ key: WhatsAppServiceKey; label: string }> = [
  { key: "NOTIFY_WHATSAPP", label: "Support Notifications" },
  { key: "PRIORITY_SUPPORT", label: "Priority Support Escalation" },
];

export default async function WhatsAppRoutingPage() {
  await requireSession();

  const [accounts, routes, ...resolutions] = await Promise.all([
    prisma.whatsAppAccount.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.whatsAppServiceRoute.findMany(),
    ...SERVICES.map((service) => resolveWhatsAppAccount(service.key)),
  ]);

  const routeByService = new Map(routes.map((r) => [r.serviceKey, r]));
  const accountOptions: ServiceRouteAccountOption[] = accounts.map((a) => ({
    id: a.id,
    label: a.label,
    status: a.status,
  }));

  const rows: ServiceRouteRowData[] = SERVICES.map((service, index) => {
    const route = routeByService.get(service.key);
    const resolution = resolutions[index];
    return {
      serviceKey: service.key,
      serviceLabel: service.label,
      configuredAccountId: route?.accountId ?? null,
      fallbackPolicy: route?.fallbackPolicy ?? "PRIMARY_FALLBACK",
      resolvedLabel: isResolutionError(resolution) ? null : resolution.accountLabel,
      resolvedSource: isResolutionError(resolution) ? null : resolution.source,
      resolutionError: isResolutionError(resolution) ? resolution.error : null,
    };
  });

  return (
    <div>
      <PageHeader
        title="WhatsApp Account Routing"
        description="Choose which WhatsApp account each service uses. Anything left on Primary follows whichever account is marked Primary on the Accounts page."
      />

      {accounts.length === 0 ? (
        <Alert tone="info" title="No WhatsApp accounts yet">
          Add an account on the Accounts page first.
        </Alert>
      ) : (
        <Card>
          <SectionHeader
            title="Services"
            description="Changing an account here never affects the other service — each row is independent."
          />
          <div>
            {rows.map((row) => (
              <ServiceRouteRow key={row.serviceKey} route={row} accounts={accountOptions} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
