import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NotificationEvent } from "@prisma/client";
import { createProjectWithDefaults } from "@support-automation/db";
import { DEFAULT_SHIFT_TEMPLATES, PROJECT_FEATURES } from "@support-automation/shared";
import { ISP_DIGITAL, prisma, rawPrisma } from "./helpers/projectFixtures.js";
import { forEachProject, resetProjectCachesForTests, withProject } from "../project/context.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { processOne } from "../queue/outboundQueueProcessor.js";
import { processOneNotification } from "../notifications/dispatcher.js";
import { findConnectableAccounts } from "../provider/accountProvisioning.js";
import { releaseDeletedAccounts } from "../provider/accountRegistrySync.js";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import type { NotificationProvider } from "../notifications/NotificationProvider.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Multi-project Phase 4 (MULTI_PROJECT_PLAN.md §8): creating a project, and what its status means
 * to the worker.
 *
 * - A new project starts CLEAN: its own default configuration, nothing copied from ISP Digital.
 * - SUSPENDED: nothing is sent (queued rows are held, not cancelled), scanners skip it, incoming
 *   messages are still stored but not automated.
 * - ARCHIVED: its WhatsApp accounts are not connected, and a held session is released.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const epoch = new Date(0);
const created: string[] = [];
let creatorId: string;

async function newProject(status: "SETUP" | "ACTIVE" = "ACTIVE") {
  const slug = `lifecycle-${tag}-${created.length}`;
  const project = await createProjectWithDefaults({ name: `Lifecycle ${tag} ${created.length}`, slug, status, creatorUserId: creatorId }, rawPrisma);
  created.push(project.id);
  resetProjectCachesForTests();
  return project;
}

async function setStatus(projectId: string, status: "SETUP" | "ACTIVE" | "SUSPENDED" | "ARCHIVED") {
  await rawPrisma.project.update({ where: { id: projectId }, data: { status } });
  resetProjectCachesForTests();
}

/** Row counts per project for every project-owned table — to prove what a new project did NOT get. */
async function rowCounts(projectId: string): Promise<Record<string, number>> {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
      WHERE column_name = 'projectId' AND table_schema = 'public' AND table_name <> 'SystemLog'`
  ).map((row) => row.table_name);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await rawPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table}" WHERE "projectId" = $1`, projectId);
    counts[table] = Number(row?.n ?? 0);
  }
  return counts;
}

