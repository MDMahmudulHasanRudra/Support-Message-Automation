import { notFound, redirect } from "next/navigation";
import {
  Activity,
  BadgeCheck,
  BookUser,
  CalendarClock,
  CalendarDays,
  CircleDollarSign,
  Clock,
  Crown,
  CreditCard,
  FileText,
  Globe,
  Hash,
  History,
  LayoutDashboard,
  Mail,
  MapPin,
  MessageCircle,
  MoreVertical,
  Pencil,
  Phone,
  ReceiptText,
  RefreshCw,
  Repeat,
  Shapes,
  Smartphone,
  StickyNote,
  Tag,
  User,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import Link from "@/components/ProjectLink";
import { pageAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { prisma } from "@/server/db";
import { getClientDetail, loadClientFormOptions } from "@/server/clients";
import { projectPath } from "@/server/projectPaths";
import { aliasesOf } from "@/server/clientCodes";
import { activeProjectId } from "@/server/projectContext";
import { describeDueEvent, getClientBilling } from "@/server/clientBilling";
import { getClientChatLinks, listLinkableAccounts } from "@/server/clientChatLinks";
import { formatDateTime } from "@/lib/date";
import { Alert, Badge, ButtonLink, Card, SectionHeader, ViewOnlyNotice } from "@/components/ui";
import {
  clientDisplayName,
  CLIENT_SOURCE_LABELS,
  CLIENT_STATUS_LABELS,
  describeSharedKey,
  dhakaToday,
  PAYMENT_METHOD_LABELS,
  SUBSCRIPTION_KIND_LABELS,
  SUBSCRIPTION_STATE_LABELS,
  type ClientSourceValue,
  type PaymentMethod,
  type SubscriptionKind,
} from "@support-automation/shared";
import { clientViewerCaps } from "@/server/clientModule";
import { getClient360 } from "@/server/client360";
import { loadClientFormContext } from "@/server/clientFormContext";
import { countryName } from "@/lib/clientPhone";
import { expiryTextClass, formatDay, groupChatHref, money, SUBSCRIPTION_TONE } from "@/lib/clientDisplay";
import { ClientPaymentsPanel, GroupLinksPanel, PhotoControl, SubscriptionsPanel } from "../Client360Panels";
import { ChannelsPanel, ClientLifecycle, NotesPanel } from "../ClientPanels";
import { BillingPanel } from "../ClientBilling";
import { ChatLinksPanel } from "../ClientChatLinks";
import { CopyCode } from "./CopyCode";
import { clientRenewalOffers } from "@/server/clientRenewals";
import { listClientMessages } from "@/server/clientMessages";
import { PrepareMessageButton } from "../messages/PrepareMessage";
import { MessageHistory } from "../messages/MessageHistory";
import { PrepareOfferButton } from "../subscriptions/renewals/RenewalParts";
import { RenewalOffersPanel } from "../subscriptions/renewals/RenewalOffersPanel";
import { ActivityItem, CardLink, currencyName, FactCard, flagOf, InfoRow, muted, panel, ProfileTabs, SectionCard, Timeline, type TabSpec } from "./ProfileParts";

const STATUS_COLOR: Record<string, "green" | "gray" | "yellow" | "red"> = { ACTIVE: "green", INACTIVE: "gray", PENDING: "yellow", ARCHIVED: "gray", BLOCKED: "red" };
const DAY_MS = 86_400_000;
const dayNumber = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS;

/** What the status box under the progress bar says, by the term's state. */
const TERM_MESSAGE: Record<string, { tone: "success" | "warning" | "danger" | "info" | "neutral"; title: string }> = {
  ACTIVE: { tone: "success", title: "Subscription is active" },
  TRIAL: { tone: "info", title: "Trial in progress" },
  EXPIRING: { tone: "warning", title: "Renewal due soon" },
  EXPIRED: { tone: "danger", title: "Subscription has expired" },
  SCHEDULED: { tone: "info", title: "Starts later" },
  PAUSED: { tone: "neutral", title: "Paused by staff" },
  CANCELLED: { tone: "neutral", title: "Cancelled" },
};
const TONE_BOX: Record<string, string> = {
  success: "border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)]",
  warning: "border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]",
  danger: "border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)]",
  info: "border-[var(--color-info-border)] bg-[var(--color-info-bg)] text-[color:var(--color-info-fg)]",
  neutral: "border-[var(--color-border)] bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)]",
};
const BAR: Record<string, string> = { success: "bg-[var(--color-success)]", warning: "bg-[var(--color-warning)]", danger: "bg-[var(--color-danger)]", info: "bg-[var(--color-info)]", neutral: "bg-[color:var(--color-muted-foreground)]" };

export default async function ClientDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { session, canManage } = await pageAccess("clients.view", "clients.update");
  const { id } = await params;
  const query = await searchParams;
  const detail = await getClientDetail(id);
  if (!detail) notFound();
  const { client, notes, activities, groupNames, duplicates } = detail;
  const archived = client.status === "ARCHIVED";
  // Edit has its own page now; an old "?edit=1#edit-client" link still lands on it.
  if (query.edit === "1" && canManage && !archived) redirect(await projectPath(`/clients/${client.id}/edit`));

  const caps = await clientViewerCaps(session);
  const [view, formContext] = await Promise.all([getClient360(client.id, caps), loadClientFormContext(session)]);
  const [options, formerCodes, canArchive, canDelete, canViewBilling, canEditBilling, canLinkChats, chatLinks, linkAccounts, groups] = await Promise.all([
    loadClientFormOptions(),
    aliasesOf(prisma, await activeProjectId(), [client.id]).then((m) => (m.get(client.id) ?? []).filter((c) => c !== client.code)),
    hasPermission(session, "clients.archive"),
    // Deleting: an Administrator, or a role an Administrator gave the delete permission (deleteClients re-checks).
    Promise.resolve(caps.canDelete),
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
  const showPayments = Boolean(billing && caps.settings.payments);
  // CLIENT_CRM_V7.md: renewal offers (Subscriptions tab) and messages to the client (Activity tab), read only for those tabs.
  const requestedTab = typeof query.tab === "string" ? query.tab : "overview";
  const [offers, messages] = await Promise.all([
    caps.subscriptions && requestedTab === "subscriptions" ? clientRenewalOffers(client.id, caps.billing) : Promise.resolve(null),
    requestedTab === "activity" ? listClientMessages({ clientId: client.id }) : Promise.resolve(null),
  ]);

  // ── Tabs: URL state. A tab the viewer cannot see falls back to Overview.
  const tabs: TabSpec[] = [{ id: "overview", label: "Overview", icon: LayoutDashboard }];
  if (caps.subscriptions) tabs.push({ id: "subscriptions", label: "Subscriptions", icon: CalendarDays, count: view.subscriptions.length });
  if (billing) tabs.push({ id: "billing", label: "Billing", icon: ReceiptText, count: view.invoiceCount });
  if (showPayments) tabs.push({ id: "payments", label: "Payments", icon: CreditCard, count: view.payments.length });
  tabs.push({ id: "whatsapp", label: "WhatsApp & channels", icon: MessageCircle });
  tabs.push({ id: "activity", label: "Activity & notes", icon: Activity });
  const requested = typeof query.tab === "string" ? query.tab : "overview";
  const tab = tabs.some((t) => t.id === requested) ? requested : "overview";
  const base = `/clients/${client.id}`;
  const tabHref = (t: string) => (t === "overview" ? base : `${base}?tab=${t}`);

  // ── The facts somebody opens a client for.
  const whatsapp = client.channels.find((c) => c.kind === "WHATSAPP");
  const phone = whatsapp ?? client.channels.find((c) => c.kind === "PHONE");
  const email = client.channels.find((c) => c.kind === "EMAIL");
  const activeGroups = view.groupLinks.filter((l) => !l.unlinkedAt);
  const current = view.current;
  const seller = current?.soldBy ?? client.soldByMember?.name ?? null;
  const sellerTeam = current?.soldByTeam ?? client.soldByMember?.team?.name ?? null;
  const returning = view.subscriptions.some((s) => s.isRenewal);
  const lastHandled = activities.find((a) => a.actor);
  const country = client.country ? (countryName(client.country) ?? client.country) : null;
  const groupHref = activeGroups.map((g) => groupChatHref(g.accountId, g.groupId)).find(Boolean) ?? null;
  const personalHref = chatLinks[0] ? `/chat/account/${chatLinks[0].accountId}/personal/${encodeURIComponent(chatLinks[0].chatId)}` : null;
  const daysLeft = current ? Math.round(dayNumber(current.endDate) - dayNumber(view.today)) : null;
  const termLength = current ? Math.max(1, dayNumber(current.endDate) - dayNumber(current.startDate)) : 1;
  const elapsedPct = current ? Math.min(100, Math.max(0, ((dayNumber(view.today) - dayNumber(current.startDate)) / termLength) * 100)) : 0;
  const termMessage = current ? (TERM_MESSAGE[current.state] ?? TERM_MESSAGE.ACTIVE!) : null;
  const owed = view.outstanding ?? [];
  const livePayments = view.payments.filter((p) => !p.reversed).length;
  const paymentCountText = `${livePayments} payment${livePayments === 1 ? "" : "s"}`;

  const dueDateById = new Map(billing?.dues.map((x) => [x.id, x.dueDate]));
  const summaryText = billing
    ? billing.summary.openCount === 0
      ? "No open dues."
      : `${billing.summary.openCount} open · ${billing.summary.overdueCount} overdue${billing.summary.nextDueDate ? ` · next due ${billing.summary.nextDueDate}` : ""}`
    : "";

  return (
    <div className="space-y-6">
      {/* ── Header: who this is, and the four things people do next. */}
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-5">
          <PhotoControl client={{ id: client.id, code: client.code, name: client.name, companyName: client.companyName, photoVersion: client.photoUpdatedAt?.getTime() ?? null }} canEdit={canManage && !archived} size="xl" />
          <div className="min-w-0 pt-1">
            <h1 className="text-2xl font-semibold tracking-[-0.02em] sm:text-[28px]">{clientDisplayName(client.name, client.companyName)}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CopyCode code={client.code} />
              {formerCodes.length ? <span className={`text-xs ${muted}`} title="Former codes still find this client">formerly {formerCodes.join(", ")}</span> : null}
              <Badge color={STATUS_COLOR[client.status] ?? "gray"} dot>
                {CLIENT_STATUS_LABELS[client.status]}
              </Badge>
              {country ? (
                <Badge color="gray">
                  {flagOf(client.country)} {country}
                </Badge>
              ) : null}
              {returning ? (
                <Badge color="green">
                  <Repeat className="mr-1 inline size-3" aria-hidden />
                  Repeat customer
                </Badge>
              ) : null}
            </div>
            <p className={`mt-2 text-sm ${muted}`}>
              Customer since {formatDay(dhakaToday(client.createdAt))}
              {caps.subscriptions ? ` · ${view.subscriptions.length} subscription${view.subscriptions.length === 1 ? "" : "s"}` : ""}
              {caps.groups ? ` · ${activeGroups.length} linked group${activeGroups.length === 1 ? "" : "s"}` : ""}
              {client.companyName ? ` · ${client.companyName}` : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {canManage && !archived ? (
            <ButtonLink href={`${base}/edit`} size="md">
              <Pencil className="size-4" aria-hidden /> Edit client
            </ButtonLink>
          ) : null}
          {caps.canManageSubscriptions && !archived ? (
            <ButtonLink href={tabHref("subscriptions")} size="md">
              <RefreshCw className="size-4" aria-hidden /> {current ? "Renew subscription" : "Add subscription"}
            </ButtonLink>
          ) : null}
          {showPayments && caps.canRecordPayments && !archived ? (
            <ButtonLink href={tabHref("payments")} size="md">
              <Wallet className="size-4" aria-hidden /> Record payment
            </ButtonLink>
          ) : null}
          {caps.canOpenChat && (groupHref || personalHref) ? (
            <ButtonLink href={(groupHref ?? personalHref)!} variant="primary" size="md">
              <MessageCircle className="size-4" aria-hidden /> {groupHref ? "Open WhatsApp group" : "Open WhatsApp chat"}
            </ButtonLink>
          ) : phone ? (
            // No linked conversation: the WhatsApp page finds an existing one to confirm, or offers WhatsApp's own click-to-chat.
            <ButtonLink href={`${base}/whatsapp`} size="md">
              <MessageCircle className="size-4" aria-hidden /> Open WhatsApp
            </ButtonLink>
          ) : null}
          {!archived ? <PrepareMessageButton clientId={client.id} context={current ? { subscriptionId: current.id } : {}} size="md" /> : null}
          {canArchive || canDelete ? (
            <details className="relative">
              <summary className="flex size-9.5 cursor-pointer list-none items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-neutral-bg)]" aria-label="More actions">
                <MoreVertical className="size-4" aria-hidden />
              </summary>
              <div className={`${panel} absolute right-0 z-20 mt-2 flex w-56 flex-col gap-2 p-3 shadow-[var(--shadow-md)]`}>
                <p className={`text-xs ${muted}`}>{archived ? "This client is archived." : "Archive keeps everything and can be undone."}</p>
                <ClientLifecycle clientId={client.id} archived={archived} canArchive={canArchive} canDelete={canDelete} />
              </div>
            </details>
          ) : null}
        </div>
      </div>

      {canManage ? null : <ViewOnlyNotice />}
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

      {/* ── The 360° strip. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        <FactCard icon={MapPin} accent="blue" label="Country" value={country ?? "Not set"} sub={client.preferredCurrency ? `Prefers ${client.preferredCurrency}` : null} />
        <FactCard icon={Phone} accent="green" label={whatsapp ? "Phone & WhatsApp" : "Phone"} value={phone?.value ?? "No number"} sub={chatLinks.length ? "WhatsApp chat linked" : whatsapp ? "WhatsApp" : phone ? "Phone" : null} />
        {caps.subscriptions ? (
          <FactCard
            icon={Crown}
            accent="amber"
            label="Current plan"
            value={current ? `${current.service}${current.kind !== "PAID" ? ` (${SUBSCRIPTION_KIND_LABELS[current.kind as SubscriptionKind] ?? current.kind})` : ""}` : "None"}
            sub={current ? `Since ${formatDay(current.startDate)}` : null}
          />
        ) : null}
        {caps.subscriptions ? (
          <FactCard
            icon={CalendarClock}
            accent="indigo"
            label="Expires in"
            value={current ? (daysLeft !== null && daysLeft >= 0 && current.state !== "SCHEDULED" && current.state !== "PAUSED" ? `${daysLeft} day${daysLeft === 1 ? "" : "s"}` : current.expiryText) : "—"}
            sub={current ? formatDay(current.endDate) : null}
            valueClass={current ? expiryTextClass(current.state) : ""}
          />
        ) : null}
        {view.outstanding ? (
          <FactCard
            icon={CircleDollarSign}
            accent={owed.some((o) => o.overdue) ? "red" : "green"}
            label="Outstanding"
            value={owed.length ? owed.map((o) => money(o.remaining, o.currency)).join(" · ") : "Nothing owed"}
            sub={owed.some((o) => o.overdue) ? "Has overdue invoices" : owed.length ? "Not yet overdue" : "All payments up to date"}
            valueClass={owed.some((o) => o.overdue) ? "text-[color:var(--color-danger-fg)]" : ""}
          />
        ) : null}
        <FactCard icon={Users} accent="indigo" label="Sold by" value={seller ?? "Not recorded"} sub={sellerTeam ? `${sellerTeam} team` : null} />
      </div>

      <ProfileTabs base={base} tabs={tabs} active={tab} />

      {/* ── Overview. */}
      {tab === "overview" ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <SectionCard
              icon={BookUser}
              title="Client information"
              action={canManage && !archived ? <CardLink href={`${base}/edit`} icon={Pencil}>Edit</CardLink> : null}
            >
              <InfoRow icon={User} label="Full name">{client.name}</InfoRow>
              {client.companyName ? <InfoRow icon={Shapes} label="Company">{client.companyName}</InfoRow> : null}
              <InfoRow icon={Hash} label="Client ID">{client.code}</InfoRow>
              <InfoRow icon={Globe} label="Country">{country ? `${flagOf(client.country)} ${country}` : <span className={muted}>Not set</span>}</InfoRow>
              <InfoRow icon={Smartphone} label="Phone / WhatsApp">
                {phone ? <span className="text-[color:var(--color-accent-fg)]">{phone.value}</span> : <span className={muted}>Not set</span>}
              </InfoRow>
              <InfoRow icon={Mail} label="Email">{email ? email.value : <span className={muted}>Not set</span>}</InfoRow>
              <InfoRow icon={CircleDollarSign} label="Preferred currency">
                {client.preferredCurrency ? `${client.preferredCurrency}${currencyName(client.preferredCurrency) ? ` (${currencyName(client.preferredCurrency)})` : ""}` : <span className={muted}>Not set</span>}
              </InfoRow>
              <InfoRow icon={MapPin} label="Address">{client.address || <span className={muted}>Not set</span>}</InfoRow>
              <InfoRow icon={FileText} label="Source">
                {CLIENT_SOURCE_LABELS[client.source as ClientSourceValue] ?? client.source}
                {client.sourceDetail ? <span className={muted}> ({client.sourceDetail})</span> : null}
              </InfoRow>
              {client.category ? <InfoRow icon={Shapes} label="Category">{client.category}</InfoRow> : null}
              <InfoRow icon={Tag} label="Tags">
                {client.tags.length ? (
                  <span className="flex flex-wrap gap-1.5">
                    {client.tags.map((t) => (
                      <Badge key={t} color="blue">
                        {t}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <span className={muted}>None</span>
                )}
              </InfoRow>
              <InfoRow icon={StickyNote} label="Notes">
                <span className="flex items-center justify-between gap-2">
                  <span className={notes.length ? "" : muted}>{notes.length ? `${notes.length} note${notes.length === 1 ? "" : "s"} · latest ${formatDateTime(notes[0]!.createdAt)}` : "No notes added"}</span>
                  <CardLink href={`${tabHref("activity")}#notes`}>{canManage && !archived ? "Add note" : "View"}</CardLink>
                </span>
              </InfoRow>
            </SectionCard>

            <div className="flex flex-col gap-6">
              {caps.subscriptions ? (
                <SectionCard
                  icon={CalendarDays}
                  title="Current subscription"
                  action={current ? <Badge color={SUBSCRIPTION_TONE[view.overallState]} dot>{SUBSCRIPTION_STATE_LABELS[view.overallState]}</Badge> : null}
                >
                  {current ? (
                    <>
                      <div className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-neutral-bg)]">
                            <Crown className="size-5" aria-hidden />
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{current.service}</p>
                            <p className={`text-xs ${muted}`}>{SUBSCRIPTION_KIND_LABELS[current.kind as SubscriptionKind] ?? current.kind}{current.isRenewal ? " · renewal" : ""}</p>
                          </div>
                        </div>
                        <CardLink href={tabHref("subscriptions")}>Manage</CardLink>
                      </div>
                      <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
                        <div>
                          <dt className={`text-xs ${muted}`}>Start date</dt>
                          <dd className="font-semibold">{formatDay(current.startDate)}</dd>
                        </div>
                        <div>
                          <dt className={`text-xs ${muted}`}>Expiry date</dt>
                          <dd className="font-semibold">{formatDay(current.endDate)}</dd>
                        </div>
                        <div>
                          <dt className={`text-xs ${muted}`}>Time remaining</dt>
                          <dd className={`font-semibold ${expiryTextClass(current.state)}`}>{daysLeft !== null && daysLeft >= 0 ? `${daysLeft} day${daysLeft === 1 ? "" : "s"}` : current.expiryText}</dd>
                        </div>
                      </dl>
                      <div className="mt-4">
                        <div className="h-2 overflow-hidden rounded-full bg-[var(--color-neutral-bg)]" role="progressbar" aria-valuenow={Math.round(elapsedPct)} aria-valuemin={0} aria-valuemax={100} aria-label="Share of the term used">
                          <div className={`h-full rounded-full ${BAR[termMessage!.tone]}`} style={{ width: `${Math.max(2, elapsedPct)}%` }} />
                        </div>
                        <p className={`mt-1 flex justify-between text-[11px] ${muted}`}>
                          <span>{Math.round(elapsedPct)}% of the term used</span>
                          <span>{formatDay(current.endDate)}</span>
                        </p>
                      </div>
                      <div className={`mt-4 rounded-[var(--radius-lg)] border px-3 py-2.5 text-sm ${TONE_BOX[termMessage!.tone]}`}>
                        <p className="flex items-center gap-2 font-medium">
                          <BadgeCheck className="size-4" aria-hidden />
                          {termMessage!.title}
                        </p>
                        <p className="mt-0.5 text-xs opacity-90">
                          {current.expiryText}
                          {current.soldBy ? ` · sold by ${current.soldBy}` : ""}
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-start gap-3 text-sm">
                      <p className={muted}>{view.subscriptions.length ? "No current term — every earlier one was cancelled." : "No subscription recorded yet."}</p>
                      {caps.canManageSubscriptions && !archived ? <CardLink href={tabHref("subscriptions")}>Add subscription</CardLink> : null}
                    </div>
                  )}
                  {client.recordedExpiryDate ? (
                    <div className="mt-3 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] px-3 py-2 text-sm">
                      <p className="font-medium">
                        Expiry on record: {client.recordedExpiryDate.toISOString().slice(0, 10)}
                        {client.recordedExpiryService ? ` · ${client.recordedExpiryService}` : ""}
                      </p>
                      <p className={`text-xs ${muted}`}>From an import that gave an expiry but no start date — kept as a note, not a subscription term. Add a subscription with its start date to track it.</p>
                    </div>
                  ) : null}
                </SectionCard>
              ) : null}

              {view.ledger ? (
                <SectionCard icon={ReceiptText} title="Billing summary" action={<CardLink href={tabHref("billing")}>View all invoices</CardLink>}>
                  {(() => {
                    const lines = view.ledger.length ? view.ledger : [{ currency: client.preferredCurrency ?? "", billed: "0.00", collected: "0.00", remaining: "0.00", openCount: 0, overdueCount: 0 }];
                    const tiles: Array<[string, string, string, string]> = [
                      ["Total billed", lines.map((l) => money(l.billed, l.currency || null)).join(" · "), `${view.invoiceCount} invoice${view.invoiceCount === 1 ? "" : "s"}`, "bg-[var(--color-success-bg)]"],
                      ["Total paid", lines.map((l) => money(l.collected, l.currency || null)).join(" · "), paymentCountText, "bg-[var(--color-info-bg)]"],
                      ["Due amount", lines.map((l) => money(l.remaining, l.currency || null)).join(" · "), lines.some((l) => l.overdueCount) ? "Overdue" : lines.some((l) => l.openCount) ? "Open" : "Nothing owed", "bg-[var(--color-warning-bg)]"],
                      ["Next due date", billing?.summary.nextDueDate ? formatDay(billing.summary.nextDueDate) : "—", billing?.summary.oldestOverdueDate ? `Overdue since ${formatDay(billing.summary.oldestOverdueDate)}` : billing?.summary.nextDueDate ? "Upcoming" : "None open", "bg-[var(--color-neutral-bg)]"],
                    ];
                    return (
                      <div className="grid grid-cols-2 gap-2.5">
                        {tiles.map(([label, value, sub, bg]) => (
                          <div key={label} className={`rounded-[var(--radius-lg)] px-3 py-2.5 ${bg}`}>
                            <p className={`text-xs ${muted}`}>{label}</p>
                            <p className="truncate text-base font-semibold tabular-nums" title={value}>{value}</p>
                            <p className={`text-[11px] ${muted}`}>{sub}</p>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  {view.ledger.length > 1 ? <p className={`mt-2 text-[11px] ${muted}`}>Totals are per currency; nothing is converted.</p> : null}
                </SectionCard>
              ) : null}

              {/* V5 §7: what an imported spreadsheet said, shown only to someone who may see billing figures. */}
              {caps.billing && Array.isArray(client.importedAmounts) && client.importedAmounts.length ? (
                <SectionCard icon={ReceiptText} title="Amounts recorded at import">
                  <p className={`mb-2 text-xs ${muted}`}>As the imported file wrote them — not invoices, payments or dues, and never added together.</p>
                  <ul className="space-y-1 text-sm">
                    {(client.importedAmounts as Array<{ currency: string | null; amount: string | null; original: string; column: string; problem?: string; file?: string; at?: string }>).map((a, i) => (
                      <li key={i} className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className={a.problem ? "text-[color:var(--color-danger-fg)]" : "tabular-nums font-medium"}>{a.amount && a.currency ? `${a.currency} ${a.amount}` : `“${a.original}”`}</span>
                        <span className={`text-xs ${muted}`}>
                          {a.column} column{a.file ? ` · ${a.file}` : ""}
                          {a.at ? ` · ${formatDay(a.at.slice(0, 10))}` : ""}
                        </span>
                        {a.problem ? <span className="basis-full text-xs text-[color:var(--color-danger-fg)]">{a.problem}</span> : null}
                      </li>
                    ))}
                  </ul>
                </SectionCard>
              ) : null}
            </div>

            <div className="flex flex-col gap-6">
              <SectionCard icon={UserCog} title="Team & ownership" action={canManage && !archived ? <CardLink href={`${base}/edit`} icon={Pencil}>Edit</CardLink> : null}>
                <InfoRow icon={BadgeCheck} label="Sold by">
                  {seller ?? <span className={muted}>Not recorded</span>}
                  {sellerTeam ? <span className={`block text-xs ${muted}`}>{sellerTeam} team</span> : null}
                </InfoRow>
                <InfoRow icon={Users} label="Team">{client.assignedTeam?.name ?? <span className={muted}>No team</span>}</InfoRow>
                <InfoRow icon={User} label="Assigned staff">
                  <span className="flex items-center justify-between gap-2">
                    <span className={client.assignedMember ? "" : muted}>{client.assignedMember?.name ?? "Not assigned"}</span>
                    {!client.assignedMember && canManage && !archived ? <CardLink href={`${base}/edit`}>Assign</CardLink> : null}
                  </span>
                </InfoRow>
                <InfoRow icon={Clock} label="Last handled by">
                  {lastHandled ? (
                    <>
                      {lastHandled.actor!.name}
                      <span className={`block text-xs ${muted}`}>{formatDateTime(lastHandled.createdAt)}</span>
                    </>
                  ) : (
                    <span className={muted}>Nobody yet</span>
                  )}
                </InfoRow>
                {client.preferredLanguage ? (
                  <InfoRow icon={Globe} label="Language">
                    {client.preferredLanguage}
                    {client.additionalLanguages.length ? <span className={`block text-xs ${muted}`}>Also {client.additionalLanguages.join(", ")}</span> : null}
                  </InfoRow>
                ) : null}
                {client.businessType ? <InfoRow icon={Shapes} label="Business type">{client.businessType}</InfoRow> : null}
              </SectionCard>

              <SectionCard
                icon={MessageCircle}
                title="WhatsApp"
                action={<Badge color={activeGroups.length || chatLinks.length ? "green" : "yellow"} dot>{activeGroups.length || chatLinks.length ? "Linked" : "Not linked"}</Badge>}
              >
                <InfoRow icon={Smartphone} label="Account">
                  {activeGroups[0]?.accountLabel ?? chatLinks[0]?.accountLabel ?? <span className={muted}>Not linked</span>}
                </InfoRow>
                {caps.groups ? (
                  <InfoRow icon={Users} label="WhatsApp group">
                    <span className="flex items-center justify-between gap-2">
                      <span className={activeGroups.length ? "" : muted}>
                        {activeGroups[0]?.groupName ?? "No group linked"}
                        {activeGroups.length > 1 ? <span className={muted}> +{activeGroups.length - 1}</span> : null}
                      </span>
                      {groupHref && caps.canOpenChat ? <CardLink href={groupHref}>Open</CardLink> : caps.canLinkGroups && !archived ? <CardLink href={tabHref("whatsapp")}>Link group</CardLink> : null}
                    </span>
                  </InfoRow>
                ) : null}
                <InfoRow icon={Phone} label="Personal chat">
                  <span className="flex items-center justify-between gap-2">
                    <span className={chatLinks.length ? "" : muted}>{chatLinks[0]?.chatLabel ?? (whatsapp ? `${whatsapp.value} (not linked)` : "Not linked")}</span>
                    {personalHref && caps.canOpenChat ? <CardLink href={personalHref}>Open chat</CardLink> : canLinkChats && !archived ? <CardLink href={tabHref("whatsapp")}>Link</CardLink> : null}
                  </span>
                </InfoRow>
              </SectionCard>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            {showPayments ? (
              <SectionCard icon={Wallet} title="Recent payments" action={<CardLink href={tabHref("payments")}>View all</CardLink>}>
                {view.payments.length ? (
                  <div className="-mx-1 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className={`text-left text-[11px] uppercase tracking-[0.05em] ${muted}`}>
                          <th className="px-1 pb-2 font-medium">Date</th>
                          <th className="px-1 pb-2 font-medium">Amount</th>
                          <th className="px-1 pb-2 font-medium">Method</th>
                          <th className="px-1 pb-2 font-medium">Receipt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.payments.slice(0, 5).map((p) => (
                          <tr key={p.id} className={`border-t border-[var(--color-border)] ${p.reversed ? "line-through opacity-60" : ""}`}>
                            <td className="whitespace-nowrap px-1 py-2">
                              {formatDay(p.receivedDate)}
                              {p.recordedBy ? <span className={`block text-[11px] ${muted}`}>by {p.recordedBy}</span> : null}
                            </td>
                            <td className="whitespace-nowrap px-1 py-2 font-medium tabular-nums">{money(p.amount, p.currency)}</td>
                            <td className="px-1 py-2">
                              <Badge color="gray">{(PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method).split(" (")[0]}</Badge>
                            </td>
                            <td className="whitespace-nowrap px-1 py-2 font-mono text-xs">{p.receiptNumber ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className={`text-sm ${muted}`}>No payments recorded.</p>
                )}
              </SectionCard>
            ) : null}

            <SectionCard icon={Activity} title="Recent activity" action={<CardLink href={tabHref("activity")}>View all</CardLink>}>
              {activities.length ? (
                <Timeline>
                  {activities.slice(0, 5).map((a) => (
                    <ActivityItem key={a.id} type={a.type} summary={a.summary} meta={`${a.actor?.name ?? "System"} · ${formatDateTime(a.createdAt)}`} />
                  ))}
                </Timeline>
              ) : (
                <p className={`text-sm ${muted}`}>Nothing recorded yet.</p>
              )}
            </SectionCard>

            {caps.subscriptions ? (
              <SectionCard icon={History} title="Subscription history" action={<CardLink href={tabHref("subscriptions")}>View all</CardLink>}>
                {view.subscriptions.length ? (
                  <Timeline>
                    {view.subscriptions.slice(0, 4).map((s) => (
                      <li key={s.id} className="relative flex gap-3 pb-4 last:pb-0">
                        <span className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-info-bg)] text-[color:var(--color-info-fg)]">
                          <CalendarDays className="size-3.5" aria-hidden />
                        </span>
                        <div className="min-w-0 text-sm">
                          <p className="flex flex-wrap items-center gap-2 font-medium">
                            {s.service}
                            {s.kind !== "PAID" ? <span className={`font-normal ${muted}`}>({SUBSCRIPTION_KIND_LABELS[s.kind as SubscriptionKind] ?? s.kind})</span> : null}
                            <Badge color={SUBSCRIPTION_TONE[s.state]}>{SUBSCRIPTION_STATE_LABELS[s.state]}</Badge>
                          </p>
                          <p className={`text-xs ${muted}`}>
                            {formatDay(s.startDate)} → {formatDay(s.endDate)}
                            {s.soldBy ? ` · sold by ${s.soldBy}` : ""}
                          </p>
                        </div>
                      </li>
                    ))}
                  </Timeline>
                ) : (
                  <p className={`text-sm ${muted}`}>No subscriptions yet.</p>
                )}
              </SectionCard>
            ) : null}
          </div>

          {client.businessDetails || client.followUpInstructions ? (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {client.businessDetails ? (
                <SectionCard icon={Shapes} title="Business details">
                  <p className="whitespace-pre-wrap text-sm">{client.businessDetails}</p>
                </SectionCard>
              ) : null}
              {client.followUpInstructions ? (
                <SectionCard icon={StickyNote} title="Follow-up instructions">
                  <p className="whitespace-pre-wrap text-sm">{client.followUpInstructions}</p>
                </SectionCard>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Subscriptions. */}
      {tab === "subscriptions" ? (
        <Card className="p-6">
          <SectionHeader title="Subscriptions" />
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
            canDelete={caps.canDelete}
          />
        </Card>
      ) : null}
      {tab === "subscriptions" && offers ? (
        <Card className="p-6">
          <SectionHeader title="Renewal offers" />
          <RenewalOffersPanel offers={offers} today={view.today} canManage={caps.canManageSubscriptions && !archived} canInvoice={caps.canEditBilling} currentTerm={current ? { id: current.id, endDate: current.endDate } : null} />
          {current && caps.canManageSubscriptions && !archived && !offers.some((o) => o.subscriptionId === current.id && ["PREPARED", "CONTACTED", "AWAITING_RESPONSE", "ACCEPTED"].includes(o.status)) ? (
            <div className="mt-4">
              <PrepareOfferButton
                subscriptionId={current.id}
                defaults={{ service: current.service, durationValue: current.durationValue, durationUnit: current.durationUnit, currency: client.preferredCurrency }}
                currencies={formContext.currencies}
                sellers={options.roster.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name }))}
                canPrice={caps.billing}
                label="Prepare renewal offer"
              />
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ── Billing. */}
      {tab === "billing" && billing ? (
        <Card className="p-6">
          <SectionHeader title="Invoices and dues" />
          <BillingPanel
            clientId={client.id}
            canEdit={canEditBilling}
            archived={archived}
            canDelete={caps.canDelete}
            summaryText={summaryText}
            currencies={billing.currencies.filter((c) => c.enabled).map((c) => c.code)}
            dues={billing.dues}
            invoice={{ sellers: options.roster.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name, teamName: m.teamName })), today: view.today }}
            history={billing.history.map((h) => ({ id: h.id, dueId: h.dueId, type: h.type, summary: describeDueEvent(h.type, h.changes, dueDateById.get(h.dueId) ?? null), actor: h.actor, at: formatDateTime(h.at) }))}
          />
        </Card>
      ) : null}

      {/* ── Payments. */}
      {tab === "payments" && showPayments ? (
        <Card className="p-6">
          <SectionHeader title="Payments & receipts" />
          <ClientPaymentsPanel client={{ name: clientDisplayName(client.name, client.companyName), code: client.code }} openInvoices={view.openInvoices} payments={view.payments} canRecord={caps.canRecordPayments && !archived} today={view.today} canDelete={caps.canDelete} />
        </Card>
      ) : null}

      {/* ── WhatsApp & channels. */}
      {tab === "whatsapp" ? (
        <div className="space-y-6">
          {caps.groups ? (
            <Card className="p-6">
              <SectionHeader title="WhatsApp groups" />
              <GroupLinksPanel clientId={client.id} links={view.groupLinks} accounts={formContext.accounts} canLink={caps.canLinkGroups} canOpenChat={caps.canOpenChat} archived={archived} />
            </Card>
          ) : null}
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
            <p className={`mt-3 text-xs ${muted}`}>
              Last contact: {client.lastContactAt ? formatDateTime(client.lastContactAt) : "none recorded"}. Consent is recorded per channel for later; nothing is sent from here today.
            </p>
          </Card>
        </div>
      ) : null}

      {/* ── Activity & notes. */}
      {tab === "activity" ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
          <div id="notes" className="scroll-mt-24 xl:col-span-2">
            <Card className="p-6">
              <SectionHeader title="Internal notes" />
              <NotesPanel
                clientId={client.id}
                canEdit={canManage && !archived}
                canDelete={caps.canDelete}
                notes={notes.map((n) => ({ id: n.id, body: n.body, author: n.author?.name ?? null, at: formatDateTime(n.createdAt) }))}
              />
            </Card>
            <Card className="mt-6 p-6">
              <SectionHeader title="Messages to the client" />
              {/* Kept apart from internal notes: these are words meant for the client (CLIENT_CRM_V7.md §8). */}
              <MessageHistory messages={messages ?? []} empty="No message prepared or sent to this client yet." />
            </Card>
          </div>
          <div className="xl:col-span-3">
            <SectionCard icon={Activity} title="Activity timeline">
              {activities.length ? (
                <Timeline>
                  {activities.map((a) => (
                    <ActivityItem key={a.id} type={a.type} summary={a.summary} meta={`${a.actor?.name ?? "System"} · ${formatDateTime(a.createdAt)}`} />
                  ))}
                </Timeline>
              ) : (
                <p className={`text-sm ${muted}`}>Nothing recorded yet.</p>
              )}
              {activities.length >= 100 ? <p className={`mt-3 text-xs ${muted}`}>Showing the latest 100 entries.</p> : null}
              <p className={`mt-4 border-t border-[var(--color-border)] pt-3 text-xs ${muted}`}>
                Created {formatDateTime(client.createdAt)}
                {client.createdBy ? ` by ${client.createdBy.name}` : ""} · updated {formatDateTime(client.updatedAt)}
              </p>
            </SectionCard>
          </div>
        </div>
      ) : null}
    </div>
  );
}
