import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { PageHeader } from "@/components/ui";
import { LeaveTypesAndHolidays } from "./LeaveTypesAndHolidays";

/** Leave types and holidays — the two things this module deliberately refuses to assume. */
export default async function TeamManagementSettingsPage() {
  const session = await requireSession();
  await requirePermission(session, "team_management.manage");

  const [leaveTypes, holidays] = await Promise.all([
    prisma.leaveType.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }] }),
    prisma.holiday.findMany({ orderBy: { date: "desc" }, take: 100 }),
  ]);

  return (
    <div>
      <PageHeader
        title="Team Management settings"
        description="Your leave types and your holiday calendar. Nothing here ships with a default — entitlement and public holidays are decisions for the business, not for this software."
      />
      <LeaveTypesAndHolidays
        leaveTypes={leaveTypes.map((row) => ({
          id: row.id,
          name: row.name,
          annualAllowanceDays: row.annualAllowanceDays,
          isPaid: row.isPaid,
          isActive: row.isActive,
          position: row.position,
        }))}
        holidays={holidays.map((row) => ({
          id: row.id,
          name: row.name,
          date: row.date.toISOString().slice(0, 10),
          description: row.description,
        }))}
      />
    </div>
  );
}
