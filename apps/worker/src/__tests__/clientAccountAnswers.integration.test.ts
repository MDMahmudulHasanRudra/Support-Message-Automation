import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { withProject, resetProjectCachesForTests } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { findClientAccountGrounding, type AccountCustomer } from "../aiFallback/clientAccountContext.js";
import { verifiedWhatsAppPhone } from "../aiFallback/commerceContext.js";
import { buildFallbackPrompt } from "../aiFallback/prompt.js";
import { runAiFallback } from "../aiFallback/runAiFallback.js";
import { processOne as processOutboundOne } from "../queue/outboundQueueProcessor.js";
import { MockAiClient } from "./mockAiClient.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Customer account answers (AI_CLIENT_ANSWERS.md) against a real, isolated database.
 *
 * What must hold:
 *   - a one-to-one chat whose `…@c.us` number matches exactly one client gets that client's entries;
 *   - a LID sender (no number WhatsApp delivered) gets none; a group gets none; a number shared by two
 *     clients gets none and the question is handed over; another project's client never matches;
 *   - with the switches off nothing is queried and the prompt is byte-identical;
 *   - dues stay out when only account answers are on;
 *   - a reply naming an amount it was not given is handed over (UNGROUNDED_PRICE), never sent.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
// Digits only, unique per run (CLAUDE.md: a "unique" test phone number must be digits only).
const run = String(randomInt(1000, 9999));
const P_ONE = `88017${run}0001`;
const P_SHARED = `88018${run}0002`;
const P_OTHER_PROJECT = `88019${run}0003`;
const LID = `1616${run}0000004`;

let A = "";
let B = "";
let creator = "";
let accountA = "";
let accountB = "";
let groupA = "";
let groupChatA = "";
const msg: Record<string, string> = {};

const inA = <T,>(fn: () => Promise<T>) => withProject(A, fn);
const inB = <T,>(fn: () => Promise<T>) => withProject(B, fn);
const ON = { clientAccountAnswers: true, clientDueAnswers: true, clientAccountAutoReply: false };

async function makeClient(projectId: string, code: string, phone: string | null, opts: { dues?: Array<{ amount: string; currency: string }>; service?: string } = {}) {
  const client = await rawPrisma.client.create({ data: { projectId, code, name: `Client ${code} ${tag}` } });
  if (phone) await rawPrisma.clientChannel.create({ data: { projectId, clientId: client.id, kind: "WHATSAPP", value: `+${phone}`, normalizedValue: phone } });
  if (opts.service) {
    const term = await rawPrisma.clientSubscription.create({
      data: { projectId, clientId: client.id, service: opts.service, startDate: new Date("2026-10-15T00:00:00Z"), endDate: new Date("2099-11-15T00:00:00Z") },
    });
    await rawPrisma.client.update({ where: { id: client.id }, data: { currentSubscriptionId: term.id } });
  }
  for (const d of opts.dues ?? []) {
    await rawPrisma.clientDue.create({ data: { projectId, clientId: client.id, dueDate: new Date("2099-01-01T00:00:00Z"), amount: d.amount, currency: d.currency, status: "UNPAID" } });
  }
  return client.id;
}

async function makeMessage(projectId: string, accountId: string, chatId: string, senderJid: string, groupId: string | null = null, body = "what is my due?") {
  const m = await rawPrisma.message.create({
    data: {
      projectId,
      accountId,
      groupId,
      whatsappMessageId: `false_${randomUUID()}`,
      chatId,
      senderPhone: senderJid.split("@")[0]!,
      senderJid,
      direction: "INCOMING",
      body,
      normalizedBody: body.toLowerCase(),
      timestampWa: new Date(),
    },
  });
  return m.id;
}

const makeOutgoing = (phone: string, whatsappMessageId: string, at = new Date()) =>
  rawPrisma.message.create({ data: { projectId: A, accountId: accountA, whatsappMessageId, chatId: `${phone}@c.us`, senderPhone: "880100", direction: "OUTGOING", body: "x", normalizedBody: "x", timestampWa: at } });

const whatsapp = (accountId: string, chatId: string, messageId: string, isGroup = false): AccountCustomer => ({
  kind: "WHATSAPP",
  accountId,
  chatId,
  isGroup,
  verifiedPhone: () => verifiedWhatsAppPhone(messageId),
});

