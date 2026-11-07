import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { parseWidgetSettings, type WidgetSettings } from "@support-automation/shared";

/**
 * Routing a new website chat (WEBSITE_CHAT.md §Routing): the rule's Team or person is on the conversation before the
 * worker ever sees it, a rule can never reach into another project, and trouble with a rule never costs the message.
 */
// The public API resolves its customer from the address; here, the original installation.
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  getSession: async () => ({ userId: "visitor-request", username: "", email: "", name: "", tenant: null }),
}));

const { recordVisitorMessage, loadPublicWidget, startVisitor } = await import("@/server/channels/webchat");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const fx = {} as { team: string; otherTeam: string; biz: string; connection: string; key: string; agent: string };
const ids = { users: [] as string[] };

async function widgetWith(settings: Partial<WidgetSettings>) {
  await rawPrisma.channelConnection.update({ where: { id: fx.connection }, data: { widgetSettings: parseWidgetSettings({ ...settings, prechat: { enabled: true, fields: [{ key: "c1", label: "Topic", required: true, enabled: true, type: "select", options: ["Billing", "Sales"] }, { key: "name", enabled: false }, { key: "phone", enabled: false }, { key: "email", enabled: false }] } }) as never } });
  return (await loadPublicWidget(fx.key))!;
}

async function visitorSends(settings: Partial<WidgetSettings>, topic: string, pageUrl = "https://shop.example/billing/invoice") {
  const widget = await widgetWith(settings);
  const started = await startVisitor(widget, { custom: { c1: topic }, context: { pageUrl }, ip: null });
  const visitor = { id: started.visitorId, name: null, email: null, verified: false };
  await recordVisitorMessage(widget, visitor, { text: "Hello", nonce: randomUUID().replace(/-/g, ""), pageUrl });
  const conversation = await rawPrisma.channelConversation.findFirst({ where: { connectionId: fx.connection, externalThreadId: visitor.id } });
  const events = conversation ? await rawPrisma.conversationEvent.findMany({ where: { channelConversationId: conversation.id } }) : [];
  const recorded = await rawPrisma.channelInboundEvent.count({ where: { connectionId: fx.connection, dedupKey: { startsWith: `wc:${visitor.id}:` } } });
  return { conversation, events, recorded, visitor };
}

const rule = (over: Record<string, unknown>) => ({ id: "r1", name: "Billing desk", enabled: true, pages: [], fieldKey: null, fieldValue: "", when: "any", teamId: null, userId: null, ...over });

beforeAll(async () => {
  const pid = { projectId: ORIGINAL_PROJECT_ID };
  fx.team = (await rawPrisma.team.create({ data: { ...pid, name: `Billing ${tag}` } })).id;
  const creator = await rawPrisma.user.create({ data: { username: `creator_${tag}`, email: `creator_${tag}@example.test`, name: "Creator", passwordHash: "x" } });
  ids.users.push(creator.id);
  fx.biz = (await createProjectWithDefaults({ name: `Biz ${tag}`, slug: `biz-${tag}`, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma)).id;
  fx.otherTeam = (await rawPrisma.team.create({ data: { projectId: fx.biz, name: `Other ${tag}` } })).id;
  const agent = await rawPrisma.user.create({ data: { username: `agent_${tag}`, email: `agent_${tag}@example.test`, name: "Agent", passwordHash: "x" } });
  ids.users.push(agent.id);
  await rawPrisma.projectAccess.create({ data: { ...pid, userId: agent.id } });
  fx.agent = agent.id;
  fx.key = `wc${tag}${tag}${tag}`;
  fx.connection = (await rawPrisma.channelConnection.create({ data: { ...pid, type: "WEBCHAT", name: `Site ${tag}`, status: "CONNECTED", enabled: true, webhookKey: fx.key, allowedOrigins: ["https://shop.example"] } })).id;
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: ORIGINAL_PROJECT_ID, key: "OMNICHANNEL" } }, create: { ...pid, key: "OMNICHANNEL", enabled: true }, update: { enabled: true } });
});

