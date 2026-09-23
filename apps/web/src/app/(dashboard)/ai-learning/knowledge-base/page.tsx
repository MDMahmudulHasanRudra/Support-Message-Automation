/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { Download } from "lucide-react";
import { prisma } from "@support-automation/db";
import type { AiKnowledgeCategory, Prisma } from "@prisma/client";
import { KNOWLEDGE_IMPORT_CATEGORIES } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { ActiveFilters, Button, ButtonLink, FilterBar, HelpButton, HelpSection, Input, NoFilterResults, PageHeader, Pagination, Select, type ActiveFilter, ViewOnlyNotice } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { KnowledgeTable, type KnowledgeRow } from "./KnowledgeTable";

type FilterKey = "all" | "active" | "inactive" | "archived";

/**
 * Operator-chosen, not free-typed: an importer can now add hundreds of entries at once, and
 * "how many rows" is worth switching without round-tripping through the URL bar. Whitelisted
 * rather than parsed from the query string, same reasoning as the Overview `within` param — a
 * pasted arbitrary number should fall back to the default rather than page through the table.
 */
const PAGE_SIZE_OPTIONS = [50, 500, 1000] as const;
const DEFAULT_PAGE_SIZE: (typeof PAGE_SIZE_OPTIONS)[number] = 50;

function isPageSizeOption(value: string | undefined): value is `${(typeof PAGE_SIZE_OPTIONS)[number]}` {
  return PAGE_SIZE_OPTIONS.some((option) => String(option) === value);
}

interface SearchParams {
  search?: string;
  filter?: string;
  category?: string;
  module?: string;
  page?: string;
  pageSize?: string;
}

