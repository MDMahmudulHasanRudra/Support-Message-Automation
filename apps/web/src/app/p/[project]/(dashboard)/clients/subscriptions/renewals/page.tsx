import { AlarmClock, CalendarClock, CheckCircle2, Hourglass, Search, Send } from "lucide-react";
import { RENEWAL_VIEWS, RENEWAL_VIEW_LABELS, type RenewalView } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { clientViewerCaps } from "@/server/clientModule";
import { listBillingCurrencies } from "@/server/clientBilling";
import { listRenewals, parseRenewalView, renewalCounts, RENEWAL_PAGE_SIZE } from "@/server/clientRenewals";
import Link from "@/components/ProjectLink";
import { Alert, Badge, EmptyState, HelpButton, HelpSection, Input, Pagination, ViewOnlyNotice } from "@/components/ui";
import { formatDay } from "@/lib/clientDisplay";
import { AutoSubmitForm } from "../../AutoSubmitForm";
import { ChipTabs, KpiCard, mutedText, surface, type Chip } from "../../ModuleKit";
import { PrepareMessageButton } from "../../messages/PrepareMessage";
import { OfferActions, PrepareOfferButton } from "./RenewalParts";

export const metadata = { title: "Renewals" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TONE: Record<string, "gray" | "blue" | "yellow" | "green" | "red"> = { PREPARED: "gray", CONTACTED: "blue", AWAITING_RESPONSE: "yellow", ACCEPTED: "green", RENEWED: "green", DECLINED: "red", WITHDRAWN: "gray" };

/**
 * The Renewal workspace (CLIENT_CRM_V7.md §4): terms renewing soon or expired, and the offers made for them —
 * prepared, sent, awaiting a response, accepted, renewed, declined — plus every follow-up that is due. An expiring
 * term is NOT money owed; a proposal is not an invoice. Money appears only when a person renews and raises an invoice.
 */
export default async function RenewalsPage({ searchParams }: { searchParams: SearchParams }) {
  const { session, canManage } = await pageAccess("clients.view", "clients.manage_subscriptions");
  const caps = await clientViewerCaps(session);
  if (!caps.settings.subscriptions) return <Alert tone="info">Subscriptions are switched off for this project. A Client Module manager can turn them on under Settings → Client Module.</Alert>;
  const raw = await searchParams;
  const view = parseRenewalView(raw.view);
  const q = (typeof raw.q === "string" ? raw.q : "").trim().slice(0, 100);
  const page = Math.max(1, Number(raw.page) || 1);
  const windowDays = caps.settings.renewalWindowDays;
  const [{ rows, total, today }, counts, currencies, sellers, countsAll] = await Promise.all([
    listRenewals({ view, q, page, windowDays, billing: caps.billing }),
    renewalCounts(windowDays, q),
    listBillingCurrencies(),
    prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 300 }),
    q ? renewalCounts(windowDays) : null,
  ]);
  const c = countsAll ?? counts;
  const href = (patch: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const next = { view, q, page: undefined as number | undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== "" && !(k === "view" && v === "renewing") && !(k === "page" && v === 1)) p.set(k, String(v));
    const s = p.toString();
    return `/clients/subscriptions/renewals${s ? `?${s}` : ""}`;
  };
  const chips: Chip[] = RENEWAL_VIEWS.map((v) => ({
    key: v,
    label: RENEWAL_VIEW_LABELS[v],
    count: counts[v],
    href: href({ view: v }),
    active: view === v,
    tone: v === "expired" || v === "follow-up" ? "danger" : v === "renewing" ? "warning" : undefined,
  }));
  const enabled = currencies.filter((x) => x.enabled).map((x) => x.code);
  const canAct = canManage && caps.canManageSubscriptions;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] sm:text-[28px]">Renewals</h1>
          <p className={`mt-1 text-sm ${mutedText}`}>Terms ending within {windowDays} days or already expired, the offers made for them, and the follow-ups that are due.</p>
        </div>
        <HelpButton moduleTitle="Renewals">
          <HelpSection title="The workflow">
            <p>Prepare an offer (service, duration, optional price), contact the customer and record each attempt, mark it awaiting a response, then record the acceptance or decline. From an accepted offer, Renew creates the new term — and, if you tick it, the invoice. Payment is recorded separately and gets its own receipt.</p>
          </HelpSection>
          <HelpSection title="Renewal pending is not money owed">
            <p>An expiring term, a prepared offer and even an accepted one create no due and no balance. Only an invoice is owed.</p>
          </HelpSection>
          <HelpSection title="Messages">
            <p>Message client fills a Renewal offer or Renewal reminder template with the offer&apos;s details. Email is sent by Get Assist; WhatsApp is prepared for you to send. Record the contact on the offer afterwards.</p>
          </HelpSection>
        </HelpButton>
      </div>
      {canManage ? null : <ViewOnlyNotice />}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard icon={CalendarClock} accent="amber" label="Renewing soon" value={String(c.renewing)} hint={`Within ${windowDays} days`} href={href({ view: "renewing", q: undefined })} />
        <KpiCard icon={AlarmClock} accent={c.expired ? "red" : "slate"} toneValue={c.expired > 0} label="Expired" value={String(c.expired)} hint="Current term has ended" href={href({ view: "expired", q: undefined })} />
        <KpiCard icon={Hourglass} accent="blue" label="Awaiting response" value={String(c.awaiting + c.sent)} hint="Offer sent or awaiting" href={href({ view: "awaiting", q: undefined })} />
        <KpiCard icon={CheckCircle2} accent="green" label="Accepted, to renew" value={String(c.accepted)} hint={c["follow-up"] ? `${c["follow-up"]} follow-up(s) due` : "No follow-up due"} href={href({ view: "accepted", q: undefined })} />
      </div>
      <ChipTabs label="Renewal views" chips={chips} />

      <AutoSubmitForm className={`${surface} p-3`}>
        <input type="hidden" name="view" value={view} />
        <label className="relative block">
          <Search className={`pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 ${mutedText}`} aria-hidden />
          <Input name="q" defaultValue={q} placeholder="Search client name, code or company…" className="pl-9" aria-label="Search renewals" />
        </label>
      </AutoSubmitForm>

      {rows.length === 0 ? (
        <EmptyState>{emptyText(view)}</EmptyState>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={`${r.term?.id}-${r.offer?.id ?? "none"}`} className={`${surface} grid gap-3 p-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] md:items-center`}>
              <div className="min-w-0">
                <Link href={`/clients/${r.client.id}?tab=subscriptions`} className="block truncate font-semibold hover:underline">
                  {r.client.name}
                </Link>
                <p className={`truncate text-xs ${mutedText}`}>
                  {r.client.code} · {r.term?.service}
                </p>
              </div>
              <div className="text-sm">
                {r.term ? (
                  <>
                    <div className={r.term.daysLeft < 0 ? "font-medium text-[color:var(--color-danger-fg)]" : r.term.daysLeft <= windowDays ? "font-medium text-[color:var(--color-warning-fg)]" : ""}>{formatDay(r.term.endDate)}</div>
                    <div className={`text-xs ${mutedText}`}>{r.term.daysLeft < 0 ? `Expired ${-r.term.daysLeft} day(s) ago` : r.term.daysLeft === 0 ? "Expires today" : `${r.term.daysLeft} day(s) left`}{r.term.paused ? " · paused" : ""}</div>
                  </>
                ) : null}
              </div>
              <div className="min-w-0 text-sm">
                {r.offer ? (
                  <>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge color={TONE[r.offer.status] ?? "gray"}>{r.offer.statusLabel}</Badge>
                      {r.offer.lapsed ? <Badge color="red">Past valid-until</Badge> : null}
                      {r.offer.followUpDue ? <Badge color="yellow">Follow-up due</Badge> : null}
                    </div>
                    <div className={`mt-1 truncate text-xs ${mutedText}`}>
                      {r.offer.service} · {r.offer.duration}
                      {r.offer.price ? ` · ${r.offer.price}` : ""}
                      {r.offer.contactCount ? ` · contacted ${r.offer.contactCount}×` : ""}
                      {r.offer.followUpDate ? ` · follow up ${formatDay(r.offer.followUpDate)}` : ""}
                    </div>
                    {r.offer.invoiceDueId ? (
                      <Link href={`/clients/dues/${r.offer.invoiceDueId}`} className="text-xs hover:underline">
                        View invoice
                      </Link>
                    ) : null}
                  </>
                ) : (
                  <span className={`text-xs ${mutedText}`}>No open offer</span>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {!r.client.archived && r.term ? (
                  <PrepareMessageButton clientId={r.client.id} context={{ subscriptionId: r.term.id, offerId: r.offer?.id }} category={r.offer ? "RENEWAL_OFFER" : r.term.daysLeft < 0 ? "EXPIRY_NOTICE" : "RENEWAL_REMINDER"} label="Message" variant="ghost" />
                ) : null}
                {canAct && !r.client.archived && r.term && !r.offer && (view === "renewing" || view === "expired") ? (
                  <PrepareOfferButton subscriptionId={r.term.id} defaults={{ service: r.term.service, durationValue: r.term.durationValue, durationUnit: r.term.durationUnit, currency: null }} currencies={enabled} sellers={sellers} canPrice={caps.billing} />
                ) : null}
                {canAct && !r.client.archived && r.offer && r.term ? (
                  <OfferActions offerId={r.offer.id} status={r.offer.status} offerPrice={r.offer.price} termEnd={r.term.endDate} today={today} canInvoice={caps.canEditBilling} />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {total > RENEWAL_PAGE_SIZE ? <Pagination page={page} pageSize={RENEWAL_PAGE_SIZE} total={total} buildHref={(p) => href({ page: p })} /> : null}
      <p className={`flex items-center gap-1.5 text-xs ${mutedText}`}>
        <Send className="size-3.5" aria-hidden /> Renewal pending is not a due · an accepted offer is not a payment · nothing here sends a message by itself.
      </p>
    </div>
  );
}

function emptyText(view: RenewalView): string {
  switch (view) {
    case "renewing":
      return "No current term ends within the renewal window.";
    case "expired":
      return "No client's current term has expired.";
    case "follow-up":
      return "No follow-up is due.";
    default:
      return "No offer here.";
  }
}
