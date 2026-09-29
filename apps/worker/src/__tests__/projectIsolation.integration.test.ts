import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { createKnowledgeItem, encryptSecret, isResolutionError, ProjectScopeError, resolveWhatsAppAccount } from "@support-automation/db";
import { resolveAiClientResult } from "@support-automation/ai-client";
import { ISP_DIGITAL, inIsp, prisma, rawPrisma } from "./helpers/projectFixtures.js";
import { prisma as workerPrisma } from "../db.js";
import { forEachProject, resetProjectCachesForTests, withProject } from "../project/context.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { findRelevantKnowledge } from "../aiFallback/knowledgeContext.js";
import { processOne } from "../queue/outboundQueueProcessor.js";
import { processOneNotification } from "../notifications/dispatcher.js";
import { processOneCommand } from "../commands/commandProcessor.js";
import { enqueueNotification } from "../notifications/enqueueNotification.js";
import { processOneSegmentationBatch } from "../learning/sessionSegmentation.js";
import { ensurePrimaryAccountExists } from "../provider/accountProvisioning.js";
import type { NotificationProvider } from "../notifications/NotificationProvider.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Multi-project Phase 3 (MULTI_PROJECT_PLAN.md §10.3): the WORKER keeps projects apart.
 *
 * Two projects — ISP Digital and a throwaway "Bizify" — each with its own WhatsApp account. Every
 * test asks one question: can work that belongs to one project read, write, answer from, send
 * through or be configured by the other? It must not. And work with no project, or an unknown one,
 * must be refused rather than land somewhere by default.
 *
 * Fixtures go through the test client (ISP Digital outside a context, Bizify inside
 * `inBiz`); assertions that must see across projects use `rawPrisma`.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const BIZIFY = `proj_test_bizify_${tag}`;
