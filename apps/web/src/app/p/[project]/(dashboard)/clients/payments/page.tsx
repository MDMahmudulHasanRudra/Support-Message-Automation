import { pageAccess } from "@/server/authorize";
import { listPayments } from "@/server/clientBilling";
import { clientViewerCaps } from "@/server/clientModule";
import { Alert, Button, EmptyState, Input, PageHeader, Pagination, StatTile, ViewOnlyNotice } from "@/components/ui";
import Link from "@/components/ProjectLink";
import { money } from "@/lib/clientDisplay";
import { PaymentsTable } from "./PaymentsTable";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const PAGE_SIZE = 50;
const SHOWS = [
  ["active", "Recorded"],
  ["reversed", "Reversed"],
  ["all", "All"],
] as const;

/**
 * Payments & Receipts (CLIENTS_V3.md §4): every payment recorded by hand, the invoices it settled, and
 * reversals. Collected totals are per currency, never added together.
 */
export default async function PaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const { session, canManage } = await pageAccess("clients.view_billing", "clients.edit_billing");
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const show = (SHOWS.find(([k]) => k === one(params.show))?.[0] ?? "active") as "active" | "reversed" | "all";
  const q = one(params.q).trim().slice(0, 100);
  const page = Math.max(1, Number(one(params.page)) || 1);
  const caps = await clientViewerCaps(session);
  if (!caps.settings.payments) {
    return (
      <div>
        <PageHeader title="Payments & Receipts" />
        <Alert tone="info">Payments are switched off for this project (they need Billing on). A Client Module manager can turn them on under Settings → Client Module.</Alert>
      </div>
    );
  }
  const data = await listPayments({ q, show, page, pageSize: PAGE_SIZE });
  const href = (patch: Record<string, string | number | undefined>) => {
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries<string | number | undefined>({ show, q, ...patch })) if (v !== undefined && v !== "" && !(k === "show" && v === "active") && !(k === "page" && v === 1)) out.set(k, String(v));
    const s = out.toString();
    return `/clients/payments${s ? `?${s}` : ""}`;
  };
  return (
    <div className="space-y-5">
      <PageHeader title="Payments & Receipts" description="Money received, recorded by hand, and which invoices it settled. Record payments from the Billing List or a client's page." />
      {canManage ? null : <ViewOnlyNotice />}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Receipts" value={data.total.toLocaleString()} hint={q ? "Matching your search" : "In this view"} />
        {data.collected.slice(0, 3).map((c) => (
          <StatTile key={c.currency} label={`Collected · ${c.currency}`} value={money(c.amount, c.currency)} hint={`${c.count} receipt(s), reversals excluded`} tone="success" />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {SHOWS.map(([k, label]) => (
          <Link
            key={k}
            href={href({ show: k, page: undefined })}
            aria-current={show === k ? "true" : undefined}
            className={`rounded-full px-3 py-1 text-xs ${show === k ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] hover:bg-[var(--color-border)]"}`}
          >
            {label}
          </Link>
        ))}
        <form method="GET" className="ml-auto flex gap-2">
          <input type="hidden" name="show" value={show} />
          <Input name="q" defaultValue={q} placeholder="Receipt, reference, client, invoice…" className="sm:w-72" aria-label="Search payments" />
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>
      </div>
      {data.payments.length === 0 ? (
        <EmptyState>No payment recorded{q ? " matches" : " yet"}.</EmptyState>
      ) : (
        <>
          <PaymentsTable payments={data.payments} canReverse={caps.canRecordPayments} />
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} buildHref={(p) => href({ page: p })} />
        </>
      )}
    </div>
  );
}
