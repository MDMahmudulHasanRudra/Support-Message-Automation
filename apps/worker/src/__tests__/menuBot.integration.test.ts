import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { DEFAULT_MENU_WORDING, MENU_BOT_VARIANT, type MenuTree } from "@support-automation/shared";
import { continueMenuOnWhatsApp, handleChannelMenu, startMenuOnWhatsApp, type WhatsAppMenuInput } from "../menuBot/menuBot.js";
import { isCooldownActive } from "../queue/cooldown.js";
import { withProject } from "../project/context.js";

/**
 * Menu bots in the message path (MENU_BOTS.md): silent unless switched on, one step per message, stopped by a person and
 * by the kill switch, quiet after a hand-over, and held to the same limits as any automatic reply.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let projectId: string;
let accountId: string;
let otherProject: string;
let n = 0;

const tree: MenuTree = {
  rootId: "root",
  nodes: {
    root: { id: "root", title: "Main", text: "Welcome", kind: "MENU", options: [{ label: "Prices", goTo: "price" }, { label: "Person", goTo: "human" }] },
    price: { id: "price", title: "Prices", text: "500 taka", kind: "ANSWER", options: [] },
    human: { id: "human", title: "Human", text: "Someone will reply", kind: "HANDOFF", options: [] },
  },
};

const inProject = <T>(fn: () => Promise<T>) => withProject(projectId, fn);

async function bot(status: "ACTIVE" | "DRAFT" | "PAUSED" = "ACTIVE", extra: Record<string, unknown> = {}) {
  await rawPrisma.menuBot.deleteMany({ where: { projectId } });
  return rawPrisma.menuBot.create({
    data: { projectId, name: `Bot ${tag}`, status, tree: tree as never, keywords: ["menu"], invalidText: DEFAULT_MENU_WORDING.invalidText, handoffText: DEFAULT_MENU_WORDING.handoffText, backLabel: "Back", homeLabel: "Home", ...extra },
  });
}
function chat() {
  n += 1;
  return `88017${String(10000000 + n)}@c.us`;
}
async function message(chatId: string, body: string, extra: Record<string, unknown> = {}) {
  n += 1;
  return rawPrisma.message.create({ data: { projectId, accountId, chatId, whatsappMessageId: `mb-${tag}-${n}`, senderPhone: chatId.replace(/\D/g, ""), body, normalizedBody: body, direction: "INCOMING", timestampWa: new Date(), ...extra } as never });
}
async function input(chatId: string, body: string): Promise<WhatsAppMenuInput> {
  const row = await message(chatId, body);
  const s = await rawPrisma.automationSettings.findFirstOrThrow({ where: { projectId } });
  return { messageId: row.id, accountId, chatId, senderPhone: chatId.replace(/\D/g, ""), senderJid: chatId, senderName: "Customer", body, isFirstMessage: false, group: null, settings: s, traceId: "t" };
}
const sent = (chatId: string) => rawPrisma.outboundMessage.findMany({ where: { projectId, chatId }, orderBy: { createdAt: "asc" } });
const start = (i: WhatsAppMenuInput) => inProject(() => startMenuOnWhatsApp(i));
const step = (i: WhatsAppMenuInput) => inProject(() => continueMenuOnWhatsApp(i));

beforeAll(async () => {
  const p = await createProjectWithDefaults({ name: `Menu ${tag}`, slug: `menu-${tag}`, status: "ACTIVE", creatorUserId: null }, rawPrisma);
  projectId = p.id;
  otherProject = (await createProjectWithDefaults({ name: `Other ${tag}`, slug: `menu-o-${tag}`, status: "ACTIVE", creatorUserId: null }, rawPrisma)).id;
  accountId = (await rawPrisma.whatsAppAccount.create({ data: { projectId, sessionId: `mb-${tag}`, label: "A", phoneNumber: "8801700000099" } as never })).id;
});

beforeEach(async () => {
  await rawPrisma.automationSettings.updateMany({ where: { projectId }, data: { automationEnabled: true, mode: "FULL_RULE_AUTOMATION" } as never });
  await bot();
});

afterAll(async () => {
  const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((t) => t.table_name);
  for (const id of [projectId, otherProject]) {
    for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, id).catch(() => undefined);
    await rawPrisma.project.deleteMany({ where: { id } });
  }
});

describe("when it answers", () => {
  it("a draft or paused bot does nothing", async () => {
    await bot("DRAFT");
    const c = chat();
    expect(await start(await input(c, "menu"))).toBe(false);
    await bot("PAUSED");
    expect(await start(await input(c, "menu"))).toBe(false);
    expect(await sent(c)).toHaveLength(0);
  });

  it("only the whole word starts it", async () => {
    const c = chat();
    expect(await start(await input(c, "what is on the menu today"))).toBe(false);
    expect(await start(await input(c, "Menu"))).toBe(true);
  });

  it("the replies go through the one queue and walk the menu", async () => {
    const c = chat();
    await start(await input(c, "menu"));
    expect(await step(await input(c, "1"))).toBe(true);
    const rows = await sent(c);
    expect(rows.map((r) => r.body)).toEqual(["Welcome\n\n1. Prices\n2. Person", "500 taka\n\n0. Back\n00. Home"]);
    expect(rows[0]).toMatchObject({ actionType: "AUTO_REPLY", status: "PENDING", ruleId: null });
    expect(rows[0]!.idempotencyKey.endsWith(`:${MENU_BOT_VARIANT}`)).toBe(true);
  });

  it("a replayed message does not move the menu twice or send twice", async () => {
    const c = chat();
    await start(await input(c, "menu"));
    const first = await input(c, "1");
    await step(first);
    await step(first);
    expect(await sent(c)).toHaveLength(2);
    expect(await rawPrisma.menuEvent.count({ where: { projectId, messageRef: first.messageId } })).toBe(1);
    expect((await rawPrisma.menuSession.findFirstOrThrow({ where: { projectId, chatId: c } })).path).toEqual(["root"]);
  });

  it("two messages arriving together open one session", async () => {
    const c = chat();
    const [a, b] = [await input(c, "menu"), await input(c, "menu")];
    await Promise.all([start(a), start(b)]);
    expect(await rawPrisma.menuSession.count({ where: { projectId, chatId: c, status: "ACTIVE" } })).toBe(1);
  });

  it("a menu step does not count as the AI having answered", async () => {
    const c = chat();
    await start(await input(c, "menu"));
    const phone = c.replace(/\D/g, "");
    expect(await inProject(() => isCooldownActive({ accountId, toPhone: phone, ruleId: null, cooldownSeconds: 600 }))).toBe(false);
  });
});

describe("what stops it", () => {
  it("the kill switch", async () => {
    await rawPrisma.automationSettings.updateMany({ where: { projectId }, data: { automationEnabled: false } });
    const c = chat();
    expect(await start(await input(c, "menu"))).toBe(false);
    expect(await sent(c)).toHaveLength(0);
  });

  it("manual-only mode, inside a running menu too", async () => {
    const c = chat();
    await start(await input(c, "menu"));
    await rawPrisma.automationSettings.updateMany({ where: { projectId }, data: { mode: "MANUAL_ONLY" } as never });
    expect(await step(await input(c, "1"))).toBe(false);
    expect(await sent(c)).toHaveLength(1);
  });

  it("a person replying in the chat ends the menu", async () => {
    const c = chat();
    await start(await input(c, "menu"));
    await message(c, "Hello, this is Rakib from support", { direction: "OUTGOING", senderPhone: "8801700000099", timestampWa: new Date(Date.now() + 1000) });
    expect(await step(await input(c, "1"))).toBe(false);
    expect(await rawPrisma.menuSession.findFirstOrThrow({ where: { projectId, chatId: c } })).toMatchObject({ status: "ENDED" });
  });

  it("the bot's own message coming back does not count as a person", async () => {
    const c = chat();
    await start(await input(c, "menu"));
    await message(c, "Welcome\n\n1. Prices\n2. Person", { direction: "OUTGOING", senderPhone: "8801700000099", timestampWa: new Date(Date.now() + 1000) });
    expect(await step(await input(c, "1"))).toBe(true);
  });

  it("an expired session is forgotten", async () => {
    const c = chat();
    await start(await input(c, "menu"));
    await rawPrisma.menuSession.updateMany({ where: { projectId, chatId: c }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await step(await input(c, "1"))).toBe(false);
    expect(await rawPrisma.menuSession.findFirstOrThrow({ where: { projectId, chatId: c } })).toMatchObject({ status: "EXPIRED" });
  });

  it("after a hand-over it stays quiet", async () => {
    const c = chat();
    await start(await input(c, "menu"));
    await step(await input(c, "2"));
    expect(await rawPrisma.menuSession.findFirstOrThrow({ where: { projectId, chatId: c } })).toMatchObject({ status: "HANDED_OFF" });
    expect(await start(await input(c, "menu"))).toBe(false);
    expect(await sent(c)).toHaveLength(2);
  });

  it("a sentence is left to the rules and AI", async () => {
    const c = chat();
    await start(await input(c, "menu"));
    expect(await step(await input(c, "my bill is wrong this month"))).toBe(false);
    expect(await sent(c)).toHaveLength(1);
  });
});

describe("scope", () => {
  it("a group needs its own switch and must be monitored", async () => {
    const c = `1203${Date.now()}@g.us`;
    const group = await rawPrisma.whatsAppGroup.create({ data: { projectId, accountId, whatsappGroupId: c, name: "G", isMonitored: true, isActive: true } as never });
    const asGroup = async (monitored: boolean) => ({ ...(await input(c, "menu")), group: { id: group.id, name: "G", testModeEnabled: false, isMonitored: monitored } });
    expect(await start(await asGroup(true))).toBe(false);
    await bot("ACTIVE", { onWhatsAppGroups: true });
    expect(await start(await asGroup(false))).toBe(false);
    expect(await start(await asGroup(true))).toBe(true);
  });

  it("another project's bot never answers here", async () => {
    await bot("DRAFT");
    await rawPrisma.menuBot.create({ data: { projectId: otherProject, name: "Theirs", status: "ACTIVE", tree: tree as never, keywords: ["menu"], invalidText: "x", handoffText: "y", backLabel: "b", homeLabel: "h" } });
    const c = chat();
    expect(await start(await input(c, "menu"))).toBe(false);
  });
});

describe("channels", () => {
  async function conversation(kind: "DIRECT" | "GROUP" = "DIRECT") {
    n += 1;
    const connection = await rawPrisma.channelConnection.create({ data: { projectId, type: "TELEGRAM", name: `c${n}`, status: "CONNECTED", webhookKey: `mb-${tag}-${n}` } });
    const convo = await rawPrisma.channelConversation.create({ data: { projectId, connectionId: connection.id, type: "TELEGRAM", externalThreadId: `t${n}`, kind, lastInboundAt: new Date(), lastMessageAt: new Date() } as never });
    return { connection, convo };
  }
  async function customer(c: Awaited<ReturnType<typeof conversation>>, text: string, occurredAt = new Date()) {
    n += 1;
    return rawPrisma.channelMessage.create({ data: { projectId, conversationId: c.convo.id, connectionId: c.connection.id, type: "TELEGRAM", direction: "INBOUND", senderType: "CUSTOMER", text, occurredAt, externalMessageId: `e${n}` } });
  }
  const run = (c: Awaited<ReturnType<typeof conversation>>, m: { id: string; occurredAt: Date }, text: string) => inProject(() => handleChannelMenu({ messageId: m.id, conversationId: c.convo.id, text, occurredAt: m.occurredAt, isFirstMessage: false }));
  const replies = (c: Awaited<ReturnType<typeof conversation>>) => rawPrisma.channelMessage.findMany({ where: { conversationId: c.convo.id, direction: "OUTBOUND" } });

  it("needs the channel switched on for the bot, then answers and keeps AI off that message", async () => {
    const c = await conversation();
    let m = await customer(c, "menu");
    expect(await run(c, m, "menu")).toBe(false);
    await bot("ACTIVE", { channels: ["TELEGRAM"] });
    m = await customer(c, "menu");
    expect(await run(c, m, "menu")).toBe(true);
    expect(await replies(c)).toHaveLength(1);
    expect(await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ aiOutcome: "SKIPPED" });
  });

  it("never in a group chat, never for an old message", async () => {
    await bot("ACTIVE", { channels: ["TELEGRAM"] });
    const g = await conversation("GROUP");
    expect(await run(g, await customer(g, "menu"), "menu")).toBe(false);
    const c = await conversation();
    expect(await run(c, await customer(c, "menu", new Date(Date.now() - 20 * 60_000)), "menu")).toBe(false);
  });

  it("a person replying ends it", async () => {
    await bot("ACTIVE", { channels: ["TELEGRAM"] });
    const c = await conversation();
    await run(c, await customer(c, "menu"), "menu");
    n += 1;
    await rawPrisma.channelMessage.create({ data: { projectId, conversationId: c.convo.id, connectionId: c.connection.id, type: "TELEGRAM", direction: "OUTBOUND", senderType: "AGENT", text: "Hi, Rakib here", occurredAt: new Date(), deliveryStatus: "SENT", idempotencyKey: `a${n}` } });
    expect(await run(c, await customer(c, "1"), "1")).toBe(false);
  });
});

