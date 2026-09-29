import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { createProjectWithDefaults } from "@support-automation/db";
import type { ProjectFeatureKey } from "@support-automation/shared";
import { prisma, rawPrisma } from "./helpers/projectFixtures.js";
import { resetProjectCachesForTests, withProject } from "../project/context.js";
import { projectHasFeature, resetProjectFeatureCacheForTests } from "../project/features.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { processOneSegmentationBatch } from "../learning/sessionSegmentation.js";
import { checkAiFallbackEligibility } from "../aiFallback/eligibility.js";
import { MockAiClient } from "./mockAiClient.js";

/**
 * Multi-project Phase 5 (MULTI_PROJECT_PLAN.md §9): a project's feature ENTITLEMENTS in the worker.
 *
 * Each test runs the same work twice in one fresh project — once with the feature on, once off —
 * with every one of the module's own settings switched ON both times. So the only difference is the
 * entitlement, and "off" must mean the work does not happen at all.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let projectId: string;
let creatorId: string;
let account: WhatsAppAccount;
let group: WhatsAppGroup;
const inProject = <T,>(fn: () => Promise<T>) => withProject(projectId, fn);
const digits = () => `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

async function setFeature(key: ProjectFeatureKey, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId, key } },
    update: { enabled },
    create: { projectId, key, enabled },
  });
  resetProjectFeatureCacheForTests();
}

function customerMessage(body: string, senderPhone = digits(), inGroup: WhatsAppGroup = group) {
  return {
    accountId: account.id,
    whatsappMessageId: `wamid-${randomUUID()}`,
    chatId: inGroup.whatsappGroupId,
    whatsappGroupId: inGroup.whatsappGroupId,
    senderPhone,
    direction: "INCOMING" as const,
    body,
    timestampWa: new Date(),
  };
}

beforeAll(async () => {
  const user = await rawPrisma.user.create({
    data: { username: `feat_${tag}`, email: `feat_${tag}@example.test`, name: "Feature test", passwordHash: "x" },
  });
  creatorId = user.id;
  projectId = (await createProjectWithDefaults({ name: `Features ${tag}`, slug: `features-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma)).id;
  resetProjectCachesForTests();

  await inProject(async () => {
    account = await prisma.whatsAppAccount.create({ data: { label: `F ${tag}`, status: "CONNECTED", isPrimary: true } });
    group = await prisma.whatsAppGroup.create({
      data: {
        accountId: account.id,
        whatsappGroupId: `${tag}-4444444444@g.us`,
        name: "Feature group",
        isMonitored: true,
        aiAutomationEnabled: true,
        priority: "P1",
        escalationMonitoringEnabled: true,
        lastSyncedAt: new Date(),
      },
    });
    // Every module's OWN switch on, so only the entitlement differs between the two runs.
    await prisma.automationSettings.update({
      where: { id: "global" },
      data: { automationEnabled: true, mode: "SAFE_AUTO_REPLY", defaultReplyDelayMinMs: 0, defaultReplyDelayMaxMs: 0 },
    });
    await prisma.aiSettings.update({
      where: { id: "global" },
      data: { aiEngineEnabled: true, autoResponseEnabled: true, aiResponseMode: "KNOWLEDGE_PLUS_GENERAL" },
    });
    await prisma.learningSettings.update({ where: { id: "global" }, data: { conversationLearningEnabled: true } });
    await prisma.supportEscalationSettings.update({ where: { id: "global" }, data: { enabled: true } });
  });
});

beforeEach(() => {
  resetProjectFeatureCacheForTests();
});

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const table of tables) {
      await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = $1`, projectId).catch(() => undefined);
    }
  }
  await rawPrisma.project.deleteMany({ where: { id: projectId } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

describe("reading a project's features", () => {
  it("is on by default — no row means the catalogue default — and a row turns it off", async () => {
    await rawPrisma.projectFeature.deleteMany({ where: { projectId, key: "BULK_MESSAGING" } });
    resetProjectFeatureCacheForTests();
    expect(await inProject(() => projectHasFeature("BULK_MESSAGING"))).toBe(true);
    await setFeature("BULK_MESSAGING", false);
    expect(await inProject(() => projectHasFeature("BULK_MESSAGING"))).toBe(false);
    await setFeature("BULK_MESSAGING", true);
  });

  it("the AI eligibility gate refuses a project that is not entitled, and only that", () => {
    const base = {
      automationEnabled: true,
      mode: "SAFE_AUTO_REPLY" as const,
      group: { isMonitored: true, aiAutomationEnabled: true, aiAutomationExcluded: false, aiSuppressedUntil: null },
      aiEngineEnabled: true,
      autoResponseEnabled: true,
      scope: "PER_GROUP" as const,
      now: new Date(),
    };
    expect(checkAiFallbackEligibility(base)).toEqual({ eligible: true });
    expect(checkAiFallbackEligibility({ ...base, aiReplyEntitled: true })).toEqual({ eligible: true });
    expect(checkAiFallbackEligibility({ ...base, aiReplyEntitled: false })).toMatchObject({ eligible: false });
  });
});

describe("switching a feature off stops its background work", () => {
  it("AI_REPLY: the AI fallback does not run at all", async () => {
    const run = async () => {
      const raw = customerMessage(`how do I configure the qorbit${tag} option?`);
      await processIncomingMessage(raw, new MockAiClient());
      const stored = await rawPrisma.message.findFirstOrThrow({ where: { whatsappMessageId: raw.whatsappMessageId } });
      return rawPrisma.aiFallbackDecision.count({ where: { messageId: stored.id } });
    };
    await setFeature("AI_REPLY", true);
    expect(await run()).toBe(1);
    await setFeature("AI_REPLY", false);
    expect(await run()).toBe(0);
    await setFeature("AI_REPLY", true);
  });

  it("ESCALATIONS: a priority group's customer message opens no case", async () => {
    // A fresh priority group each run: a case is per conversation, so a second message in the same
    // chat continues the case rather than opening one.
    const run = async () => {
      const priorityGroup = await inProject(() =>
        prisma.whatsAppGroup.create({
          data: {
            accountId: account.id, whatsappGroupId: `${randomUUID().slice(0, 10)}-5555555555@g.us`, name: "Priority group",
            isMonitored: true, priority: "P1", escalationMonitoringEnabled: true, lastSyncedAt: new Date(),
          },
        }),
      );
      await processIncomingMessage(customerMessage("my connection is down", digits(), priorityGroup));
      return rawPrisma.supportEscalationCase.count({ where: { projectId, groupId: priorityGroup.id } });
    };
    await setFeature("ESCALATIONS", true);
    expect(await run()).toBe(1);
    await setFeature("ESCALATIONS", false);
    expect(await run()).toBe(0);
    await setFeature("ESCALATIONS", true);
  });

  it("TEAM_MANAGEMENT: a team member's message records no attendance", async () => {
    const run = async () => {
      const phone = digits();
      const member = await inProject(() =>
        prisma.internalTeamMember.create({ data: { name: `Member ${phone}`, phoneNumber: phone, role: "Support", status: "ACTIVE" } }),
      );
      await processIncomingMessage(customerMessage("I am on it", phone));
      return rawPrisma.teamAttendanceDay.count({ where: { teamMemberId: member.id } });
    };
    await setFeature("TEAM_MANAGEMENT", true);
    expect(await run()).toBe(1);
    await setFeature("TEAM_MANAGEMENT", false);
    expect(await run()).toBe(0);
    await setFeature("TEAM_MANAGEMENT", true);
  });

  it("CONVERSATION_LEARNING: session segmentation does nothing", async () => {
    const run = async () => {
      const message = await inProject(() =>
        prisma.message.create({
          data: {
            accountId: account.id, whatsappMessageId: `wamid-${randomUUID()}`, chatId: `${tag}-${randomUUID().slice(0, 6)}@g.us`,
            senderPhone: digits(), direction: "INCOMING", body: "x", normalizedBody: "x", timestampWa: new Date(Date.now() - 60_000),
            processingStatus: "IGNORED",
          },
        }),
      );
      await inProject(() => processOneSegmentationBatch());
      return (await rawPrisma.message.findUniqueOrThrow({ where: { id: message.id } })).conversationSessionId;
    };
    await setFeature("CONVERSATION_LEARNING", false);
    expect(await run()).toBeNull();
    await setFeature("CONVERSATION_LEARNING", true);
    expect(await run()).not.toBeNull();
  });

  it("switching a feature off deletes nothing: the module's own settings are kept", async () => {
    await setFeature("CONVERSATION_LEARNING", false);
    const settings = await rawPrisma.learningSettings.findUniqueOrThrow({ where: { projectId } });
    expect(settings.conversationLearningEnabled).toBe(true);
    await setFeature("CONVERSATION_LEARNING", true);
  });
});
