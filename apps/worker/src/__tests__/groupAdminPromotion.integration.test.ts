import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { WhatsAppAccount } from "@prisma/client";
import { prisma, rawPrisma, ISP_DIGITAL } from "./helpers/projectFixtures.js";
import { processOneAdminPromotion } from "../queue/groupAdminPromotionProcessor.js";
import { resetProjectCachesForTests } from "../project/context.js";
import { MockProvider } from "./mockProvider.js";

/**
 * WhatsApp Groups Admin Maker (GROUP_ADMIN_MAKER.md): the worker side, driven exactly as the loop
 * drives it — one `processOneAdminPromotion` per tick — against a MockProvider that answers like
 * WhatsApp: a member list, an admin list, and a promote call.
 *
 * Time is moved by hand (`advance`), so the pacing and retry delays are tested without waiting.
 */

const TARGET = `88017${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const T = `${TARGET}@c.us`;
const ME = "8801999000999@c.us";

let account: WhatsAppAccount;
let provider: MockProvider;
const providers = { get: (id: string) => (id === account.id ? provider : undefined) };
let savedAutomation: boolean | null = null;

async function group(label: string, opts: { active?: boolean } = {}) {
  return prisma.whatsAppGroup.create({
    data: { accountId: account.id, whatsappGroupId: `${label}-${randomUUID().slice(0, 8)}@g.us`, name: `Admin ${label}`, isActive: opts.active ?? true, isMonitored: false },
  });
}

async function job(groups: Array<{ id: string; name: string }>) {
  return prisma.groupAdminPromotionJob.create({
    data: {
      accountId: account.id,
      phoneNumber: TARGET,
      totalGroups: groups.length,
      items: { create: groups.map((g) => ({ projectId: ISP_DIGITAL, groupId: g.id, groupNameSnapshot: g.name, scheduledAt: new Date(0) })) },
    },
  });
}

/** Moves every pacing and retry clock of this test back, as if `ms` had passed. */
async function advance(ms: number) {
  await rawPrisma.$executeRaw`UPDATE "GroupAdminPromotionItem" SET "scheduledAt" = "scheduledAt" - make_interval(secs => ${ms / 1000}), "lastAttemptAt" = "lastAttemptAt" - make_interval(secs => ${ms / 1000}) WHERE "jobId" IN (SELECT "id" FROM "GroupAdminPromotionJob" WHERE "accountId" = ${account.id})`;
}

/** Runs the loop until the job settles, letting time pass whenever it is only waiting. */
async function drain(jobId: string, maxSteps = 60) {
  for (let i = 0; i < maxSteps; i++) {
    const worked = await processOneAdminPromotion(providers);
    const state = await prisma.groupAdminPromotionJob.findUniqueOrThrow({ where: { id: jobId } });
    if (!["CHECKING", "RUNNING"].includes(state.status)) return state;
    if (!worked) await advance(120_000);
  }
  throw new Error("job did not settle");
}

const items = async (jobId: string) =>
  Object.fromEntries(
    (await prisma.groupAdminPromotionItem.findMany({ where: { jobId }, select: { groupNameSnapshot: true, status: true, reason: true, failureCode: true } })).map((i) => [
      i.groupNameSnapshot,
      i,
    ]),
  );

beforeAll(async () => {
  const settings = await prisma.automationSettings.findFirst();
  savedAutomation = settings?.automationEnabled ?? null;
  await prisma.automationSettings.upsert({ where: { id: "global" }, update: { automationEnabled: true }, create: { id: "global", automationEnabled: true } });
});

beforeEach(async () => {
  resetProjectCachesForTests();
  account = await prisma.whatsAppAccount.create({ data: { label: `Admin Maker ${randomUUID()}`, status: "CONNECTED" } });
  provider = new MockProvider();
});

afterEach(async () => {
  await rawPrisma.groupAdminPromotionJob.deleteMany({ where: { accountId: account.id } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: account.id } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: account.id } });
});

afterAll(async () => {
  if (savedAutomation !== null) await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: savedAutomation } });
  await rawPrisma.$disconnect();
});

describe("which groups are touched", () => {
  it("promotes only where the account is an admin and the number is a member — and never adds anyone", async () => {
    const promote = await group("promote");
    const already = await group("already");
    const notMember = await group("not-member");
    const lid = await group("lid");
    const notOurs = await group("not-ours");
    const gone = await group("gone", { active: false });
    provider.adminGroupIdsConfigured = true;
    provider.adminGroupIds = [promote, already, notMember, lid, gone].map((g) => g.whatsappGroupId);
    provider.participantsByChatId.set(promote.whatsappGroupId, [MockProvider.phoneParticipant(ME), MockProvider.phoneParticipant(TARGET)]);
    provider.adminIdsByChatId.set(promote.whatsappGroupId, [ME]);
    provider.participantsByChatId.set(already.whatsappGroupId, [MockProvider.phoneParticipant(ME), MockProvider.phoneParticipant(TARGET)]);
    provider.adminIdsByChatId.set(already.whatsappGroupId, [ME, T]);
    provider.participantsByChatId.set(notMember.whatsappGroupId, [MockProvider.phoneParticipant(ME), MockProvider.phoneParticipant("8801700000001")]);
    provider.adminIdsByChatId.set(notMember.whatsappGroupId, [ME]);
    provider.participantsByChatId.set(lid.whatsappGroupId, [MockProvider.phoneParticipant(ME), MockProvider.lidParticipant("123456789012345")]);
    provider.adminIdsByChatId.set(lid.whatsappGroupId, [ME]);
    // A group the account does not administer is never even read.
    provider.participantsByChatId.set(notOurs.whatsappGroupId, [MockProvider.phoneParticipant(ME), MockProvider.phoneParticipant(TARGET)]);

    const j = await job([promote, already, notMember, lid, notOurs, gone]);
    const done = await drain(j.id);

    expect(done.status).toBe("COMPLETED");
    expect(done.adminGroups).toBe(4);
    const result = await items(j.id);
    expect(result["Admin promote"]!.status).toBe("PROMOTED");
    expect(result["Admin already"]!.status).toBe("ALREADY_ADMIN");
    expect(result["Admin not-member"]!.status).toBe("NOT_MEMBER");
    expect(result["Admin lid"]!.status).toBe("CANNOT_VERIFY");
    expect(result["Admin not-ours"]!.status).toBe("NOT_ACCOUNT_ADMIN");
    expect(result["Admin gone"]!.status).toBe("GROUP_UNAVAILABLE");
    expect(provider.promotions).toEqual([{ chatId: promote.whatsappGroupId, participantId: T }]);
    expect(provider.addedParticipants).toEqual([]);
  });

  it("does nothing at all when WhatsApp will not say which groups the account administers", async () => {
    const g = await group("unknown");
    provider.participantsByChatId.set(g.whatsappGroupId, [MockProvider.phoneParticipant(ME), MockProvider.phoneParticipant(TARGET)]);
    provider.adminIdsByChatId.set(g.whatsappGroupId, [ME]);
    // adminGroupIds left unconfigured: the provider answers null.
    const j = await job([g]);
    const done = await drain(j.id);
    expect(done.status).toBe("FAILED");
    expect(done.statusReason).toMatch(/would not say which groups/);
    expect(provider.promotions).toEqual([]);
    expect((await items(j.id))["Admin unknown"]!.status).toBe("PENDING");
  });
});

describe("failures", () => {
  it("records WhatsApp's refusal as the group's result, retries what may pass, and carries on", async () => {
    const refused = await group("refused");
    const flaky = await group("flaky");
    const fine = await group("fine");
    provider.adminGroupIdsConfigured = true;
    provider.adminGroupIds = [refused, flaky, fine].map((g) => g.whatsappGroupId);
    for (const g of [refused, flaky, fine]) {
      provider.participantsByChatId.set(g.whatsappGroupId, [MockProvider.phoneParticipant(ME), MockProvider.phoneParticipant(TARGET)]);
      provider.adminIdsByChatId.set(g.whatsappGroupId, [ME]);
    }
    provider.promoteResults.set(refused.whatsappGroupId, { success: false, error: "INSUFFICIENT_PERMISSIONS" });
    provider.promoteResults.set(flaky.whatsappGroupId, { success: false, error: "Protocol error: Target closed" });

    const j = await job([refused, flaky, fine]);
    const done = await drain(j.id);
    expect(done.status).toBe("COMPLETED");
    const result = await items(j.id);
    expect(result["Admin refused"]).toMatchObject({ status: "NOT_ACCOUNT_ADMIN", failureCode: "INSUFFICIENT_PERMISSIONS" });
    expect(result["Admin flaky"]).toMatchObject({ status: "FAILED", failureCode: "Protocol error: Target closed" });
    expect(result["Admin flaky"]!.reason).toMatch(/WhatsApp refused the promotion/);
    expect(result["Admin fine"]!.status).toBe("PROMOTED");
    // The flaky group was tried twice (once, then once more), never more.
    expect(provider.promotions.filter((p) => p.chatId === flaky.whatsappGroupId)).toHaveLength(2);
  });

  it("never records a promotion WhatsApp's own admin list does not show", async () => {
    const g = await group("unconfirmed");
    provider.adminGroupIdsConfigured = true;
    provider.adminGroupIds = [g.whatsappGroupId];
    provider.participantsByChatId.set(g.whatsappGroupId, [MockProvider.phoneParticipant(ME), MockProvider.phoneParticipant(TARGET)]);
    provider.adminIdsByChatId.set(g.whatsappGroupId, [ME]);
    // Says yes, changes nothing.
    provider.promoteGroupParticipant = async (chatId, participantId) => (provider.promotions.push({ chatId, participantId }), { success: true });
    const j = await job([g]);
    await drain(j.id);
    expect((await items(j.id))["Admin unconfirmed"]!.status).toBe("FAILED");
  });

  it("after a crash between promoting and recording, the next visit records PROMOTED without promoting again", async () => {
    const g = await group("crashed");
    provider.adminGroupIdsConfigured = true;
    provider.adminGroupIds = [g.whatsappGroupId];
    provider.participantsByChatId.set(g.whatsappGroupId, [MockProvider.phoneParticipant(ME), MockProvider.phoneParticipant(TARGET)]);
    provider.adminIdsByChatId.set(g.whatsappGroupId, [ME, T]); // the promotion landed
    const j = await job([g]);
    await prisma.groupAdminPromotionItem.updateMany({ where: { jobId: j.id }, data: { attemptCount: 1, lastAttemptAt: new Date(0) } });
    await drain(j.id);
    expect((await items(j.id))["Admin crashed"]!.status).toBe("PROMOTED");
    expect(provider.promotions).toEqual([]);
  });
});

describe("pacing, disconnection and the kill switch", () => {
  it("never promotes twice on one account within the minimum gap", async () => {
    const groups = await Promise.all(["p1", "p2", "p3"].map((l) => group(l)));
    provider.adminGroupIdsConfigured = true;
    provider.adminGroupIds = groups.map((g) => g.whatsappGroupId);
    for (const g of groups) {
      provider.participantsByChatId.set(g.whatsappGroupId, [MockProvider.phoneParticipant(ME), MockProvider.phoneParticipant(TARGET)]);
      provider.adminIdsByChatId.set(g.whatsappGroupId, [ME]);
    }
    const j = await job(groups);
    // No time passes: the loop may only promote once, then everything else waits its turn.
    for (let i = 0; i < 20; i++) await processOneAdminPromotion(providers);
    expect(provider.promotions).toHaveLength(1);
    const waiting = await prisma.groupAdminPromotionItem.findMany({ where: { jobId: j.id, status: "PENDING" } });
    expect(waiting).toHaveLength(2);
    for (const w of waiting) expect(w.scheduledAt.getTime()).toBeGreaterThan(Date.now() + 5_000);
    const done = await drain(j.id);
    expect(done.status).toBe("COMPLETED");
    expect(provider.promotions).toHaveLength(3);
  });

  it("pauses — not completes — when the account drops, and carries on after Resume", async () => {
    const a = await group("a");
    const b = await group("b");
    provider.adminGroupIdsConfigured = true;
    provider.adminGroupIds = [a.whatsappGroupId, b.whatsappGroupId];
    for (const g of [a, b]) {
      provider.participantsByChatId.set(g.whatsappGroupId, [MockProvider.phoneParticipant(ME), MockProvider.phoneParticipant(TARGET)]);
      provider.adminIdsByChatId.set(g.whatsappGroupId, [ME]);
    }
    const j = await job([a, b]);
    await processOneAdminPromotion(providers); // checking
    await processOneAdminPromotion(providers); // first group promoted
    provider.connectionStatus = "DISCONNECTED";
    await advance(120_000);
    await processOneAdminPromotion(providers);
    const paused = await prisma.groupAdminPromotionJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(paused.status).toBe("PAUSED_DISCONNECTED");
    expect(paused.statusReason).toMatch(/disconnected/);
    expect(await prisma.groupAdminPromotionItem.count({ where: { jobId: j.id, status: "PENDING" } })).toBe(1);
    // Nothing happens while paused.
    for (let i = 0; i < 5; i++) await processOneAdminPromotion(providers);
    expect(provider.promotions).toHaveLength(1);

    provider.connectionStatus = "CONNECTED";
    await prisma.groupAdminPromotionJob.update({ where: { id: j.id }, data: { status: "RUNNING", statusReason: null } }); // what Resume does
    const done = await drain(j.id);
    expect(done.status).toBe("COMPLETED");
    expect(provider.promotions).toHaveLength(2);
  });

  it("stops while automation is off, like Add Number to Groups", async () => {
    const g = await group("killed");
    provider.adminGroupIdsConfigured = true;
    provider.adminGroupIds = [g.whatsappGroupId];
    await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: false } });
    try {
      const j = await job([g]);
      await processOneAdminPromotion(providers);
      expect((await prisma.groupAdminPromotionJob.findUniqueOrThrow({ where: { id: j.id } })).status).toBe("STOPPED_KILL_SWITCH");
      expect(provider.promotions).toEqual([]);
    } finally {
      await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: true } });
    }
  });
});
