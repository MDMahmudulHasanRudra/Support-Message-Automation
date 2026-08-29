/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { Download } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";
import { formatDurationShort, formatElapsedShort } from "@/lib/duration";
import { getDhakaDayRange } from "@/lib/supportActivityPeriod";
import { getGroupSessionHistory, getGroupSupportHistory } from "@/server/supportActivityReports";
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
  SectionHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { CloseSessionButton } from "./CloseSessionButton";

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
  // Sessions are shown across every group by default (not gated behind picking one) so this page
  // can answer "what's happening right now" at a glance — the same group/date filters above scope
  // it down when a group is selected, keeping one set of controls for both sections.
  const sessions = await getGroupSessionHistory(range, groupId);
  const selectedGroup = groupId ? groups.find((g) => g.id === groupId) : null;
  const rangeLabel = customRange ? `${from} to ${to}` : "today";
  const rangeParams = `from=${range.start.toISOString()}&to=${range.end.toISOString()}`;
  const activitiesExportParams = groupId ? `type=activities&groupId=${groupId}&${rangeParams}` : null;
  const sessionsExportParams = `type=sessions&${rangeParams}${groupId ? `&groupId=${groupId}` : ""}`;

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Support activity history and session tracking, by WhatsApp group."
        actions={
          <HelpButton moduleTitle="Reports">
            <HelpSection title="Support Activity vs. Support Sessions">
              <p>
                <strong>Support Activity</strong> is the raw detected keyword/reply/mention log for
                one group. <strong>Support Sessions</strong> tracks how long a group's support
                request took to resolve — from the first activity to a completion keyword (or a
                manual close) — and isn't limited to a single group unless you filter to one.
              </p>
            </HelpSection>
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
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
          <Input name="from" type="date" defaultValue={from ?? ""} className="w-36" />
          <Input name="to" type="date" defaultValue={to ?? ""} className="w-36" />
          <Button type="submit" size="sm">
            Apply
          </Button>
        </FilterBar>
      </form>

      <section className="mt-6">
        <SectionHeader
          title="Support Activity"
          description="Detected keyword, reply, and mention activity for the selected group."
        />
        {!selectedGroup ? (
          <Card>
            <EmptyState>Select a group above to see its detected support activity.</EmptyState>
          </Card>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="grid grid-cols-2 gap-4">
                <StatTile label={`Counted Support (${rangeLabel})`} value={history?.countedSupport ?? 0} />
                <StatTile label={`Activities (${rangeLabel})`} value={history?.rawActivityCount ?? 0} />
              </div>
              {activitiesExportParams ? (
                <div className="flex gap-2">
                  <ButtonLink variant="secondary" size="sm" href={`/api/support-activity/export?${activitiesExportParams}&format=csv`}>
                    <Download className="size-3.5" aria-hidden />
                    Export CSV
                  </ButtonLink>
                  <ButtonLink variant="secondary" size="sm" href={`/api/support-activity/export?${activitiesExportParams}&format=xlsx`}>
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
                        <p className="font-medium text-[color:var(--color-foreground)]">
                          {a.actor === "AI" ? "AI" : (a.teamMemberName ?? "—")}
                        </p>
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
      </section>

      <section className="mt-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <SectionHeader
            title="Support Sessions"
            description="Track active and completed support sessions by WhatsApp group."
          />
          <div className="flex gap-2">
            <ButtonLink variant="secondary" size="sm" href={`/api/support-activity/export?${sessionsExportParams}&format=csv`}>
              <Download className="size-3.5" aria-hidden />
              Export CSV
            </ButtonLink>
            <ButtonLink variant="secondary" size="sm" href={`/api/support-activity/export?${sessionsExportParams}&format=xlsx`}>
              <Download className="size-3.5" aria-hidden />
              Export Excel
            </ButtonLink>
          </div>
        </div>

        <Card>
          {sessions.length > 0 ? (
            <Table>
              <thead>
                <tr>
                  <Th>Group</Th>
                  <Th>Started By</Th>
                  <Th>Started</Th>
                  <Th>Duration</Th>
                  <Th>Status</Th>
                  <Th>Completed By</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <Td className="font-medium">{s.groupName}</Td>
                    <Td>{s.startedByName ?? "—"}</Td>
                    <Td className="whitespace-nowrap">{formatDateTime(s.startedAt)}</Td>
                    <Td className="tabular-nums whitespace-nowrap">
                      {s.status === "OPEN"
                        ? `${s.isStale ? "Needs attention" : "In progress"} · ${formatElapsedShort(s.startedAt)}`
                        : formatDurationShort(s.durationSeconds ?? 0)}
                    </Td>
                    <Td>
                      {s.status === "OPEN" ? (
                        <Badge color={s.isStale ? "yellow" : "blue"} dot pulse={!s.isStale}>
                          {s.isStale ? "Needs attention" : "Open"}
                        </Badge>
                      ) : (
                        <Badge color="green">Completed</Badge>
                      )}
                    </Td>
                    <Td>{s.completedByLabel ?? "—"}</Td>
                    <Td>
                      {s.status === "OPEN" ? (
                        <CloseSessionButton
                          sessionId={s.id}
                          groupName={s.groupName}
                          startedAtIso={s.startedAt.toISOString()}
                        />
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState>
              No support sessions yet — they'll appear here once a team member starts handling a
              WhatsApp group.
            </EmptyState>
          )}
        </Card>
      </section>
    </div>
  );
}
