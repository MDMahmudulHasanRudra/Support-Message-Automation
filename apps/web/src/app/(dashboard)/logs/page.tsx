/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import type { LogLevel, Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { Button, EmptyState, FilterBar, HelpButton, HelpSection, Input, PageHeader, Select } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { LogsTable, type LogRow } from "./LogsTable";

const LEVELS = ["INFO", "WARN", "ERROR"] as const;

interface LogsSearchParams {
  level?: string;
  scope?: string;
}

export default async function LogsPage({ searchParams }: { searchParams: Promise<LogsSearchParams> }) {
  await requireSession();
  const filters = await searchParams;

  const where: Prisma.SystemLogWhereInput = {};
  if (filters.level) where.level = filters.level as LogLevel;
  if (filters.scope) where.scope = { contains: filters.scope, mode: "insensitive" };

  const logs = await prisma.systemLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
  const hasActiveFilters = Boolean(filters.level || filters.scope);

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
        description="Most recent 200 entries."
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
          <Input name="scope" placeholder="Scope contains…" defaultValue={filters.scope ?? ""} className="w-48" />
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
        <LogsTable logs={rows} />
      )}
    </div>
  );
}