beforeAll(async () => {
  creator = (await rawPrisma.user.create({ data: { username: `ca_${tag}`, email: `ca.${tag}@example.test`, name: "CA", passwordHash: "x" } })).id;
  const make = async (name: string) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: creator }, rawPrisma);
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
    return p.id;
  };
  A = await make("AcctA");
  B = await make("AcctB");
  resetProjectCachesForTests();
  resetProjectFeatureCacheForTests();

  accountA = (await rawPrisma.whatsAppAccount.create({ data: { projectId: A, label: `A ${tag}`, status: "CONNECTED" } })).id;
  accountB = (await rawPrisma.whatsAppAccount.create({ data: { projectId: B, label: `B ${tag}`, status: "CONNECTED" } })).id;

  await makeClient(A, "0012", P_ONE, { service: "Home 20 Mbps", dues: [{ amount: "1200.00", currency: "BDT" }, { amount: "15.00", currency: "USD" }] });
  await makeClient(A, "0013", P_SHARED, { service: "Home 10 Mbps" });
  await makeClient(A, "0014", P_SHARED, { service: "Office 50 Mbps" });
  // A LID that somebody stored as a "phone" (it happens: a LID is all message history carries). Reading a
  // LID as a number would match this client; the test below proves it never does.
  await makeClient(A, "0015", LID, { service: "Should never be told" });
  await makeClient(B, "0001", P_OTHER_PROJECT, { service: "Bizify Plan", dues: [{ amount: "999.00", currency: "BDT" }] });

  msg.one = await makeMessage(A, accountA, `${P_ONE}@c.us`, `${P_ONE}@c.us`);
  msg.lid = await makeMessage(A, accountA, `${LID}@lid`, `${LID}@lid`);
  msg.shared = await makeMessage(A, accountA, `${P_SHARED}@c.us`, `${P_SHARED}@c.us`);
  msg.otherProject = await makeMessage(A, accountA, `${P_OTHER_PROJECT}@c.us`, `${P_OTHER_PROJECT}@c.us`);
  msg.inB = await makeMessage(B, accountB, `${P_OTHER_PROJECT}@c.us`, `${P_OTHER_PROJECT}@c.us`);

  groupChatA = `${tag}-1234567890@g.us`;
  groupA = (await rawPrisma.whatsAppGroup.create({ data: { projectId: A, accountId: accountA, whatsappGroupId: groupChatA, name: "Acct group", isMonitored: true, aiAutomationEnabled: true, lastSyncedAt: new Date() } })).id;
  msg.group = await makeMessage(A, accountA, groupChatA, `${P_ONE}@c.us`, groupA);
});

afterAll(async () => {
  for (const projectId of [A, B]) {
    if (!projectId) continue;
    await rawPrisma.ruleProposal.deleteMany({ where: { projectId } });
    await rawPrisma.commerceOrder.deleteMany({ where: { projectId } });
    await rawPrisma.client.updateMany({ where: { projectId }, data: { currentSubscriptionId: null } });
    await rawPrisma.clientDue.deleteMany({ where: { projectId } });
    await rawPrisma.clientSubscription.deleteMany({ where: { projectId } });
    await rawPrisma.clientWhatsAppChatLink.deleteMany({ where: { projectId } });
    await rawPrisma.clientChannel.deleteMany({ where: { projectId } });
    await rawPrisma.client.deleteMany({ where: { projectId } });
    await rawPrisma.notification.deleteMany({ where: { projectId } });
    await rawPrisma.outboundMessage.deleteMany({ where: { projectId } });
    await rawPrisma.aiEvidenceSnapshot.deleteMany({ where: { projectId } });
    await rawPrisma.aiFallbackDecision.deleteMany({ where: { projectId } });
    await rawPrisma.message.deleteMany({ where: { projectId } });
    await rawPrisma.whatsAppGroup.deleteMany({ where: { projectId } });
    await rawPrisma.whatsAppAccount.deleteMany({ where: { projectId } });
  }
});

