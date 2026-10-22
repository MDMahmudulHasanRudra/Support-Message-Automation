/* eslint-disable react/no-unescaped-entities -- long-form Help prose reads better with real apostrophes */

import { AlarmClock, ArrowUp, CircleDollarSign, Download, Filter, MessageCircle, Plus, Repeat, Search, Upload, Users } from "lucide-react";
import { pageAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { getClientRegisterKpis, getRegisterFilterOptions, listClients, resolvePageSize } from "@/server/clients";
import { clientFilterContext, clientViewerCaps, columnNeeds, getColumnPreference } from "@/server/clientModule";
import { buildClientWhere, CLIENT_PAGE_SIZES, EMPTY_CLIENT_FILTERS, MAX_CLIENT_BULK, clientQueryString, parseClientFilters, parseClientSort, type ClientFilters } from "@/lib/clientFilters";
import { countryName, countryOptions } from "@/lib/clientPhone";
import { loadClientFormOptions } from "@/server/clients";
import { prisma } from "@/server/db";
import { ActiveFilters, ButtonLink, EmptyState, HelpButton, HelpSection, Input, NoFilterResults, Pagination, Select, ViewOnlyNotice, type ActiveFilter } from "@/components/ui";
import {
  allowedColumns,
  CLIENT_CHANNEL_KINDS,
  CLIENT_CHANNEL_LABELS,
  CLIENT_STATUS_LABELS,
  SUBSCRIPTION_STATES,
  SUBSCRIPTION_STATE_LABELS,
} from "@support-automation/shared";
import { money } from "@/lib/clientDisplay";
import { ClientsTable, type RegisterCaps } from "./ClientsTable";
import { ColumnChooser } from "./ColumnChooser";
import { AutoSubmitForm } from "./AutoSubmitForm";
import { ChipTabs, KpiCard, mutedText, surface, type Chip } from "./ModuleKit";
import { RowMenu } from "./RowMenu";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const EXPIRY_LABELS: Record<string, string> = { "7": "Expiring in 7 days", "30": "Expiring in 30 days", "90": "Expiring in 90 days", expired: "Already expired" };
const ORDERS: Array<{ value: string; label: string; needs?: "subscriptions" }> = [
  { value: "name:asc", label: "Name (A – Z)" },
  { value: "name:desc", label: "Name (Z – A)" },
  { value: "expiry:asc", label: "Expiry (soonest first)", needs: "subscriptions" },
  { value: "expiry:desc", label: "Expiry (latest first)", needs: "subscriptions" },
  { value: "created:desc", label: "Newest first" },
  { value: "created:asc", label: "Oldest first" },
  { value: "updated:desc", label: "Recently updated" },
  { value: "contact:desc", label: "Recent contact" },
  { value: "country:asc", label: "Country" },
  { value: "code:asc", label: "Client ID" },
];

/**
 * All Clients — the 360° register (CLIENTS_V3.md §5). Identity, country, phone, current plan and its
 * expiry, subscription state, what is outstanding (billing viewers only), who sold it and the linked
 * WhatsApp group, with each person's own column choice. Filtering, sorting and paging all happen on
 * the server; the browser only ever holds one page.
 */
export default async function ClientsPage({ searchParams }: { searchParams: SearchParams }) {
  const { session, canManage } = await pageAccess("clients.view", "clients.update");
  const params = await searchParams;
  // The filter bar sends one "order" (sort + direction); links keep `sort`/`dir` as before.
  const order = typeof params.order === "string" ? params.order : "";
  const fromOrder = ORDERS.some((o) => o.value === order) ? { sort: order.split(":")[0], dir: order.split(":")[1] } : {};
  const filters = parseClientFilters(params);
  const { sort, dir } = parseClientSort({ ...params, ...fromOrder });
  const pageSize = resolvePageSize(typeof params.pageSize === "string" ? params.pageSize : undefined);
  const page = Math.max(1, Number(typeof params.page === "string" ? params.page : 1) || 1);

  const [caps, ctx] = await Promise.all([clientViewerCaps(session), clientFilterContext(session)]);
  const chipCount = (patch: Partial<ClientFilters>) => prisma.client.count({ where: buildClientWhere({ ...EMPTY_CLIENT_FILTERS, ...patch }, ctx) });
  const [data, kpis, options, columns, canArchive, canExport, canImport, chipCounts] = await Promise.all([
    listClients({ filters, sort, dir, page, pageSize, ctx }),
    getClientRegisterKpis(ctx),
    getRegisterFilterOptions(),
    getColumnPreference(session.userId, "clients", caps),
    hasPermission(session, "clients.archive"),
    hasPermission(session, "clients.export"),
    hasPermission(session, "clients.import"),
    Promise.all([
      chipCount({}),
      chipCount({ status: "ACTIVE" }),
      caps.subscriptions ? chipCount({ state: "EXPIRING" }) : 0,
      caps.subscriptions ? chipCount({ state: "TRIAL" }) : 0,
      caps.subscriptions ? chipCount({ state: "EXPIRED" }) : 0,
      caps.billing ? chipCount({ due: "overdue" }) : 0,
      chipCount({ status: "INACTIVE" }),
      chipCount({ status: "ARCHIVED" }),
    ]),
  ]);
  const available = allowedColumns("clients", columnNeeds(caps));
  const [roster, billingCurrencies] = await Promise.all([
    loadClientFormOptions(),
    prisma.clientBillingCurrency.findMany({ where: { enabled: true }, select: { code: true }, orderBy: { code: "asc" } }),
  ]);
  const bulkOptions = {
    teams: roster.allTeams.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name })),
    sellers: roster.roster.filter((m) => m.active).map((m) => ({ id: m.id, name: m.teamName ? `${m.name} · ${m.teamName}` : m.name })),
    countries: countryOptions().map((c) => ({ code: c.code, name: c.name })),
    currencies: [...new Set([...billingCurrencies.map((c) => c.code), ...options.currencies])].sort(),
  };
  const columnLabels = Object.fromEntries(available.map((c) => [c.key, c.label]));

  const keep = { sort: sort === "name" && dir === "asc" ? undefined : sort, dir: dir === "asc" ? undefined : dir, pageSize: pageSize === 50 ? undefined : pageSize };
  const href = (f = filters, extra: Record<string, string | number | undefined> = {}) => `/clients${clientQueryString(f, { ...keep, ...extra })}`;

  // The view chips: the client's status, its current term, or an overdue invoice — one at a time.
  const [allCount, activeCount, renewCount, trialCount, expiredCount, overdueCount, inactiveCount, archivedCount] = chipCounts;
  const chipDefs: Array<{ key: string; label: string; patch: Pick<ClientFilters, "status" | "state" | "due">; count: number; show: boolean; tone?: Chip["tone"] }> = [
    { key: "all", label: "All", patch: { status: "", state: "", due: "" }, count: allCount, show: true },
    { key: "active", label: "Active", patch: { status: "ACTIVE", state: "", due: "" }, count: activeCount, show: true },
    { key: "renew", label: "Renew soon", patch: { status: "", state: "EXPIRING", due: "" }, count: renewCount, show: caps.subscriptions, tone: "warning" },
    { key: "trial", label: "Trial", patch: { status: "", state: "TRIAL", due: "" }, count: trialCount, show: caps.subscriptions },
    { key: "expired", label: "Expired", patch: { status: "", state: "EXPIRED", due: "" }, count: expiredCount, show: caps.subscriptions, tone: "danger" },
    { key: "overdue", label: "Overdue", patch: { status: "", state: "", due: "overdue" }, count: overdueCount, show: caps.billing, tone: "danger" },
    { key: "inactive", label: "Inactive", patch: { status: "INACTIVE", state: "", due: "" }, count: inactiveCount, show: true },
    { key: "archived", label: "Archived", patch: { status: "ARCHIVED", state: "", due: "" }, count: archivedCount, show: true },
  ];
  const chips: Chip[] = chipDefs
    .filter((c) => c.show)
    .map((c) => ({
      key: c.key,
      label: c.label,
      count: c.count,
      tone: c.tone,
      href: href({ ...filters, ...c.patch }, { page: undefined }),
      active: filters.status === c.patch.status && filters.state === c.patch.state && filters.due === c.patch.due,
    }));

  const activeFilters: ActiveFilter[] = [];
  const add = (label: string, value: string, patch: Partial<typeof filters>) => value && activeFilters.push({ label, value, removeHref: href({ ...filters, ...patch }) });
  add("Search", filters.q, { q: "" });
  add("Subscription", filters.state ? SUBSCRIPTION_STATE_LABELS[filters.state as keyof typeof SUBSCRIPTION_STATE_LABELS] : "", { state: "" });
  add("Expiry", EXPIRY_LABELS[filters.expiry] ?? "", { expiry: "" });
  add("Service", filters.service, { service: "" });
  add("Country", filters.country ? (countryName(filters.country) ?? filters.country) : "", { country: "" });
  add("Team", filters.team === "none" ? "No team" : options.teams.find((t) => t.id === filters.team)?.name ?? "", { team: "" });
  add("Sold by", filters.seller === "none" ? "Not recorded" : data.members.find((m) => m.id === filters.seller)?.name ?? (filters.seller ? "Former member" : ""), { seller: "" });
  add("WhatsApp group", filters.group === "linked" ? "Linked" : filters.group === "unlinked" ? "Not linked" : "", { group: "" });
  add("Currency", filters.currency, { currency: "" });
  add("Returning", filters.repeat ? "Returning customers" : "", { repeat: "" });
  if (caps.billing) add("Payment", filters.due === "open" ? "Has an open invoice" : filters.due === "overdue" ? "Has an overdue invoice" : "", { due: "" });
  add("Category", filters.category, { category: "" });
  add("Tag", filters.tag, { tag: "" });
  add("Channel", filters.channel ? CLIENT_CHANNEL_LABELS[filters.channel as keyof typeof CLIENT_CHANNEL_LABELS] : "", { channel: "" });
  add("Assigned", filters.assigned === "none" ? "Unassigned" : data.members.find((m) => m.id === filters.assigned)?.name ?? "", { assigned: "" });
  add("Status", filters.status === "ALL" ? "All, including archived" : filters.status ? CLIENT_STATUS_LABELS[filters.status as keyof typeof CLIENT_STATUS_LABELS] : "", { status: "" });
  const clearAll = href(EMPTY_CLIENT_FILTERS);

  const filterParams = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== ""));
  const totalAll = Object.values(data.counts).reduce((a, b) => a + b, 0);
  const registerCaps: RegisterCaps = {
    canUpdate: canManage,
    canArchive,
    canDelete: caps.canDelete,
    canExport,
    canManageSubscriptions: caps.canManageSubscriptions,
    canRecordPayments: caps.canRecordPayments,
    canLinkGroups: caps.canLinkGroups,
    canOpenChat: caps.canOpenChat,
  };
  const moreFilters = [filters.service, filters.team, filters.group, filters.currency, filters.repeat, filters.category, filters.tag, filters.channel, filters.assigned].filter(Boolean).length;
  const orderValue = `${sort}:${dir}`;
  const owed = kpis.outstanding ?? [];

  return (
    <div className="space-y-5">
      {/* ── Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] sm:text-[28px]">All Clients</h1>
          <p className={`mt-1 text-sm ${mutedText}`}>See every client with their identity, subscription, expiry, balance, seller and WhatsApp status in one place.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canImport ? (
            <ButtonLink href="/clients/import" size="md">
              <Upload className="size-4" aria-hidden /> Import clients
            </ButtonLink>
          ) : null}
          {canExport ? (
            <RowMenu
              label="Export"
              buttonText="Export"
              items={[
                { label: `Excel — ${data.total.toLocaleString()} matching`, icon: <Download className="size-4" aria-hidden />, href: `/api/clients/export${clientQueryString(filters, { format: "xlsx" })}` },
                { label: "CSV — same clients", icon: <Download className="size-4" aria-hidden />, href: `/api/clients/export${clientQueryString(filters, { format: "csv" })}` },
              ]}
            />
          ) : null}
          {caps.canCreate ? (
            <ButtonLink href="/clients/new" variant="primary" size="md">
              <Plus className="size-4" aria-hidden /> Add client
            </ButtonLink>
          ) : null}
          <HelpButton moduleTitle="All Clients">
            <HelpSection title="What this page is for">
              <p>Every client in one register. Each row shows who they are, where they are, what they bought, when it expires, what they still owe (if you may see billing), who sold it and which WhatsApp group you support them in. Open a row (the eye) for the full profile.</p>
            </HelpSection>
            <HelpSection title="The chips and filters">
              <p>The chips along the top are quick views — Active, Renew soon, Trial, Expired, Overdue, Inactive, Archived. The drop-downs apply as soon as you pick something; press Enter to search. "More filters" holds the rest. Every view is in the address bar, so you can bookmark or share it.</p>
            </HelpSection>
            <HelpSection title="Expiry is not a debt">
              <p>A subscription that expired after being paid owes nothing. "Outstanding" counts only invoices on the Billing List; the subscription badge only tells you whether to talk to them about renewing.</p>
            </HelpSection>
            <HelpSection title="Columns">
              <p>"Customize columns" picks and orders the columns you see. It is saved for you only, in this project, and "Reset to default" brings back the standard set.</p>
            </HelpSection>
            <HelpSection title="Selecting many, and deleting">
              <p>The header checkbox selects this page; "Select all N matching" widens it to every client matching your filters (up to {MAX_CLIENT_BULK.toLocaleString()}). Deleting is for an Administrator, or someone an Administrator gave the delete permission — everyone else archives, which can be undone.</p>
            </HelpSection>
          </HelpButton>
        </div>
      </div>

      {canManage ? null : <ViewOnlyNotice />}

      {/* ── KPIs */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard
          icon={Users}
          accent="indigo"
          label="Total clients"
          value={kpis.total.toLocaleString()}
          hint="All current (non-archived) records"
          href="/clients"
          badge={
            kpis.newThisMonth ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-success-fg)]">
                <ArrowUp className="size-3" aria-hidden /> +{kpis.newThisMonth} this month
              </span>
            ) : null
          }
        />
        {caps.groups ? <KpiCard icon={MessageCircle} accent="green" label="Linked WhatsApp groups" value={kpis.linkedGroups.toLocaleString()} hint="From your connected accounts" href="/clients?group=linked" /> : null}
        {caps.subscriptions ? (
          <KpiCard icon={AlarmClock} accent={kpis.renewalAttention ? "red" : "slate"} toneValue label="Renewal attention" value={kpis.renewalAttention.toLocaleString()} hint={`Expiring in ${ctx.renewalWindowDays} days or in the last 30 days`} href="/clients/subscriptions?view=renew" />
        ) : null}
        {kpis.outstanding ? (
          <KpiCard
            icon={CircleDollarSign}
            accent={owed.some((o) => o.overdue) ? "red" : "blue"}
            toneValue={owed.some((o) => o.overdue)}
            label="Outstanding balance"
            value={owed.length ? owed.map((o) => money(o.remaining, o.currency)).join(" · ") : "Nothing owed"}
            hint={owed.length > 1 ? "Per currency, never converted" : "Across all clients"}
            href="/clients/dues"
          />
        ) : null}
        {caps.subscriptions ? <KpiCard icon={Repeat} accent="blue" label="Returning customers" value={kpis.returning.toLocaleString()} hint="Renewed or bought again" href="/clients?repeat=1" /> : null}
      </div>

      <ChipTabs label="Client views" chips={chips} />

      {/* ── Filters: drop-downs apply themselves; Enter searches. */}
      <AutoSubmitForm className={`${surface} space-y-3 p-3`}>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-full sm:basis-[300px]">
            <Search className={`pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 ${mutedText}`} aria-hidden />
            <Input name="q" placeholder="Search name, phone, code, country, seller, service…" defaultValue={filters.q} className="pl-9" aria-label="Search clients" />
          </label>
          {caps.subscriptions ? (
            <Select name="state" defaultValue={filters.state} className="sm:w-48" aria-label="Subscription">
              <option value="">All subscriptions</option>
              {SUBSCRIPTION_STATES.map((s) => (
                <option key={s} value={s}>
                  {SUBSCRIPTION_STATE_LABELS[s]}
                </option>
              ))}
            </Select>
          ) : null}
          {caps.subscriptions ? (
            <Select name="expiry" defaultValue={filters.expiry} className="sm:w-44" aria-label="Expiry window">
              <option value="">All expiry</option>
              {Object.entries(EXPIRY_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          ) : null}
          <Select name="seller" defaultValue={filters.seller} className="sm:w-44" aria-label="Sold by">
            <option value="">All sellers</option>
            <option value="none">Seller not recorded</option>
            {data.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <Select name="country" defaultValue={filters.country} className="sm:w-44" aria-label="Country">
            <option value="">All countries</option>
            {options.countries
              .map((c) => ({ c, n: countryName(c) ?? c }))
              .sort((a, b) => a.n.localeCompare(b.n))
              .map(({ c, n }) => (
                <option key={c} value={c}>
                  {n}
                </option>
              ))}
          </Select>
          <ColumnChooser list="clients" available={available.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))} selected={columns.columns} />
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Select name="order" defaultValue={orderValue} className="sm:w-56" aria-label="Sort">
            {ORDERS.filter((o) => o.needs !== "subscriptions" || caps.subscriptions).map((o) => (
              <option key={o.value} value={o.value}>
                Sort: {o.label}
              </option>
            ))}
          </Select>
          <details className="group" open={moreFilters > 0}>
            <summary className="inline-flex h-9.5 cursor-pointer list-none items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 text-sm font-medium hover:bg-[var(--color-neutral-bg)]">
              <Filter className="size-4" aria-hidden /> More filters
              {moreFilters ? <span className="rounded-full bg-[var(--color-primary)] px-1.5 text-[11px] text-[var(--color-on-primary)]">{moreFilters}</span> : null}
            </summary>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {caps.subscriptions ? (
                <Select name="service" defaultValue={filters.service} aria-label="Service">
                  <option value="">Any service</option>
                  {options.services.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              ) : null}
              <Select name="team" defaultValue={filters.team} aria-label="Team">
                <option value="">Any team</option>
                <option value="none">No team</option>
                {options.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.status !== "ACTIVE" ? " (disabled)" : ""}
                  </option>
                ))}
              </Select>
              {caps.groups ? (
                <Select name="group" defaultValue={filters.group} aria-label="WhatsApp group">
                  <option value="">Any WhatsApp group status</option>
                  <option value="linked">Group linked</option>
                  <option value="unlinked">No group linked</option>
                </Select>
              ) : null}
              <Select name="currency" defaultValue={filters.currency} aria-label="Preferred currency">
                <option value="">Any currency</option>
                {options.currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
              {caps.subscriptions ? (
                <Select name="repeat" defaultValue={filters.repeat} aria-label="Returning customers">
                  <option value="">New and returning</option>
                  <option value="1">Returning customers only</option>
                </Select>
              ) : null}
              <Select name="category" defaultValue={filters.category} aria-label="Category">
                <option value="">Any category</option>
                {data.categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
              <Select name="tag" defaultValue={filters.tag} aria-label="Tag">
                <option value="">Any tag</option>
                {data.knownTags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
              <Select name="channel" defaultValue={filters.channel} aria-label="Has channel">
                <option value="">Any channel</option>
                {CLIENT_CHANNEL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {CLIENT_CHANNEL_LABELS[k]}
                  </option>
                ))}
              </Select>
              <Select name="assigned" defaultValue={filters.assigned} aria-label="Assigned to">
                <option value="">Assigned to anyone</option>
                <option value="none">Unassigned</option>
                {data.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </div>
          </details>
          <span className={`ml-auto self-center text-xs ${mutedText}`}>{data.total.toLocaleString()} result{data.total === 1 ? "" : "s"}</span>
        </div>
        {/* The chip's own view travels with every search. */}
        {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
        {filters.due ? <input type="hidden" name="due" value={filters.due} /> : null}
        {pageSize !== 50 ? <input type="hidden" name="pageSize" value={pageSize} /> : null}
      </AutoSubmitForm>

      <ActiveFilters filters={activeFilters} clearAllHref={clearAll} resultCount={data.total} totalCount={totalAll} noun={{ singular: "client", plural: "clients" }} />

      {data.clients.length === 0 ? (
        activeFilters.length > 0 ? (
          <NoFilterResults clearAllHref={clearAll} filters={activeFilters}>
            No client matches.
          </NoFilterResults>
        ) : (
          <EmptyState>No clients yet.{caps.canCreate ? " Add one, or import a file." : ""}</EmptyState>
        )
      ) : (
        <div>
          <ClientsTable
            clients={data.clients}
            total={data.total}
            filterParams={filterParams}
            columns={columns.columns}
            columnLabels={columnLabels}
            caps={registerCaps}
            bulkOptions={bulkOptions}
            members={data.members}
            maxBulk={MAX_CLIENT_BULK}
            exportBase="/api/clients/export"
            today={ctx.today}
          />
          <p className={`mt-2 hidden text-xs md:block ${mutedText}`}>Scroll sideways for more columns · Customize columns to choose what you see · Open a client for the complete history</p>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={data.total}
            buildHref={(p) => href(filters, { page: p })}
            pageSizeOptions={[...CLIENT_PAGE_SIZES]}
            buildPageSizeHref={(size) => href(filters, { pageSize: size === 50 ? undefined : size, page: undefined })}
          />
        </div>
      )}
    </div>
  );
}
