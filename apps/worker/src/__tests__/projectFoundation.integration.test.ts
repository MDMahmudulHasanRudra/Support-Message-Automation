import "./helpers/requireTestDatabase.js";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";

/**
 * Multi-project database foundation (MULTI_PROJECT_PLAN.md §10.1, as finished by Phase 3 §10.3).
 * These pin the properties the scoped clients rely on — that the original installation IS the
 * project ISP Digital, that a write naming no project is now REFUSED rather than quietly landing
 * there, and that only the per-project constraints remain.
 *
 * Deliberately the RAW client: this is the database's own behaviour, beneath any scoping.
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

  it("a write that names no project is refused — there is no default project any more (Phase 3)", async () => {
    // Phases 1 and 2 defaulted this to ISP Digital. Now the column's default raises, so a write
    // that escaped every scoped client fails instead of silently joining the original project.
    await expect(prisma.team.create({ data: { name: `Foundation Test ${randomUUID()}` } })).rejects.toThrow(
      /Null constraint violation|projectId is required/,
    );
    const raw = prisma.$executeRawUnsafe(`INSERT INTO "Team" ("id", "name", "updatedAt") VALUES ('${randomUUID()}', 'raw', now())`);
    await expect(raw).rejects.toThrow(/23502|projectId is required/); // not_null_violation, raised by project_id_required()
  });

  it("a write that names its project lands there", async () => {
    const team = await prisma.team.create({ data: { name: `Foundation Test ${randomUUID()}`, projectId: ISP_DIGITAL } });
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

  it("only the per-project uniques remain; the install-wide ones are gone (Phase 3)", async () => {
    const team = await indexNames("Team");
    expect(team).toEqual(expect.arrayContaining(["Team_projectId_name_key", "Team_projectId_code_key"]));
    expect(team).not.toEqual(expect.arrayContaining(["Team_name_key"]));
    expect(team).not.toEqual(expect.arrayContaining(["Team_code_key"]));
    const member = await indexNames("InternalTeamMember");
    expect(member).toEqual(expect.arrayContaining(["InternalTeamMember_projectId_phoneNumber_key"]));
    expect(member).not.toEqual(expect.arrayContaining(["InternalTeamMember_phoneNumber_key"]));
    const account = await indexNames("WhatsAppAccount");
    expect(account).toEqual(expect.arrayContaining(["WhatsAppAccount_projectId_primary_key"]));
    expect(account).not.toEqual(expect.arrayContaining(["WhatsAppAccount_isPrimary_unique"]));
  });

  it("no project-scoped column still defaults to ISP Digital", async () => {
    const rows = await prisma.$queryRaw<Array<{ table: string; column_default: string | null }>>`
      SELECT table_name AS table, column_default FROM information_schema.columns
      WHERE column_name = 'projectId' AND table_schema = 'public'`;
    const defaultingToIsp = rows.filter((row) => (row.column_default ?? "").includes(ISP_DIGITAL));
    // Singletons' own "id" default is 'global', never the project, so nothing may name it here.
    expect(defaultingToIsp.map((row) => row.table)).toEqual([]);
    const refusing = rows.filter((row) => (row.column_default ?? "").includes("project_id_required()"));
    // 70 at Phase 1, + GroupAdminPromotionJob and GroupAdminPromotionItem (Groups Admin Maker),
    // + MessageMedia, MediaStorageSettings and MediaCleanupJob (Message & Media Storage),
    // + SupportResponseEpisode (Unanswered Groups / Response Time),
    // + CollectionGap (reporting data health), + WhatsAppOperationDismissal (Clear / Hide),
    // + the four Mood Detection tables.
    expect(refusing).toHaveLength(82);
  });

  it("catalogue-keyed tables are keyed per project", async () => {
    const pk = await prisma.$queryRaw<Array<{ table: string; columns: string }>>`
      SELECT c.conrelid::regclass::text AS table,
             string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum)) AS columns
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'p' AND c.conrelid::regclass::text IN ('"NotificationTemplate"', '"NotificationEventSetting"', '"WhatsAppServiceRoute"')
      GROUP BY c.conrelid`;
    expect(Object.fromEntries(pk.map((row) => [row.table, row.columns]))).toEqual({
      '"NotificationTemplate"': "projectId,key",
      '"NotificationEventSetting"': "projectId,event",
      '"WhatsAppServiceRoute"': "projectId,serviceKey",
    });
  });

  it("every project-scoped table has a validated foreign key to Project", async () => {
    const rows = await prisma.$queryRaw<Array<{ table: string; validated: boolean }>>`
      SELECT conrelid::regclass::text AS table, convalidated AS validated
      FROM pg_constraint
      WHERE contype = 'f' AND confrelid = '"Project"'::regclass AND conname LIKE '%\\_projectId\\_fkey'`;
    // 82 project-scoped tables (70 at Phase 1 + the two Groups Admin Maker tables + the three Message
    // & Media Storage tables + SupportResponseEpisode + CollectionGap + WhatsAppOperationDismissal
    // + the four Mood Detection tables) + SystemLog + ProjectAccess + ProjectFeature.
    expect(rows).toHaveLength(85);
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
