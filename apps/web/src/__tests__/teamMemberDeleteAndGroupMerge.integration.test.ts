import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import type { Session } from "@/server/auth";

/**
 * Audit bugs B3 and B4 (docs/unified-reporting/01-existing-system-audit.md), against real rows.
 *
 * B3: hard-deleting a team member nulls the assignee of their groups through the foreign key, and no
 * GroupResponsibilityChange was written, so every earlier Missed wait of those groups moved to
 * "Unassigned". (Related: a member whose only work is dashboard replies through a linked login was deleted
 * outright and their replies reverted to the business number.)
 *
 * B4: the Team Report merged two non-Primary copies' assignees in whatever order the database returned the
 * rows, while GroupResponsibilityChange is recorded on `mergedGroupResponsibility` (Primary first, lowest id).
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const id = (name: string) => `db-${tag}-${name}`;
const WG = { g1: "120000000000000011@g.us", g2: "120000000000000012@g.us", g3: "120000000000000013@g.us", g4: "120000000000000014@g.us" };
const CUSTOMER = "8801999000011";
const at = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2025, 9, day, hh - 6, mm));
const NOW = at(30, 12);

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("@/server/authorize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/authorize")>()),
  requireAccess: async () => current,
  checkPermission: async () => ({ session: current }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => p, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { deleteTeamMember } = await import("@/server/actions/teamMembers");
const { loadTeamReport, parseTeamReportFilters } = await import("@/server/teamReport");
const { mergedGroupResponsibility } = await import("@/server/groupResponsibility");
const { prisma } = await import("@/server/db");

interface Proj {
  id: string;
  slug: string;
  name: string;
  status: "ACTIVE";
}
let project: Proj;
let userId = "";
let linkedUserId = "";
const inProject = <T,>(fn: () => Promise<T>) => runWithProject(project, fn);

async function group(account: "A" | "B" | "C", wgid: string, assignee: string | null, rowId?: string) {
  await rawPrisma.whatsAppGroup.create({
    data: {
      projectId: project.id,
      id: rowId ?? id(`${account}-${wgid.slice(-7, -5)}`),
      accountId: id(account),
      whatsappGroupId: wgid,
      name: `Group ${wgid.slice(-7, -5)}`,
      isMonitored: true,
      isActive: true,
      assignedTeamMemberId: assignee,
    },
  });
}

const changes = (wgid: string) =>
  rawPrisma.groupResponsibilityChange.findMany({ where: { projectId: project.id, whatsappGroupId: wgid }, select: { previousAssignedTeamMemberId: true, assignedTeamMemberId: true, changedByUserId: true } });

beforeAll(async () => {
  userId = (await rawPrisma.user.create({ data: { username: `db_${tag}`, email: `db_${tag}@example.test`, name: "DB", passwordHash: "x" } })).id;
  linkedUserId = (await rawPrisma.user.create({ data: { username: `dbl_${tag}`, email: `dbl_${tag}@example.test`, name: "DBL", passwordHash: "x" } })).id;
  current = { userId, username: `db_${tag}`, email: `db_${tag}@example.test`, name: "DB" } as Session;
  const created = await createProjectWithDefaults({ name: `DB ${tag}`, slug: `db-${tag}`, status: "ACTIVE", creatorUserId: userId }, rawPrisma);
  project = { id: created.id, slug: created.slug, name: `DB ${tag}`, status: "ACTIVE" };
  const pid = { projectId: project.id };
  await rawPrisma.projectAccess.create({ data: { ...pid, userId: linkedUserId } });
  for (const a of ["A", "B", "C"] as const) {
    await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id(a), label: `Account ${a}`, status: "CONNECTED", isPrimary: a === "A" } });
  }
  for (const name of ["temp", "keeper", "dash", "busy", "zz", "aa"]) {
    await rawPrisma.internalTeamMember.create({
      data: { ...pid, id: id(name), name: `M ${name}`, phoneNumber: `+88010000${String(100 + name.length * 7 + name.charCodeAt(0)).padStart(5, "0")}`, role: "Support", userId: name === "dash" ? linkedUserId : null },
    });
  }

  // G1: both copies assigned to "temp" (who has no history at all): deleting them changes the merged assignee.
  await group("A", WG.g1, id("temp"));
  await group("B", WG.g1, id("temp"));
  // G2: the Primary copy is assigned to "keeper", a second copy to "temp": the merged assignee (Primary first) stays "keeper".
  await group("A", WG.g2, id("keeper"));
  await group("B", WG.g2, id("temp"));
  // G4 (B4): the Primary copy has nobody; two non-Primary copies name different people. The copy with the HIGHER
  // row id is stored first, so a heap-order read meets it first.
  await group("A", WG.g4, null);
  await group("B", WG.g4, id("zz"), "zzz-" + tag);
  await group("C", WG.g4, id("aa"), "aaa-" + tag);
  // G3: a group assigned to a member who HAS history (an incoming message): they are deactivated, never deleted.
  await group("A", WG.g3, id("busy"));
  await rawPrisma.message.create({
    data: {
      ...pid,
      accountId: id("A"),
      groupId: id(`A-${WG.g3.slice(-7, -5)}`),
      chatId: WG.g3,
      whatsappMessageId: `false_${WG.g3}_B1_${tag}`,
      senderPhone: "8801000000199",
      direction: "INCOMING",
      body: "text",
      normalizedBody: "text",
      timestampWa: at(5, 10),
      processingStatus: "PROCESSED",
    },
  });
  await rawPrisma.internalTeamMember.update({ where: { id: id("busy") }, data: { phoneNumber: "+8801000000199" } });
  // A dashboard reply typed through "dash"'s linked login, and nothing else of theirs.
  await rawPrisma.outboundMessage.create({
    data: {
      ...pid,
      accountId: id("A"),
      chatId: WG.g1,
      toPhone: WG.g1,
      body: "typed",
      actionType: "MANUAL_REPLY",
      idempotencyKey: `db-${tag}-dash`,
      status: "SENT",
      sentAt: at(5, 11),
      scheduledAt: at(5, 11),
      providerMessageId: `true_${WG.g1}_D1_${tag}`,
      createdById: linkedUserId,
    },
  });
  // G4 needs a message in the period so the report lists it.
  await rawPrisma.message.create({
    data: {
      ...pid,
      accountId: id("A"),
      groupId: id(`A-${WG.g4.slice(-7, -5)}`),
      chatId: WG.g4,
      whatsappMessageId: `false_${WG.g4}_C1_${tag}`,
      senderPhone: CUSTOMER,
      direction: "INCOMING",
      body: "hello there",
      normalizedBody: "hello there",
      timestampWa: at(6, 10),
      processingStatus: "PROCESSED",
    },
  });
}, 120_000);

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const name of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, project.id).catch(() => undefined);
  }
  await rawPrisma.projectAccess.deleteMany({ where: { projectId: project.id } });
  await rawPrisma.project.deleteMany({ where: { id: project.id } });
  await rawPrisma.user.deleteMany({ where: { id: { in: [userId, linkedUserId] } } });
  await rawPrisma.$disconnect();
});

describe("B3: deleting a team member records the groups they leave unassigned", () => {
  it("writes one GroupResponsibilityChange per WhatsApp group whose merged assignee changes", async () => {
    const result = await inProject(() => deleteTeamMember(id("temp")));
    expect(result).toEqual({ deactivated: false });
    expect(await rawPrisma.internalTeamMember.count({ where: { id: id("temp") } })).toBe(0);
    // G1: two copies, one WhatsApp group, one change (temp, then nobody), by the person who deleted them.
    expect(await changes(WG.g1)).toEqual([{ previousAssignedTeamMemberId: id("temp"), assignedTeamMemberId: null, changedByUserId: userId }]);
    // G2: the Primary copy still says "keeper", so the merged value did not change and nothing is recorded.
    expect(await changes(WG.g2)).toEqual([]);
    expect((await inProject(() => mergedGroupResponsibility(prisma, WG.g2))).assignedTeamMemberId).toBe(id("keeper"));
  });

  it("a member with history is deactivated, and no group is touched", async () => {
    const result = await inProject(() => deleteTeamMember(id("busy")));
    expect(result).toEqual({ deactivated: true });
    expect((await rawPrisma.internalTeamMember.findUniqueOrThrow({ where: { id: id("busy") } })).status).toBe("INACTIVE");
    expect(await changes(WG.g3)).toEqual([]);
    expect((await rawPrisma.whatsAppGroup.findFirstOrThrow({ where: { projectId: project.id, whatsappGroupId: WG.g3 } })).assignedTeamMemberId).toBe(id("busy"));
  });

  it("a member whose only work is dashboard replies through their linked login is deactivated, not deleted", async () => {
    const result = await inProject(() => deleteTeamMember(id("dash")));
    expect(result).toEqual({ deactivated: true });
    expect((await rawPrisma.internalTeamMember.findUniqueOrThrow({ where: { id: id("dash") } })).status).toBe("INACTIVE");
  });

  it("a member with no history at all, and no groups, is still genuinely deleted", async () => {
    const result = await inProject(() => deleteTeamMember(id("keeper")));
    expect(result).toEqual({ deactivated: false });
    expect(await rawPrisma.internalTeamMember.count({ where: { id: id("keeper") } })).toBe(0);
    // Their one group (G2, Primary copy) lost its assignee, and that is recorded: the second copy still names a deleted member.
    expect(await changes(WG.g2)).toEqual([{ previousAssignedTeamMemberId: id("keeper"), assignedTeamMemberId: null, changedByUserId: userId }]);
  });
});

describe("B4: the Team Report reads a group's assignee in the order history is recorded in", () => {
  it("two non-Primary copies: the lowest row id wins, as mergedGroupResponsibility says", async () => {
    const merged = await inProject(() => mergedGroupResponsibility(prisma, WG.g4));
    expect(merged.assignedTeamMemberId).toBe(id("aa"));
    const data = await inProject(() =>
      loadTeamReport(parseTeamReportFilters({ period: "custom", from: "2025-10-01", to: "2025-10-31", groups: WG.g4 }, NOW), NOW),
    );
    expect(data.groups.get(WG.g4)?.assignedMemberId).toBe(merged.assignedTeamMemberId);
    expect(data.responsibilityAt(WG.g4).assigned).toBe(id("aa"));
  });
});