describe("who the customer is", () => {
  it("a one-to-one chat whose …@c.us number matches one client gets its account and dues", async () => {
    const g = await inA(() => findClientAccountGrounding({ text: "what is my due?", switches: ON, customer: whatsapp(accountA, `${P_ONE}@c.us`, msg.one!) }));
    expect(g.status).toBe("FOUND");
    expect(g.handoverReason).toBeNull();
    expect(g.snippets.map((s) => s.title)).toEqual(["Your account (client 0012)", "Your outstanding dues (client 0012)"]);
    expect(g.snippets[0]!.answer).toBe("Your account (client 0012): package Home 20 Mbps — active, expires on 15 Nov 2099.");
    expect(g.snippets[1]!.answer).toBe("Your outstanding dues (client 0012): BDT 1,200.00 (1 open invoice); USD 15.00 (1 open invoice).");
    expect(g.amounts).toEqual(["BDT 1,200.00", "USD 15.00"]);
    expect(g.rules.join("\n")).toMatch(/CUSTOMER ACCOUNT/);
  });

  it("an archived client is not matched: the customer is not found, and nothing is told", async () => {
    const phone = `88016${run}0005`;
    await makeClient(A, "0016", phone, { service: "Old plan", dues: [{ amount: "700.00", currency: "BDT" }] });
    await rawPrisma.client.updateMany({ where: { projectId: A, code: "0016" }, data: { archivedAt: new Date(), status: "ARCHIVED" } });
    const message = await makeMessage(A, accountA, `${phone}@c.us`, `${phone}@c.us`);
    const g = await inA(() => findClientAccountGrounding({ text: "what is my due?", switches: ON, customer: whatsapp(accountA, `${phone}@c.us`, message) }));
    expect(g.status).toBe("NOT_FOUND");
    expect(g.snippets).toEqual([]);
    expect(g.amounts).toEqual([]);
  });

  it("a LID sender gets none: no number WhatsApp delivered, and nobody linked the chat", async () => {
    const g = await inA(() => findClientAccountGrounding({ text: "what is my due?", switches: ON, customer: whatsapp(accountA, `${LID}@lid`, msg.lid!) }));
    expect(g.status).toBe("UNVERIFIED");
    expect(g.snippets).toEqual([]);
    expect(g.amounts).toEqual([]);
  });

  it("…but a chat a person linked to the client is that client", async () => {
    const clientId = (await rawPrisma.client.findFirstOrThrow({ where: { projectId: A, code: "0012" } })).id;
    const link = await rawPrisma.clientWhatsAppChatLink.create({ data: { projectId: A, clientId, accountId: accountA, chatId: `${LID}@lid` } });
    try {
      const g = await inA(() => findClientAccountGrounding({ text: "what is my due?", switches: ON, customer: whatsapp(accountA, `${LID}@lid`, msg.lid!) }));
      expect(g.status).toBe("FOUND");
      expect(g.snippets[0]!.title).toBe("Your account (client 0012)");
    } finally {
      await rawPrisma.clientWhatsAppChatLink.delete({ where: { id: link.id } });
    }
  });

  it("a group gets none, even when the sender's own number matches a client", async () => {
    const g = await inA(() => findClientAccountGrounding({ text: "what is my due?", switches: ON, customer: whatsapp(accountA, groupChatA, msg.group!, true) }));
    expect(g.status).toBe("GROUP");
    expect(g.snippets).toEqual([]);
    // The chat id alone is enough to refuse, whatever a caller says.
    const byChat = await inA(() => findClientAccountGrounding({ text: "what is my due?", switches: ON, customer: whatsapp(accountA, groupChatA, msg.group!, false) }));
    expect(byChat.status).toBe("GROUP");
  });

  it("a number two clients share gets none, and the question is handed over", async () => {
    const g = await inA(() => findClientAccountGrounding({ text: "what is my due?", switches: ON, customer: whatsapp(accountA, `${P_SHARED}@c.us`, msg.shared!) }));
    expect(g.status).toBe("AMBIGUOUS");
    expect(g.snippets).toEqual([]);
    expect(g.handoverReason).toBe("ACCOUNT_AMBIGUOUS");
    // The Copilot drafts instead of handing over, but still gets nothing.
    const copilot = await inA(() => findClientAccountGrounding({ text: "what is my due?", switches: ON, customer: whatsapp(accountA, `${P_SHARED}@c.us`, msg.shared!), handoverRequests: false }));
    expect(copilot.handoverReason).toBeNull();
    expect(copilot.snippets).toEqual([]);
  });

  it("another project's client never matches", async () => {
    const g = await inA(() => findClientAccountGrounding({ text: "what is my due?", switches: ON, customer: whatsapp(accountA, `${P_OTHER_PROJECT}@c.us`, msg.otherProject!) }));
    expect(g.status).toBe("NOT_FOUND");
    expect(g.snippets).toEqual([]);
    // Control: in its own project the same number is that client — so the fixture is right.
    const own = await inB(() => findClientAccountGrounding({ text: "what is my due?", switches: ON, customer: whatsapp(accountB, `${P_OTHER_PROJECT}@c.us`, msg.inB!) }));
    expect(own.status).toBe("FOUND");
    expect(own.snippets[0]!.title).toBe("Your account (client 0001)");
  });

  it("channels and the Sandbox carry no verified identity: none", async () => {
    const g = await inA(() => findClientAccountGrounding({ text: "what is my due?", switches: ON, customer: { kind: "UNVERIFIABLE" } }));
    expect(g.status).toBe("UNVERIFIED");
    expect(g.snippets).toEqual([]);
  });
});

