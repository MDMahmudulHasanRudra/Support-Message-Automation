import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { AutomationSettings, Prisma, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { MockProvider } from "./mockProvider.js";

/**
 * apps/web has no test infrastructure of its own (server actions depend on next/headers' request-
 * scoped cookies(), which only exists inside a real Next.js request — same limitation
 * ruleProposalToExecution.integration.test.ts already documents), so this suite hand-mirrors the
 * exact Prisma calls apps/web/src/server/actions/rulesBulk.ts's bulkSetRuleStatus()/
 * bulkDeleteRules() perform, then proves a bulk-activated rule fires through the real, unmodified
 * evaluate()/pipeline — the same "DRAFT is inert, ACTIVE fires" shape ruleProposalToExecution uses,
 * now via the bulk path instead of the single-rule activate action.
 */

let originalSettings: AutomationSettings;
let account: WhatsAppAccount;
let group: WhatsAppGroup;
const createdRuleIds: string[] = [];
let preExistingActiveRuleIds: string[] = [];

const PHONE_RUN_PREFIX = String(randomInt(100_000, 999_999));
let phoneSequence = 0;

function uniquePhone(): string {
  // Digits only, and unique within this file's run. This used to slice a UUID, which is
  // hex: team-member matching normalizes a number to its digits, so "+8809a3f2b1c4" became
  // "88093214" — sometimes under the 8-digit minimum, making the seeded member unresolvable
  // and failing whichever test happened to draw it. Roughly one call in seven.
  return `+8809${PHONE_RUN_PREFIX}${String(++phoneSequence).padStart(4, "0")}`;
}

function uniqueGroupJid(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-1234567890@g.us`;
}

async function resetSettings(overrides: Partial<Prisma.AutomationSettingsUpdateInput> = {}) {
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: {
      automationEnabled: true,
      mode: "SAFE_AUTO_REPLY",
      rateLimitingEnabled: false,
      defaultReplyDelayMinMs: 0,
      defaultReplyDelayMaxMs: 0,
      ...overrides,
    },
  });
}

/** Mirrors apps/web/src/server/actions/rulesBulk.ts's bulkSetRuleStatus() exactly. */
async function bulkSetRuleStatus(ruleIds: string[], status: "ACTIVE" | "DISABLED") {
  const dedupedIds = [...new Set(ruleIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (dedupedIds.length === 0) {
    return { requested: 0, updated: 0, alreadyInTargetState: 0, notFound: 0, error: "No rules selected." };
  }

  const existing = await prisma.automationRule.findMany({
    where: { id: { in: dedupedIds } },
    select: { id: true, status: true },
  });
  const existingIds = new Set(existing.map((r) => r.id));
  const notFound = dedupedIds.filter((id) => !existingIds.has(id)).length;
  const alreadyInTargetState = existing.filter((r) => r.status === status).length;
  const idsToChange = existing.filter((r) => r.status !== status).map((r) => r.id);

  let updated = 0;
  if (idsToChange.length > 0) {
    const result = await prisma.automationRule.updateMany({ where: { id: { in: idsToChange } }, data: { status } });
    updated = result.count;
  }

  return { requested: dedupedIds.length, updated, alreadyInTargetState, notFound };
}

/** Mirrors apps/web/src/server/actions/rulesBulk.ts's bulkDeleteRules() exactly. */
async function bulkDeleteRules(ruleIds: string[]) {
  const dedupedIds = [...new Set(ruleIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (dedupedIds.length === 0) {
    return { requested: 0, deleted: 0, notFound: 0, error: "No rules selected." };
  }

  const existing = await prisma.automationRule.findMany({ where: { id: { in: dedupedIds } }, select: { id: true } });
  const existingIds = existing.map((r) => r.id);
  const notFound = dedupedIds.length - existingIds.length;

  let deleted = 0;
  if (existingIds.length > 0) {
    const result = await prisma.automationRule.deleteMany({ where: { id: { in: existingIds } } });
    deleted = result.count;
  }

  return { requested: dedupedIds.length, deleted, notFound };
}

beforeAll(async () => {
  originalSettings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  preExistingActiveRuleIds = (
    await prisma.automationRule.findMany({ where: { status: "ACTIVE" }, select: { id: true } })
  ).map((r) => r.id);
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "DISABLED" } });
  }
});

afterAll(async () => {
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: originalSettings as unknown as Prisma.AutomationSettingsUpdateInput,
  });
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "ACTIVE" } });
  }
});

beforeEach(async () => {
  await resetSettings();
  account = await prisma.whatsAppAccount.create({ data: { label: `Bulk Rules Test ${randomUUID()}`, status: "CONNECTED" } });
  group = await prisma.whatsAppGroup.create({
    data: {
      accountId: account.id,
      whatsappGroupId: uniqueGroupJid(),
      name: "Test Support Group",
      isMonitored: true,
      lastSyncedAt: new Date(),
    },
  });
});

afterEach(async () => {
  await prisma.outboundMessage.deleteMany({ where: { accountId: account.id } });
  await prisma.automationExecution.deleteMany({ where: { message: { accountId: account.id } } });
  await prisma.message.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }); // cascades WhatsAppGroup
  if (createdRuleIds.length) {
    await prisma.automationRule.deleteMany({ where: { id: { in: createdRuleIds } } });
    createdRuleIds.length = 0;
  }
});

describe("bulkSetRuleStatus", () => {
  it("activates multiple DRAFT rules in one call, counts already-active and not-found correctly", async () => {
    const draft1 = await prisma.automationRule.create({
      data: { name: `Bulk A ${randomUUID()}`, type: "GENERIC", matchType: "ALWAYS", actions: [{ type: "TAG", tag: "bulk" }], status: "DRAFT" },
    });
    const draft2 = await prisma.automationRule.create({
      data: { name: `Bulk B ${randomUUID()}`, type: "GENERIC", matchType: "ALWAYS", actions: [{ type: "TAG", tag: "bulk" }], status: "DRAFT" },
    });
    const alreadyActive = await prisma.automationRule.create({
      data: { name: `Bulk C ${randomUUID()}`, type: "GENERIC", matchType: "ALWAYS", actions: [{ type: "TAG", tag: "bulk" }], status: "ACTIVE" },
    });
    createdRuleIds.push(draft1.id, draft2.id, alreadyActive.id);
    const missingId = randomUUID();

    const result = await bulkSetRuleStatus([draft1.id, draft2.id, alreadyActive.id, missingId], "ACTIVE");

    expect(result).toEqual({ requested: 4, updated: 2, alreadyInTargetState: 1, notFound: 1 });

    const rows = await prisma.automationRule.findMany({
      where: { id: { in: [draft1.id, draft2.id, alreadyActive.id] } },
      select: { id: true, status: true },
    });
    expect(rows.every((r) => r.status === "ACTIVE")).toBe(true);
  });

  it("dedupes repeated ids and treats an empty selection as a no-op error", async () => {
    const draft = await prisma.automationRule.create({
      data: { name: `Bulk Dedupe ${randomUUID()}`, type: "GENERIC", matchType: "ALWAYS", actions: [{ type: "TAG", tag: "bulk" }], status: "DRAFT" },
    });
    createdRuleIds.push(draft.id);

    const result = await bulkSetRuleStatus([draft.id, draft.id, draft.id], "ACTIVE");
    expect(result).toEqual({ requested: 1, updated: 1, alreadyInTargetState: 0, notFound: 0 });

    const empty = await bulkSetRuleStatus([], "ACTIVE");
    expect(empty.error).toBe("No rules selected.");
  });

  it("a rule bulk-activated stays inert as DRAFT beforehand, then matches and auto-replies once ACTIVE — same DRAFT-inert/ACTIVE-fires shape as the single-rule activate action", async () => {
    const rule = await prisma.automationRule.create({
      data: {
        name: `Bulk Activate Fires ${randomUUID()}`,
        type: "AUTO_REPLY",
        matchType: "KEYWORDS",
        keywords: ["billing", "invoice"],
        actions: [{ type: "AUTO_REPLY" }],
        replyMessage: "Our billing team will follow up shortly.",
        status: "DRAFT",
      },
    });
    createdRuleIds.push(rule.id);

    // DRAFT must never fire.
    await processIncomingMessage({
      accountId: account.id,
      whatsappMessageId: randomUUID(),
      chatId: group.whatsappGroupId,
      whatsappGroupId: group.whatsappGroupId,
      senderPhone: uniquePhone(),
      senderName: "Client",
      direction: "INCOMING",
      body: "I have a question about my invoice",
      timestampWa: new Date(),
    });
    let executions = await prisma.automationExecution.findMany({ where: { ruleId: rule.id } });
    expect(executions).toHaveLength(0);

    // Bulk-activate (the path under test) rather than the single-rule setRuleStatus().
    const result = await bulkSetRuleStatus([rule.id], "ACTIVE");
    expect(result).toEqual({ requested: 1, updated: 1, alreadyInTargetState: 0, notFound: 0 });

    await processIncomingMessage({
      accountId: account.id,
      whatsappMessageId: randomUUID(),
      chatId: group.whatsappGroupId,
      whatsappGroupId: group.whatsappGroupId,
      senderPhone: uniquePhone(),
      senderName: "Client",
      direction: "INCOMING",
      body: "I have a question about my invoice",
      timestampWa: new Date(),
    });

    executions = await prisma.automationExecution.findMany({ where: { ruleId: rule.id } });
    expect(executions).toHaveLength(1);
    expect(executions[0]!.decision).toBe("AUTO_REPLY");

    const outbound = await prisma.outboundMessage.findFirstOrThrow({ where: { accountId: account.id, ruleId: rule.id } });
    expect(outbound.body).toBe("Our billing team will follow up shortly.");

    const provider = new MockProvider();
    const { processOne } = await import("../queue/outboundQueueProcessor.js");
    const sent = await processOne(provider);
    expect(sent).toBe(true);
    expect(provider.sentMessages).toHaveLength(1);
  });
});

describe("bulkDeleteRules", () => {
  it("deletes multiple rules in one call and preserves AutomationExecution/RuleProposal history via SetNull", async () => {
    const rule1 = await prisma.automationRule.create({
      data: { name: `Bulk Delete A ${randomUUID()}`, type: "GENERIC", matchType: "ALWAYS", actions: [{ type: "TAG", tag: "bulk" }], status: "ACTIVE" },
    });
    const rule2 = await prisma.automationRule.create({
      data: { name: `Bulk Delete B ${randomUUID()}`, type: "GENERIC", matchType: "ALWAYS", actions: [{ type: "TAG", tag: "bulk" }], status: "ACTIVE" },
    });
    const missingId = randomUUID();

    // Give rule1 an execution history row so we can prove it survives the delete via onDelete: SetNull.
    await processIncomingMessage({
      accountId: account.id,
      whatsappMessageId: randomUUID(),
      chatId: group.whatsappGroupId,
      whatsappGroupId: group.whatsappGroupId,
      senderPhone: uniquePhone(),
      senderName: "Client",
      direction: "INCOMING",
      body: "anything at all",
      timestampWa: new Date(),
    });
    const executionsBefore = await prisma.automationExecution.findMany({ where: { message: { accountId: account.id } } });
    expect(executionsBefore.length).toBeGreaterThan(0);
    const executionIds = executionsBefore.map((e) => e.id);

    const result = await bulkDeleteRules([rule1.id, rule2.id, missingId]);
    expect(result).toEqual({ requested: 3, deleted: 2, notFound: 1 });

    const remaining = await prisma.automationRule.findMany({ where: { id: { in: [rule1.id, rule2.id] } } });
    expect(remaining).toHaveLength(0);

    const executionsAfter = await prisma.automationExecution.findMany({ where: { id: { in: executionIds } } });
    expect(executionsAfter).toHaveLength(executionsBefore.length);
    expect(executionsAfter.every((e) => e.ruleId === null)).toBe(true);
  });

  it("treats an empty selection as a no-op error, never calling deleteMany", async () => {
    const result = await bulkDeleteRules([]);
    expect(result).toEqual({ requested: 0, deleted: 0, notFound: 0, error: "No rules selected." });
  });
});
