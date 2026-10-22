import NextLink from "next/link";
import { Plus } from "lucide-react";
import { SAAS_SUBSCRIPTION_STATE_LABELS } from "@support-automation/shared";
import { Alert, Badge, ButtonLink, PageHeader, SectionHeader, StatTile, Table, Td, Th } from "@/components/ui";
import { requireOperatorPage } from "@/server/platform/auth";
import { customersHealth, platformHealth } from "@/server/platform/monitoring";
import { listSupportSessions } from "@/server/platform/support";
import { formatBytes } from "./customers/[id]/CustomerHealthPanel";

export const metadata = { title: "Overview" };

const stateColor = (s: string) => (s === "ACTIVE" ? "green" : s === "TRIALING" ? "blue" : s === "PAST_DUE" ? "yellow" : s === "SUSPENDED" ? "red" : "gray");

/**
 * The SaaS control centre (SAAS_PLATFORM_PLAN.md §12). Top: the shared platform — one worker and one
 * database serve every customer, so a problem there is everyone's. Below: each customer on its own.
 */
export default async function PlatformOverview() {
  await requireOperatorPage();
  const [platform, customers, activeSupport] = await Promise.all([platformHealth(), customersHealth(), listSupportSessions({ activeOnly: true, take: 20 })]);
  const attention = customers.filter((c) => c.attention.length > 0);
  const subscribed = customers.filter((c) => c.subscription);
  return (
    <div>
      <PageHeader
        title="Overview"
        description="Every customer at a glance. The platform section is shared by all customers; each customer's own health is below."
        actions={
          <ButtonLink href="/platform/customers/new" variant="primary">
            <Plus className="size-4" aria-hidden />
            Add customer
          </ButtonLink>
        }
      />

      <SectionHeader title="Platform — shared by every customer" />
      {platform.workerStale ? (
        <div className="mb-3"><Alert tone="danger" title="The worker is not reporting">
          Last heartbeat {platform.workerHeartbeatAt ? new Date(platform.workerHeartbeatAt).toLocaleString() : "never"}. No customer is sending or collecting until it runs.
        </Alert></div>
      ) : null}
      {platform.stalledLoops.length > 0 ? (
        <div className="mb-3"><Alert tone="warning" title="Stalled background loops">
          {platform.stalledLoops.map((l) => `${l.name} (last ${l.lastTickAt ? new Date(l.lastTickAt).toLocaleString() : "never"})`).join(", ")}
        </Alert></div>
      ) : null}
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Worker" value={platform.workerStale ? "Not reporting" : "Running"} tone={platform.workerStale ? "danger" : "success"} hint={platform.workerStartedAt ? `since ${new Date(platform.workerStartedAt).toLocaleString()}` : undefined} />
        <StatTile
          label="WhatsApp connected"
          value={`${platform.whatsapp.connected} / ${platform.whatsapp.total}`}
          tone={platform.whatsapp.needsPhone + platform.whatsapp.down > 0 ? "warning" : "success"}
          hint={platform.whatsapp.needsPhone > 0 ? `${platform.whatsapp.needsPhone} need the phone` : undefined}
        />
        <StatTile label="Send queue" value={platform.outboundPending.toLocaleString()} hint={`${platform.failedSends24h} failed in 24h`} tone={platform.failedSends24h > 0 ? "warning" : "neutral"} />
        <StatTile
          label="Failed alerts / commands (24h)"
          value={`${platform.failedNotifications24h} / ${platform.failedCommands24h}`}
          tone={platform.failedNotifications24h + platform.failedCommands24h > 0 ? "warning" : "neutral"}
          hint={`${platform.openCollectionGaps} open collection gap(s)`}
        />
      </div>

      <SectionHeader title="Customers" description={`${customers.length} customer(s), ${subscribed.length} with a subscription, ${attention.length} needing attention.`} />
      {activeSupport.length > 0 ? (
        <div className="mb-3"><Alert tone="info" title="Support sessions open now">
          {activeSupport.map((s) => `${s.operatorUsername} in ${s.customerName} (until ${new Date(s.expiresAt).toLocaleTimeString()})`).join(" · ")}{" "}
          <NextLink href="/platform/support" className="font-medium underline">
            Manage
          </NextLink>
        </Alert></div>
      ) : null}
      <Table>
        <thead>
          <tr>
            <Th>Customer</Th>
            <Th>Subscription</Th>
            <Th>WhatsApp</Th>
            <Th>Messages 24h</Th>
            <Th>Usage</Th>
            <Th>Needs attention</Th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.customerId}>
              <Td>
                {c.customerId === "__original__" ? (
                  <span className="font-medium">{c.name}</span>
                ) : (
                  <NextLink href={`/platform/customers/${c.customerId}`} className="font-medium hover:underline">
                    {c.name}
                  </NextLink>
                )}
                {c.isFounding ? <span className="ml-2 text-xs text-[color:var(--color-muted-foreground)]">original</span> : null}
              </Td>
              <Td>
                {c.subscription ? (
                  <span className="flex flex-col gap-1">
                    <span>{c.subscription.planName}</span>
                    <span className="flex items-center gap-2">
                      <Badge color={stateColor(c.subscription.state)} dot>
                        {SAAS_SUBSCRIPTION_STATE_LABELS[c.subscription.state]}
                      </Badge>
                      {c.subscription.accessUntil ? <span className="text-xs text-[color:var(--color-muted-foreground)]">until {c.subscription.accessUntil.slice(0, 10)}</span> : null}
                    </span>
                  </span>
                ) : (
                  <span className="text-[color:var(--color-muted-foreground)]">None</span>
                )}
              </Td>
              <Td>
                {c.whatsapp.connected} / {c.whatsapp.total}
              </Td>
              <Td>{c.messages24h.toLocaleString()}</Td>
              <Td className="text-xs">
                {c.people} people · {c.workspaces} ws · {formatBytes(c.mediaBytes)}
              </Td>
              <Td className="text-xs">{c.attention.length === 0 ? <span className="text-[color:var(--color-muted-foreground)]">—</span> : c.attention.join(" ")}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
