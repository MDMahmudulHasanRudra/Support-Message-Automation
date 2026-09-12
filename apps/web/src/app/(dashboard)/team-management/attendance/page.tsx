import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { hasPermission, requirePermission } from "@/server/permissions";
import { formatDhakaDateKey, getDhakaDayRange, parseDhakaDayRangeFromInput } from "@/lib/supportActivityPeriod";
import { formatDate } from "@/lib/date";
import { formatShiftRange, getDutyHistory } from "@/server/teamManagementReports";
import { Alert, Button, Card, EmptyState, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { DutyStateBadge } from "../DutyStateBadge";
import { AttendanceOverride } from "./AttendanceOverride";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Duty history: what was planned, what the messages showed, and the reading of the two.
 *
 * Rows come from `DutyAssignment`, so this lists dates somebody actually scheduled. A day nobody
 * rostered has nothing to compare against and would be a row of dashes claiming to mean something.
 *
 * The filters are a GET form, like every other filter in this app — a range can be bookmarked and
 * shared, and survives a refresh.
 */
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; member?: string }>;
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

  const [rows, members] = await Promise.all([
    getDutyHistory(range, teamMemberId),
    prisma.internalTeamMember.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div>
      <PageHeader
        title="Duty history"
        description="Scheduled against observed. “No activity recorded” means no message was stored from that person that day — it is never a claim that they did not work."
        actions={
          <form method="GET" className="flex flex-wrap items-end gap-2">
            <Input
              type="date"
              name="from"
              defaultValue={formatDhakaDateKey(range.start)}
              aria-label="From"
              className="w-40"
            />
            <Input
              type="date"
              name="to"
              defaultValue={formatDhakaDateKey(new Date(range.end.getTime() - 1))}
              aria-label="To"
              className="w-40"
            />
            <Select name="member" defaultValue={teamMemberId ?? ""} aria-label="Team member" className="w-48">
              <option value="">Everyone</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
          </form>
        }
      />

      {rows.length >= 500 ? (
        <Alert tone="info">Showing the most recent 500 rows. Narrow the dates or pick one person to see the rest.</Alert>
      ) : null}

      <Card>
        {rows.length === 0 ? (
          <EmptyState>
            No roster entries in this range. Attendance is compared against a scheduled day — build the roster first.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Team member</Th>
                <Th>Scheduled</Th>
                <Th>Messages</Th>
                <Th>Groups</Th>
                <Th>Reading</Th>
                {canManage ? <Th> </Th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <Td className="whitespace-nowrap">{formatDate(row.dutyDate)}</Td>
                  <Td className="font-medium">{row.memberName}</Td>
                  <Td>
                    {row.shiftName ? (
                      <>
                        <div>{row.shiftName}</div>
                        <div className="text-xs tabular-nums text-[color:var(--color-muted-foreground)]">
                          {formatShiftRange(row.shiftStartMinute, row.shiftEndMinute)}
                        </div>
                      </>
                    ) : (
                      <span className="text-[color:var(--color-muted-foreground)]">
                        {row.status?.toLowerCase().replace("_", " ") ?? "—"}
                      </span>
                    )}
                  </Td>
                  <Td className="tabular-nums">{row.messageCount || "—"}</Td>
                  <Td className="tabular-nums">{row.uniqueGroupCount || "—"}</Td>
                  <Td>
                    <DutyStateBadge state={row.derived} />
                  </Td>
                  {canManage ? (
                    <Td>
                      <div className="flex justify-end">
                        <AttendanceOverride
                          teamMemberId={row.teamMemberId}
                          memberName={row.memberName}
                          date={formatDhakaDateKey(row.dutyDate)}
                          current={row.override}
                          currentReason={row.overrideReason}
                        />
                      </div>
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
