import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { AutomationSettings, Prisma, WhatsAppAccount } from "@prisma/client";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { recoverStuckOutboundMessages, processOne } from "../queue/outboundQueueProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Integration tests run against a real Postgres instance (the same one the
 * dashboard/worker use in dev) rather than a separate test database — there
 * is no isolated test DB provisioned yet (a Phase 9 hardening item). Every
 * test creates uniquely-identified fixtures and cleans them up, and the
 * global AutomationSettings singleton is snapshotted/restored around the
 * whole suite so it never leaks into other runs.
 *
 * Covers the automatable subset of the Phase 8 scenario list. Two scenarios
 * are NOT covered here because they require a real WhatsApp account/QR scan
 * and an actual container recreation, neither of which this environment can
 * do: "worker restart -> OpenWA session survives" and "Docker restart ->
 * database and OpenWA session persist" (see ARCHITECTURE.md's Phase 5
 * acceptance test note).
 */

let originalSettings: AutomationSettings;
let account: WhatsAppAccount;
const createdRuleIds: string[] = [];
const createdTeamMemberIds: string[] = [];
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

async function resetSettings(overrides: Partial<Prisma.AutomationSettingsUpdateInput> = {}) {
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: {
      automationEnabled: true,
      mode: "SAFE_AUTO_REPLY",
      rateLimitingEnabled: true,
      maxRepliesPerClientPerHour: 3,
      maxRepliesPerClientPerDay: 10,
      globalMaxPerMinute: 5,
      globalMaxPerHour: 100,
      globalMaxPerDay: 500,
      defaultReplyDelayMinMs: 0,
      defaultReplyDelayMaxMs: 0,
      teamsWebhookUrl: "https://example.invalid/webhook",
      ...overrides,
    },
  });
}

beforeAll(async () => {
  originalSettings = await prisma.automationSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  // The rule engine reads ALL active rules globally (not scoped per test),
  // so pre-existing rules (e.g. the seeded "Auto Reply: Greeting") would
  // otherwise leak into every test's evaluation. Disable them for the
  // duration of this suite and restore afterwards.
  preExistingActiveRuleIds = (
    await prisma.automationRule.findMany({ where: { status: "ACTIVE" }, select: { id: true } })
  ).map((r) => r.id);
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({
      where: { id: { in: preExistingActiveRuleIds } },
      data: { status: "DISABLED" },
    });
  }
});

afterAll(async () => {
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: originalSettings as unknown as Prisma.AutomationSettingsUpdateInput,
  });
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({
      where: { id: { in: preExistingActiveRuleIds } },
      data: { status: "ACTIVE" },
    });
  }
});

beforeEach(async () => {
  await resetSettings();
  account = await prisma.whatsAppAccount.create({
    data: { label: `Test Account ${randomUUID()}`, status: "CONNECTED" },
  });
});

afterEach(async () => {
  await prisma.outboundMessage.deleteMany({ where: { accountId: account.id } });
  await prisma.notification.deleteMany({ where: { relatedMessage: { accountId: account.id } } });
  await prisma.automationExecution.deleteMany({ where: { message: { accountId: account.id } } });
  await prisma.message.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppAccount.delete({ where: { id: account.id } });

  if (createdRuleIds.length) {
    await prisma.automationRule.deleteMany({ where: { id: { in: createdRuleIds } } });
    createdRuleIds.length = 0;
  }
  if (createdTeamMemberIds.length) {
    await prisma.internalTeamMember.deleteMany({ where: { id: { in: createdTeamMemberIds } } });
    createdTeamMemberIds.length = 0;
  }
});

async function makeRule(data: Parameters<typeof prisma.automationRule.create>[0]["data"]) {
  const rule = await prisma.automationRule.create({ data });
  createdRuleIds.push(rule.id);
  return rule;
}

