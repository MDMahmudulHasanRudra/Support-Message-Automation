import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { withProject, resetProjectCachesForTests } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { prisma } from "../db.js";
import { COPILOT_LEASE_MS, COPILOT_MAX_ATTEMPTS, processOneCopilotRequest, recoverStaleCopilotRequests } from "../copilot/copilotJob.js";
import { MockAiClient } from "./mockAiClient.js";

/**
 * AI Copilot reliability (INBOX_WORKSPACE.md § Reliability):
 *   - the database allows ONE active request per person per conversation, even under concurrency;
 *   - an abandoned claim is re-queued while attempts remain, then FAILED — never retried forever;
 *   - a result is written only by the claim that still holds the row (a cancelled request stays cancelled);
 *   - with AI_COPILOT off nothing reaches a provider and waiting requests are CANCELLED.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let projectId = "";
let userId = "";
let accountId = "";
const chatId = `1203630${tag.replace(/\D/g, "1")}@g.us`;
const run = <T,>(fn: () => Promise<T>) => withProject(projectId, fn);

async function setFeature(enabled: boolean) {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId, key: "AI_COPILOT" } },
    update: { enabled },
    create: { projectId, key: "AI_COPILOT", enabled },
  });
  resetProjectFeatureCacheForTests();
}

function draft(data: Record<string, unknown> = {}) {
  return rawPrisma.aiDraft.create({
    data: { projectId, accountId, chatId, mode: "REWRITE", instruction: "SHORTER", baseText: "Please restart the router and wait two minutes.", requestedById: userId, ...data },
  });
}

beforeAll(async () => {
  userId = (await rawPrisma.user.create({ data: { username: `copilot_${tag}`, name: "Copilot tester", passwordHash: "x" } })).id;
  projectId = (await createProjectWithDefaults({ name: `Copilot ${tag}`, slug: `copilot-${tag}`, status: "ACTIVE", creatorUserId: userId }, rawPrisma)).id;
  accountId = (await rawPrisma.whatsAppAccount.create({ data: { projectId, label: `Copilot ${tag}` } })).id;
  await run(() => prisma.aiSettings.upsert({ where: { id: "global" }, update: { aiEngineEnabled: true }, create: { id: "global", aiEngineEnabled: true } }));
  resetProjectCachesForTests();
  await setFeature(true);
});

beforeEach(async () => {
  await rawPrisma.aiDraft.deleteMany({ where: { projectId } });
  await setFeature(true);
});

afterAll(async () => {
  const where = { projectId };
  await rawPrisma.aiDraft.deleteMany({ where });
  await rawPrisma.whatsAppAccount.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId } });
});

describe("one active request per person per conversation", () => {
  it("concurrent inserts: exactly one wins, the rest are unique violations", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => draft()));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
      expect((r.reason as { code?: string }).code).toBe("P2002");
    }
  });

  it("finished requests are history: a new one is allowed after completion, and another person is never blocked", async () => {
    await draft({ status: "COMPLETE" });
    await draft({ status: "FAILED" });
    await draft({ status: "CANCELLED" });
    await expect(draft()).resolves.toBeTruthy();
    const other = (await rawPrisma.user.create({ data: { username: `copilot2_${tag}`, name: "Other", passwordHash: "x" } })).id;
    await expect(draft({ requestedById: other })).resolves.toBeTruthy();
    await rawPrisma.aiDraft.deleteMany({ where: { requestedById: other } });
    await rawPrisma.user.delete({ where: { id: other } });
  });
});

describe("crash recovery", () => {
  it("an abandoned claim with attempts left goes back to PENDING; an exhausted one FAILS", async () => {
    const past = new Date(Date.now() - COPILOT_LEASE_MS - 1000);
    const retry = await draft({ status: "PROCESSING", attempts: 1, leaseExpiresAt: past });
    const other = (await rawPrisma.user.create({ data: { username: `copilot3_${tag}`, name: "Third", passwordHash: "x" } })).id;
    const exhausted = await draft({ status: "PROCESSING", attempts: COPILOT_MAX_ATTEMPTS, leaseExpiresAt: past, requestedById: other });
    const live = await draft({ status: "PROCESSING", attempts: 1, leaseExpiresAt: new Date(Date.now() + 60_000), chatId: `9${chatId}` });

    await run(() => recoverStaleCopilotRequests());

    const rows = await rawPrisma.aiDraft.findMany({ where: { id: { in: [retry.id, exhausted.id, live.id] } }, select: { id: true, status: true } });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId[retry.id]).toBe("PENDING");
    expect(byId[exhausted.id]).toBe("FAILED");
    expect(byId[live.id]).toBe("PROCESSING");
    await rawPrisma.aiDraft.deleteMany({ where: { requestedById: other } });
    await rawPrisma.user.delete({ where: { id: other } });
  });

  it("a claim increments attempts, holds a lease, and completes once with usage recorded", async () => {
    const d = await draft();
    const ai = new MockAiClient();
    ai.nextText = "Please restart the router.";
    await run(() => processOneCopilotRequest(ai));
    const row = await rawPrisma.aiDraft.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: "COMPLETE", attempts: 1, leaseExpiresAt: null, responseText: "Please restart the router.", tokensUsed: 42, modelId: "mock-model" });
    expect(ai.requests).toHaveLength(1);
    // Nothing left to claim: a second tick makes no call.
    await run(() => processOneCopilotRequest(ai));
    expect(ai.requests).toHaveLength(1);
  });

  it("a request cancelled while the call is in flight stays cancelled", async () => {
    const d = await draft();
    const ai = new MockAiClient();
    const original = ai.complete.bind(ai);
    ai.complete = async (req) => {
      await rawPrisma.aiDraft.update({ where: { id: d.id }, data: { status: "CANCELLED" } });
      return original(req);
    };
    await run(() => processOneCopilotRequest(ai));
    const row = await rawPrisma.aiDraft.findUniqueOrThrow({ where: { id: d.id } });
    expect(row.status).toBe("CANCELLED");
    expect(row.responseText).toBeNull();
  });
});

describe("feature switched off", () => {
  it("cancels waiting requests and calls no provider", async () => {
    const d = await draft();
    await setFeature(false);
    const ai = new MockAiClient();
    await run(() => processOneCopilotRequest(ai));
    expect(ai.requests).toHaveLength(0);
    expect((await rawPrisma.aiDraft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("CANCELLED");
  });
});