export default async function KnowledgeBasePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { canManage } = await pageAccess("ai_learning.view", "ai_learning.manage");
  const params = await searchParams;
  const filter: FilterKey = isFilterKey(params.filter) ? params.filter : "all";
  const search = (params.search ?? "").trim();
  const category = isCategory(params.category) ? params.category : null;
  const moduleName = (params.module ?? "").trim();
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const pageSize = isPageSizeOption(params.pageSize) ? Number(params.pageSize) : DEFAULT_PAGE_SIZE;

  // Everything except the status chips. The chips' own counts are computed against this, so each
  // one says how many entries have that status *within the current search and filters* rather
  // than across the whole table, which would make them useless as soon as anything is filtered.
  const facetWhere: Prisma.AiKnowledgeItemWhereInput = {
    // Title-only search was too narrow to find anything imported: an entry's title is derived
    // from its question, so the words an operator remembers are usually in the answer.
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" as const } },
            { question: { contains: search, mode: "insensitive" as const } },
            { answer: { contains: search, mode: "insensitive" as const } },
            { module: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(category ? { category } : {}),
    ...(moduleName ? { module: moduleName } : {}),
  };

  const where: Prisma.AiKnowledgeItemWhereInput = { ...facetWhere };
  if (filter === "active") where.status = "ACTIVE";
  if (filter === "inactive") where.status = "INACTIVE";
  if (filter === "archived") where.status = "ARCHIVED";

  const [items, total, allCount, activeCount, inactiveCount, archivedCount, moduleRows] = await Promise.all([
    prisma.aiKnowledgeItem.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { sourceGroup: { select: { name: true } } },
    }),
    prisma.aiKnowledgeItem.count({ where }),
    prisma.aiKnowledgeItem.count({ where: facetWhere }),
    prisma.aiKnowledgeItem.count({ where: { ...facetWhere, status: "ACTIVE" } }),
    prisma.aiKnowledgeItem.count({ where: { ...facetWhere, status: "INACTIVE" } }),
    prisma.aiKnowledgeItem.count({ where: { ...facetWhere, status: "ARCHIVED" } }),
    prisma.aiKnowledgeItem.findMany({
      where: { module: { not: null } },
      distinct: ["module"],
      select: { module: true },
      orderBy: { module: "asc" },
      take: 200,
    }),
  ]);

  const knownModules = moduleRows.map((row) => row.module).filter((m): m is string => Boolean(m));

  const rows: KnowledgeRow[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    module: item.module,
    status: item.status,
    currentVersion: item.currentVersion,
    aiGenerated: item.aiGenerated,
    humanVerified: item.humanVerified,
    sourceGroupName: item.sourceGroup?.name ?? null,
    sourceLabel: item.sourceLabel,
    sourceUrl: item.sourceUrl,
    updatedAtLabel: formatDateTime(item.updatedAt),
  }));

  const query = { search, category, module: moduleName, pageSize };

  // Four filters compose here — search, category, module and the status chip — and until now none
  // of them was visible as a thing you had applied, so a search typed five minutes ago silently
  // explained a result set nobody could account for.
  const activeFilters: ActiveFilter[] = [];
  if (search) {
    activeFilters.push({ label: "Search", value: search, removeHref: buildHref({ ...query, search: "" }, filter) });
  }
  if (category) {
    activeFilters.push({
      label: "Category",
      value: category.replace(/_/g, " "),
      removeHref: buildHref({ ...query, category: null }, filter),
    });
  }
  if (moduleName) {
    activeFilters.push({
      label: "Module",
      value: moduleName,
      removeHref: buildHref({ ...query, module: "" }, filter),
    });
  }
  if (filter !== "all") {
    activeFilters.push({
      label: "Status",
      value: filter.charAt(0).toUpperCase() + filter.slice(1),
      removeHref: buildHref(query, "all"),
    });
  }
  const clearAllHref = buildHref({ search: "", category: null, module: "", pageSize }, "all");

  return (
    <div>
      <PageHeader
        title="Knowledge Base"
        description="Everything the AI is allowed to know about your software — written by hand, imported from your documentation, or learned from real conversations."
        actions={
          <>
            <HelpButton moduleTitle="Knowledge Base">
              <HelpSection title="What this is">
                <p>
                  A versioned library of FAQs, SOPs and known answers. Only entries that are both
                  ACTIVE and verified are ever retrieved to answer a customer, so this page is the
                  full picture and Pending Review is the part that isn't in play yet.
                </p>
              </HelpSection>
              <HelpSection title="Where entries come from">
                <p>
                  Three places, all shown in the Source column: written here by hand, produced by
                  an import of your own documentation, or distilled from a monitored group's
                  conversations. An entry imported from a web page keeps a link to that page, so a
                  claim can be checked against its source rather than taken on trust.
                </p>
              </HelpSection>
              <HelpSection title="Versioning">
                <p>
                  Editing an item never overwrites its history — it creates a new version and keeps
                  every prior one, viewable and individually restorable from the item's detail page.
                  Restoring an old version doesn't delete anything either; it copies that version's
                  content into a brand-new "current" version.
                </p>
              </HelpSection>
              <HelpSection title="Export">
                <p>
                  Export downloads what the current filters show, with the importable columns first
                  and spelled the way the import template spells them — so an export can be edited
                  in Excel and uploaded straight back. Knowledge you built up over months should
                  never be trapped in one application.
                </p>
              </HelpSection>
            </HelpButton>
            <ButtonLink href={`/api/knowledge/export${buildExportQuery(query, filter)}`} download>
              <Download className="size-3.5" aria-hidden />
              Export
            </ButtonLink>
            <Link href="/ai-learning/knowledge-base/new">
              <Button>Add Knowledge</Button>
            </Link>
          </>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      <FilterBar>
        <form className="flex flex-wrap items-end gap-2" method="GET">
          <Input
            name="search"
            placeholder="Search title, question, answer…"
            defaultValue={search}
            className="w-64"
          />
          <Select name="category" defaultValue={category ?? ""} className="w-44">
            <option value="">All categories</option>
            {KNOWLEDGE_IMPORT_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
          <Select name="module" defaultValue={moduleName} className="w-44">
            <option value="">All modules</option>
            {knownModules.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          <input type="hidden" name="filter" value={filter} />
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          <FilterChip href={buildHref(query, "all")} active={filter === "all"} label={`All (${allCount})`} />
          <FilterChip href={buildHref(query, "active")} active={filter === "active"} label={`Active (${activeCount})`} />
          <FilterChip href={buildHref(query, "inactive")} active={filter === "inactive"} label={`Inactive (${inactiveCount})`} />
          <FilterChip href={buildHref(query, "archived")} active={filter === "archived"} label={`Archived (${archivedCount})`} />
        </div>
      </FilterBar>

      <ActiveFilters
        filters={activeFilters}
        clearAllHref={clearAllHref}
        resultCount={total}
        totalCount={allCount}
        noun={{ singular: "entry", plural: "entries" }}
      />

      {rows.length === 0 && activeFilters.length > 0 ? (
        <NoFilterResults clearAllHref={clearAllHref} filters={activeFilters}>
          No knowledge matches these filters.
        </NoFilterResults>
      ) : (
        <KnowledgeTable items={rows} filtered={activeFilters.length > 0} />
      )}
      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        buildHref={(next) => buildHref(query, filter, next)}
        pageSizeOptions={[...PAGE_SIZE_OPTIONS]}
        buildPageSizeHref={(size) => buildPageSizeHref(query, filter, size)}
        sticky
      />
    </div>
  );
}

interface QueryState {
  search: string;
  category: AiKnowledgeCategory | null;
  module: string;
  pageSize: number;
}

function isFilterKey(value: string | undefined): value is FilterKey {
  return value === "all" || value === "active" || value === "inactive" || value === "archived";
}

function isCategory(value: string | undefined): value is AiKnowledgeCategory {
  return (KNOWLEDGE_IMPORT_CATEGORIES as readonly string[]).includes(value ?? "");
}

function buildParams(query: QueryState): URLSearchParams {
  const qs = new URLSearchParams();
  if (query.search) qs.set("search", query.search);
  if (query.category) qs.set("category", query.category);
  if (query.module) qs.set("module", query.module);
  if (query.pageSize !== DEFAULT_PAGE_SIZE) qs.set("pageSize", String(query.pageSize));
  return qs;
}

function buildHref(query: QueryState, filter: FilterKey, page?: number): string {
  const qs = buildParams(query);
  qs.set("filter", filter);
  // Page 1 is left off so a changed filter drops the caller back to the first page rather than
  // landing on a page number the new result set may not have.
  if (page && page > 1) qs.set("page", String(page));
  return `/ai-learning/knowledge-base?${qs.toString()}`;
}

/** Switching page size, like switching a filter, always drops back to page 1 — the old page
 * number belongs to a differently-sized result set and would otherwise land somewhere arbitrary. */
function buildPageSizeHref(query: QueryState, filter: FilterKey, pageSize: number): string {
  return buildHref({ ...query, pageSize }, filter);
}

/** The export route takes the real status, not this page's chip key. */
function buildExportQuery(query: QueryState, filter: FilterKey): string {
  const qs = buildParams(query);
  if (filter !== "all") qs.set("status", filter.toUpperCase());
  const value = qs.toString();
  return value ? `?${value}` : "";
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-xs transition-colors ${
        active
          ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]"
          : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] hover:bg-[var(--color-border)]"
      }`}
    >
      {label}
    </Link>
  );
}
