import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type {
  SupportIssue,
  TeamsChannel,
  TeamsIntegrationSettings,
  TeamsMessage,
  TeamsResolutionRule,
  WhatsAppAccount,
  WhatsAppGroup,
  WhatsAppServiceRoute,
} from "@prisma/client";
import { evaluateResolutionForMessage } from "../teams/resolutionEngine.js";

/**
 * Covers the resolution engine's idempotency guard and every notification safety-check skip path
 * (ENGINEERING_STANDARDS.md's "idempotency is mandatory" + master prompt section 18's "never
 * silently fail to notify without a recorded reason"). Same real-Postgres, uniquely-identified-
 * fixtures-with-cleanup convention as the rest of this directory — see multiAccountRouting.
 * integration.test.ts for why TEAMS_RESOLUTION_NOTIFY is routed via WhatsAppServiceRoute with
 * STRICT_NO_FALLBACK instead of relying on whatever the shared DB's real Primary account is.
 */

let originalRoute: WhatsAppServiceRoute | null;
let originalSettings: TeamsIntegrationSettings;
let connectedAccount: WhatsAppAccount;
let disconnectedAccount: WhatsAppAccount;
let group: WhatsAppGroup;
let team: { id: string };
let channel: TeamsChannel;
let rule: TeamsResolutionRule;
let keywordId: string;
let issue: SupportIssue;

const cleanupTeamsMessageIds: string[] = [];

async function makeRootMessage(body: string): Promise<TeamsMessage> {
  const message = await prisma.teamsMessage.create({
    data: {
      channelId: channel.id,
      externalMessageId: randomUUID(),
      senderExternalId: "dev-1",
      senderDisplayName: "Test Developer",
      body,
      sentAt: new Date(),
    },
  });
  cleanupTeamsMessageIds.push(message.id);
  return message;
}

async function setNotificationsEnabled(enabled: boolean) {
  await prisma.teamsIntegrationSettings.upsert({
    where: { id: "global" },
    update: { enableCustomerNotification: enabled, enableResolutionDetection: true },
    create: { id: "global", enableCustomerNotification: enabled, enableResolutionDetection: true },
  });
}

beforeAll(async () => {
  originalRoute = await prisma.whatsAppServiceRoute.findUnique({ where: { serviceKey: "TEAMS_RESOLUTION_NOTIFY" } });
  originalSettings = await prisma.teamsIntegrationSettings.upsert({ where: { id: "global" }, update: {}, create: {} });
});

afterAll(async () => {
  if (originalRoute) {
    await prisma.whatsAppServiceRoute.upsert({
      where: { serviceKey: "TEAMS_RESOLUTION_NOTIFY" },
      update: originalRoute,
      create: originalRoute,
    });
  } else {
    await prisma.whatsAppServiceRoute.deleteMany({ where: { serviceKey: "TEAMS_RESOLUTION_NOTIFY" } });
  }
  await prisma.teamsIntegrationSettings.update({
    where: { id: "global" },
    data: {
      enableCustomerNotification: originalSettings.enableCustomerNotification,
      enableResolutionDetection: originalSettings.enableResolutionDetection,
    },
  });
});

beforeEach(async () => {
  connectedAccount = await prisma.whatsAppAccount.create({
    data: { label: `Teams Resolution Test Connected ${randomUUID()}`, status: "CONNECTED" },
  });
  disconnectedAccount = await prisma.whatsAppAccount.create({
    data: { label: `Teams Resolution Test Disconnected ${randomUUID()}`, status: "DISCONNECTED" },
  });
  group = await prisma.whatsAppGroup.create({
    data: {
      accountId: connectedAccount.id,
      whatsappGroupId: `${randomUUID()}@g.us`,
      name: "Test Support Group",
    },
  });

  team = await prisma.teamsTeam.create({ data: { externalTeamId: randomUUID(), name: "Test Team" } });
  channel = await prisma.teamsChannel.create({
    data: { teamId: team.id, externalChannelId: randomUUID(), name: "General" },
  });

  const keyword = await prisma.teamsResolutionKeyword.create({ data: { value: "resolved", isActive: true } });
  keywordId = keyword.id;
  rule = await prisma.teamsResolutionRule.create({
    data: { name: `Test Resolution Rule ${randomUUID()}`, isActive: true, keywords: { create: { keywordId: keyword.id } } },
  });

  issue = await prisma.supportIssue.create({
    data: {
      accountId: connectedAccount.id,
      groupId: group.id,
      chatId: group.whatsappGroupId,
      clientPhone: "+8801700000000",
      status: "WAITING_DEVELOPER",
      teamsChannelId: channel.id,
    },
  });

  await setNotificationsEnabled(true);
  await prisma.whatsAppServiceRoute.upsert({
    where: { serviceKey: "TEAMS_RESOLUTION_NOTIFY" },
    update: { accountId: connectedAccount.id, fallbackPolicy: "STRICT_NO_FALLBACK", enabled: true },
    create: { serviceKey: "TEAMS_RESOLUTION_NOTIFY", accountId: connectedAccount.id, fallbackPolicy: "STRICT_NO_FALLBACK", enabled: true },
  });
});

