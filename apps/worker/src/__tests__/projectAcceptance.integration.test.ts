import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { createKnowledgeItem, createProjectWithDefaults, encryptSecret } from "@support-automation/db";
import { resolveAiClientResult } from "@support-automation/ai-client";
import { ISP_DIGITAL, prisma, rawPrisma } from "./helpers/projectFixtures.js";
import { prisma as workerPrisma } from "../db.js";
import { resetProjectCachesForTests, withProject } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { resolveActiveTeamMember } from "../pipeline/teamFilter.js";
import { findRelevantKnowledge } from "../aiFallback/knowledgeContext.js";
import { processOneSegmentationBatch } from "../learning/sessionSegmentation.js";
import { processOnePatternDetectionBatch } from "../learning/patternDetectionJob.js";
import { enqueueNotification } from "../notifications/enqueueNotification.js";
import { getEventDelivery } from "../notifications/eventSettings.js";

/**
 * MULTI_PROJECT_PLAN.md §11 — the acceptance list for the WORKER, with two projects each holding its
 * own account, group, team member, rule, knowledge, AI model and alert settings. Each item is the
 * plan's own sentence; each test was confirmed to fail with the worker's project scope removed (the
 * scoped client in src/db.ts replaced by the platform client).
 *
 * The other §11 items live beside it: web lists and reports in apps/web's
 * projectReports.integration.test.ts, existing permissions in navigationPermissions.test.ts, access
 * in the browser verification, lifecycle in projectLifecycle.integration.test.ts, features in
 * projectFeatures.integration.test.ts, and cross-project refusals in projectIsolation.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const MARKER = `vantrel${tag}`;
const digits = () => `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

interface Side {
  projectId: string;
  account: WhatsAppAccount;
  group: WhatsAppGroup;
  memberPhone: string;
  memberId: string;
  providerId: string;
}
let isp: Side;
let biz: Side;
let creatorId: string;
let ispAutomationBefore: { automationEnabled: boolean; whatsappNotificationGroupIds: string[] } | null = null;
const ispCleanups: Array<() => Promise<unknown>> = [];
const inIspP = <T,>(fn: () => Promise<T>) => withProject(ISP_DIGITAL, fn);
const inBiz = <T,>(fn: () => Promise<T>) => withProject(biz.projectId, fn);

async function side(projectId: string, label: string): Promise<Side> {
  return withProject(projectId, async () => {
    const account = await prisma.whatsAppAccount.create({ data: { label: `${label} ${tag}`, status: "CONNECTED" } });
    const group = await prisma.whatsAppGroup.create({
      data: {
        accountId: account.id,
        whatsappGroupId: `${label.toLowerCase()}-${tag}@g.us`,
        name: `${label} group ${tag}`,
        isMonitored: true,
        lastSyncedAt: new Date(),
      },
    });
    const memberPhone = digits();
    const member = await prisma.internalTeamMember.create({
      data: { name: `${label} member ${tag}`, phoneNumber: memberPhone, role: "Support", status: "ACTIVE" },
    });
    const provider = await prisma.aiProvider.create({
      data: { name: `${label} provider ${tag}`, kind: "OPENROUTER", apiKeyCiphertext: encryptSecret(`${label}-key`), status: "ACTIVE" },
    });
    return { projectId, account, group, memberPhone, memberId: member.id, providerId: provider.id };
  });
}

beforeAll(async () => {
  const user = await rawPrisma.user.create({ data: { username: `acc_${tag}`, email: `acc_${tag}@example.test`, name: "Acceptance", passwordHash: "x" } });
  creatorId = user.id;
  const bizProject = await createProjectWithDefaults({ name: `Bizify ${tag}`, slug: `bizify-acc-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  resetProjectCachesForTests();
  resetProjectFeatureCacheForTests();
  isp = await side(ISP_DIGITAL, "ISP");
  biz = await side(bizProject.id, "BIZ");

  const settings = await rawPrisma.automationSettings.findUnique({ where: { projectId: ISP_DIGITAL } });
  ispAutomationBefore = settings ? { automationEnabled: settings.automationEnabled, whatsappNotificationGroupIds: settings.whatsappNotificationGroupIds } : null;
});

afterAll(async () => {
  for (const undo of ispCleanups.reverse()) await undo().catch(() => undefined);
  if (ispAutomationBefore) await rawPrisma.automationSettings.update({ where: { projectId: ISP_DIGITAL }, data: ispAutomationBefore });
  const acc = isp.account.id;
  const ispMessageIds = (await rawPrisma.message.findMany({ where: { accountId: acc }, select: { id: true } })).map((m) => m.id);
  await rawPrisma.automationExecution.deleteMany({ where: { messageId: { in: ispMessageIds } } });
  await rawPrisma.aiFallbackDecision.deleteMany({ where: { messageId: { in: ispMessageIds } } });
  for (const table of ["SupportActivity", "OutboundMessage", "Notification", "ProcessingCheckpoint", "Message", "WhatsAppGroup"]) {
    await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "accountId" = $1`, acc).catch(() => undefined);
  }
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: acc } });
  await rawPrisma.teamMemberNotificationPreference.deleteMany({ where: { teamMemberId: isp.memberId } });
  await rawPrisma.teamAttendanceGroup.deleteMany({ where: { attendanceDay: { teamMemberId: isp.memberId } } }).catch(() => undefined);
  await rawPrisma.teamAttendanceDay.deleteMany({ where: { teamMemberId: isp.memberId } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: isp.memberId } });
  await rawPrisma.aiProvider.deleteMany({ where: { id: isp.providerId } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const table of tables) {
      await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = $1`, biz.projectId).catch(() => undefined);
    }
  }
  await rawPrisma.project.deleteMany({ where: { id: biz.projectId } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

function incoming(s: Side, body: string, senderPhone = digits(), inGroup: WhatsAppGroup = s.group) {
  return {
    accountId: s.account.id,
    whatsappMessageId: `wamid-${randomUUID()}`,
    chatId: inGroup.whatsappGroupId,
    whatsappGroupId: inGroup.whatsappGroupId,
    senderPhone,
    direction: "INCOMING" as const,
    body,
    timestampWa: new Date(),
  };
}

describe("§11 Knowledge", () => {
  it("an ISP Digital question retrieves only ISP Digital's verified knowledge, even when Bizify has an exact match", async () => {
    const question = `How do I reset the ${MARKER} router?`;
    const ispItem = await inIspP(() =>
      createKnowledgeItem(
        { title: `ISP ${MARKER} reset`, category: "FAQ", question: `Resetting a ${MARKER} router`, answer: `Hold the ${MARKER} reset button.`, source: "MANUAL", aiGenerated: false, humanVerified: true },
        prisma,
      ),
    );
    ispCleanups.push(() => rawPrisma.aiKnowledgeItem.deleteMany({ where: { id: ispItem.id } }));
    // Bizify's entry is the customer's EXACT question — the strongest possible match.
    await inBiz(() =>
      createKnowledgeItem(
        { title: `BIZ ${MARKER} exact`, category: "FAQ", question, answer: `Bizify's own ${MARKER} answer.`, source: "MANUAL", aiGenerated: false, humanVerified: true },
        prisma,
      ),
    );
    const ispFound = await inIspP(() => findRelevantKnowledge(question, { groupId: isp.group.id, accountId: isp.account.id }));
    expect(ispFound.map((k) => k.title)).toEqual([`ISP ${MARKER} reset`]);
    const bizFound = await inBiz(() => findRelevantKnowledge(question, { groupId: biz.group.id, accountId: biz.account.id }));
    expect(bizFound.map((k) => k.title)).toEqual([`BIZ ${MARKER} exact`]);
  });
});

describe("§11 AI", () => {
  it("each project's reply resolves its own model assignment and credentials", async () => {
    for (const s of [isp, biz]) {
      await withProject(s.projectId, async () => {
        const existing = await prisma.aiModelConfig.findFirst({ where: { job: "RESPONSE" } });
        if (existing) {
          const original = { providerId: existing.providerId, modelId: existing.modelId };
          await prisma.aiModelConfig.update({ where: { id: existing.id }, data: { providerId: s.providerId, modelId: `model-${s.projectId}` } });
          if (s === isp) ispCleanups.push(() => rawPrisma.aiModelConfig.update({ where: { id: existing.id }, data: original }));
        } else {
          const created = await prisma.aiModelConfig.create({ data: { job: "RESPONSE", providerId: s.providerId, modelId: `model-${s.projectId}` } });
          if (s === isp) ispCleanups.push(() => rawPrisma.aiModelConfig.deleteMany({ where: { id: created.id } }));
        }
        const ai = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
        if (!ai.aiEngineEnabled) {
          await prisma.aiSettings.update({ where: { id: "global" }, data: { aiEngineEnabled: true } });
          if (s === isp) ispCleanups.push(() => rawPrisma.aiSettings.update({ where: { projectId: ISP_DIGITAL }, data: { aiEngineEnabled: false } }));
        }
      });
    }
    const ispResult = await inIspP(() => resolveAiClientResult("RESPONSE", workerPrisma));
    const bizResult = await inBiz(() => resolveAiClientResult("RESPONSE", workerPrisma));
    expect(ispResult.providerId).toBe(isp.providerId);
    expect(bizResult.providerId).toBe(biz.providerId);
    expect(ispResult.client).not.toBeNull();
    expect(bizResult.client).not.toBeNull();
  });
});

describe("§11 Rules and §11 Worker", () => {
  it("a Bizify rule never matches an ISP Digital message; Bizify's own message is answered on Bizify's account", async () => {
    // Bizify: automation on, one rule. ISP Digital: its own kill switch OFF at the same moment.
    await inBiz(async () => {
      await prisma.automationSettings.update({
        where: { id: "global" },
        data: { automationEnabled: true, mode: "SAFE_AUTO_REPLY", defaultReplyDelayMinMs: 0, defaultReplyDelayMaxMs: 0 },
      });
      await prisma.whatsAppAccount.update({ where: { id: biz.account.id }, data: { isPrimary: true } });
    });
    await rawPrisma.automationSettings.update({ where: { projectId: ISP_DIGITAL }, data: { automationEnabled: false } });
    const rule = await inBiz(() =>
      prisma.automationRule.create({
        data: {
          name: `Bizify rule ${tag}`, type: "AUTO_REPLY", matchType: "KEYWORDS", keywords: [MARKER], conditions: {},
          actions: [{ type: "AUTO_REPLY" }], replyMessage: `Bizify reply ${tag}`, priority: 5, status: "ACTIVE",
        },
      }),
    );

    const ispMsg = incoming(isp, `hello ${MARKER}`);
    const bizMsg = incoming(biz, `hello ${MARKER}`);
    await processIncomingMessage(ispMsg);
    await processIncomingMessage(bizMsg);

    const ispStored = await rawPrisma.message.findFirstOrThrow({ where: { whatsappMessageId: ispMsg.whatsappMessageId } });
    const bizStored = await rawPrisma.message.findFirstOrThrow({ where: { whatsappMessageId: bizMsg.whatsappMessageId } });
    const ispExec = await rawPrisma.automationExecution.findFirst({ where: { messageId: ispStored.id } });
    expect(ispExec?.ruleId ?? null).not.toBe(rule.id);

    const bizReplies = await rawPrisma.outboundMessage.findMany({ where: { relatedMessageId: bizStored.id } });
    expect(bizReplies).toHaveLength(1);
    expect(bizReplies[0]).toMatchObject({ projectId: biz.projectId, accountId: biz.account.id, ruleId: rule.id });
    // ISP Digital's kill switch did not stop Bizify, and Bizify's rule did not answer ISP Digital.
    expect(await rawPrisma.outboundMessage.count({ where: { relatedMessageId: ispStored.id } })).toBe(0);
  });
});

describe("§11 Team", () => {
  it("an ISP Digital member is staff in an ISP Digital group; a Bizify-only person in the same group is a customer", async () => {
    expect(await inIspP(() => resolveActiveTeamMember(isp.memberPhone))).toMatchObject({ id: isp.memberId });
    expect(await inIspP(() => resolveActiveTeamMember(biz.memberPhone))).toBeNull();

    const fromIspMember = incoming(isp, "on it", isp.memberPhone);
    const fromBizPerson = incoming(isp, "on it too", biz.memberPhone);
    await processIncomingMessage(fromIspMember);
    await processIncomingMessage(fromBizPerson);
    const a = await rawPrisma.message.findFirstOrThrow({ where: { whatsappMessageId: fromIspMember.whatsappMessageId } });
    const b = await rawPrisma.message.findFirstOrThrow({ where: { whatsappMessageId: fromBizPerson.whatsappMessageId } });
    expect(a.isFromTeamMember).toBe(true);
    expect(b.isFromTeamMember).toBe(false);
  });
});

describe("§11 Learning", () => {
  it("segmentation and pattern detection in Bizify write no sessions or candidates in ISP Digital", async () => {
    await inBiz(() =>
      prisma.learningSettings.update({
        where: { id: "global" },
        data: { conversationLearningEnabled: true, minOccurrenceForCandidate: 1, minDistinctGroupsForCandidate: 1, minDistinctClientsForCandidate: 1 },
      }),
    );
    const earlier = new Date(Date.now() - 6 * 60 * 60_000);
    for (let i = 0; i < 3; i++) {
      await inBiz(() =>
        prisma.message.create({
          data: {
            accountId: biz.account.id, groupId: biz.group.id, whatsappMessageId: `wamid-${randomUUID()}`, chatId: `${tag}-learn-${i}@g.us`,
            senderPhone: digits(), direction: "INCOMING", body: `how to pay the ${MARKER} bill`, normalizedBody: `how to pay the ${MARKER} bill`,
            timestampWa: earlier, processingStatus: "IGNORED",
          },
        }),
      );
    }
    const ispSessionsBefore = await rawPrisma.conversationSession.count({ where: { projectId: ISP_DIGITAL } });
    const ispCandidatesBefore = await rawPrisma.patternCandidate.count({ where: { projectId: ISP_DIGITAL } });

    await inBiz(() => processOneSegmentationBatch());
    await inBiz(() => processOnePatternDetectionBatch());

    expect(await rawPrisma.conversationSession.count({ where: { projectId: biz.projectId } })).toBeGreaterThan(0);
    expect(await rawPrisma.conversationSession.count({ where: { projectId: ISP_DIGITAL } })).toBe(ispSessionsBefore);
    expect(await rawPrisma.patternCandidate.count({ where: { projectId: ISP_DIGITAL } })).toBe(ispCandidatesBefore);
    const bizSessions = await rawPrisma.conversationSession.findMany({ where: { projectId: biz.projectId }, select: { accountId: true } });
    expect(bizSessions.every((row) => row.accountId === biz.account.id)).toBe(true);
  });
});

describe("§11 Notifications", () => {
  it("an alert goes only to the project's own destinations and its own members' direct messages", async () => {
    // Both projects route this event to their own group, and both have a member who asked for it by DM.
    await inIspP(() =>
      prisma.notificationEventSetting.upsert({
        where: { projectId_event: { projectId: ISP_DIGITAL, event: "AI_HUMAN_FALLBACK" } },
        update: { enabled: true, sendToWhatsApp: true, whatsappGroupIds: [`isp-alerts-${tag}@g.us`] },
        create: { event: "AI_HUMAN_FALLBACK", whatsappGroupIds: [`isp-alerts-${tag}@g.us`] },
      }),
    );
    ispCleanups.push(() => rawPrisma.notificationEventSetting.deleteMany({ where: { projectId: ISP_DIGITAL, event: "AI_HUMAN_FALLBACK", whatsappGroupIds: { has: `isp-alerts-${tag}@g.us` } } }));
    await inBiz(() =>
      prisma.notificationEventSetting.update({
        where: { projectId_event: { projectId: biz.projectId, event: "AI_HUMAN_FALLBACK" } },
        data: { enabled: true, sendToWhatsApp: true, whatsappGroupIds: [`biz-alerts-${tag}@g.us`] },
      }),
    );
    await inIspP(() => prisma.teamMemberNotificationPreference.create({ data: { teamMemberId: isp.memberId, event: "AI_HUMAN_FALLBACK" } }));
    await inBiz(() => prisma.teamMemberNotificationPreference.create({ data: { teamMemberId: biz.memberId, event: "AI_HUMAN_FALLBACK" } }));

    const delivery = await inBiz(() => getEventDelivery("AI_HUMAN_FALLBACK"));
    expect(delivery.whatsappGroupIds).toEqual([`biz-alerts-${tag}@g.us`]);

    await inBiz(() =>
      enqueueNotification({
        type: "WHATSAPP", event: "AI_HUMAN_FALLBACK", destination: `biz-alerts-${tag}@g.us`, accountId: biz.account.id, payload: { marker: MARKER },
      }),
    );
    const sent = await rawPrisma.notification.findMany({ where: { payload: { path: ["marker"], equals: MARKER } }, select: { projectId: true, destination: true, accountId: true } });
    expect(sent.length).toBeGreaterThanOrEqual(2); // the group, and Bizify's member by DM
    expect(sent.every((n) => n.projectId === biz.projectId && n.accountId === biz.account.id)).toBe(true);
    const destinations = sent.map((n) => n.destination);
    expect(destinations).toContain(`biz-alerts-${tag}@g.us`);
    expect(destinations.some((d) => d.startsWith(biz.memberPhone))).toBe(true);
    expect(destinations.some((d) => d.startsWith(isp.memberPhone))).toBe(false);
    expect(destinations).not.toContain(`isp-alerts-${tag}@g.us`);
  });
});