beforeAll(async () => {
  const user = await rawPrisma.user.create({
    data: { username: `creator_${tag}`, email: `creator_${tag}@example.test`, name: "Creator", passwordHash: "x" },
  });
  creatorId = user.id;
});

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const table of tables) {
      await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = ANY($1)`, created).catch(() => undefined);
    }
  }
  await rawPrisma.projectAccess.deleteMany({ where: { projectId: { in: created } } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: { in: created } } });
  await rawPrisma.project.deleteMany({ where: { id: { in: created } } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

describe("creating a project", () => {
  it("creates its own default configuration and copies nothing from ISP Digital", async () => {
    const ispBefore = await rowCounts(ISP_DIGITAL);
    const project = await newProject("SETUP");

    const counts = await rowCounts(project.id);
    const expected: Record<string, number> = {
      AutomationSettings: 1,
      AiSettings: 1,
      GroupBroadcastSettings: 1,
      GroupParticipantAddSettings: 1,
      SupportEscalationSettings: 1,
      LearningSettings: 1,
      SupportActivitySettings: 1,
      ForgeSettings: 1,
      TeamManagementSettings: 1,
      CommunicationStyleProfile: 1,
      NotificationEventSetting: Object.values(NotificationEvent).length,
      ShiftTemplate: DEFAULT_SHIFT_TEMPLATES.length,
      ProjectAccess: 1,
      ProjectFeature: PROJECT_FEATURES.length,
    };
    // Everything else — messages, groups, knowledge, rules, AI providers and keys, teams, members,
    // notifications, templates, WhatsApp accounts, reports' rows — is empty.
    for (const [table, n] of Object.entries(counts)) expect({ table, n }).toEqual({ table, n: expected[table] ?? 0 });

    const automation = await rawPrisma.automationSettings.findUniqueOrThrow({ where: { projectId: project.id } });
    expect(automation.automationEnabled).toBe(false);
    const ai = await rawPrisma.aiSettings.findUniqueOrThrow({ where: { projectId: project.id } });
    expect(ai.aiEngineEnabled).toBe(false);
    expect(await rawPrisma.projectAccess.count({ where: { projectId: project.id, userId: creatorId } })).toBe(1);

    // ISP Digital is untouched.
    expect(await rowCounts(ISP_DIGITAL)).toEqual(ispBefore);
  });

  it("its settings are what the scoped client reads for it — never ISP Digital's", async () => {
    const project = await newProject();
    const read = await withProject(project.id, () => prisma.automationSettings.findUnique({ where: { id: "global" } }));
    expect(read?.projectId).toBe(project.id);
    expect(read?.automationEnabled).toBe(false);
  });

  it("is all or nothing: a clashing slug leaves no half-created project behind", async () => {
    const before = await rawPrisma.automationSettings.count();
    await expect(
      createProjectWithDefaults({ name: "Clash", slug: "isp-digital", status: "SETUP", creatorUserId: creatorId }, rawPrisma),
    ).rejects.toThrow();
    expect(await rawPrisma.automationSettings.count()).toBe(before);
  });
});

describe("a SUSPENDED project", () => {
  it("holds its queued messages and alerts — neither sent nor cancelled — until it is active again", async () => {
    const project = await newProject();
    const account = await withProject(project.id, () => prisma.whatsAppAccount.create({ data: { label: `L ${tag}`, status: "CONNECTED" } }));
    const chat = `${tag}-2222222222@g.us`;
    const outbound = await rawPrisma.outboundMessage.create({
      data: {
        projectId: project.id, accountId: account.id, chatId: chat, toPhone: chat, body: "held",
        actionType: "MANUAL_REPLY", idempotencyKey: randomUUID(), status: "PENDING", scheduledAt: epoch,
      },
    });
    const alert = await rawPrisma.notification.create({
      data: { projectId: project.id, accountId: account.id, type: "WHATSAPP", destination: chat, payload: {}, status: "PENDING", createdAt: epoch },
    });
    await setStatus(project.id, "SUSPENDED");

    const provider = new MockProvider();
    let alertsSent = 0;
    const whatsapp = { send: async () => ((alertsSent += 1), { success: true }) } as unknown as NotificationProvider;
    // Drain whatever else is due; ours must never be picked while suspended.
    for (let i = 0; i < 20 && (await processOne(provider)); i++);
    for (let i = 0; i < 20 && (await processOneNotification({ WHATSAPP: whatsapp })); i++);
    expect((await rawPrisma.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } })).status).toBe("PENDING");
    expect((await rawPrisma.notification.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("PENDING");
    expect(provider.sentMessages.find((m) => m.body === "held")).toBeUndefined();

    await setStatus(project.id, "ACTIVE");
    expect(await processOne(provider)).toBe(true);
    expect((await rawPrisma.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } })).status).toBe("SENT");
    expect(await processOneNotification({ WHATSAPP: whatsapp })).toBe(true);
    expect(alertsSent).toBe(1);
  });

  it("still stores incoming messages, but runs no automation on them", async () => {
    const project = await newProject();
    const account = await withProject(project.id, () => prisma.whatsAppAccount.create({ data: { label: `L2 ${tag}`, status: "CONNECTED", isPrimary: true } }));
    await withProject(project.id, async () => {
      await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: true } });
      await prisma.automationRule.create({
        data: {
          name: `Suspended rule ${tag}`, type: "AUTO_REPLY", matchType: "KEYWORDS", keywords: [`zeph${tag}`],
          conditions: {}, actions: [{ type: "AUTO_REPLY" }], replyMessage: "should not go", priority: 1, status: "ACTIVE",
        },
      });
    });
    await setStatus(project.id, "SUSPENDED");

    const whatsappMessageId = `wamid-${randomUUID()}`;
    await processIncomingMessage({
      accountId: account.id, whatsappMessageId, chatId: `${tag}-3333333333@g.us`, whatsappGroupId: `${tag}-3333333333@g.us`,
      senderPhone: "8801711000111", direction: "INCOMING", body: `hello zeph${tag}`, timestampWa: new Date(),
    });
    const stored = await rawPrisma.message.findFirstOrThrow({ where: { whatsappMessageId } });
    expect(stored.projectId).toBe(project.id);
    expect(stored.processingStatus).toBe("IGNORED");
    expect(await rawPrisma.outboundMessage.count({ where: { projectId: project.id } })).toBe(0);
    expect(await rawPrisma.automationExecution.count({ where: { messageId: stored.id } })).toBe(0);
  });

  it("is skipped by the background scanners, and picked up again when reactivated", async () => {
    const project = await newProject();
    await setStatus(project.id, "SUSPENDED");
    const visited: string[] = [];
    await forEachProject("lifecycle-test", async (id) => void visited.push(id));
    expect(visited).not.toContain(project.id);
    expect(visited).toContain(ISP_DIGITAL);

    await setStatus(project.id, "ACTIVE");
    const again: string[] = [];
    await forEachProject("lifecycle-test", async (id) => void again.push(id));
    expect(again).toContain(project.id);
  });
});

describe("an ARCHIVED project", () => {
  it("has its accounts left unconnected and a held session released — never logged out", async () => {
    const project = await newProject();
    const account = await withProject(project.id, () =>
      prisma.whatsAppAccount.create({ data: { label: `A ${tag}`, status: "CONNECTED", sessionId: `s-${tag}`, sessionDataPath: `/tmp/${tag}` } }),
    );
    expect((await findConnectableAccounts()).map((a) => a.id)).toContain(account.id);

    await setStatus(project.id, "ARCHIVED");
    expect((await findConnectableAccounts()).map((a) => a.id)).not.toContain(account.id);

    const released: string[] = [];
    const registry = {
      allAccountIds: () => [account.id],
      disconnectAccount: async (id: string) => (released.push(id), true),
    } as unknown as ProviderRegistry;
    await releaseDeletedAccounts(registry);
    expect(released).toEqual([account.id]);
    // The row, and the session it points at, are untouched.
    const after = await rawPrisma.whatsAppAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.sessionId).toBe(`s-${tag}`);
  });
});
