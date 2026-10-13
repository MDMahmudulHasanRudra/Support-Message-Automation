/* eslint-disable react/no-unescaped-entities -- long-form Help prose reads better with real apostrophes */

import { pageAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { listClients, resolvePageSize } from "@/server/clients";
import { CLIENT_PAGE_SIZES, MAX_CLIENT_BULK, clientQueryString, parseClientFilters, parseClientSort } from "@/lib/clientFilters";
import { formatDate } from "@/lib/date";
import { ActiveFilters, Badge, Button, ButtonLink, EmptyState, FilterBar, HelpButton, HelpSection, Input, NoFilterResults, PageHeader, Pagination, Select, ViewOnlyNotice, type ActiveFilter } from "@/components/ui";
import Link from "@/components/ProjectLink";
import { CLIENT_CHANNEL_KINDS, CLIENT_CHANNEL_LABELS, CLIENT_STATUSES, CLIENT_STATUS_LABELS } from "@support-automation/shared";
import { ClientsTable, type ClientTableRow } from "./ClientsTable";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ClientsPage({ searchParams }: { searchParams: SearchParams }) {
  const { session, canManage } = await pageAccess("clients.view", "clients.update");
  const params = await searchParams;
  const filters = parseClientFilters(params);
  const { sort, dir } = parseClientSort(params);
  const pageSize = resolvePageSize(typeof params.pageSize === "string" ? params.pageSize : undefined);
  const page = Math.max(1, Number(typeof params.page === "string" ? params.page : 1) || 1);

  const [data, canCreate, canArchive, canDelete, canExport, canImport] = await Promise.all([
    listClients({ filters, sort, dir, page, pageSize }),
    hasPermission(session, "clients.create"),
    hasPermission(session, "clients.archive"),
    hasPermission(session, "clients.delete"),
    hasPermission(session, "clients.export"),
    hasPermission(session, "clients.import"),
  ]);

  const keep = { sort: sort === "name" && dir === "asc" ? undefined : sort, dir: dir === "asc" ? undefined : dir, pageSize: pageSize === 50 ? undefined : pageSize };
  const href = (f = filters, extra: Record<string, string | number | undefined> = {}) => `/clients${clientQueryString(f, { ...keep, ...extra })}`;

  const activeFilters: ActiveFilter[] = [];
  const add = (label: string, value: string, patch: Partial<typeof filters>) => value && activeFilters.push({ label, value, removeHref: href({ ...filters, ...patch }) });
  add("Search", filters.q, { q: "" });
  add("Category", filters.category, { category: "" });
  add("Tag", filters.tag, { tag: "" });
  add("Channel", filters.channel ? CLIENT_CHANNEL_LABELS[filters.channel as keyof typeof CLIENT_CHANNEL_LABELS] : "", { channel: "" });
  add("Assigned", filters.assigned === "none" ? "Unassigned" : data.members.find((m) => m.id === filters.assigned)?.name ?? "", { assigned: "" });
  add("Status", filters.status === "ALL" ? "All, including archived" : filters.status ? CLIENT_STATUS_LABELS[filters.status as keyof typeof CLIENT_STATUS_LABELS] : "", { status: "" });
  const clearAll = href({ q: "", status: "", category: "", tag: "", assigned: "", channel: "", source: "" });

  const rows: ClientTableRow[] = data.clients.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    companyName: c.companyName,
    status: c.status,
    category: c.category,
    tags: c.tags,
    assignedMemberName: c.assignedMemberName,
    lastContact: c.lastContactAt ? formatDate(c.lastContactAt) : null,
    channels: c.channels,
  }));
  const filterParams = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== ""));
  const totalAll = Object.values(data.counts).reduce((a, b) => a + b, 0);
  const statusChipHref = (status: string) => href({ ...filters, status }, { page: undefined });

  return (
    <div>
      <PageHeader
        title="Clients"
        description="One record per client, whatever app they use. Contact details, channel references, tags, notes and history."
        actions={
          <>
            {canImport ? (
              <ButtonLink href="/clients/import" variant="secondary" size="md">
                Import
              </ButtonLink>
            ) : null}
            {canExport ? (
              <ButtonLink href={`/api/clients/export${clientQueryString(filters, { format: "xlsx" })}`} variant="secondary" size="md" download>
                Export {data.total.toLocaleString()} (Excel)
              </ButtonLink>
            ) : null}
            {canCreate ? (
              <ButtonLink href="/clients/new" variant="primary" size="md">
                Add client
              </ButtonLink>
            ) : null}
            <HelpButton moduleTitle="Clients">
              <HelpSection title="What this page is for">
                <p>The one list of your clients, independent of how you talk to them. A client can have several ways to reach them (phone, WhatsApp, email, Messenger, Instagram, a WhatsApp group) on one record.</p>
              </HelpSection>
              <HelpSection title="What it does not do (yet)">
                <p>Nothing here sends a message, and there are no invoices or balances — billing lives in its own system and is not connected. The consent set on a channel is recorded for later; it does not send or block anything today.</p>
              </HelpSection>
              <HelpSection title="Duplicates">
                <p>Two clients are possible duplicates when they share a phone or WhatsApp number, an email, another channel reference or the client code — never just a similar name. You are shown matches before a client is created, and nothing is ever merged automatically.</p>
              </HelpSection>
              <HelpSection title="Archive, not delete">
                <p>Archiving hides a client from the default list and keeps everything. Only an archived client can be permanently deleted, with a separate permission.</p>
              </HelpSection>
              <HelpSection title="Selecting many">
                <p>The header checkbox selects this page. "Select all N matching" widens it to every client matching your filters (up to {MAX_CLIENT_BULK.toLocaleString()}). Every bulk action tells you how many clients it will touch first.</p>
              </HelpSection>
            </HelpButton>
          </>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      <div className="mb-3 flex flex-wrap gap-1.5">
        {[{ key: "", label: "Current", count: totalAll - (data.counts.ARCHIVED ?? 0) }, ...CLIENT_STATUSES.map((s) => ({ key: s, label: CLIENT_STATUS_LABELS[s], count: data.counts[s] ?? 0 })), { key: "ALL", label: "All", count: totalAll }].map((chip) => {
          const active = filters.status === chip.key;
          return (
            <Link
              key={chip.key || "current"}
              href={statusChipHref(chip.key)}
              aria-current={active ? "true" : undefined}
              className={`rounded-full px-3 py-1 text-xs tabular transition-colors ${active ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] hover:bg-[var(--color-border)]"}`}
            >
              {chip.label} ({chip.count.toLocaleString()})
            </Link>
          );
        })}
      </div>

      <FilterBar>
        <form className="flex flex-wrap items-end gap-2" method="GET">
          <Input name="q" placeholder="Search name, code, company, phone, email…" defaultValue={filters.q} className="sm:w-72" />
          <Select name="category" defaultValue={filters.category} className="sm:w-40" aria-label="Category">
            <option value="">Any category</option>
            {data.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Select name="tag" defaultValue={filters.tag} className="sm:w-36" aria-label="Tag">
            <option value="">Any tag</option>
            {data.knownTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Select name="channel" defaultValue={filters.channel} className="sm:w-44" aria-label="Has channel">
            <option value="">Any channel</option>
            {CLIENT_CHANNEL_KINDS.map((k) => (
              <option key={k} value={k}>
                {CLIENT_CHANNEL_LABELS[k]}
              </option>
            ))}
          </Select>
          <Select name="assigned" defaultValue={filters.assigned} className="sm:w-40" aria-label="Assigned to">
            <option value="">Anyone</option>
            <option value="none">Unassigned</option>
            {data.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <Select name="sort" defaultValue={sort} className="sm:w-36" aria-label="Sort by">
            <option value="name">Sort: name</option>
            <option value="code">Sort: code</option>
            <option value="created">Sort: newest</option>
            <option value="updated">Sort: updated</option>
            <option value="contact">Sort: last contact</option>
          </Select>
          <Select name="dir" defaultValue={dir} className="sm:w-28" aria-label="Direction">
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </Select>
          {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
          <Button type="submit" size="sm">
            Apply
          </Button>
        </form>
      </FilterBar>

      <ActiveFilters filters={activeFilters} clearAllHref={clearAll} resultCount={data.total} totalCount={totalAll} noun={{ singular: "client", plural: "clients" }} />

      {data.clients.length === 0 ? (
        activeFilters.length > 0 ? (
          <NoFilterResults clearAllHref={clearAll} filters={activeFilters}>
            No client matches.
          </NoFilterResults>
        ) : (
          <EmptyState>
            No clients yet.{canCreate ? " Add one, or import a file." : ""}
          </EmptyState>
        )
      ) : (
        <>
          <ClientsTable
            clients={rows}
            total={data.total}
            filterParams={filterParams}
            canUpdate={canManage}
            canArchive={canArchive}
            canDelete={canDelete}
            canExport={canExport}
            members={data.members}
            maxBulk={MAX_CLIENT_BULK}
            exportBase="/api/clients/export"
          />
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
