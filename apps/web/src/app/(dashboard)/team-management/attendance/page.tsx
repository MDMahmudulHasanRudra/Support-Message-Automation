import { prisma } from "@support-automation/db";
import { formatMinutesShort } from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { hasPermission, requirePermission } from "@/server/permissions";
import { formatDhakaDateKey, getDhakaDayRange, parseDhakaDayRangeFromInput } from "@/lib/supportActivityPeriod";
import { formatDate, formatDateTime } from "@/lib/date";
import {
  formatShiftRange,
  getDutyHistory,
  groupDutyHistoryByMember,
  summariseDutyHistory,
} from "@/server/teamManagementReports";
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Pagination,
  Select,
  StatTile,
} from "@/components/ui";
import { DutyHistoryByMemberTable, DutyHistoryTable } from "./DutyHistoryTable";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Duty history: what was planned, what the messages showed, and the reading of the two.
 *
 * Rows come from `DutyAssignment`, so this lists dates somebody actually scheduled. A day nobody
 * rostered has nothing to compare against and would be a row of dashes claiming to mean something.
 *
 * The filters are a GET form, like every other filter in this app — a range can be bookmarked and
 * shared, and survives a refresh. The view toggle is part of that same form so switching between
 * by-day and by-person keeps the range you were looking at.
 *
 * The summary and the per-person fold are computed from the SAME rows the table renders, never
 * from a second set of queries. Two independent paths to one figure is how a summary comes to
 * disagree with the list beneath it, and a page that contradicts itself is worse than one with no
 * summary at all.
 */
/** A 20-person roster over a month is 600 rows, so the old hard 500 truncated the ordinary
 *  monthly review with no page two. */
