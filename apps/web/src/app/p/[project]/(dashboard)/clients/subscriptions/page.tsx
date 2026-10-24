import { LARGE_LIST_PAGE_SIZES, pickPageSize } from "@/lib/listPageSizes";
import { CalendarCheck2, CalendarClock, CalendarX2, CirclePause, CirclePlay, FlaskConical, Plus, Search } from "lucide-react";
import { pageAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { clientFilterContext, clientViewerCaps } from "@/server/clientModule";
import { getRegisterFilterOptions, listClients, loadClientFormOptions } from "@/server/clients";
import { Alert, ButtonLink, EmptyState, HelpButton, HelpSection, Input, Pagination, Select, ViewOnlyNotice } from "@/components/ui";
import { prisma } from "@/server/db";
import { countryName } from "@/lib/clientPhone";
import { buildClientWhere, clientQueryString, EMPTY_CLIENT_FILTERS, type ClientFilters } from "@/lib/clientFilters";
import { AutoSubmitForm } from "../AutoSubmitForm";
import { ChipTabs, KpiCard, mutedText, surface, type Chip } from "../ModuleKit";
import { RowMenu } from "../RowMenu";
import { SubscriptionTable } from "./SubscriptionTable";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The views, each one state of the client's CURRENT term (the same rule as the All Clients filter). */
const VIEWS = [
  { key: "all", label: "All", state: "", hint: "Every client with a current subscription." },
  { key: "active", label: "Active", state: "ACTIVE", hint: "Running, with more than the renewal window left." },
  { key: "renew", label: "Renew soon", state: "EXPIRING", hint: "Paid terms inside the renewal window: talk to them before they lapse." },
  { key: "trials", label: "Trials & demos", state: "TRIAL", hint: "Running trials and demos — a chance to convert." },
  { key: "expired", label: "Expired", state: "EXPIRED", hint: "The latest term has ended and was not renewed. Expired is not owed: billing is separate." },
  { key: "scheduled", label: "Starts later", state: "SCHEDULED", hint: "A first term that has not started yet." },
  { key: "paused", label: "Paused", state: "PAUSED", hint: "On hold by staff." },
] as const;

const PAGE_SIZES = [...LARGE_LIST_PAGE_SIZES];
/** A client with a current term — what "a subscription" means on this page. */
const HAS_TERM = { currentSubscriptionId: { not: null } } as const;

/**
 * Subscriptions (CLIENTS_V3.md §3): every client's current term by state, soonest expiry first, with
 * Renew, Pause and (for an Administrator) Delete one click away. Reads through the same register query
 * and state rule as All Clients, so a count here and a filter there always agree.
 */
export default async function SubscriptionsPage({ searchParams }: { searchParams: SearchParams }) {
  const { session, canManage } = await pageAccess("clients.view", "clients.manage_subscriptions");
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const view = VIEWS.find((v) => v.key === one(params.view)) ?? VIEWS[0];
  const page = Math.max(1, Number(one(params.page)) || 1);
  const pageSize = pickPageSize(one(params.pageSize), 25, PAGE_SIZES);
  const caps = await clientViewerCaps(session);
  if (!caps.settings.subscriptions) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Subscriptions</h1>
        <Alert tone="info">Subscriptions are switched off for this project. A Client Module manager can turn them on under Settings → Client Module.</Alert>
      </div>
    );
  }
  const ctx = await clientFilterContext(session);
  const narrow: ClientFilters = {
    ...EMPTY_CLIENT_FILTERS,
    q: one(params.q).slice(0, 120),
    service: one(params.service).slice(0, 120),
    seller: /^[A-Za-z0-9_-]{1,60}$/.test(one(params.seller)) ? one(params.seller) : "",
    team: /^[A-Za-z0-9_-]{1,60}$/.test(one(params.team)) ? one(params.team) : "",
    country: /^[A-Z]{2}$/.test(one(params.country)) ? one(params.country) : "",
  };
  const filters: ClientFilters = { ...narrow, state: view.state };
  const count = (state: string) => prisma.client.count({ where: { AND: [buildClientWhere({ ...EMPTY_CLIENT_FILTERS, state }, ctx), HAS_TERM] } });
  const [data, counts, options, filterOptions, currencies, canExport] = await Promise.all([
    listClients({ filters, sort: "expiry", dir: view.key === "expired" ? "desc" : "asc", page, pageSize, ctx, extraWhere: HAS_TERM }),
    Promise.all(VIEWS.map((v) => count(v.state))),
    loadClientFormOptions(),
    getRegisterFilterOptions(),
    prisma.clientBillingCurrency.findMany({ where: { enabled: true }, select: { code: true }, orderBy: { code: "asc" } }),
    hasPermission(session, "clients.export"),
  ]);
  const countOf = (key: string) => counts[VIEWS.findIndex((v) => v.key === key)] ?? 0;
  const href = (patch: Record<string, string | number | undefined>) => {
    const out = new URLSearchParams();
    const next = { view: view.key, ...narrow, pageSize: pageSize === 25 ? undefined : pageSize, page: undefined as number | undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== "" && !(k === "view" && v === "all") && !(k === "page" && v === 1)) out.set(k, String(v));
    const s = out.toString();
    return `/clients/subscriptions${s ? `?${s}` : ""}`;
  };
  const chips: Chip[] = VIEWS.filter((v) => v.key !== "scheduled" || countOf("scheduled") > 0).map((v) => ({
    key: v.key,
    label: v.label,
    count: countOf(v.key),
    href: href({ view: v.key }),
    active: v.key === view.key,
    tone: v.key === "expired" ? "danger" : v.key === "renew" ? "warning" : undefined,
  }));
  const exportQuery = clientQueryString({ ...filters }, { format: "xlsx" });

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] sm:text-[28px]">Subscriptions</h1>
          <p className={`mt-1 text-sm ${mutedText}`}>Manage every client&apos;s subscription, trial, renewal and expiry. Keep clients active and never miss a renewal.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canExport ? (
            <RowMenu
              label="Export"
              buttonText="Export"
              items={[
                { label: "Excel — clients in this view", href: `/api/clients/export${exportQuery}` },
                { label: "CSV — same clients", href: `/api/clients/export${clientQueryString({ ...filters }, { format: "csv" })}` },
              ]}
            />
          ) : null}
          {caps.canManageSubscriptions ? (
            <ButtonLink href="/clients?state=NONE" variant="primary" size="md" title="Pick a client without a subscription, then add one on their profile">
              <Plus className="size-4" aria-hidden /> Add subscription
            </ButtonLink>
          ) : null}
          <HelpButton moduleTitle="Subscriptions">
            <HelpSection title="What a row is">
              <p>One row per client: their CURRENT term. Older terms are on the client&apos;s profile (Subscriptions tab). &quot;Renew soon&quot; means within {ctx.renewalWindowDays} days (Settings → Client Module).</p>
            </HelpSection>
            <HelpSection title="Renewing">
              <p>Renew adds a new term that starts where the current one ends — or today, when it has already lapsed — so no paid day is lost or charged twice. The old term stays in the history, and the client is marked as returning.</p>
            </HelpSection>
            <HelpSection title="Expiry is not a debt">
              <p>An expired subscription that was paid owes nothing. Money is on the Billing List; a renewal can raise its invoice in the same step if you have the billing permission.</p>
            </HelpSection>
            <HelpSection title="Deleting">
              <p>Delete removes a term that should never have been recorded. Only an Administrator, or someone an Administrator gave the delete permission, sees it. To end a real subscription, pause or cancel it on the client&apos;s profile instead — that keeps the history.</p>
            </HelpSection>
          </HelpButton>
        </div>
      </div>
      {canManage ? null : <ViewOnlyNotice />}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard icon={CalendarCheck2} accent="green" label="Subscriptions" value={countOf("all").toLocaleString()} hint="Clients with a current term" href={href({ view: "all" })} />
        <KpiCard icon={CirclePlay} accent="green" toneValue label="Active" value={countOf("active").toLocaleString()} hint="Currently running" href={href({ view: "active" })} />
        <KpiCard icon={CalendarClock} accent="amber" toneValue label="Renew soon" value={countOf("renew").toLocaleString()} hint={`Within ${ctx.renewalWindowDays} days`} href={href({ view: "renew" })} />
        <KpiCard icon={CalendarX2} accent="red" toneValue label="Expired" value={countOf("expired").toLocaleString()} hint="Needs attention" href={href({ view: "expired" })} />
        <KpiCard icon={FlaskConical} accent="indigo" label="Trials & demos" value={countOf("trials").toLocaleString()} hint="Not converted yet" href={href({ view: "trials" })} />
        <KpiCard icon={CirclePause} accent="slate" label="Paused" value={countOf("paused").toLocaleString()} hint="On hold" href={href({ view: "paused" })} />
      </div>

      <ChipTabs label="Subscription views" chips={chips} />

      <AutoSubmitForm className={`${surface} flex flex-wrap items-center gap-2 p-3`}>
        <input type="hidden" name="view" value={view.key} />
        {pageSize !== 25 ? <input type="hidden" name="pageSize" value={pageSize} /> : null}
        <label className="relative min-w-0 flex-1 basis-full sm:basis-[280px]">
          <Search className={`pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 ${mutedText}`} aria-hidden />
          <Input name="q" defaultValue={narrow.q} placeholder="Search client name, phone, code, service, seller…" className="pl-9" aria-label="Search subscriptions" />
        </label>
        <Select name="service" defaultValue={narrow.service} className="sm:w-44" aria-label="Service">
          <option value="">All services</option>
          {filterOptions.services.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select name="seller" defaultValue={narrow.seller} className="sm:w-44" aria-label="Sold by">
          <option value="">All sellers</option>
          {data.members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
        <Select name="team" defaultValue={narrow.team} className="sm:w-40" aria-label="Team">
          <option value="">All teams</option>
          {filterOptions.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select name="country" defaultValue={narrow.country} className="sm:w-44" aria-label="Country">
          <option value="">All countries</option>
          {filterOptions.countries
            .map((c) => ({ c, n: countryName(c) ?? c }))
            .sort((a, b) => a.n.localeCompare(b.n))
            .map(({ c, n }) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
        </Select>
      </AutoSubmitForm>
      <p className={`-mt-2 text-sm ${mutedText}`}>{view.hint}</p>

      {data.clients.length === 0 ? (
        <EmptyState>{Object.values(narrow).some(Boolean) ? "No subscription matches these filters." : "Nothing here."}</EmptyState>
      ) : (
        <div>
          <SubscriptionTable
            rows={data.clients}
            roster={options.roster}
            today={ctx.today}
            currencies={currencies.map((c) => c.code)}
            canRenew={caps.canManageSubscriptions}
            canInvoice={caps.canEditBilling}
            canDelete={caps.canDelete}
          />
          <Pagination page={page} pageSize={pageSize} total={data.total} buildHref={(p) => href({ page: p })} pageSizeOptions={PAGE_SIZES} buildPageSizeHref={(size) => href({ pageSize: size === 25 ? undefined : size })} />
        </div>
      )}
    </div>
  );
}
