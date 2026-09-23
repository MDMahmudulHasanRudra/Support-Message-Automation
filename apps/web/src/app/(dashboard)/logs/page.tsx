/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import type { LogLevel, Prisma } from "@prisma/client";
import { requireAccess } from "@/server/authorize";
import {
  ActiveFilters,
  Button,
  EmptyState,
  FilterBar,
  HelpButton,
  HelpSection,
  Input,
  NoFilterResults,
  PageHeader,
  Pagination,
  Select,
  type ActiveFilter,
} from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { LogsTable, type LogRow } from "./LogsTable";

const LEVELS = ["INFO", "WARN", "ERROR"] as const;

const PAGE_SIZE_OPTIONS = [100, 250, 500] as const;
const DEFAULT_PAGE_SIZE = 100;

/**
 * The windows an incident is actually investigated in.
 *
 * This page had no time filter at all, which made its canonical use — "what happened between 07:06
 * and 10:22 on the day collection stopped" — reachable only by paging 100 rows at a time through
 * months of a table that nothing ever prunes. `@@index([createdAt])` already served this query; it
 * simply had no way to be asked for.
 */
const RANGE_PRESETS = {
  "1h": { label: "Last hour", ms: 60 * 60 * 1000 },
  "24h": { label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  "7d": { label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  "30d": { label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
} as const;
type RangeKey = keyof typeof RANGE_PRESETS;

function isRangeKey(value: string | undefined): value is RangeKey {
  return value !== undefined && value in RANGE_PRESETS;
}

/** A datetime-local value, or nothing. Whitelisted by parse rather than trusted, so a pasted
 *  nonsense value falls through to "no bound" instead of producing an Invalid Date in the query. */
function parseInstant(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface LogsSearchParams {
  level?: string;
  scope?: string;
  message?: string;
  correlationId?: string;
  range?: string;
  from?: string;
  to?: string;
  page?: string;
  pageSize?: string;
}

export default async function LogsPage({ searchParams }: { searchParams: Promise<LogsSearchParams> }) {
  await requireAccess("system_logs.view");
  const filters = await searchParams;

  const scope = (filters.scope ?? "").trim();
  const message = (filters.message ?? "").trim();
  const correlationId = (filters.correlationId ?? "").trim();
  const range = isRangeKey(filters.range) ? filters.range : null;
  const from = parseInstant(filters.from);
  const to = parseInstant(filters.to);

  const where: Prisma.SystemLogWhereInput = {};
  // Whitelisted, not cast. `filters.level as LogLevel` handed any URL value straight to Prisma, so a
  // hand-edited or stale link (`?level=error`, `?level=DEBUG`) threw a validation error and took the
  // whole page to the error boundary rather than simply showing nothing.
  const level = (LEVELS as readonly string[]).includes(filters.level ?? "")
    ? (filters.level as LogLevel)
    : null;
  if (level) where.level = level;
  if (scope) where.scope = { contains: scope, mode: "insensitive" };
  if (message) where.message = { contains: message, mode: "insensitive" };
  // The column has been written on every request-scoped event since the log was built and read by
  // nothing — this is the reader. One incoming message's whole trail, in one query.
  if (correlationId) where.correlationId = correlationId;

  // An explicit from/to wins over a preset: a typed bound is a deliberate act and a shorthand must
  // never override it. Same rule the Overview tiles' `within` param follows.
  // eslint-disable-next-line react-hooks/purity -- server component runs fresh per request; not subject to render-purity rules
  const nowMs = Date.now();
  const createdAt: Prisma.DateTimeFilter = {};
  if (from) createdAt.gte = from;
  if (to) createdAt.lte = to;
  if (!from && !to && range) createdAt.gte = new Date(nowMs - RANGE_PRESETS[range].ms);
  if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;

  const requestedPageSize = Number(filters.pageSize ?? DEFAULT_PAGE_SIZE);
  const PAGE_SIZE = PAGE_SIZE_OPTIONS.includes(requestedPageSize as (typeof PAGE_SIZE_OPTIONS)[number])
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;

  // Paginated rather than a bare "newest 200". The cap silently hid everything older, which on a
  // page whose whole purpose is finding out what happened is the wrong kind of quiet: the entry
  // you are looking for is the one you cannot reach.
  const page = Math.max(1, Number(filters.page ?? "1") || 1);
  const [logs, totalCount, unfilteredCount] = await Promise.all([
    prisma.systemLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.systemLog.count({ where }),
    prisma.systemLog.count(),
  ]);

  const buildHref = (
    overrides: Partial<LogsSearchParams> = {},
    nextPage = 1,
    nextPageSize = PAGE_SIZE,
  ) => {
    const merged = {
      level: level ?? "",
      scope,
      message,
      correlationId,
      range: range ?? "",
      from: filters.from ?? "",
      to: filters.to ?? "",
      ...overrides,
    };
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
      if (value) qs.set(key, String(value));
    }
    if (nextPage > 1) qs.set("page", String(nextPage));
    if (nextPageSize !== DEFAULT_PAGE_SIZE) qs.set("pageSize", String(nextPageSize));
    const query = qs.toString();
    return query ? `/logs?${query}` : "/logs";
  };

  const activeFilters: ActiveFilter[] = [];
  if (level) {
    activeFilters.push({ label: "Level", value: level, removeHref: buildHref({ level: "" }) });
  }
  if (scope) activeFilters.push({ label: "Scope", value: scope, removeHref: buildHref({ scope: "" }) });
  if (message) activeFilters.push({ label: "Message", value: message, removeHref: buildHref({ message: "" }) });
  if (correlationId) {
    activeFilters.push({
      label: "Trail",
      value: correlationId,
      removeHref: buildHref({ correlationId: "" }),
    });
  }
  if (from || to) {
    activeFilters.push({
      label: "Between",
      value: `${from ? formatDateTime(from) : "anything"} → ${to ? formatDateTime(to) : "now"}`,
      removeHref: buildHref({ from: "", to: "" }),
    });
  } else if (range) {
    activeFilters.push({
      label: "Window",
      value: RANGE_PRESETS[range].label,
      removeHref: buildHref({ range: "" }),
    });
  }
  const clearAllHref = "/logs";
  const hasActiveFilters = activeFilters.length > 0;

  const rows: LogRow[] = logs.map((log) => ({
    id: log.id,
    timeLabel: formatDateTime(log.createdAt),
    level: log.level,
    scope: log.scope,
    message: log.message,
    correlationId: log.correlationId,
    trailHref: log.correlationId ? buildHref({ correlationId: log.correlationId }) : null,
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

      <FilterBar>
        <form method="GET" className="flex flex-wrap items-end gap-2">
          <Select name="level" defaultValue={level ?? ""} className="w-32">
            <option value="">All levels</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          <Input name="scope" placeholder="Scope contains…" defaultValue={scope} className="w-36" />
          <Input
            name="message"
            type="search"
            placeholder="Message contains…"
            defaultValue={message}
            className="w-52"
          />
          {/* Minute precision, because an incident is bounded by the minute it started, not the day. */}
          <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-muted-foreground)]">
            From
            <Input name="from" type="datetime-local" defaultValue={filters.from ?? ""} className="w-52" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-muted-foreground)]">
            To
            <Input name="to" type="datetime-local" defaultValue={filters.to ?? ""} className="w-52" />
          </label>
          {/* Carried through the submit so narrowing by message does not silently discard the
              trail or the preset window the operator is already inside. */}
          {correlationId ? <input type="hidden" name="correlationId" value={correlationId} /> : null}
          {range && !filters.from && !filters.to ? <input type="hidden" name="range" value={range} /> : null}
          <Button type="submit" size="sm">
            Filter
          </Button>
        </form>

        {/* Presets for the windows an incident is actually read in — one click instead of typing
            two timestamps, which is the common case by a wide margin. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-[color:var(--color-muted-foreground)]">Window</span>
          {(Object.keys(RANGE_PRESETS) as RangeKey[]).map((key) => (
            <RangeChip
              key={key}
              href={buildHref({ range: key, from: "", to: "" })}
              active={range === key && !from && !to}
              label={RANGE_PRESETS[key].label}
            />
          ))}
        </div>
      </FilterBar>

      <ActiveFilters
        filters={activeFilters}
        clearAllHref={clearAllHref}
        resultCount={totalCount}
        totalCount={unfilteredCount}
        noun={{ singular: "entry", plural: "entries" }}
      />

      {rows.length === 0 ? (
        hasActiveFilters ? (
          <NoFilterResults clearAllHref={clearAllHref} filters={activeFilters}>
            No log entries match these filters.
          </NoFilterResults>
        ) : (
          <EmptyState>No log entries yet.</EmptyState>
        )
      ) : (
        <>
          <LogsTable logs={rows} />
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={totalCount}
            buildHref={(p) => buildHref({}, p, PAGE_SIZE)}
            pageSizeOptions={[...PAGE_SIZE_OPTIONS]}
            buildPageSizeHref={(size) => buildHref({}, 1, size)}
            sticky
          />
        </>
      )}
    </div>
  );
}

function RangeChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
        active
          ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]"
          : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] hover:bg-[var(--color-border)]"
      }`}
    >
      {label}
    </Link>
  );
}
