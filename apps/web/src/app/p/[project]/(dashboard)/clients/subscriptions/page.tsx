import { pageAccess } from "@/server/authorize";
import { clientFilterContext, clientViewerCaps } from "@/server/clientModule";
import { listClients, loadClientFormOptions } from "@/server/clients";
import { Alert, Button, EmptyState, HelpButton, HelpSection, Input, PageHeader, Pagination, ViewOnlyNotice } from "@/components/ui";
import Link from "@/components/ProjectLink";
import { prisma } from "@/server/db";
import { buildClientWhere, EMPTY_CLIENT_FILTERS, type ClientFilters } from "@/lib/clientFilters";
import { SubscriptionTable } from "./SubscriptionTable";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The tabs, each one state of the client's CURRENT term (the same rule as the All Clients filter). */
const VIEWS = [
  { key: "active", label: "Active", state: "ACTIVE", hint: "Running, with more than the renewal window left." },
  { key: "renew", label: "Renew soon", state: "EXPIRING", hint: "Paid terms inside the renewal window: talk to them before they lapse." },
  { key: "trials", label: "Trials & demos", state: "TRIAL", hint: "Running trials and demos — a chance to convert." },
  { key: "expired", label: "Expired", state: "EXPIRED", hint: "The latest term has ended and was not renewed. Expired is not owed: billing is separate." },
  { key: "scheduled", label: "Starts later", state: "SCHEDULED", hint: "A first term that has not started yet." },
  { key: "paused", label: "Paused", state: "PAUSED", hint: "On hold by staff." },
] as const;

const PAGE_SIZE = 50;

/**
 * Subscriptions (CLIENTS_V3.md §3): every client's current term by state — Active, Renew soon, Trials,
 * Expired — soonest expiry first, with Renew one click away. Reads through the same register query
 * and state rule as All Clients, so a count here and a filter there always agree.
 */
export default async function SubscriptionsPage({ searchParams }: { searchParams: SearchParams }) {
  const { session, canManage } = await pageAccess("clients.view", "clients.manage_subscriptions");
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const view = VIEWS.find((v) => v.key === one(params.view)) ?? VIEWS[0];
  const q = one(params.q).slice(0, 120);
  const page = Math.max(1, Number(one(params.page)) || 1);
  const caps = await clientViewerCaps(session);
  if (!caps.settings.subscriptions) {
    return (
      <div>
        <PageHeader title="Subscriptions" />
        <Alert tone="info">Subscriptions are switched off for this project. A Client Module manager can turn them on under Settings → Client Module.</Alert>
      </div>
    );
  }
  const ctx = await clientFilterContext(session);
  const filters: ClientFilters = { ...EMPTY_CLIENT_FILTERS, q, state: view.state };
  const [data, counts, options, currencies] = await Promise.all([
    listClients({ filters, sort: "expiry", dir: view.key === "expired" ? "desc" : "asc", page, pageSize: PAGE_SIZE, ctx }),
    Promise.all(VIEWS.map((v) => prisma.client.count({ where: buildClientWhere({ ...EMPTY_CLIENT_FILTERS, state: v.state }, ctx) }))),
    loadClientFormOptions(),
    prisma.clientBillingCurrency.findMany({ where: { enabled: true }, select: { code: true }, orderBy: { code: "asc" } }),
  ]);
  const href = (patch: Record<string, string | number | undefined>) => {
    const out = new URLSearchParams();
    const next = { view: view.key, q, page: undefined as number | undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== "" && !(k === "view" && v === "active") && !(k === "page" && v === 1)) out.set(k, String(v));
    const s = out.toString();
    return `/clients/subscriptions${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Subscriptions"
        description={`Every client's current plan, by state. "Renew soon" means within ${ctx.renewalWindowDays} days (Settings → Client Module).`}
        actions={
          <HelpButton moduleTitle="Subscriptions">
            <HelpSection title="Renewing">
              <p>Renew adds a new term that starts where the current one ends — or today, when it has already lapsed — so no paid day is lost or charged twice. The old term stays in the client&apos;s history, and the client is marked as returning.</p>
            </HelpSection>
            <HelpSection title="Expiry is not a debt">
              <p>An expired subscription that was paid owes nothing. Money is on the Billing List; a renewal can raise its invoice in the same step if you have the billing permission.</p>
            </HelpSection>
          </HelpButton>
        }
      />
      {canManage ? null : <ViewOnlyNotice />}
      <div className="flex flex-wrap gap-1.5">
        {VIEWS.map((v, i) => (
          <Link
            key={v.key}
            href={href({ view: v.key, page: undefined })}
            aria-current={v.key === view.key ? "true" : undefined}
            className={`rounded-full px-3 py-1 text-xs tabular transition-colors ${v.key === view.key ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] hover:bg-[var(--color-border)]"}`}
          >
            {v.label} ({counts[i]!.toLocaleString()})
          </Link>
        ))}
      </div>
      <p className="text-sm text-[color:var(--color-muted-foreground)]">{view.hint}</p>
      <form method="GET" className="flex flex-wrap gap-2">
        <input type="hidden" name="view" value={view.key} />
        <Input name="q" defaultValue={q} placeholder="Search client, service, seller…" className="min-w-0 flex-1 sm:max-w-sm" aria-label="Search subscriptions" />
        <Button type="submit" size="sm">
          Search
        </Button>
      </form>
      {data.clients.length === 0 ? (
        <EmptyState>Nothing here.</EmptyState>
      ) : (
        <>
          <SubscriptionTable
            rows={data.clients}
            roster={options.roster}
            today={ctx.today}
            currencies={currencies.map((c) => c.code)}
            canRenew={caps.canManageSubscriptions}
            canInvoice={caps.canEditBilling}
          />
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} buildHref={(p) => href({ page: p })} />
        </>
      )}
    </div>
  );
}