const MARKER = `qorvex${tag}`;
const inBiz = <T,>(fn: () => Promise<T>) => withProject(BIZIFY, fn);
const epoch = new Date(0); // oldest possible, so a shared queue claims these rows first
const chatId = () => `${randomUUID().replace(/-/g, "").slice(0, 10)}-1111111111@g.us`;
const digits = () => `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

let ispAccount: WhatsAppAccount;
let bizAccount: WhatsAppAccount;
let ispGroup: WhatsAppGroup;
let bizGroup: WhatsAppGroup;
let ispPrimaryIdsBefore: string[] = [];
const cleanupIsp: Array<() => Promise<unknown>> = [];

function raw(accountId: string, body: string, whatsappGroupId: string | null, direction: "INCOMING" | "OUTGOING" = "INCOMING") {
  return {
    accountId,
    whatsappMessageId: `wamid-${randomUUID()}`,
    chatId: whatsappGroupId ?? `${digits()}@c.us`,
    whatsappGroupId,
    senderPhone: digits(),
    direction,
    body,
    timestampWa: new Date(),
  } as const;
}

beforeAll(async () => {
  await rawPrisma.project.create({ data: { id: BIZIFY, name: `Bizify ${tag}`, slug: `bizify-${tag}`, status: "ACTIVE" } });
  resetProjectCachesForTests();
  ispPrimaryIdsBefore = (await rawPrisma.whatsAppAccount.findMany({ where: { projectId: ISP_DIGITAL, isPrimary: true }, select: { id: true } })).map((a) => a.id);

  ispAccount = await prisma.whatsAppAccount.create({ data: { label: `ISP ${tag}`, status: "CONNECTED" } });
  ispGroup = await prisma.whatsAppGroup.create({
    data: { accountId: ispAccount.id, whatsappGroupId: chatId(), name: "ISP isolation group", lastSyncedAt: new Date() },
  });
  bizAccount = await inBiz(() => prisma.whatsAppAccount.create({ data: { label: `Bizify ${tag}`, status: "CONNECTED", isPrimary: true } }));
  bizGroup = await inBiz(() =>
    prisma.whatsAppGroup.create({
      data: { accountId: bizAccount.id, whatsappGroupId: chatId(), name: "Bizify isolation group", lastSyncedAt: new Date() },
    }),
  );
});

afterAll(async () => {
  for (const undo of cleanupIsp.reverse()) await undo().catch(() => undefined);
  // Whatever Primary this suite's ensurePrimary test promoted in ISP Digital goes back.
  await rawPrisma.whatsAppAccount.updateMany({
    where: { projectId: ISP_DIGITAL, isPrimary: true, id: { notIn: ispPrimaryIdsBefore } },
    data: { isPrimary: false },
  });
  for (const table of ["Message", "OutboundMessage", "Notification", "WorkerCommand", "AutomationExecution", "ProcessingCheckpoint", "WhatsAppGroup"]) {
    await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "accountId" = $1`, ispAccount.id).catch(() => undefined);
  }
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: ispAccount.id } });
  // Everything Bizify owns, in whatever order the foreign keys allow.
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const table of tables) {
      await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = $1`, BIZIFY).catch(() => undefined);
    }
  }
  await rawPrisma.project.delete({ where: { id: BIZIFY } });
  await rawPrisma.$disconnect();
});

describe("incoming messages carry the receiving account's project", () => {
  it("stores each project's message in that project, even for the same WhatsApp group", async () => {
    // The same WhatsApp group id seen by both numbers: ISP Digital already has a row for it.
    const sharedGroupId = ispGroup.whatsappGroupId;
    const ispMsg = raw(ispAccount.id, `hello from isp ${MARKER}`, sharedGroupId);
    const bizMsg = raw(bizAccount.id, `hello from bizify ${MARKER}`, sharedGroupId);
    await processIncomingMessage(ispMsg);
    await processIncomingMessage(bizMsg);

    const ispRow = await rawPrisma.message.findFirstOrThrow({ where: { whatsappMessageId: ispMsg.whatsappMessageId } });
    const bizRow = await rawPrisma.message.findFirstOrThrow({ where: { whatsappMessageId: bizMsg.whatsappMessageId } });
    expect(ispRow.projectId).toBe(ISP_DIGITAL);
    expect(ispRow.groupId).toBe(ispGroup.id);
    expect(bizRow.projectId).toBe(BIZIFY);
    // Never filed under ISP Digital's group row: Bizify registers its own.
    expect(bizRow.groupId).not.toBe(ispGroup.id);
    const bizRowGroup = await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: bizRow.groupId! } });
    expect(bizRowGroup.projectId).toBe(BIZIFY);
    expect(bizRowGroup.accountId).toBe(bizAccount.id);
  });

  it("refuses a message from an account that does not exist, and stores nothing", async () => {
    const orphan = raw(randomUUID(), "who am I", null);
    await expect(processIncomingMessage(orphan)).rejects.toBeInstanceOf(ProjectScopeError);
    expect(await rawPrisma.message.count({ where: { whatsappMessageId: orphan.whatsappMessageId } })).toBe(0);
  });
});

describe("no project, an unknown project, or a switch of project is refused", () => {
  it("worker code touching project data outside any project context throws", async () => {
    await expect(workerPrisma.whatsAppGroup.findMany({ take: 1 })).rejects.toBeInstanceOf(ProjectScopeError);
  });

  it("an unknown project is refused", async () => {
    await expect(withProject(`proj_missing_${tag}`, async () => 1)).rejects.toBeInstanceOf(ProjectScopeError);
    await expect(withProject("", async () => 1)).rejects.toBeInstanceOf(ProjectScopeError);
  });

  it("work in one project cannot switch itself into another", async () => {
    await expect(inBiz(() => withProject(ISP_DIGITAL, async () => 1))).rejects.toBeInstanceOf(ProjectScopeError);
  });

  it("cross-project attack: a Bizify context cannot read, change or create ISP Digital rows by id", async () => {
    await inBiz(async () => {
      expect(await workerPrisma.whatsAppGroup.findUnique({ where: { id: ispGroup.id } })).toBeNull();
      expect(await workerPrisma.message.findMany({ where: { accountId: ispAccount.id } })).toEqual([]);
      await expect(
        workerPrisma.whatsAppGroup.update({ where: { id: ispGroup.id }, data: { isMonitored: true } }),
      ).rejects.toThrow();
      await expect(
        workerPrisma.whatsAppGroup.create({
          data: { projectId: ISP_DIGITAL, accountId: ispAccount.id, whatsappGroupId: chatId(), name: "injected" },
        }),
      ).rejects.toBeInstanceOf(ProjectScopeError);
    });
    const ispGroupAfter = await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: ispGroup.id } });
    expect(ispGroupAfter.isMonitored).toBe(false);
  });
});

describe("knowledge and AI configuration are per project", () => {
  it("ISP Digital's verified knowledge never grounds a Bizify answer", async () => {
    const item = await createKnowledgeItem(
      {
        title: `${MARKER} guide`,
        category: "FAQ",
        question: `How does ${MARKER} work?`,
        answer: `The ${MARKER} option is on the billing screen.`,
        source: "MANUAL",
        aiGenerated: false,
        humanVerified: true,
      },
      prisma,
    );
    cleanupIsp.push(() => rawPrisma.aiKnowledgeItem.deleteMany({ where: { id: item.id } }));

    const inIspDigital = await inIsp(() => findRelevantKnowledge(`tell me about ${MARKER}`, { groupId: ispGroup.id, accountId: ispAccount.id }));
    expect(inIspDigital.map((k) => k.title)).toContain(`${MARKER} guide`);
    const inBizify = await inBiz(() => findRelevantKnowledge(`tell me about ${MARKER}`, { groupId: bizGroup.id, accountId: bizAccount.id }));
    expect(inBizify).toEqual([]);
  });

  it("a project without its own AI model never borrows another project's provider", async () => {
    const ispProvider = await prisma.aiProvider.create({
      data: { name: `ISP provider ${tag}`, kind: "OPENROUTER", apiKeyCiphertext: encryptSecret("isp-key"), status: "ACTIVE" },
    });
    cleanupIsp.push(() => rawPrisma.aiProvider.deleteMany({ where: { id: ispProvider.id } }));
    const existingIspConfig = await prisma.aiModelConfig.findFirst({ where: { job: "RESPONSE" } });
    if (!existingIspConfig) {
      const config = await prisma.aiModelConfig.create({ data: { job: "RESPONSE", providerId: ispProvider.id, modelId: "isp/model" } });
      cleanupIsp.unshift(() => rawPrisma.aiModelConfig.deleteMany({ where: { id: config.id } }));
    }

    await inBiz(() => prisma.aiSettings.upsert({ where: { id: "global" }, update: { aiEngineEnabled: true }, create: { id: "global", aiEngineEnabled: true } }));
    const bizResult = await inBiz(() => resolveAiClientResult("RESPONSE", workerPrisma));
    expect(bizResult.client).toBeNull();
    expect(bizResult.reason).toBe("NO_MODEL_CONFIGURED");

    const bizProvider = await inBiz(() =>
      prisma.aiProvider.create({ data: { name: `Bizify provider ${tag}`, kind: "OPENROUTER", apiKeyCiphertext: encryptSecret("biz-key"), status: "ACTIVE" } }),
    );
    expect(await inIsp(() => workerPrisma.aiProvider.findUnique({ where: { id: bizProvider.id } }))).toBeNull();
    expect(await inBiz(() => workerPrisma.aiProvider.findUnique({ where: { id: ispProvider.id } }))).toBeNull();
  });
});

describe("rules and automation are per project", () => {
  it("an ISP Digital rule never fires on a Bizify message", async () => {
    const rule = await prisma.automationRule.create({
      data: {
        name: `ISP only ${tag}`,
        type: "AUTO_REPLY",
        matchType: "KEYWORDS",
        keywords: [MARKER],
        conditions: {},
        actions: [{ type: "AUTO_REPLY" }],
        replyMessage: "isp reply",
        priority: 1,
        status: "ACTIVE",
      },
    });
    cleanupIsp.push(() => rawPrisma.automationRule.deleteMany({ where: { id: rule.id } }));

    const bizMsg = raw(bizAccount.id, `please help ${MARKER}`, bizGroup.whatsappGroupId);
    await processIncomingMessage(bizMsg);
    const stored = await rawPrisma.message.findFirstOrThrow({ where: { whatsappMessageId: bizMsg.whatsappMessageId } });
    const executions = await rawPrisma.automationExecution.findMany({ where: { messageId: stored.id } });
    expect(executions.every((e) => e.ruleId !== rule.id)).toBe(true);
    expect(executions.every((e) => e.projectId === BIZIFY)).toBe(true);
    expect(await rawPrisma.outboundMessage.count({ where: { ruleId: rule.id } })).toBe(0);
  });
});

describe("Primary WhatsApp is per project", () => {
  it("each project resolves its own Primary", async () => {
    const resolved = await inBiz(() => resolveWhatsAppAccount("NOTIFY_WHATSAPP", workerPrisma));
    expect(isResolutionError(resolved)).toBe(false);
    if (!isResolutionError(resolved)) expect(resolved.accountId).toBe(bizAccount.id);

    const ispResolved = await inIsp(() => resolveWhatsAppAccount("NOTIFY_WHATSAPP", workerPrisma));
    if (!isResolutionError(ispResolved)) expect(ispResolved.accountId).not.toBe(bizAccount.id);
  });

  it("two projects may each have a Primary; one project may not have two", async () => {
    if (ispPrimaryIdsBefore.length === 0) {
      await rawPrisma.whatsAppAccount.update({ where: { id: ispAccount.id }, data: { isPrimary: true } });
    }
    expect(await rawPrisma.whatsAppAccount.count({ where: { isPrimary: true, projectId: { in: [ISP_DIGITAL, BIZIFY] } } })).toBe(2);
    await expect(
      inBiz(() => prisma.whatsAppAccount.create({ data: { label: `Bizify second ${tag}`, isPrimary: true } })),
    ).rejects.toThrow();
  });

  it("a project that lost its Primary gets one from its OWN accounts", async () => {
    await rawPrisma.whatsAppAccount.update({ where: { id: bizAccount.id }, data: { isPrimary: false } });
    await ensurePrimaryAccountExists();
    expect((await rawPrisma.whatsAppAccount.findUniqueOrThrow({ where: { id: bizAccount.id } })).isPrimary).toBe(true);
  });
});

describe("outbound messages, alerts and commands never cross projects", () => {
  it("refuses to send a Bizify message through an ISP Digital account, and says why", async () => {
    const provider = new MockProvider();
    const row = await rawPrisma.outboundMessage.create({
      data: {
        projectId: BIZIFY, accountId: ispAccount.id, chatId: ispGroup.whatsappGroupId, toPhone: ispGroup.whatsappGroupId,
        body: "cross-project", actionType: "MANUAL_REPLY", idempotencyKey: randomUUID(), status: "PENDING", scheduledAt: epoch,
      },
    });
    expect(await processOne(provider)).toBe(true);
    const after = await rawPrisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("FAILED");
    expect(after.failureReason).toMatch(/different project/);
    expect(provider.sentMessages).toEqual([]);
    const logged = await rawPrisma.systemLog.findFirst({
      where: { message: "Refused to send a message through an account outside its project", projectId: BIZIFY },
      orderBy: { createdAt: "desc" },
    });
    expect(logged).not.toBeNull();
  });

  it("still sends a Bizify message through Bizify's own account", async () => {
    const provider = new MockProvider();
    const row = await rawPrisma.outboundMessage.create({
      data: {
        projectId: BIZIFY, accountId: bizAccount.id, chatId: bizGroup.whatsappGroupId, toPhone: bizGroup.whatsappGroupId,
        body: "same-project", actionType: "MANUAL_REPLY", idempotencyKey: randomUUID(), status: "PENDING", scheduledAt: epoch,
      },
    });
    expect(await processOne(provider)).toBe(true);
    expect((await rawPrisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("SENT");
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("refuses to send a Bizify alert through an ISP Digital account", async () => {
    let sends = 0;
    const whatsapp: NotificationProvider = {
      send: async () => {
        sends += 1;
        return { success: true };
      },
    } as NotificationProvider;
    const row = await rawPrisma.notification.create({
      data: {
        projectId: BIZIFY, accountId: ispAccount.id, type: "WHATSAPP", destination: ispGroup.whatsappGroupId,
        payload: {}, status: "PENDING", createdAt: epoch,
      },
    });
    expect(await processOneNotification({ WHATSAPP: whatsapp })).toBe(true);
    const after = await rawPrisma.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("FAILED");
    expect(after.failureReason).toMatch(/different project/);
    expect(sends).toBe(0);
  });

  it("refuses a Bizify command aimed at an ISP Digital account", async () => {
    const provider = new MockProvider();
    const row = await rawPrisma.workerCommand.create({
      data: { projectId: BIZIFY, accountId: ispAccount.id, type: "LOGOUT", status: "PENDING", createdAt: epoch },
    });
    await processOneCommand(ispAccount.id, provider);
    const after = await rawPrisma.workerCommand.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("FAILED");
    expect(JSON.stringify(after.result)).toMatch(/outside its project/);
    expect(provider.loggedOut).toBe(false);
  });

  it("alert routing and muting are each project's own", async () => {
    const existing = await prisma.notificationEventSetting.findFirst({ where: { event: "AI_HUMAN_FALLBACK" } });
    await prisma.notificationEventSetting.upsert({
      where: { projectId_event: { projectId: ISP_DIGITAL, event: "AI_HUMAN_FALLBACK" } },
      update: { enabled: false },
      create: { event: "AI_HUMAN_FALLBACK", enabled: false },
    });
    cleanupIsp.push(() =>
      existing
        ? rawPrisma.notificationEventSetting.update({ where: { projectId_event: { projectId: ISP_DIGITAL, event: "AI_HUMAN_FALLBACK" } }, data: { enabled: existing.enabled } })
        : rawPrisma.notificationEventSetting.deleteMany({ where: { projectId: ISP_DIGITAL, event: "AI_HUMAN_FALLBACK" } }),
    );

    const params = { type: "TEAMS" as const, event: "AI_HUMAN_FALLBACK" as const, destination: "teams", payload: { marker: MARKER } };
    const muted = await inIsp(() => enqueueNotification(params));
    expect(muted.suppressed).toBe(true);
    const sent = await inBiz(() => enqueueNotification(params));
    expect(sent.suppressed).toBeUndefined();
    expect((await rawPrisma.notification.findUniqueOrThrow({ where: { id: sent.id } })).projectId).toBe(BIZIFY);
  });
});

describe("background learning runs per project", () => {
  it("Bizify's segmentation never touches ISP Digital's messages", async () => {
    const at = new Date(Date.now() - 60_000);
    // Sorts first by chat id, so an unscoped scan would reach it before anything else.
    const ispMessage = await prisma.message.create({
      data: {
        accountId: ispAccount.id, whatsappMessageId: `wamid-${randomUUID()}`, chatId: `0000${tag}@g.us`, senderPhone: digits(),
        direction: "INCOMING", body: "isp", normalizedBody: "isp", timestampWa: at, processingStatus: "IGNORED",
      },
    });
    const bizMessage = await inBiz(() =>
      prisma.message.create({
        data: {
          accountId: bizAccount.id, whatsappMessageId: `wamid-${randomUUID()}`, chatId: `0001${tag}@g.us`, senderPhone: digits(),
          direction: "INCOMING", body: "biz", normalizedBody: "biz", timestampWa: at, processingStatus: "IGNORED",
        },
      }),
    );
    await inBiz(() =>
      prisma.learningSettings.upsert({
        where: { id: "global" },
        update: { conversationLearningEnabled: true },
        create: { id: "global", conversationLearningEnabled: true },
      }),
    );

    await inBiz(() => processOneSegmentationBatch());

    const bizAfter = await rawPrisma.message.findUniqueOrThrow({ where: { id: bizMessage.id } });
    expect(bizAfter.conversationSessionId).not.toBeNull();
    const session = await rawPrisma.conversationSession.findUniqueOrThrow({ where: { id: bizAfter.conversationSessionId! } });
    expect(session.projectId).toBe(BIZIFY);
    expect((await rawPrisma.message.findUniqueOrThrow({ where: { id: ispMessage.id } })).conversationSessionId).toBeNull();
  });

  it("the background loops visit every project, and one project failing does not stop the next", async () => {
    const visited: string[] = [];
    await forEachProject("isolation-test", async (projectId) => {
      visited.push(projectId);
      if (projectId === ISP_DIGITAL) throw new Error("simulated failure in ISP Digital");
    });
    expect(visited).toEqual(expect.arrayContaining([ISP_DIGITAL, BIZIFY]));
    expect(visited.indexOf(BIZIFY)).toBeGreaterThan(visited.indexOf(ISP_DIGITAL));
  });
});
