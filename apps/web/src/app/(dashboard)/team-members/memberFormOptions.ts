import { prisma } from "@support-automation/db";
import type { MemberFormOptions } from "./MemberFormFields";

/** What the member forms offer: the Teams, plus designations and departments already in use. */
export async function loadMemberFormOptions(): Promise<MemberFormOptions> {
  const [teams, designations, departments] = await Promise.all([
    prisma.team.findMany({ select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
    prisma.internalTeamMember.findMany({ distinct: ["role"], select: { role: true }, orderBy: { role: "asc" } }),
    prisma.internalTeamMember.findMany({
      where: { department: { not: null } },
      distinct: ["department"],
      select: { department: true },
      orderBy: { department: "asc" },
    }),
  ]);
  return {
    teams,
    designations: designations.map((row) => row.role).filter((value) => value.trim().length > 0),
    departments: departments.map((row) => row.department!).filter((value) => value.trim().length > 0),
  };
}
