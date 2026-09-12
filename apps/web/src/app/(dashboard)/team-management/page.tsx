import Link from "next/link";
import { AlertTriangle, CalendarDays, Users } from "lucide-react";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { formatDhakaDateKey } from "@/lib/supportActivityPeriod";
import { formatTime } from "@/lib/date";
import {
  formatShiftRange,
  getCoverageForDate,
  getRosterForDate,
  getTeamOverview,
} from "@/server/teamManagementReports";
import {
  Badge,
  ButtonLink,
  Card,
  EmptyState,
  PageHeader,
  SectionHeader,
  StatTile,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { DutyStateBadge } from "./DutyStateBadge";

/**
 * Today, as it actually stands.
 *
 * Deliberately **not** a Present/Absent dashboard. This app knows who sent messages; it does not
 * know who is at their desk, and a page that prints "Absent" from silence would be stating as fact
 * something it inferred from the absence of evidence. So every row shows the plan, the evidence and
 * the reading of the two, and the reading never says absent unless a manager said so.
 *
 * It also does not duplicate `/support-activity/team`, which owns online-now, engaged time and
 * first-response stats. This page owns SCHEDULE VERSUS REALITY and links across for the rest.
 */
export default async function TeamManagementPage() {
  const session = await requireSession();
  await requirePermission(session, "team_management.view");

  const now = new Date();
  // Roster and coverage are read once and handed to the summary, which would otherwise re-run both
  // of them — the tiles and the tables below are two views of the same fetch, not two questions.
  const [roster, coverage] = await Promise.all([getRosterForDate(now), getCoverageForDate(now)]);
  const overview = await getTeamOverview(now, { roster, coverage });

  const today = formatDhakaDateKey(now);
  const gaps = coverage.filter((row) => row.gap > 0);
  const attention = roster.filter(
    (row) => row.derived === "LEAVE_CONFLICT" || row.derived === "UNASSIGNED" || row.derived === "OFF_DAY_DUTY",
  );

  return (
    <div>
      <PageHeader
        title="Team Management"
        description="Who is scheduled today, what the messages show, and where the roster is short. Attendance is evidence from real group activity — never a presence claim."
        actions={
          <>
            <ButtonLink href={`/team-management/schedule?date=${today}`}>Roster</ButtonLink>
            <ButtonLink href="/team-management/leave">Leave</ButtonLink>
          </>
        }
      />

      <div className="mb-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Active in messages" value={overview.working} tone="success" hint="Sent at least one group message today" />
        <StatTile
          label="No activity recorded"
          value={overview.noActivity}
          hint="Scheduled on duty, nothing stored yet — not a claim they are away"
        />
        <StatTile
          label="Coverage gaps"
          value={overview.coverageGaps}
          tone={overview.coverageGaps > 0 ? "danger" : "neutral"}
          hint="Shifts below their required headcount after leave"
        />
        <StatTile
          label="Leave awaiting a decision"
          value={overview.pendingLeaveRequests}
          tone={overview.pendingLeaveRequests > 0 ? "warning" : "neutral"}
          href="/team-management/leave"
        />
        <StatTile label="On approved leave" value={overview.onLeave} />
        <StatTile label="Off or holiday" value={overview.off} />
        <StatTile label="Working an off day" value={overview.offDayDuty} tone={overview.offDayDuty > 0 ? "warning" : "neutral"} />
        <StatTile
          label="Not scheduled"
          value={overview.unassigned}
          tone={overview.unassigned > 0 ? "warning" : "neutral"}
          hint="Nobody has decided their day — different from an assigned day off"
        />
      </div>

      <div className="mb-8">
        <SectionHeader
          title="Coverage by shift"
          description="Effective coverage subtracts anyone on approved leave. Their duty row is kept, which is why the shift can read as short rather than simply empty."
        />
        <Card>
          {coverage.length === 0 ? (
            <EmptyState icon={<CalendarDays className="size-5" aria-hidden />}>
              No shifts defined yet. <Link href="/team-management/shifts" className="underline">Create the first one</Link>.
            </EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Shift</Th>
                  <Th>Hours</Th>
                  <Th>Required</Th>
                  <Th>Assigned</Th>
                  <Th>On leave</Th>
                  <Th>Effective</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {coverage.map((row) => (
                  <tr key={row.shiftTemplateId}>
                    <Td className="font-medium">{row.shiftName}</Td>
                    <Td className="tabular-nums">{formatShiftRange(row.startMinute, row.endMinute)}</Td>
                    <Td className="tabular-nums">{row.requiredHeadcount}</Td>
                    <Td className="tabular-nums">{row.assigned}</Td>
                    <Td className="tabular-nums">{row.unavailable || "—"}</Td>
                    <Td className="tabular-nums font-medium">{row.effective}</Td>
                    <Td>
                      {row.gap > 0 ? (
                        <Badge color="red" dot>
                          Short by {row.gap}
                        </Badge>
                      ) : (
                        <Badge color="green" dot>
                          Covered
                        </Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      {gaps.length > 0 || attention.length > 0 ? (
        <div className="mb-8">
          <SectionHeader
            title="Worth a look"
            description="Only the rows somebody has to decide something about. Everything else is on the roster below."
          />
          <Card className="p-4">
            <ul className="space-y-2 text-sm">
              {gaps.map((row) => (
                <li key={row.shiftTemplateId} className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[color:var(--color-danger)]" aria-hidden />
                  <span>
                    <strong>{row.shiftName}</strong> needs {row.requiredHeadcount} and has {row.effective}.{" "}
                    <Link href={`/team-management/schedule?date=${today}`} className="underline">
                      Assign cover
                    </Link>
                  </span>
                </li>
              ))}
              {attention.map((row) => (
                <li key={row.teamMemberId} className="flex items-start gap-2">
                  <AlertTriangle
                    className={`mt-0.5 size-4 shrink-0 ${
                      row.derived === "LEAVE_CONFLICT"
                        ? "text-[color:var(--color-danger)]"
                        : "text-[color:var(--color-warning)]"
                    }`}
                    aria-hidden
                  />
                  <span>
                    <strong>{row.name}</strong>{" "}
                    {row.derived === "LEAVE_CONFLICT"
                      ? `sent ${row.messageCount} message${row.messageCount === 1 ? "" : "s"} while on approved ${row.leaveTypeName ?? ""} leave.`
                      : row.derived === "OFF_DAY_DUTY"
                        ? `worked on a scheduled day off (${row.messageCount} message${row.messageCount === 1 ? "" : "s"}).`
                        : "has no duty set for today."}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}

      <SectionHeader
        title="Today's roster"
        description="Plan on the left, evidence in the middle, the reading of the two on the right."
      />
      <Card>
        {roster.length === 0 ? (
          <EmptyState icon={<Users className="size-5" aria-hidden />}>
            No active team members.{" "}
            <Link href="/team-members" className="underline">
              Add them under WhatsApp → Internal Team Members
            </Link>
            .
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Team member</Th>
                <Th>Scheduled</Th>
                <Th>Messages</Th>
                <Th>Groups</Th>
                <Th>First → last</Th>
                <Th>Reading</Th>
              </tr>
            </thead>
            <tbody>
              {roster.map((row) => (
                <tr key={row.teamMemberId}>
                  <Td>
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-[color:var(--color-muted-foreground)]">{row.role}</div>
                  </Td>
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
                        {row.status ? row.status.toLowerCase().replace("_", " ") : "not set"}
                      </span>
                    )}
                  </Td>
                  <Td className="tabular-nums">{row.messageCount || "—"}</Td>
                  <Td className="tabular-nums">{row.uniqueGroupCount || "—"}</Td>
                  <Td className="tabular-nums text-xs">
                    {row.firstActivityAt && row.lastActivityAt
                      ? `${formatTime(row.firstActivityAt)} → ${formatTime(row.lastActivityAt)}`
                      : "—"}
                  </Td>
                  <Td>
                    <DutyStateBadge state={row.derived} />
                    {row.overrideReason ? (
                      <div className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">{row.overrideReason}</div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