afterEach(async () => {
  await prisma.issueResolutionEvent.deleteMany({ where: { issueId: issue.id } });
  await prisma.outboundMessage.deleteMany({ where: { accountId: { in: [connectedAccount.id, disconnectedAccount.id] } } });
  await prisma.teamsMessage.deleteMany({ where: { id: { in: cleanupTeamsMessageIds } } });
  cleanupTeamsMessageIds.length = 0;
  await prisma.supportIssue.delete({ where: { id: issue.id } });
  await prisma.teamsResolutionRule.delete({ where: { id: rule.id } });
  await prisma.teamsResolutionKeyword.delete({ where: { id: keywordId } }).catch(() => {});
  await prisma.teamsChannel.delete({ where: { id: channel.id } }).catch(() => {});
  await prisma.teamsTeam.delete({ where: { id: team.id } }).catch(() => {});
  await prisma.whatsAppGroup.delete({ where: { id: group.id } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: [connectedAccount.id, disconnectedAccount.id] } } });
});

describe("evaluateResolutionForMessage", () => {
  it("queues exactly one customer notification and marks the issue RESOLVED on a keyword match", async () => {
    const message = await makeRootMessage("The bug is resolved now, please check.");
    await evaluateResolutionForMessage(message);

    const events = await prisma.issueResolutionEvent.findMany({ where: { issueId: issue.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("NOTIFIED");
    expect(events[0]!.outboundMessageId).not.toBeNull();

    const outbound = await prisma.outboundMessage.findMany({ where: { accountId: connectedAccount.id } });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.toPhone).toBe(issue.clientPhone);

    const updatedIssue = await prisma.supportIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(updatedIssue.status).toBe("RESOLVED");
  });

  it("is idempotent: evaluating the same message twice never creates a second event or a second outbound send", async () => {
    const message = await makeRootMessage("Fixed and resolved, deployed to production.");
    await evaluateResolutionForMessage(message);
    await evaluateResolutionForMessage(message);

    const events = await prisma.issueResolutionEvent.findMany({ where: { issueId: issue.id } });
    expect(events).toHaveLength(1);
    const outbound = await prisma.outboundMessage.findMany({ where: { accountId: connectedAccount.id } });
    expect(outbound).toHaveLength(1);
  });

  it("never creates an event or outbound message when no resolution keyword matches", async () => {
    const message = await makeRootMessage("Still investigating, no update yet.");
    await evaluateResolutionForMessage(message);

    const events = await prisma.issueResolutionEvent.findMany({ where: { issueId: issue.id } });
    expect(events).toHaveLength(0);
    const outbound = await prisma.outboundMessage.findMany({ where: { accountId: connectedAccount.id } });
    expect(outbound).toHaveLength(0);
  });

  it("skips with SKIPPED_NOTIFICATIONS_DISABLED and queues nothing when customer notification is off", async () => {
    await setNotificationsEnabled(false);
    const message = await makeRootMessage("This is resolved.");
    await evaluateResolutionForMessage(message);

    const events = await prisma.issueResolutionEvent.findMany({ where: { issueId: issue.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("SKIPPED_NOTIFICATIONS_DISABLED");
    expect(events[0]!.outboundMessageId).toBeNull();
    const outbound = await prisma.outboundMessage.findMany({ where: { accountId: connectedAccount.id } });
    expect(outbound).toHaveLength(0);
  });

  it("skips with SKIPPED_ALREADY_RESOLVED for an issue that is already RESOLVED", async () => {
    await prisma.supportIssue.update({ where: { id: issue.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
    const message = await makeRootMessage("Resolved again just in case.");
    await evaluateResolutionForMessage(message);

    const events = await prisma.issueResolutionEvent.findMany({ where: { issueId: issue.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("SKIPPED_ALREADY_RESOLVED");
    const outbound = await prisma.outboundMessage.findMany({ where: { accountId: connectedAccount.id } });
    expect(outbound).toHaveLength(0);
  });

  it("skips with SKIPPED_ACCOUNT_UNAVAILABLE when the configured account is disconnected with no fallback", async () => {
    await prisma.whatsAppServiceRoute.update({
      where: { serviceKey: "TEAMS_RESOLUTION_NOTIFY" },
      data: { accountId: disconnectedAccount.id, fallbackPolicy: "STRICT_NO_FALLBACK" },
    });
    const message = await makeRootMessage("Fully resolved on our end.");
    await evaluateResolutionForMessage(message);

    const events = await prisma.issueResolutionEvent.findMany({ where: { issueId: issue.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("SKIPPED_ACCOUNT_UNAVAILABLE");
    const outbound = await prisma.outboundMessage.findMany({ where: { accountId: connectedAccount.id } });
    expect(outbound).toHaveLength(0);
  });

  it("ignores a matching message in a channel not linked to any open issue", async () => {
    const otherChannelTeam = await prisma.teamsTeam.create({ data: { externalTeamId: randomUUID(), name: "Unlinked Team" } });
    const otherChannel = await prisma.teamsChannel.create({
      data: { teamId: otherChannelTeam.id, externalChannelId: randomUUID(), name: "Unlinked Channel" },
    });
    const message = await prisma.teamsMessage.create({
      data: { channelId: otherChannel.id, externalMessageId: randomUUID(), senderExternalId: "dev-1", body: "resolved", sentAt: new Date() },
    });
    cleanupTeamsMessageIds.push(message.id);

    await evaluateResolutionForMessage(message);

    const events = await prisma.issueResolutionEvent.findMany({ where: { issueId: issue.id } });
    expect(events).toHaveLength(0);

    await prisma.teamsChannel.delete({ where: { id: otherChannel.id } });
    await prisma.teamsTeam.delete({ where: { id: otherChannelTeam.id } });
  });
});
