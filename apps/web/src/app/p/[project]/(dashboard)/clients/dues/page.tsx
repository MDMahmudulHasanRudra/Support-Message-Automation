import { AlarmClock, CircleCheck, CircleDollarSign, FileText, Filter, Hourglass, Search } from "lucide-react";
import { dhakaToday } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { prisma } from "@/server/db";
import { BILLING_PAGE_SIZES, BILLING_VIEWS, billingWhere, getBillingFilterOptions, getBillingKpis, listBillingCurrencies, listBillingRegister, parseBillingFilters, type BillingFilters } from "@/server/clientBilling";
import { clientViewerCaps, columnNeeds, getColumnPreference } from "@/server/clientModule";
import { loadClientFormOptions } from "@/server/clients";
import { Alert, Card, EmptyState, HelpButton, HelpSection, Input, Pagination, SectionHeader, Select, ViewOnlyNotice } from "@/components/ui";
import { allowedColumns, DUE_KINDS, DUE_KIND_LABELS } from "@support-automation/shared";
import { countryName } from "@/lib/clientPhone";
import { money } from "@/lib/clientDisplay";
import { CurrencyPanel } from "./CurrencyPanel";
import { BillingTable, CreateBillButton } from "./BillingTable";
import { ColumnChooser } from "../ColumnChooser";
import { AutoSubmitForm } from "../AutoSubmitForm";
import { ChipTabs, KpiCard, mutedText, surface, type Chip } from "../ModuleKit";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const VIEW_LABELS: Record<(typeof BILLING_VIEWS)[number], string> = {
  open: "Open",
  overdue: "Overdue",
  partial: "Part-paid",
  paid: "Paid",
  waived: "Waived",
  cancelled: "Cancelled",
  all: "All",
};

function query(f: BillingFilters, patch: Partial<BillingFilters> = {}): string {
  const next = { ...f, ...patch };
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) {
    if (v === "" || v === undefined) continue;
    if ((k === "page" && v === 1) || (k === "pageSize" && v === 50) || (k === "sort" && v === "due") || (k === "dir" && v === "asc") || (k === "view" && v === "open")) continue;
    out.set(k, String(v));
  }
  const s = out.toString();
  return `/clients/dues${s ? `?${s}` : ""}`;
}

/**
 * The Billing List (route kept as /clients/dues). Who was billed, for what, by which teammate, due
 * when, what was collected and what remains — each amount in its own currency. Needs the billing key;
 * recording a payment needs the edit key and Payments on.
 */
