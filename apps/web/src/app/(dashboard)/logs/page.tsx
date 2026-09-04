/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import type { LogLevel, Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { Button, EmptyState, FilterBar, HelpButton, HelpSection, Input, PageHeader, Pagination, Select } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { LogsTable, type LogRow } from "./LogsTable";

const LEVELS = ["INFO", "WARN", "ERROR"] as const;

const PAGE_SIZE = 100;

interface LogsSearchParams {
  level?: string;
  scope?: string;
  message?: string;
  page?: string;
}

export default async function LogsPage({ searchParams }: { searchParams: Promise<LogsSearchParams> }) {
  await requireSession();
  const filters = await searchParams;

  const where: Prisma.SystemLogWhereInput = {};
  if (filters.level) where.level = filters.level as LogLevel;
  if (filters.scope) where.scope = { contains: filters.scope, mode: "insensitive" };
  if (filters.message?.trim()) where.message = { contains: filters.message.trim(), mode: "insensitive" };

  // Paginated rather than a bare "newest 200". The cap silently hid everything older, which on a
  // page whose whole purpose is finding out what happened is the wrong kind of quiet: the entry
  // you are looking for is the one you cannot reach.
  const page = Math.max(1, Number(filters.page ?? "1") || 1);
  const [logs, totalCount] = await Promise.all([
    prisma.systemLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.systemLog.count({ where }),
  ]);
  const hasActiveFilters = Boolean(filters.level || filters.scope || filters.message);

  const buildHref = (nextPage: number) => {
    const qs = new URLSearchParams();
    if (filters.level) qs.set("level", filters.level);
    if (filters.scope) qs.set("scope", filters.scope);
    if (filters.message) qs.set("message", filters.message);
    if (nextPage > 1) qs.set("page", String(nextPage));
    const query = qs.toString();
    return query ? `/logs?${query}` : "/logs";
  };

  const rows: LogRow[] = logs.map((log) => ({
    id: log.id,
    timeLabel: formatDateTime(log.createdAt),
    level: log.level,
    scope: log.scope,
    message: log.message,
    metadataJson: log.metadata ? JSON.stringify(log.metadata, null, 2) : null,
  }));

  return (
    <div>
      <PageHeader
        title="System Logs"
        description={`${totalCount.toLocaleString()} entries, newest first.`}
        actions={
          <HelpButton moduleTitle="System Logs">
            <HelpSection title="What this page is for">
              <p>
                A read-only audit/diagnostic trail of internal system events — connection changes,
                account/routing changes, escalation skips, errors — written automatically as they
                happen by both the dashboard and the worker process into the same shared log. Use it for
                "why didn't X happen," not for reading chat content (that's the Messages page).
              </p>
            </HelpSection>
            <HelpSection title="Level and Scope">
              <p>
                Level is INFO/WARN/ERROR. Scope is a short tag naming which subsystem logged it —
                common ones: "provider" (WhatsApp connection), "pipeline" (message processing),
                "support-escalation", "accounts", "whatsapp-routing", "ai-learning". Scope is a free-text
                contains-match, not a fixed dropdown, so partial text works.
              </p>
            </HelpSection>
            <HelpSection title="Expandable rows">
              <p>
                A row with a chevron has extra metadata attached (account IDs, error details, counts) —
                click to expand it as raw JSON.
              </p>
            </HelpSection>
            <HelpSection title="Gotcha">
              <p>
                Logging is designed to never crash anything — if writing a log entry itself somehow
                fails, that failure is swallowed silently rather than shown here. If you suspect an
                issue but see nothing relevant in this list, also check that the affected
                service (worker or dashboard) is actually running.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <form method="GET">
        <FilterBar>
          <Select name="level" defaultValue={filters.level ?? ""} className="w-32">
            <option value="">All levels</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          <Input name="scope" placeholder="Scope contains…" defaultValue={filters.scope ?? ""} className="w-40" />
          <Input
            name="message"
            type="search"
            placeholder="Message contains…"
            defaultValue={filters.message ?? ""}
            className="w-56"
          />
          <Button type="submit" size="sm">
            Filter
          </Button>
          {hasActiveFilters ? (
            <Link
              href="/logs"
              className="text-sm text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
            >
              Clear
            </Link>
          ) : null}
        </FilterBar>
      </form>

      {rows.length === 0 ? (
        <EmptyState>{hasActiveFilters ? "No log entries match these filters." : "No log entries yet."}</EmptyState>
      ) : (
        <>
          <LogsTable logs={rows} />
          <Pagination page={page} pageSize={PAGE_SIZE} total={totalCount} buildHref={buildHref} />
        </>
      )}
    </div>
  );
}
