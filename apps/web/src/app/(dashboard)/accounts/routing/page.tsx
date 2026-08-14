/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma, resolveWhatsAppAccount, isResolutionError } from "@support-automation/db";
import type { WhatsAppServiceKey } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { Alert, Card, HelpButton, HelpSection, PageHeader, SectionHeader } from "@/components/ui";
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
        actions={
          <HelpButton moduleTitle="WhatsApp Account Routing">
            <HelpSection title="What this page is for">
              <p>
                Only matters once you have more than one connected WhatsApp account. Each row is a
                service that sends WhatsApp messages on its own (currently Support Notifications and
                Priority Support Escalation) — you can leave it on the default Primary account, or pin
                it to a specific account so that service always sends from the same number regardless
                of which account is Primary.
              </p>
            </HelpSection>
            <HelpSection title="Account dropdown">
              <p>
                "Primary (default)" means this service always follows whichever account is currently
                marked Primary on the Accounts page — if you change Primary later, this service follows
                automatically with no extra step. Picking a specific account locks that service to it
                permanently, even if Primary changes.
              </p>
            </HelpSection>
            <HelpSection title="“If unavailable” fallback policy">
              <p>
                Only relevant when you've pinned a specific account. <strong>Fall back to Primary</strong>
                {" "}means if the pinned account ever disconnects, this service temporarily uses Primary
                instead so nothing silently stops working. <strong>Show error, don't send</strong> means
                it refuses to send through any other account and instead logs a clear error — choose this
                if it would be worse to send from the wrong number than to not send at all.
              </p>
            </HelpSection>
            <HelpSection title="“Currently sends via” line">
              <p>
                This shows the real, live result of that logic right now — which account would actually
                be used if this service tried to send a message this second, and why (CONFIGURED = your
                pin, PRIMARY_DEFAULT = following Primary because nothing's pinned, PRIMARY_FALLBACK =
                your pinned account is down and it fell back). If it shows an error instead, that service
                cannot send anything until you fix the underlying account or routing.
              </p>
            </HelpSection>
          </HelpButton>
        }
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