export default async function BillingListPage({ searchParams }: { searchParams: SearchParams }) {
  const { session, canManage } = await pageAccess("clients.view_billing", "clients.edit_billing");
  const raw = await searchParams;
  // The filter bar sends one "order" (sort + direction); links keep sort/dir.
  const order = typeof raw.order === "string" && /^[a-z]+:(asc|desc)$/.test(raw.order) ? raw.order.split(":") : null;
  const f = parseBillingFilters(order ? { ...raw, sort: order[0], dir: order[1] } : raw);
  const caps = await clientViewerCaps(session);
  const canSendMessages = await hasPermission(session, "clients.send_messages");
  if (!caps.settings.billing) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Billing List</h1>
        <Alert tone="info">Billing is switched off for this project. A Client Module manager can turn it on under Settings → Client Module.</Alert>
      </div>
    );
  }
  const viewToday = dhakaToday(new Date());
  const [{ rows, total, today }, kpis, options, currencies, prefs, roster, viewCounts] = await Promise.all([
    listBillingRegister(f),
    getBillingKpis(),
    getBillingFilterOptions(),
    listBillingCurrencies(),
    getColumnPreference(session.userId, "billing", caps),
    loadClientFormOptions(),
    // Each chip counts within the current search and filters, so the numbers match what a click shows.
    Promise.all(BILLING_VIEWS.map((v) => prisma.clientDue.count({ where: billingWhere({ ...f, view: v }, viewToday) }))),
  ]);
  const available = allowedColumns("billing", columnNeeds(caps));
  const labels = Object.fromEntries(available.map((c) => [c.key, c.label]));
  const enabled = currencies.filter((c) => c.enabled).map((c) => c.code);
  const sellers = roster.roster.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name, teamName: m.teamName }));

  const chips: Chip[] = BILLING_VIEWS.map((v, i) => ({
    key: v,
    label: VIEW_LABELS[v],
    count: viewCounts[i],
    href: query(f, { view: v, page: 1 }),
    active: f.view === v,
    tone: v === "overdue" ? "danger" : v === "partial" ? "warning" : undefined,
  }));
  const moreFilters = [f.team, f.service, f.currency, f.country, f.kind, f.from, f.to].filter(Boolean).length;
  const orderValue = `${f.sort}:${f.dir}`;
  const owed = kpis.outstanding.filter((o) => o.remaining !== "0.00");

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] sm:text-[28px]">Billing List</h1>
          <p className={`mt-1 text-sm ${mutedText}`}>Who was billed, for what service, by which teammate, due when, what was collected and what remains.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage ? <CreateBillButton currencies={enabled} invoice={{ sellers, today }} /> : null}
          <HelpButton moduleTitle="Billing List">
            <HelpSection title="Amounts">
              <p>Every amount is shown in its own currency. Nothing is converted or added across currencies, so the Outstanding card has one figure per currency.</p>
            </HelpSection>
            <HelpSection title="Recording payments">
              <p>Tick the invoices a client paid and press Pay selected, or use Record payment on a row. Each invoice takes its own amount (part payments are fine, more than what is left is not). A mistake is reversed on Payments &amp; Receipts.</p>
            </HelpSection>
            <HelpSection title="Deleting">
              <p>Delete removes an invoice that should never have been raised — only an Administrator, or someone an Administrator gave the delete permission, sees it. An invoice a recorded payment still settles is kept until that payment is reversed or deleted. To stop expecting money on a real invoice, waive or cancel it on the client&apos;s profile.</p>
            </HelpSection>
            <HelpSection title="Payment due is not subscription expiry">
              <p>The due date here is when money is owed. When a service expires is on the Subscriptions page; an expired service that was paid owes nothing.</p>
            </HelpSection>
          </HelpButton>
        </div>
      </div>
      {canManage ? null : <ViewOnlyNotice />}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard icon={FileText} accent="indigo" label="Invoice records" value={kpis.invoices.toLocaleString()} hint="Every invoice and due, except cancelled" href="/clients/dues?view=all" />
        <KpiCard icon={Hourglass} accent="amber" toneValue={kpis.openCount > 0} label="Open invoices" value={kpis.openCount.toLocaleString()} hint="Still expecting money" href="/clients/dues" />
        <KpiCard icon={AlarmClock} accent={kpis.overdueCount ? "red" : "slate"} toneValue label="Overdue" value={kpis.overdueCount.toLocaleString()} hint="Past their due date" href="/clients/dues?view=overdue" />
        <KpiCard
          icon={CircleDollarSign}
          accent={kpis.overdueCount ? "red" : "blue"}
          toneValue={kpis.overdueCount > 0}
          label="Outstanding"
          value={owed.length ? owed.map((o) => money(o.remaining, o.currency)).join(" · ") : "Nothing owed"}
          hint={owed.length > 1 ? "Per currency, never merged" : "Across every client"}
        />
        <KpiCard icon={CircleCheck} accent="green" label="Paid" value={kpis.paidCount.toLocaleString()} hint="Settled in full" href="/clients/dues?view=paid" />
      </div>

      <ChipTabs label="Invoice views" chips={chips} />

      <AutoSubmitForm className={`${surface} space-y-3 p-3`}>
        <input type="hidden" name="view" value={f.view} />
        {f.pageSize !== 50 ? <input type="hidden" name="pageSize" value={f.pageSize} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-full sm:basis-[280px]">
            <Search className={`pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 ${mutedText}`} aria-hidden />
            <Input name="q" defaultValue={f.q} placeholder="Search invoice, client, phone, seller, reference…" className="pl-9" aria-label="Search invoices" />
          </label>
          <Select name="seller" defaultValue={f.seller} className="sm:w-44" aria-label="Sold by">
            <option value="">All sellers</option>
            {options.sellers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <Select name="order" defaultValue={orderValue} className="sm:w-52" aria-label="Sort">
            <option value="due:asc">Sort: due date (soonest)</option>
            <option value="due:desc">Sort: due date (latest)</option>
            <option value="issued:desc">Sort: newest issued</option>
            <option value="invoice:desc">Sort: invoice no.</option>
            <option value="client:asc">Sort: client (A – Z)</option>
            <option value="amount:desc">Sort: amount (largest)</option>
          </Select>
          <ColumnChooser list="billing" available={available.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))} selected={prefs.columns} />
        </div>
        <details open={moreFilters > 0}>
          <summary className="inline-flex h-9.5 cursor-pointer list-none items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 text-sm font-medium hover:bg-[var(--color-neutral-bg)]">
            <Filter className="size-4" aria-hidden /> More filters
            {moreFilters ? <span className="rounded-full bg-[var(--color-primary)] px-1.5 text-[11px] text-[var(--color-on-primary)]">{moreFilters}</span> : null}
          </summary>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Select name="team" defaultValue={f.team} aria-label="Team">
              <option value="">Any team</option>
              {options.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <Select name="service" defaultValue={f.service} aria-label="Service">
              <option value="">Any service</option>
              {options.services.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <Select name="currency" defaultValue={f.currency} aria-label="Currency">
              <option value="">Any currency</option>
              {options.currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
            <Input name="country" defaultValue={f.country} placeholder="Country code, e.g. AE" maxLength={2} aria-label="Client country" title={f.country ? (countryName(f.country) ?? "") : undefined} />
            <Select name="kind" defaultValue={f.kind} aria-label="Invoice type">
              <option value="">Any type</option>
              {DUE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DUE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
            <label className={`flex items-center gap-1.5 text-xs ${mutedText}`}>
              Due from <Input type="date" name="from" defaultValue={f.from} aria-label="Due from" />
            </label>
            <label className={`flex items-center gap-1.5 text-xs ${mutedText}`}>
              to <Input type="date" name="to" defaultValue={f.to} aria-label="Due until" />
            </label>
          </div>
        </details>
      </AutoSubmitForm>

      {rows.length === 0 ? (
        <EmptyState>{f.view === "open" ? "Nothing open. Every invoice is settled, waived or cancelled." : "No invoice matches."}</EmptyState>
      ) : (
        <>
          <BillingTable rows={rows} columns={prefs.columns} labels={labels} canPay={caps.canRecordPayments} canDelete={caps.canDelete} canMessage={canSendMessages} today={today} />
          <Pagination
            page={f.page}
            pageSize={f.pageSize}
            total={total}
            buildHref={(p) => query(f, { page: p })}
            pageSizeOptions={[...BILLING_PAGE_SIZES]}
            buildPageSizeHref={(size) => query(f, { pageSize: size, page: 1 })}
          />
        </>
      )}
      <p className={`text-xs ${mutedText}`}>Pay selected records a separate allocation per invoice · Payment due ≠ subscription expiry · Nothing here is sent to a client.</p>

      <Card className="p-6">
        <SectionHeader title="Currencies" />
        <CurrencyPanel currencies={currencies.map((c) => ({ code: c.code, enabled: c.enabled }))} canEdit={canManage} />
      </Card>
    </div>
  );
}
