/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { Download } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";
import { getDhakaDayRange } from "@/lib/supportActivityPeriod";
import { getGroupSupportHistory } from "@/server/supportActivityReports";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  FilterBar,
  HelpButton,
  HelpSection,
  Input,
  PageHeader,
  Select,
  StatTile,
} from "@/components/ui";

interface SearchParams {
  groupId?: string;
  from?: string;
  to?: string;
}

function parseCustomRange(from?: string, to?: string): { start: Date; end: Date } | null {
  if (!from || !to) return null;
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T23:59:59.999Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end };
}

export default async function SupportActivityReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireSession();
  const { groupId, from, to } = await searchParams;

  const groups = await prisma.whatsAppGroup.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const customRange = parseCustomRange(from, to);
  const range = customRange ?? getDhakaDayRange(new Date());
  const history = groupId ? await getGroupSupportHistory(groupId, range) : null;
  const selectedGroup = groupId ? groups.find((g) => g.id === groupId) : null;
  const rangeLabel = customRange ? `${from} to ${to}` : "today";
  const exportParams = groupId
    ? `type=activities&groupId=${groupId}&from=${range.start.toISOString()}&to=${range.end.toISOString()}`
    : null;

  return (
    <div>
      <PageHeader
        title="Group Support History"
        description="Pick a group (and optionally a custom date range) to see its detected support activity."
        actions={
          <HelpButton moduleTitle="Group Support History">
            <HelpSection title="Counted vs. Activities">
              <p>
                "Activities" is the raw number of detected support actions for this group in the
                selected range. "Counted Support" reflects the UNIQUE_GROUP counting mode
                specifically — within a single group, that mode collapses to 1 if any activity
                occurred, 0 otherwise.
              </p>
            </HelpSection>
            <HelpSection title="Custom date range">
              <p>
                Leave From/To blank to default to today. Setting both overrides the default and is
                independent of the global Counting Period setting.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <form method="GET">
        <FilterBar>
          <Select name="groupId" defaultValue={groupId ?? ""} className="w-64">
            <option value="">Select a group…</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
          <Input name="from" type="date" defaultValue={from ?? ""} className="w-36" />
          <Input name="to" type="date" defaultValue={to ?? ""} className="w-36" />
          <Button type="submit" size="sm">
            View
          </Button>
        </FilterBar>
      </form>

      {!selectedGroup ? (
        <EmptyState>Select a group above to view its support history.</EmptyState>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-2">
              <StatTile label={`Counted Support (${rangeLabel})`} value={history?.countedSupport ?? 0} />
              <StatTile label={`Activities (${rangeLabel})`} value={history?.rawActivityCount ?? 0} />
            </div>
            {exportParams ? (
              <div className="flex gap-2">
                <ButtonLink href={`/api/support-activity/export?${exportParams}&format=csv`}>
                  <Download className="size-3.5" aria-hidden />
                  Export CSV
                </ButtonLink>
                <ButtonLink href={`/api/support-activity/export?${exportParams}&format=xlsx`}>
                  <Download className="size-3.5" aria-hidden />
                  Export Excel
                </ButtonLink>
              </div>
            ) : null}
          </div>

          <Card>
            {history && history.activities.length > 0 ? (
              <ul className="divide-y divide-[var(--color-border)]">
                {history.activities.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-4 py-3 text-sm first:pt-0 last:pb-0">
                    <div>
                      <p className="font-medium text-[color:var(--color-foreground)]">{a.teamMemberName ?? "—"}</p>
                      <p className="mt-0.5 text-[color:var(--color-muted-foreground)]">{a.messageBody}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {a.keywordValue ? <Badge color="blue">{a.keywordValue}</Badge> : null}
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">{formatDateTime(a.occurredAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>No support activity for this group in the selected range.</EmptyState>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
