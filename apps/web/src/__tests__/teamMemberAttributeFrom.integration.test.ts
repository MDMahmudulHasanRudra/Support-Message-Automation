import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Phase 2, Stage 5 (PHASE2.md; Workstream F §10.3): "Count their messages from" on a team member.
 * A number that wrote as a customer before it joined keeps that history as customer history in every
 * report, set through the edit form exactly as the browser posts it, and logged like any identifier
 * change. Empty = every message counts (the default for every existing member); a form that does not
 * carry the field leaves it alone.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { role: "", user: "", project: "", slug: "", account: "", group: "", member: "" };
const WGID = `120365${Date.now()}${Math.floor(Math.random() * 1000)}@g.us`;
const memberPhone = `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
/** A Dhaka wall-clock time in June 2025, as an instant. */
const t = (day: number, hh: number) => new Date(Date.UTC(2025, 5, day, hh - 6, 0));

class Redirected extends Error {}
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => p, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { updateTeamMember } = await import("@/server/actions/teamMembers");
const { loadTeamReport, parseTeamReportFilters } = await import("@/server/teamReport");

const project = () => ({ id: ids.project, slug: ids.slug, name: `Attr ${tag}`, status: "ACTIVE" as const });
const inProject = <T,>(fn: () => Promise<T>) => runWithProject(project(), fn);

/** Posts the edit form; resolves to the error it showed, or null when it saved (and redirected). */
async function save(fields: Record<string, string>): Promise<string | null> {
  const form = new FormData();
  for (const [key, value] of Object.entries({ name: `Tanvir ${tag}`, phoneNumber: `+${memberPhone}`, role: "Support", status: "ACTIVE", ...fields })) {
    form.set(key, value);
  }
  try {
    const state = await inProject(() => updateTeamMember(ids.member, {}, form));
    return state.error ?? "no redirect";
  } catch (err) {
    if (err instanceof Redirected) return null;
    throw err;
  }
}

const juneReport = () =>
  inProject(() => loadTeamReport(parseTeamReportFilters({ period: "month", date: "2025-06-10", groups: WGID }, new Date()), new Date()));
const stored = () => rawPrisma.internalTeamMember.findUniqueOrThrow({ where: { id: ids.member }, select: { attributeFrom: true } });

beforeAll(async () => {
  const permission = PERMISSIONS.find((p) => p.key === "whatsapp.manage")!;
  const perm = await rawPrisma.permission.upsert({
    where: { key: permission.key },
    create: { key: permission.key, label: permission.label, category: permission.category },
    update: {},
    select: { id: true },
  });
  ids.role = (await rawPrisma.permissionModule.create({ data: { name: `Attr role ${tag}`, permissions: { create: [{ permissionId: perm.id }] } } })).id;
  const u = await rawPrisma.user.create({ data: { username: `attr_${tag}`, email: `attr_${tag}@example.test`, name: "Attr", passwordHash: "x", permissionModuleId: ids.role } });
  ids.user = u.id;
  current = { userId: u.id, username: u.username, email: u.email!, name: "Attr" } as Session;
  const created = await createProjectWithDefaults({ name: `Attr ${tag}`, slug: `attr-${tag}`, status: "ACTIVE", creatorUserId: u.id }, rawPrisma);
  ids.project = created.id;
  ids.slug = created.slug;
  await rawPrisma.projectAccess.upsert({
    where: { projectId_userId: { projectId: created.id, userId: u.id } },
    create: { projectId: created.id, userId: u.id },
    update: {},
  });
  const pid = { projectId: created.id };
  ids.account = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Attr ${tag}`, status: "CONNECTED" } })).id;
  ids.group = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: ids.account, whatsappGroupId: WGID, name: `Attr group ${tag}`, isActive: true } })).id;
  ids.member = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Tanvir ${tag}`, phoneNumber: `+${memberPhone}`, role: "Support" } })).id;
  // 1 June: as a customer. 3 June: as a colleague.
  for (const [key, at, body] of [["A1", t(1, 10), "is my connection fixed?"], ["A2", t(3, 10), "I have reset the customer's router"]] as const) {
    await rawPrisma.message.create({
      data: {
        ...pid,
        accountId: ids.account,
        groupId: ids.group,
        chatId: WGID,
        whatsappMessageId: `false_${WGID}_${key}${tag}_${memberPhone}@c.us`,
        senderPhone: memberPhone,
        senderJid: `${memberPhone}@c.us`,
        isFromTeamMember: false,
        direction: "INCOMING",
        body,
        normalizedBody: body,
        timestampWa: at,
        processingStatus: "PROCESSED",
      },
    });
  }
});

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const name of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, ids.project).catch(() => undefined);
  }
  await rawPrisma.projectAccess.deleteMany({ where: { userId: ids.user } });
  await rawPrisma.project.deleteMany({ where: { id: ids.project } });
  await rawPrisma.user.deleteMany({ where: { id: ids.user } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: ids.role } });
  await rawPrisma.$disconnect();
});

describe("count their messages from", () => {
  it("is empty for an existing member, who is credited with every message, as before", async () => {
    expect((await stored()).attributeFrom).toBeNull();
    const report = await juneReport();
    expect(report.result.summary).toMatchObject({ memberReplies: 2, customerMessages: 0 });
  });

  it("keeps the earlier messages as customer history once set, in Dhaka days", async () => {
    expect(await save({ attributeFrom: "2025-06-02" })).toBeNull();
    // Dhaka midnight of 2 June.
    expect((await stored()).attributeFrom?.toISOString()).toBe("2025-06-01T18:00:00.000Z");
    const report = await juneReport();
    expect(report.result.summary).toMatchObject({ memberReplies: 1, customerMessages: 1 });
    expect(report.reliabilityCounts.byActor).toMatchObject({ CUSTOMER: 1, MEMBER: 1 });
  });

  it("is a System Log entry, old and new side by side", async () => {
    const entry = await rawPrisma.systemLog.findFirst({ where: { targetId: ids.member }, orderBy: { createdAt: "desc" } });
    expect(entry?.message).toContain("Identifiers of team member");
    expect(entry?.metadata).toMatchObject({ before: { attributeFrom: null }, after: { attributeFrom: "2025-06-01T18:00:00.000Z" } });
  });

  it("is left alone by a form that does not carry the field", async () => {
    expect(await save({})).toBeNull();
    expect((await stored()).attributeFrom?.toISOString()).toBe("2025-06-01T18:00:00.000Z");
  });

  it("refuses a date it cannot read, and changes nothing", async () => {
    expect(await save({ attributeFrom: "2025-02-31" })).toMatch(/could not be read/);
    expect((await stored()).attributeFrom?.toISOString()).toBe("2025-06-01T18:00:00.000Z");
  });

  it("counts every message again once cleared", async () => {
    expect(await save({ attributeFrom: "" })).toBeNull();
    expect((await stored()).attributeFrom).toBeNull();
    expect((await juneReport()).result.summary).toMatchObject({ memberReplies: 2, customerMessages: 0 });
  });
});
