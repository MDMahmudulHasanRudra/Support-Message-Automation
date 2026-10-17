import { notFound } from "next/navigation";
import Link from "@/components/ProjectLink";
import { pageAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { prisma } from "@/server/db";
import { getClientDetail, loadClientFormOptions } from "@/server/clients";
import { describeDueEvent, getClientBilling } from "@/server/clientBilling";
import { getClientChatLinks, listLinkableAccounts } from "@/server/clientChatLinks";
import { formatDateTime } from "@/lib/date";
import { Alert, Badge, Card, PageHeader, SectionHeader, ViewOnlyNotice } from "@/components/ui";
import { clientDisplayName, CLIENT_SOURCE_LABELS, CLIENT_STATUS_LABELS, describeSharedKey, SUBSCRIPTION_STATE_LABELS, type ClientSourceValue } from "@support-automation/shared";
import { clientViewerCaps } from "@/server/clientModule";
import { getClient360 } from "@/server/client360";
import { loadClientFormContext } from "@/server/clientFormContext";
import { countryName } from "@/lib/clientPhone";
import { expiryTextClass, formatDay, money, SUBSCRIPTION_TONE } from "@/lib/clientDisplay";
import { ClientPaymentsPanel, GroupLinksPanel, PhotoControl, SubscriptionsPanel } from "../Client360Panels";
import { ClientForm } from "../ClientForm";
import { ChannelsPanel, ClientLifecycle, NotesPanel } from "../ClientPanels";
import { BillingPanel } from "../ClientBilling";
import { ChatLinksPanel } from "../ClientChatLinks";

const STATUS_COLOR: Record<string, "green" | "gray" | "yellow" | "red"> = { ACTIVE: "green", INACTIVE: "gray", PENDING: "yellow", ARCHIVED: "gray", BLOCKED: "red" };

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, canManage } = await pageAccess("clients.view", "clients.update");
  const { id } = await params;
  const detail = await getClientDetail(id);
  if (!detail) notFound();
  const { client, notes, activities, groupNames, duplicates } = detail;
  const archived = client.status === "ARCHIVED";

  const caps = await clientViewerCaps(session);
  const [view, formContext] = await Promise.all([getClient360(client.id, caps), loadClientFormContext(session)]);
  const [options, canArchive, canDelete, canViewBilling, canEditBilling, canLinkChats, chatLinks, linkAccounts, groups] = await Promise.all([
    loadClientFormOptions(),
    hasPermission(session, "clients.archive"),
    hasPermission(session, "clients.delete"),
    hasPermission(session, "clients.view_billing"),
    hasPermission(session, "clients.edit_billing"),
    hasPermission(session, "clients.link_whatsapp_chat"),
    getClientChatLinks(id),
    listLinkableAccounts(),
    canManage && !archived
      ? prisma.whatsAppGroup.findMany({ where: { isActive: true }, select: { whatsappGroupId: true, name: true }, distinct: ["whatsappGroupId"], orderBy: { name: "asc" }, take: 2000 })
      : Promise.resolve([]),
  ]);

  // Amounts and dates are read only for someone holding the billing key; the rest of the page never sees them.
  const billing = canViewBilling && caps.settings.billing ? await getClientBilling(client.id) : null;
  const phone = client.channels.find((c) => c.kind === "WHATSAPP") ?? client.channels.find((c) => c.kind === "PHONE");
  const activeGroups = view.groupLinks.filter((l) => !l.unlinkedAt);
  const seller = view.current?.soldBy ?? client.soldByMember?.name ?? null;
  const facts: Array<[string, string, string | null]> = [
    ["Country", client.country ? (countryName(client.country) ?? client.country) : "Not set", client.preferredCurrency ? `Prefers ${client.preferredCurrency}` : null],
    ["Phone & WhatsApp", phone?.value ?? "No number", chatLinks.length ? "WhatsApp chat linked" : null],
  ];
  if (caps.subscriptions) facts.push(["Current plan", view.current?.service ?? "None", view.current ? `${formatDay(view.current.endDate)} · ${view.current.expiryText}` : null]);
  if (view.outstanding) facts.push(["Outstanding", view.outstanding.length ? view.outstanding.map((o) => money(o.remaining, o.currency)).join(" · ") : "Nothing owed", view.outstanding.some((o) => o.overdue) ? "Has overdue invoices" : null]);
  facts.push(["Sold by", seller ?? "Not recorded", view.current?.soldByTeam ?? client.soldByMember?.team?.name ?? null]);
  if (caps.groups) facts.push(["WhatsApp group", activeGroups[0]?.groupName ?? "Not linked", activeGroups.length > 1 ? `+${activeGroups.length - 1} more` : (activeGroups[0]?.accountLabel ?? null)]);
  const dueDateById = new Map(billing?.dues.map((x) => [x.id, x.dueDate]));
  const summaryText = billing
    ? billing.summary.openCount === 0
      ? "No open dues."
      : `${billing.summary.openCount} open · ${billing.summary.overdueCount} overdue${billing.summary.nextDueDate ? ` · next due ${billing.summary.nextDueDate}` : ""}`
    : "";

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-4">
            <PhotoControl client={{ id: client.id, code: client.code, name: client.name, companyName: client.companyName, photoVersion: client.photoUpdatedAt?.getTime() ?? null }} canEdit={canManage && !archived} />
            {clientDisplayName(client.name, client.companyName)}
            <Badge color={STATUS_COLOR[client.status] ?? "gray"} dot>
              {CLIENT_STATUS_LABELS[client.status]}
            </Badge>
          </span>
        }
        description={`${client.code}${client.companyName ? ` · ${client.companyName}` : ""} · ${CLIENT_SOURCE_LABELS[client.source as ClientSourceValue] ?? client.source}${client.sourceDetail ? ` (${client.sourceDetail})` : ""}`}
        actions={<ClientLifecycle clientId={client.id} archived={archived} canArchive={canArchive} canDelete={canDelete} />}
      />
      {canManage ? null : <ViewOnlyNotice />}

      {/* The 360° strip: the facts somebody opens a client for, before any card. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {facts.map(([label, value, sub]) => (
          <div key={label} className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-xs)]">
            <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]">{label}</p>
            <p className={`mt-1 truncate text-sm font-semibold ${label === "Current plan" && view.current ? expiryTextClass(view.current.state) : ""}`} title={value}>
              {value}
            </p>
            {sub ? <p className="truncate text-xs text-[color:var(--color-muted-foreground)]">{sub}</p> : null}
          </div>
        ))}
      </div>
      {archived ? <Alert tone="info">This client is archived. Restore it to edit it. Its channels, notes and history are all kept.</Alert> : null}

      {duplicates.length > 0 ? (
        <Alert tone="warning" title="Possible duplicate">
          <ul className="space-y-1">
            {duplicates.map((d) => (
              <li key={d.clientId}>
                <Link className="link font-medium" href={`/clients/${d.clientId}`}>
                  {d.name} ({d.code})
                </Link>{" "}
                shares {d.sharedKeys.map(describeSharedKey).join(", ")}. Nothing is merged automatically.
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">

          {caps.subscriptions ? (
            <div id="subscriptions" className="scroll-mt-24">
            <Card className="p-6">
              <SectionHeader title="Subscriptions" />
              {view.current ? (
                <div className="-mt-2 mb-3">
                  <Badge color={SUBSCRIPTION_TONE[view.overallState]}>{SUBSCRIPTION_STATE_LABELS[view.overallState]}</Badge>
                </div>
              ) : null}
              <SubscriptionsPanel
                clientId={client.id}
                subscriptions={view.subscriptions}
                roster={options.roster}
                today={view.today}
                currencies={formContext.currencies}
                preferredCurrency={client.preferredCurrency}
                defaultSeller={client.soldByMemberId}
                canManage={caps.canManageSubscriptions}
                canInvoice={caps.canEditBilling}
                archived={archived}
              />
            </Card>
            </div>
          ) : null}

          {caps.groups ? (
            <div id="whatsapp-groups" className="scroll-mt-24">
            <Card className="p-6">
              <SectionHeader title="WhatsApp groups" />
              <GroupLinksPanel clientId={client.id} links={view.groupLinks} accounts={formContext.accounts} canLink={caps.canLinkGroups} canOpenChat={caps.canOpenChat} archived={archived} />
            </Card>
            </div>
          ) : null}

          <Card className="p-6">
            <SectionHeader title="Communication channels" />
            <ChannelsPanel
              clientId={client.id}
              canEdit={canManage}
              archived={archived}
              groups={groups}
              channels={client.channels.map((c) => ({
                id: c.id,
                kind: c.kind,
                value: c.value,
                label: c.label,
                isPrimary: c.isPrimary,
                consentStatus: c.consentStatus,
                consentChangedAt: c.consentChangedAt?.toISOString() ?? null,
                consentNote: c.consentNote,
                groupName: c.kind === "WHATSAPP_GROUP" ? groupNames.get(c.normalizedValue) ?? null : null,
              }))}
            />
            <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
              Last contact: {client.lastContactAt ? formatDateTime(client.lastContactAt) : "none recorded"}. Consent is recorded per channel for later; nothing is sent from here today.
            </p>
          </Card>

          <Card className="p-6">
            <SectionHeader title="Linked WhatsApp chats" />
            <ChatLinksPanel
              clientId={client.id}
              clientName={client.name}
              canLink={canLinkChats}
              archived={archived}
              accounts={linkAccounts.map((a) => ({ id: a.id, label: a.label }))}
              links={chatLinks.map((l) => ({ id: l.id, accountLabel: l.accountLabel, chatLabel: l.chatLabel, chatId: l.chatId, linkedBy: l.linkedBy, linkedAt: formatDateTime(l.linkedAt) }))}
            />
          </Card>

          <Card className="p-6">
            <SectionHeader title="Invoices and dues" />
            {billing ? (
              <BillingPanel
                clientId={client.id}
                canEdit={canEditBilling}
                archived={archived}
                summaryText={summaryText}
                currencies={billing.currencies.filter((c) => c.enabled).map((c) => c.code)}
                dues={billing.dues}
                invoice={{ sellers: options.roster.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name, teamName: m.teamName })), today: view.today }}
                history={billing.history.map((h) => ({ id: h.id, dueId: h.dueId, type: h.type, summary: describeDueEvent(h.type, h.changes, dueDateById.get(h.dueId) ?? null), actor: h.actor, at: formatDateTime(h.at) }))}
              />
            ) : (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">{caps.settings.billing ? "Billing is visible only to people with the billing permission." : "Billing is switched off for this project."}</p>
            )}
          </Card>

          {billing && caps.settings.payments ? (
            <Card className="p-6">
              <SectionHeader title="Payments & receipts" />
              <ClientPaymentsPanel client={{ name: clientDisplayName(client.name, client.companyName), code: client.code }} openInvoices={view.openInvoices} payments={view.payments} canRecord={caps.canRecordPayments && !archived} today={view.today} />
            </Card>
          ) : null}

          <Card className="p-6">
            <SectionHeader title="Client details" />
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                {[
                  ["Category", client.category],
                  ["Tags", client.tags.join(", ")],
                  ["Assigned staff", client.assignedMember?.name],
                  ["Assigned team", client.assignedTeam?.name],
                  ["Preferred language", client.preferredLanguage],
                  ["Address", client.address],
                  ["Business details", client.businessDetails],
                  ["Follow-up instructions", client.followUpInstructions],
                ].map(([label, value]) => (
                  <div key={label as string}>
                    <dt className="text-xs text-[color:var(--color-muted-foreground)]">{label}</dt>
                    <dd className="whitespace-pre-wrap">{value || "—"}</dd>
                  </div>
                ))}
              </dl>
            {canManage && !archived ? (
              <details className="mt-5 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4 open:pb-0">
                <summary className="cursor-pointer text-sm font-medium">Edit client details</summary>
                <div className="mt-4">
              <ClientForm
                mode="edit"
                clientId={client.id}
                options={options}
                context={formContext}
                values={{
                  name: client.name,
                  code: client.code,
                  companyName: client.companyName ?? "",
                  status: client.status,
                  category: client.category ?? "",
                  tags: client.tags.join(", "),
                  preferredChannel: client.preferredChannel ?? "",
                  preferredLanguage: client.preferredLanguage ?? "",
                  address: client.address ?? "",
                  businessDetails: client.businessDetails ?? "",
                  followUpInstructions: client.followUpInstructions ?? "",
                  assignedMemberId: client.assignedMemberId ?? "",
                  assignedTeamId: client.assignedTeamId ?? "",
                  country: client.country ?? "",
                  preferredCurrency: client.preferredCurrency ?? "",
                  soldByMemberId: client.soldByMemberId ?? "",
                }}
              />
                </div>
              </details>
            ) : null}
          </Card>

          <Card className="p-6">
            <SectionHeader title="Internal notes" />
            <NotesPanel
              clientId={client.id}
              canEdit={canManage && !archived}
              notes={notes.map((n) => ({ id: n.id, body: n.body, author: n.author?.name ?? null, at: formatDateTime(n.createdAt) }))}
            />
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-6">
            <SectionHeader title="Activity timeline" />
            {activities.length === 0 ? <p className="text-sm text-[color:var(--color-muted-foreground)]">Nothing recorded yet.</p> : null}
            <ol className="space-y-3 border-l border-[var(--color-border)] pl-4">
              {activities.map((a) => (
                <li key={a.id} className="relative">
                  <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-[var(--color-border-strong)]" aria-hidden />
                  <p className="text-sm">{a.summary}</p>
                  <p className="text-xs text-[color:var(--color-muted-foreground)]">
                    {a.actor?.name ?? "System"} · {formatDateTime(a.createdAt)}
                  </p>
                </li>
              ))}
            </ol>
            {activities.length >= 100 ? <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">Showing the latest 100 entries.</p> : null}
          </Card>
          <Card className="p-6 text-xs text-[color:var(--color-muted-foreground)]">
            Created {formatDateTime(client.createdAt)}
            {client.createdBy ? ` by ${client.createdBy.name}` : ""} · updated {formatDateTime(client.updatedAt)}
          </Card>
        </div>
      </div>
    </div>
  );
}
