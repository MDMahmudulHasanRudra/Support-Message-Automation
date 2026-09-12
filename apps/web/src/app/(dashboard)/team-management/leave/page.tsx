import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { hasPermission, requirePermission } from "@/server/permissions";
import { getLeaveRequests } from "@/server/teamManagementReports";
import { Alert, PageHeader } from "@/components/ui";
import { LeaveManager } from "./LeaveManager";

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

  return (
    <div>
      <PageHeader
        title="Leave"
        description="Approving leave keeps the duty rows that already existed and marks them as leave, so the shifts they were on report the gap instead of quietly looking empty."
      />

      {leaveTypes.length === 0 ? (
        <Alert tone="warning">
          No leave types defined.{" "}
          <Link href="/team-management/settings" className="underline">
            Add the kinds of leave your organisation offers
          </Link>{" "}
          — this app states no policy of its own.
        </Alert>
      ) : null}

      <LeaveManager requests={requests} members={members} leaveTypes={leaveTypes} canManage={canManage} />
    </div>
  );
}
