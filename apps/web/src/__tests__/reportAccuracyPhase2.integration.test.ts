import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Report accuracy audit (19 Oct 2026), Phase 2: every report outside the Team Report agrees with it.
 *
 * One WhatsApp group both of our numbers are in. A customer asks; Rina — on the roster, but added
 * after she wrote, so her messages carry no team-member stamp — answers; each message is stored by
 * both numbers. Before this phase:
 *  - Team Performance, availability and the Overview "busiest executives" read Support Activity rows
 *    (one per account copy: Rina's one reply was two) and nothing at all without them;
 *  - first response, the Overview wait chart and "waiting for a reply" trusted the stamp, so Rina's
 *    reply was a customer message — the group was still "waiting";
 *  - Support Activity counts, per-member totals and unique groups counted every copy;
 *  - busiest groups counted copies by arrival time; a SYSTEM line hid a waiting customer;
 *  - Response Time counted one answer twice, and clearing one copy of a wait left the other.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const NOW = new Date();
const t0 = new Date(NOW.getTime() - 90 * 60_000);
const plus = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
const nine = () => String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
const phone = () => `88017${nine().slice(1)}`;
const G = `120370${Date.now()}${Math.floor(Math.random() * 1000)}@g.us`;
const G2 = `120371${Date.now()}${Math.floor(Math.random() * 1000)}@g.us`;
const customer = phone();
const rinaPhone = phone();

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => p, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const reports = await import("@/server/supportActivityReports");
const overview = await import("@/server/actions/dashboardMetrics");
const responses = await import("@/server/supportResponse");
const { clearUnansweredEpisodes } = await import("@/server/actions/supportResponse");

const ids = { role: "", user: "", project: "", slug: "", accountA: "", accountB: "", gA: "", gB: "", g2: "", rina: "" };
const project = () => ({ id: ids.project, slug: ids.slug, name: `Acc2 ${tag}`, status: "ACTIVE" as const });
const inProject = <T,>(fn: () => Promise<T>) => runWithProject(project(), fn);

async function message(row: "A" | "B" | "G2", key: string, sender: string, at: Date, direction: "INCOMING" | "OUTGOING" | "SYSTEM" = "INCOMING") {
  const chat = row === "G2" ? G2 : G;
  return rawPrisma.message.create({
    data: {
      projectId: ids.project,
      accountId: row === "B" ? ids.accountB : ids.accountA,
      groupId: row === "A" ? ids.gA : row === "B" ? ids.gB : ids.g2,
      chatId: chat,
      whatsappMessageId: `false_${chat}_${key}${tag}_${sender}@c.us`,
      senderPhone: sender,
      senderJid: `${sender}@c.us`,
      isFromTeamMember: false,
      direction,
      body: "text",
      normalizedBody: "text",
      timestampWa: at,
      processingStatus: "PROCESSED",
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  const perm = PERMISSIONS.find((p) => p.key === "messages.reply")!;
  const row = await rawPrisma.permission.upsert({
    where: { key: perm.key },
    create: { key: perm.key, label: perm.label, category: perm.category },
    update: {},
    select: { id: true },
  });
  ids.role = (await rawPrisma.permissionModule.create({ data: { name: `Acc2 role ${tag}`, permissions: { create: [{ permissionId: row.id }] } } })).id;
  const u = await rawPrisma.user.create({ data: { username: `acc2_${tag}`, email: `acc2_${tag}@example.test`, name: "Acc2", passwordHash: "x", permissionModuleId: ids.role } });
  ids.user = u.id;
  current = { userId: u.id, username: u.username, email: u.email!, name: "Acc2" } as Session;
  const created = await createProjectWithDefaults({ name: `Acc2 ${tag}`, slug: `acc2-${tag}`, status: "ACTIVE", creatorUserId: u.id }, rawPrisma);
  ids.project = created.id;
  ids.slug = created.slug;
  const pid = { projectId: created.id };
  ids.accountA = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Acc2 A ${tag}`, status: "CONNECTED", isPrimary: true } })).id;
  ids.accountB = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Acc2 B ${tag}`, status: "CONNECTED" } })).id;
  const groupRow = (accountId: string, chat: string) =>
    rawPrisma.whatsAppGroup.create({
      data: { ...pid, accountId, whatsappGroupId: chat, name: `Acc2 ${chat.slice(0, 6)} ${tag}`, isMonitored: true, isActive: true, lastSyncedAt: new Date() },
      select: { id: true },
    });
  ids.gA = (await groupRow(ids.accountA, G)).id;
  ids.gB = (await groupRow(ids.accountB, G)).id;
  ids.g2 = (await groupRow(ids.accountA, G2)).id;
  ids.rina = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Rina ${tag}`, phoneNumber: `+${rinaPhone}`, role: "Support" } })).id;

  // G: the customer asks, Rina answers five minutes later; both numbers store both messages.
  for (const r of ["A", "B"] as const) await message(r, "Q", customer, t0);
  const replies = [];
  for (const r of ["A", "B"] as const) replies.push(await message(r, "R", rinaPhone, plus(5)));
  // The Support Activity detector recorded the reply once per stored copy.
  for (const [i, reply] of replies.entries()) {
    await rawPrisma.supportActivity.create({
      data: { ...pid, accountId: i === 0 ? ids.accountA : ids.accountB, groupId: i === 0 ? ids.gA : ids.gB, teamMemberId: ids.rina, messageId: reply.id, occurredAt: plus(5) },
    });
  }
  // G2: a customer asks and nobody answers; a later SYSTEM line (somebody joined) must not hide them.
  await message("G2", "Q2", customer, plus(10));
  await message("G2", "S2", G2.split("@")[0]!, plus(20), "SYSTEM");
}, 120_000);

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const name of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, ids.project).catch(() => undefined);
  }
  await rawPrisma.projectAccess.deleteMany({ where: { userId: ids.user } });
  await rawPrisma.project.deleteMany({ where: { id: ids.project } });
  await rawPrisma.user.deleteMany({ where: { id: ids.user } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: ids.role } });
  await rawPrisma.$disconnect();
});

const range = () => ({ start: new Date(t0.getTime() - 3_600_000), end: new Date(NOW.getTime() + 1) });

describe("Team Performance and availability read the messages, through the one identity rule", () => {
  it("credits Rina's one reply once, in one group — with no team-member stamp on it", async () => {
    const rows = await inProject(() => reports.getExecutiveWorkload(range(), NOW));
    expect(rows).toEqual([expect.objectContaining({ teamMemberId: ids.rina, messageCount: 1, groupsHandled: 1 })]);
  });

  it("shows her available from her own message", async () => {
    const rows = await inProject(() => reports.getTeamAvailability(NOW));
    expect(rows.find((r) => r.teamMemberId === ids.rina)?.availableNow).toBe(true);
  });
});

describe("waits read who is staff at read time", () => {
  it("measures the customer's wait as answered by Rina, once", async () => {
    expect(await inProject(() => reports.getFirstResponseStats(range(), NOW))).toMatchObject({ answered: 1, medianSeconds: 300 });
  });

  it("lists the group nobody answered once, past a SYSTEM line — and not the group Rina answered", async () => {
    const waiting = await inProject(() => reports.getGroupsAwaitingReply(NOW));
    const ours = waiting.filter((w) => [ids.gA, ids.gB, ids.g2].includes(w.groupId));
    expect(ours.map((w) => w.groupId)).toEqual([ids.g2]);
  });

  it("charts the same five-minute median on the Overview", async () => {
    const series = await inProject(() => overview.getResponseTimeSeries(NOW.getTime()));
    expect(series.latestMedianMinutes).toBe(5);
  });
});

describe("activity counts and Overview charts count each message once", () => {
  it("counts Support Activity once per message and per WhatsApp group", async () => {
    expect(await inProject(() => reports.getEveryActivityCount(range()))).toBe(1);
    expect(await inProject(() => reports.getUniqueGroupCount(range()))).toBe(1);
    expect(await inProject(() => reports.getPerTeamMemberBreakdown(range()))).toEqual([expect.objectContaining({ teamMemberId: ids.rina, activityCount: 1 })]);
    expect(await inProject(() => reports.getActorBreakdown(range()))).toMatchObject({ teamMemberCount: 1, uniqueGroups: 1 });
  });

  it("counts Rina once among the busiest executives and the people/AI split", async () => {
    expect((await inProject(() => overview.getExecutiveLoad(NOW.getTime()))).people).toEqual([expect.objectContaining({ id: ids.rina, value: 1 })]);
    expect((await inProject(() => overview.getSupportActorMix(NOW.getTime()))).slices).toEqual([expect.objectContaining({ key: "TEAM_MEMBER", value: 1 })]);
  });

  it("shows a group two of our numbers share once among the busiest, with each message once", async () => {
    const { groups } = await inProject(() => overview.getBusiestGroups(NOW.getTime()));
    const shared = groups.filter((g) => g.id === ids.gA || g.id === ids.gB);
    expect(shared).toEqual([expect.objectContaining({ id: ids.gA, value: 2 })]);
  });
});

describe("Response Time and Unanswered Groups: one wait, one row", () => {
  const episode = (accountId: string, groupId: string, status: "ANSWERED" | "UNANSWERED", isTwin: boolean, firstAt: Date) =>
    rawPrisma.supportResponseEpisode.create({
      data: {
        projectId: ids.project,
        accountId,
        groupId,
        status,
        isTwin,
        firstIncomingAt: firstAt,
        latestIncomingAt: firstAt,
        ...(status === "ANSWERED" ? { supportRepliedAt: new Date(firstAt.getTime() + 300_000), supportMemberId: ids.rina, responseSeconds: 300 } : {}),
      },
      select: { id: true },
    });

  it("counts an answered wait once unless one account is chosen", async () => {
    await episode(ids.accountA, ids.gA, "ANSWERED", false, t0);
    await episode(ids.accountB, ids.gB, "ANSWERED", true, t0);
    expect((await inProject(() => responses.listResponses(responses.parseResponseFilters({}), 1, 50))).total).toBe(1);
    expect((await inProject(() => responses.listResponses(responses.parseResponseFilters({ accountId: ids.accountB }), 1, 50))).total).toBe(1);
  });

  it("lists an unanswered wait once, and clearing it clears our other number's copy too", async () => {
    const canonical = await episode(ids.accountA, ids.gA, "UNANSWERED", false, plus(30));
    const twin = await episode(ids.accountB, ids.gB, "UNANSWERED", true, plus(30));
    expect((await inProject(() => responses.listUnanswered(responses.parseUnansweredFilters({}), 1, 50, NOW))).total).toBe(1);
    expect(await inProject(() => clearUnansweredEpisodes({ ids: [canonical.id], query: {} }))).toMatchObject({ cleared: 1 });
    expect((await rawPrisma.supportResponseEpisode.findUniqueOrThrow({ where: { id: twin.id } })).status).toBe("CLEARED");
  });
});