async function makeTeamMember(phoneNumber: string) {
  const member = await prisma.internalTeamMember.create({
    data: { name: "Test Member", phoneNumber, role: "Support", status: "ACTIVE" },
  });
  createdTeamMemberIds.push(member.id);
  return member;
}

describe("Scenario 1: team member message -> no client automation", () => {
  it("ignores the message and never queues a reply, when the client-facing rule is properly scoped to CLIENT senders", async () => {
    const teamPhone = uniquePhone();
    await makeTeamMember(teamPhone);
    // Rules intended for clients must scope sender=CLIENT — an unscoped rule
    // is intentionally allowed to fire for team members too (that's the
    // documented override mechanism), so this is what a real deployment's
    // client-facing greeting rule should look like.
    await makeRule({
      name: "Greeting", type: "AUTO_REPLY", matchType: "KEYWORDS", keywords: ["hello"],
      conditions: { sender: { type: "CLIENT" } },
      actions: [{ type: "AUTO_REPLY" }], priority: 70, status: "ACTIVE", replyMessage: "hi!",
    });

    await processIncomingMessage({
      accountId: account.id, whatsappMessageId: randomUUID(), chatId: teamPhone,
      senderPhone: teamPhone, direction: "INCOMING", body: "hello everyone", timestampWa: new Date(),
    });

    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    expect(message.isFromTeamMember).toBe(true);
    expect(message.processingStatus).toBe("IGNORED");
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(0);
  });
});

describe("Scenario 2: default message -> ignored", () => {
  it("matches a DEFAULT_IGNORE rule and produces no actions", async () => {
    await makeRule({
      name: "Ignore payment", type: "DEFAULT_IGNORE", matchType: "CONTAINS", matchValue: "payment successful",
      actions: [{ type: "IGNORE" }], priority: 10, status: "ACTIVE",
    });

    const phone = uniquePhone();
    await processIncomingMessage({
      accountId: account.id, whatsappMessageId: randomUUID(), chatId: phone,
      senderPhone: phone, direction: "INCOMING", body: "Payment successful", timestampWa: new Date(),
    });

    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    expect(message.processingStatus).toBe("IGNORED");
    const execution = await prisma.automationExecution.findFirstOrThrow({ where: { messageId: message.id } });
    expect(execution.decision).toBe("IGNORE");
  });
});

describe("Scenario 3 & 4: support issue -> acknowledgement + escalation notification", () => {
  it("queues an acknowledgement reply, marks SUPPORT_REQUIRED, and queues a Teams notification", async () => {
    await makeRule({
      name: "Internet Not Working", type: "SUPPORT_ESCALATION", matchType: "CONTAINS", matchValue: "internet not working",
      actions: [{ type: "SUPPORT_REQUIRED", category: "INTERNET_ISSUE" }, { type: "NOTIFY_TEAMS" }, { type: "AUTO_REPLY" }],
      priority: 100, status: "ACTIVE", replyMessage: "We've received your issue and are looking into it.",
    });

    const phone = uniquePhone();
    await processIncomingMessage({
      accountId: account.id, whatsappMessageId: randomUUID(), chatId: phone,
      senderPhone: phone, direction: "INCOMING", body: "internet not working", timestampWa: new Date(),
    });

    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    const execution = await prisma.automationExecution.findFirstOrThrow({ where: { messageId: message.id } });
    expect(execution.decision).toBe("SUPPORT_REQUIRED");

    const outbound = await prisma.outboundMessage.findFirst({ where: { accountId: account.id } });
    expect(outbound?.status).toBe("PENDING");

    const notification = await prisma.notification.findFirst({ where: { relatedMessageId: message.id } });
    expect(notification?.type).toBe("TEAMS");
    expect(notification?.status).toBe("PENDING");
  });
});