const PAGE_SIZE_OPTIONS = [100, 500, 1000] as const;
const DEFAULT_PAGE_SIZE = 500;

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    member?: string;
    view?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const session = await requireSession();
  await requirePermission(session, "team_management.view");
  const canManage = await hasPermission(session, "team_management.manage");

  const params = await searchParams;
  const now = new Date();
  const parsed = parseDhakaDayRangeFromInput(params.from, params.to);
  // Default: the last two weeks, which is the window somebody checking a timesheet is usually in.
  const range = parsed ?? { start: new Date(getDhakaDayRange(now).start.getTime() - 13 * DAY_MS), end: getDhakaDayRange(now).end };
  const teamMemberId = params.member && params.member !== "" ? params.member : undefined;
  const byMember = params.view === "member";

  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const requestedPageSize = Number(params.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize as (typeof PAGE_SIZE_OPTIONS)[number])
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;

  const [history, members] = await Promise.all([
    getDutyHistory(range, teamMemberId, page, pageSize),
    prisma.internalTeamMember.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const rows = history.rows;

  const buildHref = (nextPage: number, nextPageSize = pageSize): string => {
    const qs = new URLSearchParams();
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (teamMemberId) qs.set("member", teamMemberId);
    if (byMember) qs.set("view", "member");
    if (nextPage > 1) qs.set("page", String(nextPage));
    if (nextPageSize !== DEFAULT_PAGE_SIZE) qs.set("pageSize", String(nextPageSize));
    const query = qs.toString();
    return query ? `/team-management/attendance?${query}` : "/team-management/attendance";
  };

  const summary = summariseDutyHistory(rows);
  // Folded once, not once per use. Pure over at most 500 rows either way, but the count in the
  // caption and the table beneath it must be the same fold or they can disagree about the page.
  const memberRows = byMember ? groupDutyHistoryByMember(rows) : [];
  const fromKey = formatDhakaDateKey(range.start);
  const toKey = formatDhakaDateKey(new Date(range.end.getTime() - 1));
  const exportQuery = new URLSearchParams({
    from: range.start.toISOString(),
    to: range.end.toISOString(),
    ...(teamMemberId ? { member: teamMemberId } : {}),
    ...(byMember ? { view: "member" } : {}),
  });

  return (
    <div>
      <PageHeader
        title="Duty history"
        description="Scheduled against observed. “No activity recorded” means no message was stored from that person that day — it is never a claim that they did not work."
        actions={
          <form method="GET" className="flex flex-wrap items-end gap-2">
            <Input type="date" name="from" defaultValue={fromKey} aria-label="From" className="w-40" />
            <Input type="date" name="to" defaultValue={toKey} aria-label="To" className="w-40" />
            <Select name="member" defaultValue={teamMemberId ?? ""} aria-label="Team member" className="w-48">
              <option value="">Everyone</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </Select>
            <Select name="view" defaultValue={byMember ? "member" : "day"} aria-label="View" className="w-36">
              <option value="day">By day</option>
              <option value="member">By person</option>
            </Select>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
          </form>
        }
      />

      {rows.length > 0 ? (
        <div className="mb-5 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
          <StatTile label="Days scheduled" value={summary.daysScheduled} hint={`${fromKey} → ${toKey}`} />
          <StatTile
            label="Days with activity"
            value={summary.daysWorked}
            hint={summary.noActivityDays > 0 ? `${summary.noActivityDays} with none recorded` : "every scheduled day"}
          />
          <StatTile
            label="Late starts"
            value={summary.lateStarts}
            tone={summary.lateStarts > 0 ? "warning" : "neutral"}
            hint={summary.earlyFinishes > 0 ? `${summary.earlyFinishes} early finishes` : "past the configured grace"}
          />
          <StatTile
            label="Typical day"
            value={formatMinutesShort(summary.medianEngagedMinutes)}
            hint={`median span · ${summary.totalMessages.toLocaleString()} messages`}
          />
        </div>
      ) : null}

      {/* The summary tiles above are folded from THIS page's rows, so with more than one page they
          describe what is on screen rather than the whole range. Said plainly, because a timesheet
          total that silently means "the first 500" is the kind of number somebody pays against. */}
      {history.total > rows.length ? (
        <Alert tone="info">
          {history.total.toLocaleString()} scheduled days in this range. The figures above cover the{" "}
          {rows.length.toLocaleString()} on this page — narrow the dates, pick one person, or export the
          full range for totals across all of it.
        </Alert>
      ) : null}

      <Card>
        {rows.length === 0 ? (
          <EmptyState>
            No roster entries in this range. Attendance is compared against a scheduled day — build the roster first.
          </EmptyState>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-[color:var(--color-muted-foreground)]">
                {byMember
                  ? `${memberRows.length} people · ${summary.daysScheduled} scheduled days`
                  : `${summary.daysScheduled} scheduled days · expand a row for the groups behind it`}
              </p>
              <div className="flex gap-2">
                {/* Real anchors, not client handlers: a file download cannot come from a Server
                    Action, which is why this module's siblings use a Route Handler too. */}
                <ButtonLink href={`/api/team-management/export?format=csv&${exportQuery}`} variant="secondary">
                  CSV
                </ButtonLink>
                <ButtonLink href={`/api/team-management/export?format=xlsx&${exportQuery}`} variant="secondary">
                  Excel
                </ButtonLink>
              </div>
            </div>

            {byMember ? (
              <DutyHistoryByMemberTable rows={memberRows} />
            ) : (
              <DutyHistoryTable
                canManage={canManage}
                rows={rows.map((row) => ({
                  id: row.id,
                  dutyDateIso: formatDhakaDateKey(row.dutyDate),
                  dutyDateLabel: formatDate(row.dutyDate),
                  teamMemberId: row.teamMemberId,
                  memberName: row.memberName,
                  statusLabel: row.status?.toLowerCase().replace("_", " ") ?? null,
                  shiftName: row.shiftName,
                  shiftRange: formatShiftRange(row.shiftStartMinute, row.shiftEndMinute),
                  messageCount: row.messageCount,
                  uniqueGroupCount: row.uniqueGroupCount,
                  startedMinute: row.punctuality.startedMinute,
                  endedMinute: row.punctuality.endedMinute,
                  engagedMinutes: row.punctuality.engagedMinutes,
                  lateByMinutes: row.punctuality.lateByMinutes,
                  leftEarlyByMinutes: row.punctuality.leftEarlyByMinutes,
                  isLate: row.punctuality.isLate,
                  isEarlyFinish: row.punctuality.isEarlyFinish,
                  derived: row.derived,
                  override: row.override,
                  overrideReason: row.overrideReason,
                  overriddenByName: row.overriddenByName,
                  overriddenAtLabel: row.overriddenAt ? formatDateTime(row.overriddenAt) : null,
                }))}
              />
            )}
          </>
        )}
      </Card>

      {rows.length > 0 ? (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={history.total}
          buildHref={(p) => buildHref(p)}
          pageSizeOptions={[...PAGE_SIZE_OPTIONS]}
          buildPageSizeHref={(size) => buildHref(1, size)}
          sticky
        />
      ) : null}
    </div>
  );
}