beforeEach(async () => {
  await rawPrisma.conversationEvent.deleteMany({ where: { channelConversation: { connectionId: fx.connection } } });
});

afterAll(async () => {
  await rawPrisma.channelInboundEvent.deleteMany({ where: { connectionId: fx.connection } });
  await rawPrisma.channelConversation.deleteMany({ where: { connectionId: fx.connection } });
});

describe("routing a new website chat", () => {
  it("puts a matching answer's chat with its Team before the worker sees it", async () => {
    const { conversation, events, recorded } = await visitorSends({ routing: [rule({ fieldKey: "c1", fieldValue: "Billing", teamId: fx.team })] as never }, "Billing");
    expect(conversation?.assignedTeamId).toBe(fx.team);
    expect(conversation?.assignedUserId).toBeNull();
    expect(events.map((e) => [e.kind, e.toValue])).toEqual([["TEAM", fx.team]]);
    expect(events[0]!.context).toMatchObject({ reason: "WEBSITE_RULE", rule: "Billing desk" });
    expect(recorded).toBe(1);
  });

  it("gives it to a named person", async () => {
    const { conversation, events } = await visitorSends({ routing: [rule({ pages: ["/billing/*"], userId: fx.agent })] as never }, "Sales");
    expect(conversation?.assignedUserId).toBe(fx.agent);
    expect(events.map((e) => e.kind)).toEqual(["ASSIGNEE"]);
  });

  it("does nothing when no rule matches, and the worker opens the chat as ever", async () => {
    const { conversation, recorded } = await visitorSends({ routing: [rule({ fieldKey: "c1", fieldValue: "Billing", teamId: fx.team })] as never }, "Sales");
    expect(conversation).toBeNull();
    expect(recorded).toBe(1);
  });

  it("can never reach another project's Team, and the message still gets through", async () => {
    const { conversation, recorded } = await visitorSends({ routing: [rule({ teamId: fx.otherTeam })] as never }, "Billing");
    expect(conversation).toBeNull();
    expect(recorded).toBe(1);
  });

  it("does not move a chat on its second message", async () => {
    const widget = await widgetWith({ routing: [rule({ teamId: fx.team })] as never });
    const started = await startVisitor(widget, { custom: { c1: "Billing" }, context: {}, ip: null });
    const visitor = { id: started.visitorId, name: null, email: null, verified: false };
    await recordVisitorMessage(widget, visitor, { text: "One", nonce: randomUUID().replace(/-/g, "") });
    const again = await widgetWith({ routing: [rule({ userId: fx.agent })] as never });
    await recordVisitorMessage(again, visitor, { text: "Two", nonce: randomUUID().replace(/-/g, "") });
    const conversation = await rawPrisma.channelConversation.findFirstOrThrow({ where: { connectionId: fx.connection, externalThreadId: visitor.id } });
    expect(conversation.assignedTeamId).toBe(fx.team);
    expect(conversation.assignedUserId).toBeNull();
  });

  it("uses the away form while the team is away, and refuses it missing", async () => {
    const closed = { enabled: true, timezone: "Asia/Dhaka", days: Array.from({ length: 7 }, () => null) };
    const widget = await widgetWith({ hours: closed as never, prechatAway: { enabled: true, intro: "", buttonLabel: "Send", consentText: "", fields: [{ key: "name", label: "Name", enabled: false, required: false }, { key: "phone", label: "Mobile", enabled: false, required: false }, { key: "email", label: "Email", enabled: true, required: true }] } });
    await expect(startVisitor(widget, { form: "away", context: {}, ip: null })).rejects.toThrow(/Email/);
    const ok = await startVisitor(widget, { form: "away", email: "a@example.com", context: {}, ip: null });
    expect((await rawPrisma.webChatVisitor.findUniqueOrThrow({ where: { id: ok.visitorId } })).email).toBe("a@example.com");
  });
});
