import { LARGE_LIST_PAGE_SIZES, pickPageSize } from "@/lib/listPageSizes";
import { Banknote, ReceiptText, Search, Undo2, Wallet } from "lucide-react";
import { pageAccess } from "@/server/authorize";
import { listPayments } from "@/server/clientBilling";
import { clientViewerCaps } from "@/server/clientModule";
import { Alert, ButtonLink, EmptyState, HelpButton, HelpSection, Input, Pagination, Select, ViewOnlyNotice } from "@/components/ui";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "@support-automation/shared";
import { money } from "@/lib/clientDisplay";
import { AutoSubmitForm } from "../AutoSubmitForm";
import { ChipTabs, KpiCard, mutedText, surface, type Chip } from "../ModuleKit";
import { PaymentsTable } from "./PaymentsTable";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const PAGE_SIZES = [...LARGE_LIST_PAGE_SIZES];
const SHOWS = [
  ["active", "Recorded"],
  ["reversed", "Reversed"],
  ["all", "All"],
] as const;

/**
 * Payments & Receipts (CLIENTS_V3.md §4): every payment recorded by hand, the invoices it settled, and
 * reversals. Collected totals are per currency, never added together. A mistake is reversed (kept, with
 * a reason); deleting is for an Administrator, or someone an Administrator gave the delete permission.
 */
