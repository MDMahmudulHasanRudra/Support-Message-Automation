
import { prisma } from "@/server/db";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { PageHeader } from "@/components/ui";
import { getTeamManagementSettings } from "@/server/teamManagementReports";
import { LeaveTypesAndHolidays } from "./LeaveTypesAndHolidays";
import { PunctualitySettings } from "./PunctualitySettings";

/** Leave types, holidays and the punctuality policy — the things this module refuses to assume. */
export default async function TeamManagementSettingsPage() {
  const session = await requireSession();
  await requirePermission(session, "team_management.manage");

  const [leaveTypes, holidays, settings] = await Promise.all([
    prisma.leaveType.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }] }),
    prisma.holiday.findMany({ orderBy: { date: "desc" }, take: 100 }),
    getTeamManagementSettings(),
  ]);

  return (
    <div>
      <PageHeader
        title="Team Management settings"
        description="Your leave types, your holiday calendar, and how much lateness counts as on time. Entitlement and public holidays ship empty on purpose — they are decisions for the business, not for this software."
      />
      <PunctualitySettings
        latenessGraceMinutes={settings.latenessGraceMinutes}
        earlyDepartureGraceMinutes={settings.earlyDepartureGraceMinutes}
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
