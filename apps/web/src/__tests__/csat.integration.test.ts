import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Satisfaction surveys in the dashboard and the website chat API (CSAT.md):
 *   - resolving a conversation through Inbox V3 records ONE survey per resolution (keyed on the RESOLVE event),
 *     never for a WhatsApp group or a channel group thread, never with the feature or the channel off;
 *   - another project's surveys are invisible to a project's report and panel;
 *   - the report's figures (CSAT = 4–5 of the answered, response rate, average) per agent and channel;
 *   - the settings action needs settings.edit and clamps what it stores;
 *   - the website chat card and answer: only with the visitor's own token, on a listed origin, once.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

let current: Session;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const lifecycle = await import("@/server/conversationLifecycle");
const csat = await import("@/server/csat");
const csatActions = await import("@/server/actions/csat");
const inboxActions = await import("@/server/actions/inboxLifecycle");
const webchat = await import("@/server/channels/webchat");
const messagesRoute = await import("@/app/api/webchat/[key]/messages/route");
const csatRoute = await import("@/app/api/webchat/[key]/csat/route");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ISP = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
let BIZ = { id: "", slug: `csat-biz-${tag}`, name: `CSAT Biz ${tag}`, status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(ISP, fn);
const inBiz = <T,>(fn: () => Promise<T>) => runWithProject(BIZ, fn);
const SITE = "https://shop.example.test";
const ids = { users: [] as string[], roles: [] as string[], accounts: [] as string[], connections: [] as string[] };
const s = {} as Record<"agent" | "viewer" | "admin", Session>;
let account = "";
let telegram = "";
let seq = 0;
const personal = () => `88017${tag.replace(/\D/g, "").padEnd(4, "7").slice(0, 4)}${String(++seq).padStart(4, "0")}@c.us`;

async function role(name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.roles.push(r.id);
  return r.id;
}
async function user(name: string, roleId: string, projects: string[]) {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  for (const projectId of projects) await rawPrisma.projectAccess.create({ data: { projectId, userId: u.id } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
async function feature(projectId: string, key: string, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId, key } }, create: { projectId, key, enabled }, update: { enabled } });
  forgetProjectFeatureStates();
}
async function allChannelsOn(projectId: string, data: Record<string, unknown> = {}) {
  const all = { whatsappPersonalEnabled: true, webchatEnabled: true, messengerEnabled: true, instagramEnabled: true, telegramEnabled: true, cooldownDays: 7, questionText: null, ...data };
  await rawPrisma.csatSettings.upsert({ where: { projectId }, create: { projectId, ...all }, update: all });
}
const surveysOf = (where: object) => rawPrisma.csatSurvey.findMany({ where, orderBy: { createdAt: "asc" } });
const resolve = (ref: { kind: "whatsapp"; accountId: string; chatId: string } | { kind: "channel"; conversationId: string }, userId = s.agent.userId) =>
  lifecycle.changeConversationStatus(ref, { to: "RESOLVED" }, userId);

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (url: string, init: { origin?: string | null; method?: string; body?: string; auth?: string | null } = {}) =>
  new NextRequest(url, {
    method: init.method ?? "GET",
    body: init.body,
    headers: { ...(init.origin === null ? {} : { origin: init.origin ?? SITE }), ...(init.auth ? { authorization: `Bearer ${init.auth}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
  });

beforeAll(async () => {
  account = (await rawPrisma.whatsAppAccount.create({ data: { projectId: ORIGINAL_PROJECT_ID, label: `CSAT ${tag}`, status: "CONNECTED" } })).id;
  ids.accounts.push(account);
  telegram = (await rawPrisma.channelConnection.create({ data: { projectId: ORIGINAL_PROJECT_ID, type: "TELEGRAM", name: "@csat", status: "CONNECTED", webhookKey: `csatw-${tag}` } })).id;
  ids.connections.push(telegram);
  const creator = await rawPrisma.user.create({ data: { username: `csatc_${tag}`, email: `csatc_${tag}@example.test`, name: "Creator", passwordHash: "x" } });
  ids.users.push(creator.id);
  BIZ = { ...BIZ, id: (await createProjectWithDefaults({ name: BIZ.name, slug: BIZ.slug, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma)).id };

  const agent = await role("CSAT agent", ["messages.view", "messages.reply", "conversations.reply", "channels.view", "support_activity.view"]);
  const viewer = await role("CSAT viewer", ["messages.view", "settings.view"]);
  const admin = await role("CSAT admin", ["messages.view", "settings.view", "settings.edit"]);
  s.agent = await user("csat_agent", agent, [ORIGINAL_PROJECT_ID, BIZ.id]);
  s.viewer = await user("csat_viewer", viewer, [ORIGINAL_PROJECT_ID]);
  s.admin = await user("csat_admin", admin, [ORIGINAL_PROJECT_ID]);
});

beforeEach(async () => {
  for (const p of [ORIGINAL_PROJECT_ID, BIZ.id]) {
    await feature(p, "UNIFIED_INBOX_V3", true);
    await feature(p, "OMNICHANNEL", true);
    await feature(p, "CSAT_SURVEYS", true);
    await allChannelsOn(p);
  }
  current = s.agent;
});

afterAll(async () => {
  await rawPrisma.csatSurvey.deleteMany({ where: { OR: [{ accountId: { in: ids.accounts } }, { channelConversation: { connectionId: { in: ids.connections } } }] } });
  await rawPrisma.conversationEvent.deleteMany({ where: { OR: [{ accountId: { in: ids.accounts } }, { channelConversation: { connectionId: { in: ids.connections } } }] } });
  await rawPrisma.whatsAppConversationState.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.webChatVisitor.deleteMany({ where: { connectionId: { in: ids.connections } } });
  await rawPrisma.channelConversation.deleteMany({ where: { connectionId: { in: ids.connections } } });
  await rawPrisma.channelConnection.deleteMany({ where: { id: { in: ids.connections } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await rawPrisma.csatSettings.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID, key: { in: ["UNIFIED_INBOX_V3", "CSAT_SURVEYS", "OMNICHANNEL"] } } });
  const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((r) => r.table_name);
  for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, BIZ.id).catch(() => undefined);
  await rawPrisma.project.deleteMany({ where: { id: BIZ.id } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.systemLog.deleteMany({ where: { actorUserId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  forgetProjectFeatureStates();
  await rawPrisma.$disconnect();
});

describe("a resolution records one survey", () => {
  it("one PENDING survey per resolution, keyed on its RESOLVE event — resolving twice or replaying records nothing more", async () => {
    const chatId = personal();
    const ref = { kind: "whatsapp" as const, accountId: account, chatId };
    await inIsp(() => resolve(ref));
    await expect(inIsp(() => resolve(ref))).rejects.toThrow(/already/);
    // Through the panel's own action too: refused, nothing recorded. (The panel only opens a chat with a stored message.)
    await rawPrisma.message.create({
      data: { projectId: ORIGINAL_PROJECT_ID, accountId: account, chatId, whatsappMessageId: `csat-${randomUUID()}`, senderPhone: chatId.split("@")[0]!, direction: "INCOMING", body: "thanks", normalizedBody: "thanks", timestampWa: new Date(), processingStatus: "PROCESSED" },
    });
    expect(await inIsp(() => inboxActions.setConversationStatus(ref, { to: "RESOLVED" }))).toMatchObject({ error: expect.stringMatching(/already/) });
    const [survey, ...rest] = await surveysOf({ accountId: account, chatId });
    expect(rest).toHaveLength(0);
    const event = await rawPrisma.conversationEvent.findUniqueOrThrow({ where: { id: survey!.resolutionEventId } });
    expect(event).toMatchObject({ kind: "RESOLVE", accountId: account, chatId });
    expect(survey).toMatchObject({ status: "PENDING", channel: "WHATSAPP_PERSONAL", customerKey: `wa:${chatId}`, resolvedById: s.agent.userId, projectId: ORIGINAL_PROJECT_ID });

    // A replay of the same resolution (same event) records nothing.
    await inIsp(() => csat.recordCsatSurveyForResolution(ref, { eventId: survey!.resolutionEventId, resolvedAt: new Date(), actorId: s.agent.userId }));
    expect(await surveysOf({ accountId: account, chatId })).toHaveLength(1);

    // Reopened and resolved again: a second resolution, a second survey (the worker's cooldown decides whether it is asked).
    await inIsp(() => lifecycle.changeConversationStatus(ref, { to: "OPEN" }, s.agent.userId));
    await inIsp(() => resolve(ref));
    expect(await surveysOf({ accountId: account, chatId })).toHaveLength(2);
  });

  it("never for a WhatsApp group, a Telegram group thread, or a channel switched off", async () => {
    const group = `${tag}-${seq++}@g.us`;
    await rawPrisma.whatsAppGroup.create({ data: { projectId: ORIGINAL_PROJECT_ID, accountId: account, whatsappGroupId: group, name: `CSAT group ${tag}`, isActive: true } });
    await inIsp(() => resolve({ kind: "whatsapp", accountId: account, chatId: group }));
    expect(await surveysOf({ accountId: account, chatId: group })).toHaveLength(0);

    const tgGroup = await rawPrisma.channelConversation.create({ data: { projectId: ORIGINAL_PROJECT_ID, connectionId: telegram, type: "TELEGRAM", externalThreadId: `g-${randomUUID()}`, kind: "GROUP" } });
    await inIsp(() => resolve({ kind: "channel", conversationId: tgGroup.id }));
    expect(await surveysOf({ channelConversationId: tgGroup.id })).toHaveLength(0);

    await allChannelsOn(ORIGINAL_PROJECT_ID, { telegramEnabled: false });
    const direct = await rawPrisma.channelConversation.create({ data: { projectId: ORIGINAL_PROJECT_ID, connectionId: telegram, type: "TELEGRAM", externalThreadId: `d-${randomUUID()}`, kind: "DIRECT" } });
    await inIsp(() => resolve({ kind: "channel", conversationId: direct.id }));
    expect(await surveysOf({ channelConversationId: direct.id })).toHaveLength(0);

    await allChannelsOn(ORIGINAL_PROJECT_ID);
    const direct2 = await rawPrisma.channelConversation.create({ data: { projectId: ORIGINAL_PROJECT_ID, connectionId: telegram, type: "TELEGRAM", externalThreadId: `d-${randomUUID()}`, kind: "DIRECT" } });
    await inIsp(() => resolve({ kind: "channel", conversationId: direct2.id }));
    expect(await surveysOf({ channelConversationId: direct2.id })).toHaveLength(1);
  });

  it("with CSAT_SURVEYS off: the resolution happens, no survey is recorded", async () => {
    await feature(ORIGINAL_PROJECT_ID, "CSAT_SURVEYS", false);
    const chatId = personal();
    expect(await inIsp(() => resolve({ kind: "whatsapp", accountId: account, chatId }))).toBe("RESOLVED");
    expect(await surveysOf({ accountId: account, chatId })).toHaveLength(0);
  });
});

describe("project isolation", () => {
  it("another project's survey is in its own project, and never in this project's report or panel", async () => {
    const bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: BIZ.id, label: `CSAT Biz ${tag}`, status: "CONNECTED" } })).id;
    ids.accounts.push(bizAccount);
    const bizChat = personal();
    const bizRef = { kind: "whatsapp" as const, accountId: bizAccount, chatId: bizChat };
    await inBiz(() => resolve(bizRef));
    const [bizSurvey] = await surveysOf({ accountId: bizAccount });
    expect(bizSurvey).toMatchObject({ projectId: BIZ.id });
    await rawPrisma.csatSurvey.update({ where: { id: bizSurvey!.id }, data: { status: "SENT", sentAt: new Date(), answerClosedAt: new Date(), answeredAt: new Date(), rating: 1 } });

    const range = { start: new Date(Date.now() - 3_600_000), end: new Date(Date.now() + 3_600_000) };
    const ispReport = await inIsp(() => csat.loadCsatReport(range, { canReadMessages: true }));
    expect(ispReport.rows.map((r) => r.id)).not.toContain(bizSurvey!.id);
    expect(await inIsp(() => csat.loadConversationCsat(bizRef, true))).toEqual([]);
    const bizReport = await inBiz(() => csat.loadCsatReport(range, { canReadMessages: true }));
    expect(bizReport.rows.map((r) => r.id)).toEqual([bizSurvey!.id]);
  });
});

describe("the report", () => {
  it("CSAT is 4–5 of the answered, the response rate is answered of asked; per agent and per channel; comments only for message readers", async () => {
    const now = new Date();
    const made: string[] = [];
    for (const rating of [5, 4, 2, null] as const) {
      const chatId = personal();
      await inIsp(() => resolve({ kind: "whatsapp", accountId: account, chatId }));
      const [row] = await surveysOf({ accountId: account, chatId });
      const answered = rating === null ? {} : { answerClosedAt: now, answeredAt: now, rating, comment: `comment ${rating}`, answerSource: "MESSAGE" };
      await rawPrisma.csatSurvey.update({ where: { id: row!.id }, data: { status: "SENT", sentAt: new Date(now.getTime() + 60_000), ...answered } });
      made.push(row!.id);
    }
    const range = { start: new Date(now.getTime() + 30_000), end: new Date(now.getTime() + 120_000) };
    const report = await inIsp(() => csat.loadCsatReport(range, { canReadMessages: false }));
    expect(report.summary).toMatchObject({ asked: 4, answered: 3 });
    expect(report.summary.csat).toBeCloseTo(2 / 3);
    expect(report.summary.responseRate).toBeCloseTo(0.75);
    expect(report.byAgent).toEqual([expect.objectContaining({ label: "csat_agent", summary: expect.objectContaining({ asked: 4, answered: 3 }) })]);
    expect(report.byChannel.map((g) => g.key)).toEqual(["WHATSAPP_PERSONAL"]);
    expect(report.rows.every((r) => r.comment === null)).toBe(true);
    const withComments = await inIsp(() => csat.loadCsatReport(range, { canReadMessages: true }));
    expect(withComments.rows.map((r) => r.comment).filter(Boolean).sort()).toEqual(["comment 2", "comment 4", "comment 5"]);
    expect(made).toHaveLength(4);
  });
});

describe("settings", () => {
  it("need settings.edit, and are clamped on the server", async () => {
    current = s.viewer;
    expect(await inIsp(() => csatActions.saveCsatSettingsAction({ telegramEnabled: true }))).toMatchObject({ error: expect.any(String) });
    current = s.admin;
    expect(await inIsp(() => csatActions.saveCsatSettingsAction({ telegramEnabled: true, webchatEnabled: "yes", cooldownDays: 900, questionText: "  Rate us 1-5  " }))).toEqual({ ok: true });
    expect(await rawPrisma.csatSettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } })).toMatchObject({
      telegramEnabled: true,
      webchatEnabled: false,
      whatsappPersonalEnabled: false,
      cooldownDays: 365,
      questionText: "Rate us 1-5",
      updatedById: s.admin.userId,
    });
    await feature(ORIGINAL_PROJECT_ID, "CSAT_SURVEYS", false);
    expect(await inIsp(() => csatActions.saveCsatSettingsAction({ telegramEnabled: false }))).toMatchObject({ error: expect.any(String) });
  });
});

describe("the website chat card", () => {
  async function widgetWithSurvey() {
    const { id } = await inIsp(() => webchat.connectWebchat({ name: `Site ${randomUUID().slice(0, 6)}`, origins: [SITE], username: "admin" }));
    ids.connections.push(id);
    const key = (await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id } })).webhookKey;
    const w = (await webchat.loadPublicWidget(key))!;
    const owner = await webchat.startVisitor(w, { ip: `10.1.${seq % 250}.${++seq % 250}` });
    const other = await webchat.startVisitor(w, { ip: `10.2.${seq % 250}.${++seq % 250}` });
    const conversation = await rawPrisma.channelConversation.create({ data: { projectId: ORIGINAL_PROJECT_ID, connectionId: id, type: "WEBCHAT", externalThreadId: owner.visitorId, kind: "DIRECT", lastInboundAt: new Date() } });
    await inIsp(() => resolve({ kind: "channel", conversationId: conversation.id }));
    const [survey] = await surveysOf({ channelConversationId: conversation.id });
    // What the worker does for website chat: the card is shown (SENT), nothing is sent.
    await rawPrisma.csatSurvey.update({ where: { id: survey!.id }, data: { status: "SENT", sentAt: new Date(), question: "How did we do?" } });
    return { key, survey: survey!, owner: owner.token!, other: other.token! };
  }
  const poll = (key: string, token: string | null, origin?: string | null) => messagesRoute.GET(req(`https://app.example.test/api/webchat/${key}/messages`, { auth: token, origin }), params({ key }));
  const answer = (key: string, token: string | null, body: object, origin?: string | null) =>
    csatRoute.POST(req(`https://app.example.test/api/webchat/${key}/csat`, { method: "POST", auth: token, origin, body: JSON.stringify(body) }), params({ key }));

  it("is shown to its own visitor only, and answered once — fails closed on everything else", async () => {
    const w = await widgetWithSurvey();
    expect((await (await poll(w.key, w.owner)).json()).csat).toEqual({ id: w.survey.id, question: "How did we do?" });
    expect((await (await poll(w.key, w.other)).json()).csat).toBeNull();
    expect((await poll(w.key, null)).status).toBe(401);

    expect((await answer(w.key, null, { surveyId: w.survey.id, rating: 5 })).status).toBe(401);
    expect((await answer(w.key, "x".repeat(43), { surveyId: w.survey.id, rating: 5 })).status).toBe(401);
    expect((await answer(w.key, w.other, { surveyId: w.survey.id, rating: 5 })).status).toBe(404);
    expect((await answer(w.key, w.owner, { surveyId: w.survey.id, rating: 5 }, "https://evil.example.test")).status).toBe(403);
    expect((await answer(w.key, w.owner, { surveyId: w.survey.id, rating: 9 })).status).toBe(400);
    expect((await rawPrisma.csatSurvey.findUniqueOrThrow({ where: { id: w.survey.id } })).rating).toBeNull();

    const ok = await answer(w.key, w.owner, { surveyId: w.survey.id, rating: 4, comment: "  খুব ভালো  " });
    expect(ok.status).toBe(200);
    expect(await rawPrisma.csatSurvey.findUniqueOrThrow({ where: { id: w.survey.id } })).toMatchObject({ rating: 4, comment: "খুব ভালো", answerSource: "WIDGET" });
    expect((await answer(w.key, w.owner, { surveyId: w.survey.id, rating: 1 })).status).toBe(404);
    expect((await rawPrisma.csatSurvey.findUniqueOrThrow({ where: { id: w.survey.id } })).rating).toBe(4);
    expect((await (await poll(w.key, w.owner)).json()).csat).toBeNull();
  });

  it("with CSAT_SURVEYS off: no card and no answer", async () => {
    const w = await widgetWithSurvey();
    await feature(ORIGINAL_PROJECT_ID, "CSAT_SURVEYS", false);
    expect((await (await poll(w.key, w.owner)).json()).csat).toBeNull();
    expect((await answer(w.key, w.owner, { surveyId: w.survey.id, rating: 5 })).status).toBe(404);
    expect((await rawPrisma.csatSurvey.findUniqueOrThrow({ where: { id: w.survey.id } })).rating).toBeNull();
  });
});
