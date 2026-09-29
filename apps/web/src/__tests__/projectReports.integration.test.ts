import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { getChatConversations, getChatThread } from "@/server/chatInbox";
import {
  getActivityTrend,
  getActorBreakdown,
  getEveryActivityCount,
  getExecutiveWorkload,
  getFirstResponseStats,
  getGroupsAwaitingReply,
  getPerTeamMemberBreakdown,
  getUniqueGroupCount,
} from "@/server/supportActivityReports";
import {
  getAiOutcomeSeries,
  getBusiestGroups,
  getDecisionMix,
  getMessageLoadSeries,
  getResponseTimeSeries,
  getSupportActorMix,
} from "@/server/actions/dashboardMetrics";
import { loadTeamReport } from "@/server/teamReport";

/**
 * MULTI_PROJECT_PLAN.md §11, "WhatsApp" and "Reports": nothing of Bizify's appears in any ISP
 * Digital list, count, search, inbox or report — and every figure equals the sum of the project's OWN
 * rows.
 *
 * The method makes a leak impossible to miss. ISP Digital's figures are taken, then Bizify is filled
 * with the same kind of data (accounts, groups, members, messages, replies, support activity, AI
 * decisions, rule executions), then ISP Digital's figures are taken again — they must be IDENTICAL.
 * Bizify's own figures must count exactly its own fixtures. Every query here runs through the web's
 * scoped client and its raw SQL, inside `runWithProject`, exactly as a page does.
 *
 * The raw-SQL reports are the reason this exists: `$queryRaw` is not covered by the scoped client,
 * so each of those queries names its project by hand, and one that forgot would pass every other test.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const SHARED_WGID = `shared-${tag}@g.us`;
const NOW = new Date();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

let isp: ActiveProject;
let biz: ActiveProject;
let crowdId: string;
let creatorId: string;

/** One project's worth of the data every report reads. `label` is written into every name. */
async function seed(projectId: string, label: string, options: { whatsappGroupId: string; replyAfterMinutes: number }) {
  const pid = { projectId };
  const account = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `${label} account ${tag}`, status: "CONNECTED" } });
  const group = await rawPrisma.whatsAppGroup.create({
    data: {
      ...pid,
      accountId: account.id,
      // Both projects' numbers are in the SAME WhatsApp group — the realistic case, and the one where
      // a query joining on the WhatsApp group id rather than the project would mix them.
      whatsappGroupId: options.whatsappGroupId,
      name: `${label} Group ${tag}`,
      isMonitored: true,
      isActive: true,
      lastSyncedAt: NOW,
    },
  });
  const memberPhone = `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const member = await rawPrisma.internalTeamMember.create({
    data: { ...pid, name: `${label} Member ${tag}`, phoneNumber: memberPhone, role: "Support", status: "ACTIVE" },
  });
  const customerPhone = `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const message = (over: Record<string, unknown>) =>
    rawPrisma.message.create({
      data: {
        ...pid,
        accountId: account.id,
        groupId: group.id,
        chatId: group.whatsappGroupId,
        whatsappMessageId: `wamid-${randomUUID()}`,
        senderPhone: customerPhone,
        direction: "INCOMING",
        body: `${label} question ${tag}`,
        normalizedBody: `${label} question ${tag}`,
        processingStatus: "PROCESSED",
        ...over,
      } as never,
    });
  const q1 = await message({ timestampWa: minutesAgo(90) });
  // Different reply timing per project, so a leaked row would CHANGE a median rather than repeat it.
  const reply = await message({ timestampWa: minutesAgo(90 - options.replyAfterMinutes), senderPhone: memberPhone, isFromTeamMember: true, body: `${label} answer ${tag}`, normalizedBody: "a" });
  const q2 = await message({ timestampWa: minutesAgo(30) }); // still unanswered
  await rawPrisma.supportActivity.create({ data: { ...pid, accountId: account.id, groupId: group.id, teamMemberId: member.id, messageId: reply.id, occurredAt: reply.timestampWa } });
  await rawPrisma.supportActivity.create({ data: { ...pid, accountId: account.id, groupId: group.id, actor: "AI", messageId: q1.id, occurredAt: q1.timestampWa } });
  await rawPrisma.aiFallbackDecision.create({ data: { ...pid, messageId: q2.id, accountId: account.id, groupId: group.id, outcome: "HUMAN_FALLBACK", reason: "NO_KNOWLEDGE" } });
  for (const m of [q1, q2]) {
    await rawPrisma.automationExecution.create({
      data: { ...pid, messageId: m.id, decision: "NO_MATCH", actionsExecuted: [], reasonTrace: {}, idempotencyKey: `exec-${randomUUID()}` },
    });
  }
  await rawPrisma.outboundMessage.create({
    data: {
      ...pid,
      accountId: account.id,
      chatId: group.whatsappGroupId,
      toPhone: group.whatsappGroupId,
      body: `${label} outbound ${tag}`,
      actionType: "AUTO_REPLY",
      idempotencyKey: randomUUID(),
      status: "SENT",
      sentAt: minutesAgo(89),
      relatedMessageId: q1.id,
    },
  });
  return { account, group, member };
}