describe("switches", () => {
  it("off: not one query, no rules, and the prompt is byte-identical", async () => {
    const touched: string[] = [];
    const db = new Proxy({} as PrismaClient, {
      get(_t, key) {
        touched.push(String(key));
        return new Proxy(() => undefined, { get: () => () => Promise.resolve(null), apply: () => Promise.resolve(null) });
      },
    });
    const deps = {
      db,
      hasClientCenter: async () => {
        touched.push("feature");
        return true;
      },
    };
    const g = await findClientAccountGrounding(
      { text: "what is my due?", switches: { clientAccountAnswers: false, clientDueAnswers: true }, customer: { kind: "UNVERIFIABLE" } },
      deps,
    );
    expect(touched).toEqual([]);
    expect(g).toEqual({ snippets: [], rules: [], handoverReason: null, policy: null, status: null, amounts: [] });

    const input = { customerMessage: "what is my due?", groupName: null, defaultReplyLanguage: "Bengali (Bangla)", knowledge: [] };
    expect(buildFallbackPrompt({ ...input, accountRules: g.rules })).toEqual(buildFallbackPrompt(input));
  });

  it("dues stay out when only account answers are on", async () => {
    const g = await inA(() =>
      findClientAccountGrounding({ text: "what is my due?", switches: { clientAccountAnswers: true, clientDueAnswers: false }, customer: whatsapp(accountA, `${P_ONE}@c.us`, msg.one!) }),
    );
    expect(g.status).toBe("FOUND");
    expect(g.snippets.map((s) => s.title)).toEqual(["Your account (client 0012)"]);
    expect(g.amounts).toEqual([]);
    expect(g.snippets.map((s) => s.answer).join(" ")).not.toMatch(/1,200|BDT/);
    expect(g.rules.join("\n")).toMatch(/What the customer owes is not available here/);
  });

  it("a Copilot agent without the billing key gets the account but not the dues", async () => {
    const g = await inA(() =>
      findClientAccountGrounding({ text: "what is my due?", switches: ON, customer: whatsapp(accountA, `${P_ONE}@c.us`, msg.one!), viewer: { account: true, dues: false }, handoverRequests: false }),
    );
    expect(g.snippets.map((s) => s.title)).toEqual(["Your account (client 0012)"]);
    expect(g.amounts).toEqual([]);
  });
});