describe("Scenario 5 & 6: greeting reply + cooldown blocks duplicate", () => {
  it("queues a reply for the first greeting, then blocks a repeat within the cooldown window", async () => {
    await makeRule({
      name: "Greeting", type: "AUTO_REPLY", matchType: "KEYWORDS", keywords: ["hello"],
      actions: [{ type: "AUTO_REPLY" }], priority: 70, status: "ACTIVE",
      replyMessage: "Welcome!", cooldownSeconds: 3600,
    });

    const phone = uniquePhone();
    await processIncomingMessage({
      accountId: account.id, whatsappMessageId: randomUUID(), chatId: phone,
      senderPhone: phone, direction: "INCOMING", body: "hello", timestampWa: new Date(),
    });
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(1);

    await processIncomingMessage({
      accountId: account.id, whatsappMessageId: randomUUID(), chatId: phone,
      senderPhone: phone, direction: "INCOMING", body: "hello again", timestampWa: new Date(),
    });

    // Still only one queued reply — the second was blocked by cooldown, not queued.
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(1);
    const messages = await prisma.message.findMany({ where: { accountId: account.id }, orderBy: { createdAt: "asc" } });
    expect(messages).toHaveLength(2);
    const secondExecution = await prisma.automationExecution.findFirstOrThrow({ where: { messageId: messages[1]!.id } });
    const autoReplyRecord = (secondExecution.actionsExecuted as any[]).find((a) => a.type === "AUTO_REPLY");
    expect(autoReplyRecord.executed).toBe(false);
    expect(autoReplyRecord.reason).toMatch(/cooldown/i);
  });
});

describe("Scenario 7: duplicate event -> no duplicate processing", () => {
  it("processes the same whatsappMessageId only once", async () => {
    const phone = uniquePhone();
    const whatsappMessageId = randomUUID();
    const raw = {
      accountId: account.id, whatsappMessageId, chatId: phone,
      senderPhone: phone, direction: "INCOMING" as const, body: "duplicate test", timestampWa: new Date(),
    };

    await processIncomingMessage(raw);
    await processIncomingMessage(raw); // simulates a redelivered/duplicate provider event

    expect(await prisma.message.count({ where: { accountId: account.id } })).toBe(1);
    expect(await prisma.automationExecution.count({ where: { message: { accountId: account.id } } })).toBe(1);
  });
});

describe("Scenario 8: crash recovery -> no duplicate action after a simulated worker restart", () => {
  it("requeues a stuck PROCESSING row to PENDING without creating a new row", async () => {
    const stuck = await prisma.outboundMessage.create({
      data: {
        accountId: account.id, chatId: uniquePhone(), toPhone: uniquePhone(), body: "stuck message",
        actionType: "AUTO_REPLY", idempotencyKey: randomUUID(), status: "PROCESSING",
      },
    });
    // Backdate updatedAt past the stuck-processing timeout, simulating a worker that died mid-send.
    await prisma.$executeRaw`UPDATE "OutboundMessage" SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${stuck.id}`;

    const recovered = await recoverStuckOutboundMessages();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(row.status).toBe("PENDING");
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(1);
  });
});

describe("Scenario 9: automation paused -> no outbound reply", () => {
  it("blocks AUTO_REPLY at pipeline time when the kill switch is off", async () => {
    await resetSettings({ automationEnabled: false });
    await makeRule({
      name: "Greeting", type: "AUTO_REPLY", matchType: "KEYWORDS", keywords: ["hello"],
      actions: [{ type: "AUTO_REPLY" }], priority: 70, status: "ACTIVE", replyMessage: "hi",
    });

    const phone = uniquePhone();
    await processIncomingMessage({
      accountId: account.id, whatsappMessageId: randomUUID(), chatId: phone,
      senderPhone: phone, direction: "INCOMING", body: "hello", timestampWa: new Date(),
    });

    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(0);
    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    expect(message.processingStatus).toBe("PROCESSED"); // still stored, just not replied to
  });

  it("cancels an already-queued message if the kill switch is flipped off before it is sent", async () => {
    const provider = new MockProvider();
    const outbound = await prisma.outboundMessage.create({
      data: {
        accountId: account.id, chatId: uniquePhone(), toPhone: uniquePhone(), body: "should not send",
        actionType: "AUTO_REPLY", idempotencyKey: randomUUID(), status: "PENDING",
        // Explicit, safely-in-the-past scheduledAt — see the same note in
        // multiAccountRouting.integration.test.ts. The DB container's clock runs a few ms ahead of
        // the host's, so leaning on the schema's @default(now()) lets a just-inserted row read as
        // not-yet-due to the very next line's `new Date()` (host clock), and processOne() finds
        // nothing to claim. Intermittent by nature: it only bites when the round trip is quicker
        // than the skew.
        scheduledAt: new Date(Date.now() - 60_000),
      },
    });
    await resetSettings({ automationEnabled: false });

    await processOne(provider);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } });
    expect(row.status).toBe("CANCELLED");
    expect(provider.sentMessages).toHaveLength(0);
  });
});

