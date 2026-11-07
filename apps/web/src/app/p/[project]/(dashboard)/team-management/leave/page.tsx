import { addCalendarDays, formatDhakaDateKey } from "@support-automation/shared";
import { prisma } from "@/server/db";

import { requireSession } from "@/server/auth";
import { hasPermission, requirePermission } from "@/server/permissions";
import { getLeaveRequests } from "@/server/teamManagementReports";
import { PageHeader, StatTile } from "@/components/ui";
import { LeaveManager } from "./LeaveManager";
import { LeaveSetup } from "./LeaveSetup";

/**
 * Leave: requested, approved, rejected.
 *
 * Manager-entered for now. `LeaveRequest.requestedByUserId` has been on the row since the first
 * migration so employee self-service is additive later rather than a schema change that leaves
 * every existing row claiming the wrong person asked.
 */
export default async function LeavePage() {
  const session = await requireSession();
  await requirePermission(session, "team_management.view");
  const canManage = await hasPermission(session, "team_management.manage");

  const [requests, members, leaveTypes] = await Promise.all([
    getLeaveRequests(),
    prisma.internalTeamMember.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.leaveType.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: [{ position: "asc" }, { name: "asc" }],
    }),
  ]);

  // Leave dates are whole Dhaka days, stored as dates.
  const today = formatDhakaDateKey(new Date());
  const day = (when: Date) => when.toISOString().slice(0, 10);
  const inSevenDays = addCalendarDays(today, 7);
  const approved = requests.filter((r) => r.status === "APPROVED");
  const awayToday = approved.filter((r) => day(r.startDate) <= today && day(r.endDate) >= today);
  const startingSoon = approved.filter((r) => day(r.startDate) > today && day(r.startDate) <= inSevenDays);
  const waiting = requests.filter((r) => r.status === "REQUESTED");
  const names = (rows: typeof requests) => [...new Set(rows.map((r) => r.memberName))].slice(0, 3).join(", ");

  return (
    <div>
      <PageHeader
        title="Leave"
        description="Approving leave keeps the duty rows that already existed and marks them as leave, so the shifts they were on report the gap instead of quietly looking empty."
      />

      {leaveTypes.length === 0 ? <LeaveSetup canManage={canManage} /> : null}

      {requests.length > 0 ? (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatTile label="Waiting for a decision" value={waiting.length} tone={waiting.length > 0 ? "warning" : "neutral"} hint={names(waiting) || undefined} />
          <StatTile label="Away today" value={awayToday.length} hint={names(awayToday) || undefined} />
          <StatTile label="Starting in 7 days" value={startingSoon.length} hint={names(startingSoon) || undefined} />
        </div>
      ) : null}

      <LeaveManager requests={requests} members={members} leaveTypes={leaveTypes} canManage={canManage} />
    </div>
  );
}
