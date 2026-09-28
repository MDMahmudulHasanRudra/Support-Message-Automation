
import { prisma } from "@/server/db";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { Card, PageHeader, SectionHeader } from "@/components/ui";
import { ShiftTemplateManager } from "./ShiftTemplateManager";
import { MemberDefaultShift } from "./MemberDefaultShift";

/**
 * Shift templates and each person's default.
 *
 * Nothing in this codebase hardcodes 10–19, 12–21 or 13–22. The seed creates those three because
 * they are what this team works today; every one of them can be renamed, re-timed or disabled from
 * this page, and the business logic only ever reads the table.
 */
export default async function ShiftTemplatesPage() {
  const session = await requireSession();
  await requirePermission(session, "team_management.manage");

  const [templates, counts, members] = await Promise.all([
    prisma.shiftTemplate.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }] }),
    prisma.dutyAssignment.groupBy({ by: ["shiftTemplateId"], _count: { _all: true } }),
    prisma.internalTeamMember.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, role: true, defaultShiftTemplateId: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const countByTemplate = new Map(counts.map((row) => [row.shiftTemplateId, row._count._all]));

  return (
    <div>
      <PageHeader
        title="Shifts"
        description="The shifts your team works. Editing one changes what it means from now on; dates already on the roster keep the hours they were assigned with."
      />

      <ShiftTemplateManager
        templates={templates.map((row) => ({
          id: row.id,
          name: row.name,
          startMinute: row.startMinute,
          endMinute: row.endMinute,
          requiredHeadcount: row.requiredHeadcount,
          colourSlot: row.colourSlot,
          description: row.description,
          isActive: row.isActive,
          position: row.position,
          assignmentCount: countByTemplate.get(row.id) ?? 0,
        }))}
      />

      <div className="mt-10">
        <SectionHeader
          title="Default shift per person"
          description="A starting point for building their weekly pattern — never a rule about a date. Changing it here has no effect on any day already scheduled."
        />
        <Card>
          <MemberDefaultShift
            members={members}
            templates={templates.filter((row) => row.isActive).map((row) => ({ id: row.id, name: row.name }))}
          />
        </Card>
      </div>
    </div>
  );
}