/** Every report and list, as plain comparable data (Maps flattened, key order stable). */
async function allFigures(project: ActiveProject) {
  return runWithProject(project, async () => {
    const range = { start: minutesAgo(24 * 60), end: new Date(NOW.getTime() + 60_000) };
    const nowMs = NOW.getTime();
    const filters = { period: "day", date: NOW.toISOString().slice(0, 10), from: "", to: "", memberId: null, teamId: null, granularity: "day" } as never;
    const report = await loadTeamReport(filters, NOW);
    const drill = await loadTeamReport(filters, NOW, SHARED_WGID);
    const figures = {
      inbox: (await getChatConversations("")).map((c) => c.name).sort(),
      inboxSearch: (await getChatConversations(tag)).map((c) => c.name).sort(),
      everyActivity: await getEveryActivityCount(range),
      uniqueGroups: await getUniqueGroupCount(range),
      actorMix: await getActorBreakdown(range),
      perMember: (await getPerTeamMemberBreakdown(range)).map((r) => JSON.stringify(r)).sort(),
      trend: await getActivityTrend(7),
      workload: JSON.stringify(await getExecutiveWorkload(range)),
      awaiting: (await getGroupsAwaitingReply(NOW)).map((r) => JSON.stringify(r)).sort(),
      firstResponse: await getFirstResponseStats(range),
      messageLoad: await getMessageLoadSeries(nowMs),
      aiOutcomes: await getAiOutcomeSeries(nowMs),
      responseTimes: await getResponseTimeSeries(nowMs),
      decisions: await getDecisionMix(nowMs),
      busiest: await getBusiestGroups(nowMs),
      supportMix: await getSupportActorMix(nowMs),
      teamReport: JSON.stringify(report.result, (_k, v) => (v instanceof Map ? [...v.entries()] : v)),
      teamReportGroups: [...report.groups.values()].map((g) => JSON.stringify(g)).sort(),
      teamReportDrillDown: JSON.stringify(drill.result, (_k, v) => (v instanceof Map ? [...v.entries()] : v)),
      counts: {
        accounts: await prisma.whatsAppAccount.count(),
        groups: await prisma.whatsAppGroup.count(),
        members: await prisma.internalTeamMember.count(),
        messages: await prisma.message.count(),
        outbound: await prisma.outboundMessage.count(),
      },
    };
    return JSON.parse(JSON.stringify(figures));
  });
}

let ispFixtures: Awaited<ReturnType<typeof seed>>;
let bizFixtures: Awaited<ReturnType<typeof seed>>;
let ispBefore: Record<string, unknown>;
let ispAfter: Record<string, unknown>;
let bizFigures: Record<string, unknown>;

beforeAll(async () => {
  const user = await rawPrisma.user.create({ data: { username: `rep_${tag}`, email: `rep_${tag}@example.test`, name: "Reports", passwordHash: "x" } });
  creatorId = user.id;
  const ispRow = await rawPrisma.project.findUniqueOrThrow({ where: { id: ORIGINAL_PROJECT_ID } });
  isp = { id: ispRow.id, slug: ispRow.slug, name: ispRow.name, status: ispRow.status };
  const created = await createProjectWithDefaults({ name: `Bizify ${tag}`, slug: `bizify-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  biz = { id: created.id, slug: created.slug, name: `Bizify ${tag}`, status: "ACTIVE" };

  ispFixtures = await seed(isp.id, "ISP", { whatsappGroupId: SHARED_WGID, replyAfterMinutes: 10 });
  ispBefore = await allFigures(isp);
  bizFixtures = await seed(biz.id, "BIZ", { whatsappGroupId: SHARED_WGID, replyAfterMinutes: 40 });

  // A third project with more active conversations than the inbox shows (300), each newer than
  // anything above. If the inbox ranked groups across projects, these would take every slot and
  // ISP Digital's and Bizify's own conversations would drop off their inboxes.
  crowdId = (await createProjectWithDefaults({ name: `Crowd ${tag}`, slug: `crowd-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma)).id;
  const crowdAccount = await rawPrisma.whatsAppAccount.create({ data: { projectId: crowdId, label: `Crowd ${tag}`, status: "CONNECTED" } });
  const crowdGroups = Array.from({ length: 305 }, (_, i) => ({
    id: `crowd-${tag}-${i}`,
    projectId: crowdId,
    accountId: crowdAccount.id,
    whatsappGroupId: `crowd-${tag}-${i}@g.us`,
    name: `Crowd group ${i}`,
    isMonitored: true,
    isActive: true,
    lastSyncedAt: NOW,
  }));
  await rawPrisma.whatsAppGroup.createMany({ data: crowdGroups });
  await rawPrisma.message.createMany({
    data: crowdGroups.map((g) => ({
      projectId: crowdId,
      accountId: crowdAccount.id,
      groupId: g.id,
      chatId: g.whatsappGroupId,
      whatsappMessageId: `wamid-${randomUUID()}`,
      senderPhone: "8801700000999",
      direction: "INCOMING" as const,
      body: "crowd",
      normalizedBody: "crowd",
      timestampWa: minutesAgo(1),
      processingStatus: "PROCESSED" as const,
    })),
  });

  ispAfter = await allFigures(isp);
  bizFigures = await allFigures(biz);
});

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const table of tables) {
      await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = ANY($1)`, [biz.id, crowdId]).catch(() => undefined);
    }
  }
  await rawPrisma.project.deleteMany({ where: { id: { in: [biz.id, crowdId] } } });
  // ISP Digital's fixtures, by the account they hang off.
  const acc = ispFixtures.account.id;
  const ispMessageIds = (await rawPrisma.message.findMany({ where: { accountId: acc }, select: { id: true } })).map((m) => m.id);
  await rawPrisma.automationExecution.deleteMany({ where: { messageId: { in: ispMessageIds } } });
  for (const table of ["SupportActivity", "AiFallbackDecision", "OutboundMessage", "Message", "WhatsAppGroup"]) {
    await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "accountId" = $1`, acc).catch(() => undefined);
  }
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: acc } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: ispFixtures.member.id } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