describe("Scenario 10: rate limit reached -> safely blocked", () => {
  it("blocks at pipeline time when the per-client hourly limit is already zero", async () => {
    await resetSettings({ maxRepliesPerClientPerHour: 0 });
    await makeRule({
      name: "Greeting", type: "AUTO_REPLY", matchType: "KEYWORDS", keywords: ["hello"],
      actions: [{ type: "AUTO_REPLY" }], priority: 70, status: "ACTIVE", replyMessage: "hi",
    });

    const phone = uniquePhone();
    await processIncomingMessage({
      accountId: account.id, whatsappMessageId: randomUUID(), chatId: phone,
      senderPhone: phone, direction: "INCOMING", body: "hello", timestampWa: new Date(),
    });

    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("marks an already-queued message RATE_LIMITED at send time if the limit is now exceeded", async () => {
    const provider = new MockProvider();
    const outbound = await prisma.outboundMessage.create({
      data: {
        accountId: account.id, chatId: uniquePhone(), toPhone: uniquePhone(), body: "should be blocked",
        actionType: "AUTO_REPLY", idempotencyKey: randomUUID(), status: "PENDING",
        // Explicit, safely-in-the-past scheduledAt — see the same note in
        // multiAccountRouting.integration.test.ts. The DB container's clock runs a few ms ahead of
        // the host's, so leaning on the schema's @default(now()) lets a just-inserted row read as
        // not-yet-due to the very next line's `new Date()` (host clock), and processOne() finds
        // nothing to claim. Intermittent by nature: it only bites when the round trip is quicker
        // than the skew.
        scheduledAt: new Date(Date.now() - 60_000),
      },
    });
    await resetSettings({ globalMaxPerMinute: 0 });

    await processOne(provider);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } });
    expect(row.status).toBe("RATE_LIMITED");
    expect(provider.sentMessages).toHaveLength(0);
  });
});

describe("Queue processor happy path (sanity check for the mocked provider itself)", () => {
  it("sends a PENDING message through the mock provider and marks it SENT", async () => {
    const provider = new MockProvider();
    const outbound = await prisma.outboundMessage.create({
      data: {
        accountId: account.id, chatId: "1234@c.us", toPhone: "+8801000000099", body: "hello from the queue",
        actionType: "AUTO_REPLY", idempotencyKey: randomUUID(), status: "PENDING",
        // Explicit, safely-in-the-past scheduledAt — see the same note in
        // multiAccountRouting.integration.test.ts. The DB container's clock runs a few ms ahead of
        // the host's, so leaning on the schema's @default(now()) lets a just-inserted row read as
        // not-yet-due to the very next line's `new Date()` (host clock), and processOne() finds
        // nothing to claim. Intermittent by nature: it only bites when the round trip is quicker
        // than the skew.
        scheduledAt: new Date(Date.now() - 60_000),
      },
    });

    const handled = await processOne(provider);
    expect(handled).toBe(true);
    expect(provider.sentMessages).toEqual([{ chatId: "1234@c.us", body: "hello from the queue" }]);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } });
    expect(row.status).toBe("SENT");
  });
});
