/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { Button, FilterBar, HelpButton, HelpSection, Input, PageHeader } from "@/components/ui";
import { KnowledgeTable, type KnowledgeRow } from "./KnowledgeTable";

type FilterKey = "all" | "active" | "inactive" | "archived";

interface SearchParams {
  search?: string;
  filter?: string;
}

export default async function KnowledgeBasePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireSession();
  const params = await searchParams;
  const filter: FilterKey = isFilterKey(params.filter) ? params.filter : "all";
  const search = (params.search ?? "").trim();

  const searchOnlyWhere: Prisma.AiKnowledgeItemWhereInput = search
    ? { title: { contains: search, mode: "insensitive" } }
    : {};
  const where: Prisma.AiKnowledgeItemWhereInput = { ...searchOnlyWhere };
  if (filter === "active") where.status = "ACTIVE";
  if (filter === "inactive") where.status = "INACTIVE";
  if (filter === "archived") where.status = "ARCHIVED";

  const [items, allCount, activeCount, inactiveCount, archivedCount] = await Promise.all([
    prisma.aiKnowledgeItem.findMany({ where, orderBy: { updatedAt: "desc" } }),
    prisma.aiKnowledgeItem.count({ where: searchOnlyWhere }),
    prisma.aiKnowledgeItem.count({ where: { ...searchOnlyWhere, status: "ACTIVE" } }),
    prisma.aiKnowledgeItem.count({ where: { ...searchOnlyWhere, status: "INACTIVE" } }),
    prisma.aiKnowledgeItem.count({ where: { ...searchOnlyWhere, status: "ARCHIVED" } }),
  ]);

  const rows: KnowledgeRow[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    status: item.status,
    currentVersion: item.currentVersion,
    aiGenerated: item.aiGenerated,
    updatedAtLabel: item.updatedAt.toLocaleString(),
  }));

  return (
    <div>
      <PageHeader
        title="Knowledge Base"
        description="The application's permanent AI knowledge store. Manually curated for now — later phases add automated ingestion."
        actions={
          <>
            <HelpButton moduleTitle="Knowledge Base">
              <HelpSection title="What this is">
                <p>
                  A manually written, versioned library of FAQs, SOPs, and known answers — not
                  currently used to generate any live customer reply (see the AI Dashboard help for
                  why). Safe to build up now for whenever that changes.
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
              <HelpSection title="Active / Inactive / Archived">
                <p>
                  These only affect how items are organized and filtered here — since nothing consumes
                  this knowledge base yet, changing an item's status has no other effect right now.
                </p>
              </HelpSection>
            </HelpButton>
            <Link href="/ai-learning/knowledge-base/new">
              <Button>Add Knowledge</Button>
            </Link>
          </>
        }
      />

      <FilterBar>
        <form className="flex flex-wrap items-end gap-2" method="GET">
          <Input name="search" placeholder="Search title…" defaultValue={search} className="w-64" />
          <input type="hidden" name="filter" value={filter} />
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          <FilterChip href={buildHref(search, "all")} active={filter === "all"} label={`All (${allCount})`} />
          <FilterChip href={buildHref(search, "active")} active={filter === "active"} label={`Active (${activeCount})`} />
          <FilterChip href={buildHref(search, "inactive")} active={filter === "inactive"} label={`Inactive (${inactiveCount})`} />
          <FilterChip href={buildHref(search, "archived")} active={filter === "archived"} label={`Archived (${archivedCount})`} />
        </div>
      </FilterBar>

      <KnowledgeTable items={rows} />
    </div>
  );
}

function isFilterKey(value: string | undefined): value is FilterKey {
  return value === "all" || value === "active" || value === "inactive" || value === "archived";
}

function buildHref(search: string, filter: FilterKey): string {
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  qs.set("filter", filter);
  return `/ai-learning/knowledge-base?${qs.toString()}`;
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