describe("one-to-one chats: AI answers by itself only behind its own switch", () => {
  let seq = 0;
  const phoneFor = () => `88015${run}${String(++seq).padStart(4, "0")}`;
  async function aiOn(data: Record<string, unknown> = {}) {
    await rawPrisma.aiSettings.update({
      where: { projectId: A },
      data: { aiEngineEnabled: true, autoResponseEnabled: true, aiResponseMode: "STRICT_KNOWLEDGE_ONLY", autoResponseConfidenceThreshold: 80, clientAccountAnswers: true, clientDueAnswers: true, clientAccountAutoReply: true, commerceOrderAnswers: false, aiRuleGenerationEnabled: false, humanTakeoverCooldownMinutes: 30, aiReplyCooldownSeconds: 0, ...data },
    });
    return rawPrisma.automationSettings.update({
      where: { projectId: A },
      data: { automationEnabled: true, mode: "SAFE_AUTO_REPLY", rateLimitingEnabled: false, defaultReplyDelayMinMs: 0, defaultReplyDelayMaxMs: 0, teamsWebhookUrl: "https://example.invalid/webhook" },
    });
  }
  async function ask(phone: string, body: string, opts: { reply?: string; confidence?: number; senderJid?: string; chatId?: string; settings?: Record<string, unknown>; automation?: Record<string, unknown> } = {}) {
    let automationSettings = await aiOn(opts.settings);
    if (opts.automation) automationSettings = await rawPrisma.automationSettings.update({ where: { projectId: A }, data: opts.automation });
    const chatId = opts.chatId ?? `${phone}@c.us`;
    const id = await makeMessage(A, accountA, chatId, opts.senderJid ?? `${phone}@c.us`, null, body);
    const client = new MockAiClient();
    client.nextText = `INTENT: dues\nSCOPE: BUSINESS_SPECIFIC\nCONFIDENCE: ${opts.confidence ?? 97}\nSHOULD_REPLY: YES\nRESPONSE: ${opts.reply ?? "Your due is BDT 700.00."}`;
    await inA(() => runAiFallback({ message: { id, body }, accountId: accountA, chatId, toPhone: phone, group: null, automationSettings, clientOverride: client }));
    const decision = await rawPrisma.aiFallbackDecision.findFirst({ where: { messageId: id } });
    const outbound = await rawPrisma.outboundMessage.findMany({ where: { projectId: A, relatedMessageId: id } });
    const notifications = await rawPrisma.notification.count({ where: { projectId: A, relatedMessageId: id } }).catch(() => 0);
    return { id, decision, outbound, client, notifications };
  }
  const silent = (r: Awaited<ReturnType<typeof ask>>) => {
    expect(r.client.requests).toHaveLength(0);
    expect(r.decision).toBeNull();
    expect(r.outbound).toHaveLength(0);
    expect(r.notifications).toBe(0);
  };
  async function customer(opts: { dues?: boolean } = {}) {
    const phone = phoneFor();
    await makeClient(A, `P${phone.slice(-6)}`, phone, { service: "Home 20 Mbps", dues: opts.dues === false ? [] : [{ amount: "700.00", currency: "BDT" }] });
    return phone;
  }

  it("a verified customer's account question is answered from their own record, and really goes out through the queue", async () => {
    const phone = await customer();
    const r = await ask(phone, "what is my due?");
    expect(r.client.requests).toHaveLength(1);
    expect(r.client.requests[0]!.userPrompt).toMatch(/Your outstanding dues \(client/);
    expect(r.client.requests[0]!.systemPrompt).toMatch(/CUSTOMER ACCOUNT/);
    expect(r.decision).toMatchObject({ outcome: "AI_REPLIED", groupId: null });
    expect(r.outbound).toHaveLength(1);
    expect(r.outbound[0]).toMatchObject({ actionType: "AUTO_REPLY", chatId: `${phone}@c.us`, status: "PENDING", body: "Your due is BDT 700.00." });

    const provider = new MockProvider();
    await rawPrisma.outboundMessage.update({ where: { id: r.outbound[0]!.id }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    for (let i = 0; i < 10; i++) {
      const row = await rawPrisma.outboundMessage.findUniqueOrThrow({ where: { id: r.outbound[0]!.id } });
      if (row.status !== "PENDING") break;
      if (!(await processOutboundOne(provider))) break;
    }
    expect((await rawPrisma.outboundMessage.findUniqueOrThrow({ where: { id: r.outbound[0]!.id } })).status).toBe("SENT");
    expect(provider.sentMessages).toContainEqual({ chatId: `${phone}@c.us`, body: "Your due is BDT 700.00." });
  });

  it("with its switch off nothing happens at all, whatever the other two switches say", async () => {
    silent(await ask(await customer(), "what is my due?", { settings: { clientAccountAutoReply: false } }));
  });

  it("needs the account switch too", async () => {
    silent(await ask(await customer(), "what is my due?", { settings: { clientAccountAnswers: false } }));
  });

  it("an ordinary personal message stays with the team: no AI call, no decision, no alert, no reply", async () => {
    silent(await ask(await customer(), "hello, my router has a red light"));
    silent(await ask(await customer(), "ok thanks"));
  });

  it("a request to pay, change or disconnect stays with the team too, silently", async () => {
    silent(await ask(await customer(), "I want to pay my bill"));
    silent(await ask(await customer(), "please disconnect my line"));
  });

  it("nobody but one verified client: an unknown number, a LID, a number two clients share", async () => {
    silent(await ask(phoneFor(), "what is my due?"));
    const lid = `1616${run}00000${++seq}`;
    silent(await ask(lid, "what is my due?", { chatId: `${lid}@lid`, senderJid: `${lid}@lid` }));
    silent(await ask(P_SHARED, "what is my due?"));
  });

  it("stays quiet after a person replied in the chat, from the dashboard or the business phone, and AI's own reply does not count", async () => {
    const dashboard = await customer();
    await rawPrisma.outboundMessage.create({ data: { projectId: A, accountId: accountA, chatId: `${dashboard}@c.us`, toPhone: dashboard, body: "a person", actionType: "MANUAL_REPLY", status: "SENT", idempotencyKey: randomUUID() } });
    silent(await ask(dashboard, "what is my due?"));

    // A dashboard send that failed never reached the customer, so it is no reply.
    const failedSend = await customer();
    await rawPrisma.outboundMessage.create({ data: { projectId: A, accountId: accountA, chatId: `${failedSend}@c.us`, toPhone: failedSend, body: "a person", actionType: "MANUAL_REPLY", status: "FAILED", idempotencyKey: randomUUID() } });
    expect((await ask(failedSend, "what is my due?")).decision).toMatchObject({ outcome: "AI_REPLIED" });

    const businessPhone = await customer();
    await makeOutgoing(businessPhone, `business-${randomUUID()}`);
    silent(await ask(businessPhone, "what is my due?"));

    const longAgo = await customer();
    await makeOutgoing(longAgo, `old-${randomUUID()}`, new Date(Date.now() - 45 * 60_000));
    expect((await ask(longAgo, "what is my due?")).decision).toMatchObject({ outcome: "AI_REPLIED" });

    const aiBefore = await customer();
    const providerMessageId = `ai-${randomUUID()}`;
    await rawPrisma.outboundMessage.create({ data: { projectId: A, accountId: accountA, chatId: `${aiBefore}@c.us`, toPhone: aiBefore, body: "earlier answer", actionType: "AUTO_REPLY", status: "SENT", idempotencyKey: randomUUID(), providerMessageId } });
    await makeOutgoing(aiBefore, providerMessageId);
    expect((await ask(aiBefore, "when does my package expire?")).decision).toMatchObject({ outcome: "AI_REPLIED" });
  });

  it("the kill switch and MANUAL_ONLY stop it", async () => {
    silent(await ask(await customer(), "what is my due?", { automation: { automationEnabled: false } }));
    silent(await ask(await customer(), "what is my due?", { automation: { mode: "MANUAL_ONLY" } }));
  });

  it("the AI engine and auto response switches stop it", async () => {
    silent(await ask(await customer(), "what is my due?", { settings: { aiEngineEnabled: false } }));
    silent(await ask(await customer(), "what is my due?", { settings: { autoResponseEnabled: false } }));
  });

  it("an amount it was not given is handed over, never sent; a low-confidence answer too, with no holding reply", async () => {
    const wrong = await ask(await customer(), "what is my due?", { reply: "Your due is BDT 9,999.00." });
    expect(wrong.decision).toMatchObject({ outcome: "HUMAN_FALLBACK", reason: "UNGROUNDED_PRICE" });
    expect(wrong.outbound).toHaveLength(0);
    const unsure = await ask(await customer(), "what is my due?", { confidence: 10, settings: { unableToUnderstandReplyEnabled: true } });
    expect(unsure.decision).toMatchObject({ outcome: "HUMAN_FALLBACK" });
    expect(unsure.outbound).toHaveLength(0);
  });

  it("never drafts a rule from it", async () => {
    const r = await ask(await customer(), "what is my due?", { settings: { aiRuleGenerationEnabled: true, aiRuleGenerationMinConfidence: 50 } });
    expect(r.decision).toMatchObject({ outcome: "AI_REPLIED" });
    expect(await rawPrisma.ruleProposal.count({ where: { projectId: A, sourceMessageId: r.id } })).toBe(0);
  });

  it("a group's answer is unchanged: the switch never brings account details into a group", async () => {
    await aiOn();
    const g = await inA(() => findClientAccountGrounding({ text: "what is my due?", switches: { ...ON, clientAccountAutoReply: true }, customer: whatsapp(accountA, groupChatA, msg.group!, true) }));
    expect(g.status).toBe("GROUP");
    expect(g.snippets).toEqual([]);
  });
});

describe("hand-over", () => {
  async function aiSettingsOn() {
    await rawPrisma.aiSettings.update({
      where: { projectId: A },
      data: { aiEngineEnabled: true, autoResponseEnabled: true, aiResponseMode: "KNOWLEDGE_PLUS_GENERAL", autoResponseConfidenceThreshold: 90, generalAnswerMinConfidence: 90, clientAccountAnswers: true, clientDueAnswers: true },
    });
    return rawPrisma.automationSettings.update({
      where: { projectId: A },
      data: { automationEnabled: true, mode: "SAFE_AUTO_REPLY", rateLimitingEnabled: false, defaultReplyDelayMinMs: 0, defaultReplyDelayMaxMs: 0, teamsWebhookUrl: "https://example.invalid/webhook" },
    });
  }

  async function run(body: string, reply: string) {
    const automationSettings = await aiSettingsOn();
    const group = await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: groupA } });
    const id = await makeMessage(A, accountA, groupChatA, `${P_ONE}@c.us`, groupA, body);
    const client = new MockAiClient();
    client.nextText = `INTENT: dues\nSCOPE: GENERAL\nCONFIDENCE: 97\nSHOULD_REPLY: YES\nRESPONSE: ${reply}`;
    await inA(() =>
      runAiFallback({
        message: { id, body },
        accountId: accountA,
        chatId: groupChatA,
        toPhone: P_ONE,
        group: { id: group.id, name: group.name, isMonitored: true, aiAutomationEnabled: true, aiAutomationExcluded: false, aiSuppressedUntil: null, testModeEnabled: true },
        automationSettings,
        clientOverride: client,
      }),
    );
    const decision = await rawPrisma.aiFallbackDecision.findFirstOrThrow({ where: { messageId: id } });
    return { decision, client };
  }

  it("a reply naming an amount it was not given is handed over, never sent", async () => {
    const { decision, client } = await run("what is my due?", "Your due is ৳1,500.");
    expect(decision.outcome).toBe("HUMAN_FALLBACK");
    expect(decision.reason).toBe("UNGROUNDED_PRICE");
    expect(await rawPrisma.outboundMessage.count({ where: { projectId: A, relatedMessageId: decision.messageId } })).toBe(0);
    // In a group the prompt carries the account rules and no account entry.
    expect(client.requests[0]!.systemPrompt).toMatch(/This is a group conversation/);
    expect(client.requests[0]!.userPrompt).not.toMatch(/Your account \(client/);
  });

  it("a request to pay goes straight to a person, before any AI call", async () => {
    const { decision, client } = await run("I want to pay my bill", "unused");
    expect(decision.reason).toBe("ACCOUNT_REQUEST");
    expect(client.requests).toHaveLength(0);
  });

  it("an answer built from one customer's order never becomes a rule draft: a rule answers everybody", async () => {
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: A, key: "ORDERS" } }, create: { projectId: A, key: "ORDERS", enabled: true }, update: { enabled: true } });
    resetProjectFeatureCacheForTests();
    await rawPrisma.commerceOrder.create({
      data: { projectId: A, number: `ORD-${tag}`, customerName: "Rina", customerPhone: P_ONE, currency: "BDT", subtotalMinor: 150000n, totalMinor: 150000n, createdByUsername: "test", status: "CONFIRMED" },
    });
    await aiSettingsOn();
    await rawPrisma.aiSettings.update({ where: { projectId: A }, data: { commerceOrderAnswers: true, aiRuleGenerationEnabled: true, aiRuleGenerationMinConfidence: 50 } });
    const { decision } = await run("where is my order?", "Your order is confirmed.");
    expect(decision.outcome).toBe("AI_REPLIED");
    expect(await rawPrisma.ruleProposal.count({ where: { projectId: A } })).toBe(0);
  });
});
