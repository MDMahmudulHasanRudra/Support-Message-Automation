/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";
import { getDhakaDayRange } from "@/lib/supportActivityPeriod";
import { getGroupSupportHistory } from "@/server/supportActivityReports";
import { Badge, Button, Card, EmptyState, FilterBar, HelpButton, HelpSection, PageHeader, Select, StatTile } from "@/components/ui";

interface SearchParams {
  groupId?: string;
}

export default async function SupportActivityReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireSession();
  const { groupId } = await searchParams;

  const groups = await prisma.whatsAppGroup.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const today = getDhakaDayRange(new Date());
  const history = groupId ? await getGroupSupportHistory(groupId, today) : null;
  const selectedGroup = groupId ? groups.find((g) => g.id === groupId) : null;

  return (
    <div>
      <PageHeader
        title="Group Support History"
        description="Pick a group to see today's detected support activity for it."
        actions={
          <HelpButton moduleTitle="Group Support History">
            <HelpSection title="Counted vs. Activities">
              <p>
                "Activities" is the raw number of detected support actions for this group today.
                "Counted Support" reflects the UNIQUE_GROUP counting mode specifically — within a
                single group, that mode collapses to 1 if any activity occurred today, 0 otherwise.
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
          <Button type="submit" size="sm">
            View
          </Button>
        </FilterBar>
      </form>

      {!selectedGroup ? (
        <EmptyState>Select a group above to view its support history.</EmptyState>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-2">
            <StatTile label="Counted Support (today)" value={history?.countedSupport ?? 0} />
            <StatTile label="Activities (today)" value={history?.rawActivityCount ?? 0} />
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
              <EmptyState>No support activity for this group today.</EmptyState>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