export default async function PaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const { session, canManage } = await pageAccess("clients.view_billing", "clients.edit_billing");
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const show = (SHOWS.find(([k]) => k === one(params.show))?.[0] ?? "active") as "active" | "reversed" | "all";
  const q = one(params.q).trim().slice(0, 100);
  const method = (PAYMENT_METHODS as readonly string[]).includes(one(params.method)) ? one(params.method) : "";
  const currency = /^[A-Z]{3}$/.test(one(params.currency)) ? one(params.currency) : "";
  const from = /^\d{4}-\d{2}-\d{2}$/.test(one(params.from)) ? one(params.from) : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(one(params.to)) ? one(params.to) : "";
  const page = Math.max(1, Number(one(params.page)) || 1);
  const pageSize = pickPageSize(one(params.pageSize), 25, PAGE_SIZES);
  const caps = await clientViewerCaps(session);
  if (!caps.settings.payments) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Payments &amp; Receipts</h1>
        <Alert tone="info">Payments are switched off for this project (they need Billing on). A Client Module manager can turn them on under Settings → Client Module.</Alert>
      </div>
    );
  }
  const data = await listPayments({ q, show, page, pageSize, method, currency, from, to });
  const href = (patch: Record<string, string | number | undefined>) => {
    const out = new URLSearchParams();
    const next = { show, q, method, currency, from, to, pageSize: pageSize === 25 ? undefined : pageSize, page: undefined as number | undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== "" && !(k === "show" && v === "active") && !(k === "page" && v === 1)) out.set(k, String(v));
    const s = out.toString();
    return `/clients/payments${s ? `?${s}` : ""}`;
  };
  const chips: Chip[] = SHOWS.map(([k, label]) => ({ key: k, label, count: data.counts[k], href: href({ show: k }), active: show === k, tone: k === "reversed" ? "warning" : undefined }));
  const narrowed = Boolean(q || method || currency || from || to);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] sm:text-[28px]">Payments &amp; Receipts</h1>
          <p className={`mt-1 text-sm ${mutedText}`}>Money received, recorded by hand, and the invoices each payment settled.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {caps.canRecordPayments ? (
            <ButtonLink href="/clients/dues?view=open" variant="primary" size="md" title="Pick the invoices on the Billing List, then Pay selected">
              <Wallet className="size-4" aria-hidden /> Record payment
            </ButtonLink>
          ) : null}
          <HelpButton moduleTitle="Payments & Receipts">
            <HelpSection title="Recording a payment">
              <p>Payments are recorded against invoices: open the Billing List, tick the invoices the money is for and press Pay selected — or use Record payment on a client&apos;s profile. One receipt is issued per client and currency.</p>
            </HelpSection>
            <HelpSection title="A mistake">
              <p>Reverse it (with a reason): the receipt stays on this list, marked reversed, and the invoices it settled are open again for that amount. Delete removes a payment that should never have been recorded; only an Administrator, or someone an Administrator gave the delete permission, can.</p>
            </HelpSection>
            <HelpSection title="Totals">
              <p>Collected figures are per currency and leave out reversed payments. Nothing is ever converted between currencies.</p>
            </HelpSection>
          </HelpButton>
        </div>
      </div>
      {canManage ? null : <ViewOnlyNotice />}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard icon={ReceiptText} accent="indigo" label="Receipts" value={data.counts.active.toLocaleString()} hint={narrowed ? "Matching your filters" : "Recorded, not reversed"} href={href({ show: "active" })} />
        <KpiCard
          icon={Banknote}
          accent="green"
          toneValue
          label="Collected"
          value={data.collected.length ? data.collected.map((c) => money(c.amount, c.currency)).join(" · ") : "Nothing yet"}
          hint={data.collected.length > 1 ? "Per currency, never converted" : "Reversals excluded"}
        />
        <KpiCard icon={Undo2} accent={data.counts.reversed ? "amber" : "slate"} label="Reversed" value={data.counts.reversed.toLocaleString()} hint="Kept with their reason" href={href({ show: "reversed" })} />
        <KpiCard icon={Wallet} accent="blue" label="Open invoices" value="Billing List" hint="Record payments against invoices" href="/clients/dues?view=open" />
      </div>

      <ChipTabs label="Payment views" chips={chips} />

      <AutoSubmitForm className={`${surface} flex flex-wrap items-end gap-2 p-3`}>
        <input type="hidden" name="show" value={show} />
        {pageSize !== 25 ? <input type="hidden" name="pageSize" value={pageSize} /> : null}
        <label className="relative min-w-0 flex-1 basis-full sm:basis-[260px]">
          <Search className={`pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 ${mutedText}`} aria-hidden />
          <Input name="q" defaultValue={q} placeholder="Receipt, reference, client, invoice…" className="pl-9" aria-label="Search payments" />
        </label>
        <Select name="method" defaultValue={method} className="sm:w-48" aria-label="Method">
          <option value="">All methods</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {PAYMENT_METHOD_LABELS[m].split(" (")[0]}
            </option>
          ))}
        </Select>
        <Select name="currency" defaultValue={currency} className="sm:w-36" aria-label="Currency">
          <option value="">All currencies</option>
          {data.currencies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <label className={`flex items-center gap-1.5 text-xs ${mutedText}`}>
          From
          <Input type="date" name="from" defaultValue={from} className="w-40" aria-label="Received from" />
        </label>
        <label className={`flex items-center gap-1.5 text-xs ${mutedText}`}>
          To
          <Input type="date" name="to" defaultValue={to} className="w-40" aria-label="Received to" />
        </label>
        <button type="submit" className="h-9.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-sm font-medium hover:bg-[var(--color-neutral-bg)]">
          Apply
        </button>
        {narrowed ? (
          <a href="?" className={`self-center text-xs underline ${mutedText}`}>
            Clear filters
          </a>
        ) : null}
      </AutoSubmitForm>

      {data.payments.length === 0 ? (
        <EmptyState>No payment recorded{narrowed ? " matches these filters" : " yet"}.</EmptyState>
      ) : (
        <div>
          <PaymentsTable payments={data.payments} canReverse={caps.canRecordPayments} canDelete={caps.canDelete} />
          <Pagination page={page} pageSize={pageSize} total={data.total} buildHref={(p) => href({ page: p })} pageSizeOptions={PAGE_SIZES} buildPageSizeHref={(size) => href({ pageSize: size === 25 ? undefined : size })} />
        </div>
      )}
    </div>
  );
}
