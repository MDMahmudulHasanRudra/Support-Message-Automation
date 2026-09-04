/* eslint-disable react/no-unescaped-entities -- long-form Help prose reads better with real apostrophes */
import Link from "next/link";
import { Download } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { getDhakaDayRange, getDhakaMonthRange, getDhakaWeekRange } from "@/lib/supportActivityPeriod";
import { formatDurationShort } from "@/lib/duration";
import { getExecutiveWorkload, getTeamAvailability } from "@/server/supportActivityReports";
import {
  Badge,
  ButtonLink,
  Card,
  EmptyState,
  HelpButton,
  HelpSection,
  PageHeader,
  SectionHeader,
  StatusDot,
  StatTile,
  Table,
  Td,
  Th,
} from "@/components/ui";

/**
 * Who handled what, and for how long.
 *
 * Rebuilt around one question an admin actually asks — "how much is each executive carrying?" —
 * and answered for all three periods at once rather than whichever one the global counting-period
 * setting happens to be on. Comparing today against the month is the point of the page; making
 * that a settings change was making the reader do the work.
 *
 * Time is measured from each person's first message to their last, within one group on one day.
 * It replaces the old hours-worked figure, which summed SupportSession.durationSeconds and was
 * therefore permanently empty on any deployment whose rules do not carry a completion keyword —
 * including the common "every team member message counts" setup.
 */

const PERIODS = ["today", "week", "month"] as const;
type PeriodKey = (typeof PERIODS)[number];

const PERIOD_LABEL: Record<PeriodKey, string> = {
  today: "Today",
  week: "This week",
  month: "This month",
};

function isPeriod(value: string | undefined): value is PeriodKey {
  return PERIODS.includes((value ?? "") as PeriodKey);
}

