import "./helpers/requireTestDatabase.js";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";

/**
 * Multi-project Phase 1 (MULTI_PROJECT_PLAN.md §10.1): the database foundation, with no behaviour
 * change. These pin the properties later phases rely on — that the original installation IS the
 * project ISP Digital, that every existing write path still lands there without naming a project,
 * and that the per-project constraints exist next to the old ones.
 */

const ISP_DIGITAL = "proj_isp_digital";
const createdTeamIds: string[] = [];

afterAll(async () => {
  if (createdTeamIds.length) await prisma.team.deleteMany({ where: { id: { in: createdTeamIds } } });
  await prisma.$disconnect();
});

describe("ISP Digital is the original installation", () => {
  it("exists, active, with the slug the routes will use", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: ISP_DIGITAL } });
    expect(project).toMatchObject({ name: "ISP Digital", slug: "isp-digital", status: "ACTIVE" });
  });

  it("an existing write path that names no project still lands in ISP Digital", async () => {
    // Exactly how every create() in the app looks today — no projectId anywhere.
    const team = await prisma.team.create({ data: { name: `Foundation Test ${randomUUID()}` } });
    createdTeamIds.push(team.id);
    expect(team.projectId).toBe(ISP_DIGITAL);
  });

  it("the settings singletons belong to ISP Digital", async () => {
    const settings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
    expect(settings.projectId).toBe(ISP_DIGITAL);
  });
});

describe("the constraints later phases depend on", () => {
  const indexNames = async (table: string) =>
    (
      await prisma.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE tablename = ${table}`
    ).map((row) => row.indexname);

  it("per-project uniques exist NEXT TO the install-wide ones (both, until Phase 2)", async () => {
    const team = await indexNames("Team");
    expect(team).toEqual(expect.arrayContaining(["Team_name_key", "Team_projectId_name_key"]));
    const member = await indexNames("InternalTeamMember");
    expect(member).toEqual(
      expect.arrayContaining(["InternalTeamMember_phoneNumber_key", "InternalTeamMember_projectId_phoneNumber_key"]),
    );
    const account = await indexNames("WhatsAppAccount");
    expect(account).toEqual(expect.arrayContaining(["WhatsAppAccount_projectId_primary_key"]));
  });

  it("every project-scoped table has a validated foreign key to Project", async () => {
    const rows = await prisma.$queryRaw<Array<{ table: string; validated: boolean }>>`
      SELECT conrelid::regclass::text AS table, convalidated AS validated
      FROM pg_constraint
      WHERE contype = 'f' AND confrelid = '"Project"'::regclass AND conname LIKE '%\\_projectId\\_fkey'`;
    // 70 project-scoped tables + SystemLog + ProjectAccess + ProjectFeature.
    expect(rows).toHaveLength(73);
    expect(rows.every((row) => row.validated)).toBe(true);
  });

  it("Forge's own project columns were renamed, not overwritten", async () => {
    const columns = (
      await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'ForgeSettings'`
    ).map((row) => row.column_name);
    expect(columns).toEqual(expect.arrayContaining(["projectId", "forgeProjectId", "forgeProjectName"]));
    expect(columns).not.toContain("projectName");
  });
});