const FIGURES = [
  "inbox",
  "inboxSearch",
  "everyActivity",
  "uniqueGroups",
  "actorMix",
  "perMember",
  "trend",
  "workload",
  "awaiting",
  "firstResponse",
  "messageLoad",
  "aiOutcomes",
  "responseTimes",
  "decisions",
  "busiest",
  "supportMix",
  "teamReport",
  "teamReportGroups",
  "teamReportDrillDown",
  "counts",
] as const;

describe("the comparison is not vacuous", () => {
  it("ISP Digital's own fixtures are in its figures", () => {
    expect(ispAfter.inbox as string[]).toContain(ispFixtures.group.name);
    expect(ispAfter.everyActivity as number).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(ispAfter.awaiting)).toContain(ispFixtures.group.id);
    expect(JSON.stringify(ispAfter.teamReportGroups)).toContain(ispFixtures.group.name);
    // The two projects' fixtures really do differ where a leak would show: reply timing.
    expect(JSON.stringify(bizFigures.responseTimes)).not.toEqual(JSON.stringify(ispAfter.responseTimes));
  });
});

describe("ISP Digital's figures do not move when Bizify fills up", () => {
  for (const name of FIGURES) {
    it(name, () => {
      expect(ispAfter[name]).toEqual(ispBefore[name]);
    });
  }
});

describe("Bizify's figures are exactly its own rows", () => {
  it("its inbox and search list only its own group", () => {
    expect(bizFigures.inbox).toEqual([bizFixtures.group.name]);
    expect(bizFigures.inboxSearch).toEqual([bizFixtures.group.name]);
  });

  it("its counts are its fixture counts", () => {
    expect(bizFigures.counts).toEqual({ accounts: 1, groups: 1, members: 1, messages: 3, outbound: 1 });
    expect(bizFigures.everyActivity).toBe(2);
    expect(bizFigures.uniqueGroups).toBe(1);
  });

  it("its awaiting-reply list is its own group", () => {
    const awaiting = (bizFigures.awaiting as string[]).map((row) => JSON.parse(row));
    expect(awaiting.map((row) => row.groupName ?? row.name)).toEqual([bizFixtures.group.name]);
  });

  it("nothing anywhere in its figures names ISP Digital's fixtures", () => {
    const text = JSON.stringify(bizFigures);
    expect(text).not.toContain(ispFixtures.group.name);
    expect(text).not.toContain(ispFixtures.member.name);
    expect(text).not.toContain(ispFixtures.group.id);
  });

  it("and ISP Digital's never name Bizify's", () => {
    const text = JSON.stringify(ispAfter);
    expect(text).not.toContain(bizFixtures.group.name);
    expect(text).not.toContain(bizFixtures.member.name);
    expect(text).not.toContain(bizFixtures.group.id);
  });

  it("another project's conversation cannot be opened by id", async () => {
    expect(await runWithProject(isp, () => getChatThread(bizFixtures.group.id))).toBeNull();
    expect(await runWithProject(biz, () => getChatThread(ispFixtures.group.id))).toBeNull();
  });
});