export default async function SupportActivityTeamPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  await requireSession();
  const params = await searchParams;
  const period: PeriodKey = isPeriod(params.period) ? params.period : "today";

  const now = new Date();
  const ranges = {
    today: getDhakaDayRange(now),
    week: getDhakaWeekRange(now),
    month: getDhakaMonthRange(now),
  } as const;
  const range = ranges[period];

  // All three periods at once. Each is a single grouped query, so the comparison costs three
  // round trips rather than the per-member fan-out the previous page did.
  const [todayRows, weekRows, monthRows, availability, activeMembers] = await Promise.all([
    getExecutiveWorkload(ranges.today),
    getExecutiveWorkload(ranges.week),
    getExecutiveWorkload(ranges.month),
    getTeamAvailability(now),
    prisma.internalTeamMember.count({ where: { status: "ACTIVE" } }),
  ]);

  const rowsFor: Record<PeriodKey, typeof todayRows> = { today: todayRows, week: weekRows, month: monthRows };
  const rows = rowsFor[period];

  const onlineNow = availability.filter((member) => member.availableNow).length;
  const totalGroups = rows.reduce((sum, row) => sum + row.groupsHandled, 0);
  const totalMessages = rows.reduce((sum, row) => sum + row.messageCount, 0);
  const totalSeconds = rows.reduce((sum, row) => sum + row.activeSeconds, 0);

  const exportParams = `from=${range.start.toISOString()}&to=${range.end.toISOString()}`;

  return (
    <div>
      <PageHeader
        title="Team Performance"
        description="How much support each executive is carrying — groups handled, messages sent, and time engaged."
        actions={
          <div className="flex items-center gap-2">
            <ButtonLink href={`/api/support-activity/export?${exportParams}`}>
              <Download className="size-3.5" aria-hidden />
              Export
            </ButtonLink>
            <HelpButton moduleTitle="Team Performance">
              <HelpSection title="How time is measured">
                <p>
                  From each person's first message to their last, within one group on one day,
                  added up across every such span. Per group and per day on purpose: one span
                  across a week would count the nights in between, and one span across every group
                  at once would count the time they were busy elsewhere.
                </p>
              </HelpSection>
              <HelpSection title="Why a day can show zero minutes">
                <p>
                  Somebody who sent a single message in a group has no duration to measure — one
                  reply is a moment, not a span. The message count beside it is what tells you they
                  were working; the time column tells you how long they stayed with it.
                </p>
              </HelpSection>
              <HelpSection title="What counts as support">
                <p>
                  Any message a team member sends in a group, if you are running the "every message
                  counts" rule. Nothing here includes AI replies — those are tracked separately and
                  can never be attributed to a person.
                </p>
              </HelpSection>
            </HelpButton>
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap gap-1.5">
        {PERIODS.map((key) => (
          <Link
            key={key}
            href={key === "today" ? "/support-activity/team" : `/support-activity/team?period=${key}`}
            className={`rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-medium transition-colors ${
              period === key
                ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-primary)]"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)]"
            }`}
          >
            {PERIOD_LABEL[key]}
          </Link>
        ))}
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Executives active"
          value={`${rows.length} of ${activeMembers}`}
          hint={`Handled support ${PERIOD_LABEL[period].toLowerCase()}`}
        />
        <StatTile label="Groups covered" value={totalGroups} hint="Counted once per executive" />
        <StatTile label="Messages sent" value={totalMessages.toLocaleString()} hint="By people, not AI" />
        <StatTile
          label="Time engaged"
          value={totalSeconds > 0 ? formatDurationShort(totalSeconds) : "—"}
          hint={onlineNow > 0 ? `${onlineNow} online now` : "Across the whole team"}
        />
      </div>

      <Card>
        <SectionHeader
          title={`Each executive — ${PERIOD_LABEL[period].toLowerCase()}`}
          description="Busiest first. Compare a person's own columns across the three periods above to see whether their load is rising."
        />

        {rows.length === 0 ? (
          <EmptyState>
            No support recorded {PERIOD_LABEL[period].toLowerCase()}. This fills in as team members
            message in groups — check that your roster is complete on{" "}
            <Link className="link" href="/team-members">
              Team Members
            </Link>
            .
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Executive</Th>
                <Th>Groups</Th>
                <Th>Messages</Th>
                <Th>Time engaged</Th>
                <Th>First</Th>
                <Th>Last</Th>
                <Th>Today / week / month</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const inToday = todayRows.find((r) => r.teamMemberId === row.teamMemberId);
                const inWeek = weekRows.find((r) => r.teamMemberId === row.teamMemberId);
                const inMonth = monthRows.find((r) => r.teamMemberId === row.teamMemberId);
                const online = availability.find((a) => a.teamMemberId === row.teamMemberId)?.availableNow;

                return (
                  <tr key={row.teamMemberId}>
                    <Td>
                      <span className="flex items-center gap-2">
                        <StatusDot color={online ? "green" : "gray"} />
                        <span className="font-medium text-[color:var(--color-foreground)]">{row.name}</span>
                      </span>
                    </Td>
                    <Td className="tabular">{row.groupsHandled}</Td>
                    <Td className="tabular">{row.messageCount.toLocaleString()}</Td>
                    <Td className="tabular">
                      {row.activeSeconds > 0 ? (
                        formatDurationShort(row.activeSeconds)
                      ) : (
                        <span className="text-[color:var(--color-muted-foreground)]">—</span>
                      )}
                    </Td>
                    <Td className="tabular whitespace-nowrap text-[color:var(--color-muted-foreground)]">
                      {row.firstAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dhaka" })}
                    </Td>
                    <Td className="tabular whitespace-nowrap text-[color:var(--color-muted-foreground)]">
                      {row.lastAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dhaka" })}
                    </Td>
                    {/* The whole point of the page in one cell: is this person's load a spike or
                        their normal? */}
                    <Td className="tabular whitespace-nowrap text-[color:var(--color-muted-foreground)]">
                      {inToday?.groupsHandled ?? 0} / {inWeek?.groupsHandled ?? 0} / {inMonth?.groupsHandled ?? 0} groups
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {availability.length > 0 ? (
        <div className="mt-5">
          <Card>
            <SectionHeader
              title="Who is around"
              description="Green means active in the last few minutes, amber means they have worked today, grey means not yet."
            />
            <div className="flex flex-wrap gap-2">
              {availability.map((member) => (
                <Badge key={member.teamMemberId} color={member.availableNow ? "green" : member.workingToday ? "yellow" : "gray"} dot>
                  {member.name}
                </Badge>
              ))}
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
