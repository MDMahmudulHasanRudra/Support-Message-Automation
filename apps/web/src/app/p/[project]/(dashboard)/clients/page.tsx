/* eslint-disable react/no-unescaped-entities -- long-form Help prose reads better with real apostrophes */

import { Plus, Upload } from "lucide-react";
import { pageAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { getClientRegisterKpis, getRegisterFilterOptions, listClients, resolvePageSize } from "@/server/clients";
import { clientFilterContext, clientViewerCaps, columnNeeds, getColumnPreference } from "@/server/clientModule";
import { CLIENT_PAGE_SIZES, EMPTY_CLIENT_FILTERS, MAX_CLIENT_BULK, clientQueryString, parseClientFilters, parseClientSort } from "@/lib/clientFilters";
import { countryName } from "@/lib/clientPhone";
import { ActiveFilters, Badge, Button, ButtonLink, EmptyState, HelpButton, HelpSection, Input, NoFilterResults, PageHeader, Pagination, Select, StatTile, ViewOnlyNotice, type ActiveFilter } from "@/components/ui";
import Link from "@/components/ProjectLink";
import {
  allowedColumns,
  CLIENT_CHANNEL_KINDS,
  CLIENT_CHANNEL_LABELS,
  CLIENT_STATUSES,
  CLIENT_STATUS_LABELS,
  SUBSCRIPTION_STATES,
  SUBSCRIPTION_STATE_LABELS,
} from "@support-automation/shared";
import { ClientsTable, type RegisterCaps } from "./ClientsTable";
import { ColumnChooser } from "./ColumnChooser";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const EXPIRY_LABELS: Record<string, string> = { "7": "Expiring in 7 days", "30": "Expiring in 30 days", "90": "Expiring in 90 days", expired: "Already expired" };

/**
 * All Clients — the 360° register (CLIENTS_V3.md §5). Identity, country, phone, current plan and its
 * expiry, subscription state, what is outstanding (billing viewers only), who sold it and the linked
 * WhatsApp group, with each person's own column choice. Filtering, sorting and paging all happen on
 * the server; the browser only ever holds one page.
 */
export default async function ClientsPage({ searchParams }: { searchParams: SearchParams }) {
  const { session, canManage } = await pageAccess("clients.view", "clients.update");
  const params = await searchParams;
  const filters = parseClientFilters(params);
  const { sort, dir } = parseClientSort(params);
  const pageSize = resolvePageSize(typeof params.pageSize === "string" ? params.pageSize : undefined);
  const page = Math.max(1, Number(typeof params.page === "string" ? params.page : 1) || 1);

  const [caps, ctx] = await Promise.all([clientViewerCaps(session), clientFilterContext(session)]);
  const [data, kpis, options, columns, canArchive, canDelete, canExport, canImport] = await Promise.all([
    listClients({ filters, sort, dir, page, pageSize, ctx }),
    getClientRegisterKpis(ctx),
    getRegisterFilterOptions(),
    getColumnPreference(session.userId, "clients", caps),
    hasPermission(session, "clients.archive"),
    hasPermission(session, "clients.delete"),
    hasPermission(session, "clients.export"),
    hasPermission(session, "clients.import"),
  ]);
  const available = allowedColumns("clients", columnNeeds(caps));
  const columnLabels = Object.fromEntries(available.map((c) => [c.key, c.label]));

  const keep = { sort: sort === "name" && dir === "asc" ? undefined : sort, dir: dir === "asc" ? undefined : dir, pageSize: pageSize === 50 ? undefined : pageSize };
  const href = (f = filters, extra: Record<string, string | number | undefined> = {}) => `/clients${clientQueryString(f, { ...keep, ...extra })}`;

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
    canDelete,
    canExport,
    canManageSubscriptions: caps.canManageSubscriptions,
    canRecordPayments: caps.canRecordPayments,
    canLinkGroups: caps.canLinkGroups,
    canOpenChat: caps.canOpenChat,
  };
  const moreOpen = Boolean(filters.country || filters.team || filters.seller || filters.group || filters.currency || filters.repeat || filters.due || filters.category || filters.tag || filters.channel || filters.assigned || filters.status);

  return (
    <div>
      <PageHeader
        title="All Clients"
        description="A single 360° view: identity, country, subscription, expiry, billing balance, seller, team and linked WhatsApp group."
        actions={
          <>
            {canImport ? (
              <ButtonLink href="/clients/import" variant="secondary" size="md">
                <Upload className="size-4" aria-hidden /> Import clients
              </ButtonLink>
            ) : null}
            {canExport ? (
              <ButtonLink href={`/api/clients/export${clientQueryString(filters, { format: "xlsx" })}`} variant="secondary" size="md" download>
                Export {data.total.toLocaleString()}
              </ButtonLink>
            ) : null}
            {caps.canCreate ? (
              <ButtonLink href="/clients/new" variant="primary" size="md">
                <Plus className="size-4" aria-hidden /> Add client
              </ButtonLink>
            ) : null}
            <HelpButton moduleTitle="All Clients">
              <HelpSection title="What this page is for">
                <p>Every client in one register. Each row shows who they are, where they are, what they bought, when it expires, what they still owe (if you may see billing), who sold it and which WhatsApp group you support them in. Open a row for the full 360° view.</p>
              </HelpSection>
              <HelpSection title="Expiry is not a debt">
                <p>A subscription that expired after being paid owes nothing. "Outstanding" counts only invoices on the Billing List; the subscription badge only tells you whether to talk to them about renewing.</p>
              </HelpSection>
              <HelpSection title="Columns">
                <p>"Customize columns" picks and orders the columns you see. It is saved for you only, in this project, and "Reset to default" brings back the standard set. Billing columns are offered only to people who may see billing.</p>
              </HelpSection>
              <HelpSection title="Duplicates">
                <p>Two clients are possible duplicates when they share a phone or WhatsApp number, an email, another channel reference or the client code — never just a similar name. Nothing is ever merged automatically.</p>
              </HelpSection>
              <HelpSection title="Selecting many">
                <p>The header checkbox selects this page. "Select all N matching" widens it to every client matching your filters (up to {MAX_CLIENT_BULK.toLocaleString()}). Every bulk action tells you how many clients it will touch first.</p>
              </HelpSection>
            </HelpButton>
          </>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total clients" value={kpis.total.toLocaleString()} hint="All current (non-archived) records" href="/clients" />
        {caps.groups ? <StatTile label="Linked WhatsApp groups" value={kpis.linkedGroups.toLocaleString()} hint="From your connected accounts" href="/clients?group=linked" /> : null}
        {caps.subscriptions ? (
          <StatTile label="Renewal attention" value={kpis.renewalAttention.toLocaleString()} hint={`Expiring in ${ctx.renewalWindowDays} days or expired in the last 30 — not a debt`} tone={kpis.renewalAttention ? "warning" : "neutral"} href="/clients/subscriptions?view=renew" />
        ) : null}
        {caps.subscriptions ? <StatTile label="Returning customers" value={kpis.returning.toLocaleString()} hint="Renewed or bought again" href="/clients?repeat=1" /> : null}
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {[{ key: "", label: "Current", count: totalAll - (data.counts.ARCHIVED ?? 0) }, ...CLIENT_STATUSES.map((s) => ({ key: s, label: CLIENT_STATUS_LABELS[s], count: data.counts[s] ?? 0 })), { key: "ALL", label: "All", count: totalAll }].map((chip) => {
          const active = filters.status === chip.key;
          return (
            <Link
              key={chip.key || "current"}
              href={href({ ...filters, status: chip.key }, { page: undefined })}
              aria-current={active ? "true" : undefined}
              className={`rounded-full px-3 py-1 text-xs tabular transition-colors ${active ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] hover:bg-[var(--color-border)]"}`}
            >
              {chip.label} ({chip.count.toLocaleString()})
            </Link>
          );
        })}
      </div>

      <form method="GET" className="mb-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-xs)]">
        <div className="flex flex-wrap items-center gap-2">
          <Input name="q" placeholder="Search name, phone, code, company, seller, service…" defaultValue={filters.q} className="min-w-0 flex-1 sm:min-w-[280px]" aria-label="Search clients" />
          {caps.subscriptions ? (
            <Select name="state" defaultValue={filters.state} className="sm:w-44" aria-label="Subscription">
              <option value="">Any subscription</option>
              {SUBSCRIPTION_STATES.map((s) => (
                <option key={s} value={s}>
                  {SUBSCRIPTION_STATE_LABELS[s]}
                </option>
              ))}
            </Select>
          ) : null}
          {caps.subscriptions ? (
            <Select name="expiry" defaultValue={filters.expiry} className="sm:w-48" aria-label="Expiry window">
              <option value="">Any expiry</option>
              {Object.entries(EXPIRY_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          ) : null}
          <Select name="sort" defaultValue={sort} className="sm:w-40" aria-label="Sort by">
            <option value="name">Sort: name</option>
            {caps.subscriptions ? <option value="expiry">Sort: expiry</option> : null}
            <option value="country">Sort: country</option>
            <option value="code">Sort: code</option>
            <option value="created">Sort: newest</option>
            <option value="updated">Sort: updated</option>
            <option value="contact">Sort: last contact</option>
          </Select>
          <Select name="dir" defaultValue={dir} className="sm:w-32" aria-label="Direction">
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </Select>
          <Button type="submit" size="sm">
            Apply
          </Button>
          <ColumnChooser list="clients" available={available.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))} selected={columns.columns} />
          <span className="text-xs text-[color:var(--color-muted-foreground)]">{data.total.toLocaleString()} results</span>
        </div>
        <details className="group mt-2" open={moreOpen}>
          <summary className="cursor-pointer select-none text-xs font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">More filters</summary>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
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
            <Select name="country" defaultValue={filters.country} aria-label="Country">
              <option value="">Any country</option>
              {options.countries
                .map((c) => ({ c, n: countryName(c) ?? c }))
                .sort((a, b) => a.n.localeCompare(b.n))
                .map(({ c, n }) => (
                  <option key={c} value={c}>
                    {n}
                  </option>
                ))}
            </Select>
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
            <Select name="seller" defaultValue={filters.seller} aria-label="Sold by">
              <option value="">Any seller</option>
              <option value="none">Seller not recorded</option>
              {data.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
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
            {caps.billing ? (
              <Select name="due" defaultValue={filters.due} aria-label="Payment">
                <option value="">Any payment status</option>
                <option value="open">Has an open invoice</option>
                <option value="overdue">Has an overdue invoice</option>
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
        {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
      </form>

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
        <>
          <ClientsTable
            clients={data.clients}
            total={data.total}
            filterParams={filterParams}
            columns={columns.columns}
            columnLabels={columnLabels}
            caps={registerCaps}
            members={data.members}
            maxBulk={MAX_CLIENT_BULK}
            exportBase="/api/clients/export"
          />
          <p className="mt-2 hidden text-xs text-[color:var(--color-muted-foreground)] md:block">
            Scroll sideways for more columns · Customize columns to choose what you see · Open a client for the complete history
          </p>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={data.total}
            buildHref={(p) => href(filters, { page: p })}
            pageSizeOptions={[...CLIENT_PAGE_SIZES]}
            buildPageSizeHref={(size) => href(filters, { pageSize: size === 50 ? undefined : size, page: undefined })}
          />
        </>
      )}
      {filters.status === "ARCHIVED" ? <Badge color="gray">Archived view — clients here can be restored or, with permission, deleted permanently.</Badge> : null}
    </div>
  );
}
