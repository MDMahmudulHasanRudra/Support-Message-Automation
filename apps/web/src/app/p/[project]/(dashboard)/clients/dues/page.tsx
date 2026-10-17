import { pageAccess } from "@/server/authorize";
import { BILLING_PAGE_SIZES, BILLING_VIEWS, getBillingFilterOptions, getBillingKpis, listBillingCurrencies, listBillingRegister, parseBillingFilters, type BillingFilters } from "@/server/clientBilling";
import { clientViewerCaps, columnNeeds, getColumnPreference } from "@/server/clientModule";
import { loadClientFormOptions } from "@/server/clients";
import { Alert, Button, Card, EmptyState, HelpButton, HelpSection, Input, PageHeader, Pagination, SectionHeader, Select, StatTile, ViewOnlyNotice } from "@/components/ui";
import Link from "@/components/ProjectLink";
import { allowedColumns, DUE_KINDS, DUE_KIND_LABELS } from "@support-automation/shared";
import { countryName } from "@/lib/clientPhone";
import { money } from "@/lib/clientDisplay";
import { CurrencyPanel } from "./CurrencyPanel";
import { BillingTable, CreateBillButton } from "./BillingTable";
import { ColumnChooser } from "../ColumnChooser";

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
  const f = parseBillingFilters(await searchParams);
  const caps = await clientViewerCaps(session);
  if (!caps.settings.billing) {
    return (
      <div>
        <PageHeader title="Billing List" />
        <Alert tone="info">Billing is switched off for this project. A Client Module manager can turn it on under Settings → Client Module.</Alert>
      </div>
    );
  }
  const [{ rows, total, today }, kpis, options, currencies, prefs, roster] = await Promise.all([
    listBillingRegister(f),
    getBillingKpis(),
    getBillingFilterOptions(),
    listBillingCurrencies(),
    getColumnPreference(session.userId, "billing", caps),
    loadClientFormOptions(),
  ]);
  const available = allowedColumns("billing", columnNeeds(caps));
  const labels = Object.fromEntries(available.map((c) => [c.key, c.label]));
  const enabled = currencies.filter((c) => c.enabled).map((c) => c.code);
  const sellers = roster.roster.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name, teamName: m.teamName }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Billing List"
        description="One glance: who was billed, for what service, by which teammate, due when, what was collected and what remains."
        actions={
          <>
            {canManage ? <CreateBillButton currencies={enabled} invoice={{ sellers, today }} /> : null}
            <HelpButton moduleTitle="Billing List">
              <HelpSection title="Amounts">
                <p>Every amount is shown in its own currency. Nothing is converted or added across currencies, so the Outstanding tile has one line per currency.</p>
              </HelpSection>
              <HelpSection title="Recording payments">
                <p>Tick the invoices a client paid and press Pay selected. Each invoice takes its own amount (part payments are fine, more than what is left is not). One payment is recorded per client and currency; a mistake is reversed on Payments &amp; Receipts, never edited.</p>
              </HelpSection>
              <HelpSection title="Payment due is not subscription expiry">
                <p>The due date here is when money is owed. When a service expires is on the Subscriptions page; an expired service that was paid owes nothing.</p>
              </HelpSection>
            </HelpButton>
          </>
        }
      />
      {canManage ? null : <ViewOnlyNotice />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Invoice records" value={kpis.invoices.toLocaleString()} hint="Every invoice and due, except cancelled" href="/clients/dues?view=all" />
        <StatTile label="Open invoices" value={kpis.openCount.toLocaleString()} hint="Still expecting money" tone={kpis.openCount ? "warning" : "neutral"} href="/clients/dues" />
        <StatTile label="Overdue" value={kpis.overdueCount.toLocaleString()} hint="Past their due date" tone={kpis.overdueCount ? "danger" : "neutral"} href="/clients/dues?view=overdue" />
        <StatTile
          label="Outstanding"
          value={kpis.outstanding.length ? <span className="text-lg">{kpis.outstanding.map((o) => money(o.remaining, o.currency)).join(" · ")}</span> : "Nothing"}
          hint={`${kpis.outstanding.length} currency ledger(s) · never merged`}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {BILLING_VIEWS.map((v) => (
          <Link
            key={v}
            href={query(f, { view: v, page: 1 })}
            aria-current={f.view === v ? "true" : undefined}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${f.view === v ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] hover:bg-[var(--color-border)]"}`}
          >
            {VIEW_LABELS[v]}
          </Link>
        ))}
      </div>

      <form method="GET" className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-xs)]">
        <input type="hidden" name="view" value={f.view} />
        <div className="flex flex-wrap items-center gap-2">
          <Input name="q" defaultValue={f.q} placeholder="Search invoice, client, seller, reference…" className="min-w-0 flex-1 sm:min-w-[260px]" aria-label="Search invoices" />
          <Select name="sort" defaultValue={f.sort} className="sm:w-40" aria-label="Sort by">
            <option value="due">Sort: due date</option>
            <option value="issued">Sort: issued</option>
            <option value="invoice">Sort: invoice no.</option>
            <option value="client">Sort: client</option>
            <option value="amount">Sort: amount</option>
          </Select>
          <Select name="dir" defaultValue={f.dir} className="sm:w-32" aria-label="Direction">
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </Select>
          <Button type="submit" size="sm">
            Apply
          </Button>
          <ColumnChooser list="billing" available={available.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))} selected={prefs.columns} />
          <span className="text-xs text-[color:var(--color-muted-foreground)]">{total.toLocaleString()} results</span>
        </div>
        <details open={Boolean(f.seller || f.team || f.service || f.currency || f.country || f.kind || f.from || f.to)}>
          <summary className="cursor-pointer text-xs font-medium text-[color:var(--color-muted-foreground)]">More filters</summary>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Select name="seller" defaultValue={f.seller} aria-label="Sold by">
              <option value="">Any seller</option>
              {options.sellers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
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
            <Input type="date" name="from" defaultValue={f.from} aria-label="Due from" />
            <Input type="date" name="to" defaultValue={f.to} aria-label="Due until" />
          </div>
        </details>
      </form>

      {rows.length === 0 ? (
        <EmptyState>{f.view === "open" ? "Nothing open. Every invoice is settled, waived or cancelled." : "No invoice matches."}</EmptyState>
      ) : (
        <>
          <BillingTable rows={rows} columns={prefs.columns} labels={labels} canPay={caps.canRecordPayments} today={today} />
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
      <p className="text-xs text-[color:var(--color-muted-foreground)]">Pay selected records a separate allocation per invoice · Payment due ≠ subscription expiry · Nothing here is sent to a client.</p>

      <Card className="p-6">
        <SectionHeader title="Currencies" />
        <CurrencyPanel currencies={currencies.map((c) => ({ code: c.code, enabled: c.enabled }))} canEdit={canManage} />
      </Card>
    </div>
  );
}
