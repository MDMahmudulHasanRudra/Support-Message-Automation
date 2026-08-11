import Link from "next/link";
import { prisma } from "@support-automation/db";
import type { LogLevel, Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { Button, EmptyState, FilterBar, Input, PageHeader, Select } from "@/components/ui";
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
    timeLabel: log.createdAt.toLocaleString(),
    level: log.level,
    scope: log.scope,
    message: log.message,
    metadataJson: log.metadata ? JSON.stringify(log.metadata, null, 2) : null,
  }));

  return (
    <div>
      <PageHeader title="System Logs" description="Most recent 200 entries." />

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
