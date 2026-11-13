import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AiClient } from "@support-automation/ai-client";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { collectContactsForProject } from "../contacts/contactCollector.js";
import { withProject } from "../project/context.js";

/**
 * The contact collector (CONTACTS.md): reads every conversation, past ones included, never a team member's message or
 * an unmonitored group; values are read without AI, the AI can only point at values really in the message, and a number
 * is stored once.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let project: { id: string; slug: string; name: string; status: "ACTIVE" };
let accountId: string;
let groupId: string;
let quietGroupId: string;
const GROUP_CHAT = `1203630${Date.now()}@g.us`;
const QUIET_CHAT = `1203631${Date.now()}@g.us`;
let n = 0;

const answer = (text: string): AiClient => ({ complete: vi.fn(async () => ({ text })) }) as unknown as AiClient;
const run = (aiClient: AiClient | null) => withProject(project.id, () => collectContactsForProject({ aiClient }));

async function incoming(chatId: string, body: string, extra: { groupId?: string | null; isFromTeamMember?: boolean; senderName?: string; createdAt?: Date } = {}) {
  n += 1;
  return rawPrisma.message.create({
    data: {
      projectId: project.id, accountId, chatId, groupId: extra.groupId ?? null, whatsappMessageId: `m-${tag}-${n}`, senderPhone: "880", senderName: extra.senderName ?? "Customer", body, normalizedBody: body,
      direction: "INCOMING", isFromTeamMember: extra.isFromTeamMember ?? false, timestampWa: new Date(), ...(extra.createdAt ? { createdAt: extra.createdAt } : {}),
    } as never,
  });
}
async function settings(data: { ai?: boolean; auto?: boolean }, fromStart = false) {
  const start = fromStart ? null : new Date(Date.now() - 1000);
  await rawPrisma.contactSettings.upsert({
    where: { projectId: project.id },
    create: { projectId: project.id, aiCollectionEnabled: data.ai ?? false, autoCreateFromChats: data.auto ?? false, collectionStartedAt: start, whatsappCursorAt: start, channelCursorAt: start },
    update: { aiCollectionEnabled: data.ai ?? false, autoCreateFromChats: data.auto ?? false, collectionStartedAt: start, whatsappCursorAt: start, whatsappCursorId: null, channelCursorAt: start },
  });
}
const contactsFor = (chatId: string) => rawPrisma.contact.findMany({ where: { projectId: project.id, conversations: { some: { chatId } } }, include: { identifiers: true } });

beforeAll(async () => {
  const p = await createProjectWithDefaults({ name: `Coll ${tag}`, slug: `coll-${tag}`, status: "ACTIVE", creatorUserId: null }, rawPrisma);
  project = { id: p.id, slug: p.slug, name: "Coll", status: "ACTIVE" };
  await rawPrisma.aiSettings.updateMany({ where: { projectId: p.id }, data: { aiEngineEnabled: true } });
  accountId = (await rawPrisma.whatsAppAccount.create({ data: { projectId: p.id, sessionId: `s-${tag}`, label: "A", phoneNumber: "8801700000000" } as never })).id;
  groupId = (await rawPrisma.whatsAppGroup.create({ data: { projectId: p.id, accountId, whatsappGroupId: GROUP_CHAT, name: "Client Group", isMonitored: true, isActive: true } as never })).id;
  quietGroupId = (await rawPrisma.whatsAppGroup.create({ data: { projectId: p.id, accountId, whatsappGroupId: QUIET_CHAT, name: "Friends", isMonitored: false, isActive: true } as never })).id;
});

beforeEach(async () => {
  await rawPrisma.contact.deleteMany({ where: { projectId: project.id } });
  await rawPrisma.message.deleteMany({ where: { projectId: project.id } });
});

afterAll(async () => {
  const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((t) => t.table_name);
  for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, project.id).catch(() => undefined);
  await rawPrisma.project.deleteMany({ where: { id: project.id } });
});

describe("what it reads", () => {
  it("does nothing while switched off", async () => {
    await rawPrisma.contactSettings.upsert({ where: { projectId: project.id }, create: { projectId: project.id, aiCollectionEnabled: false, autoCreateFromChats: false }, update: { aiCollectionEnabled: false, autoCreateFromChats: false } });
    await incoming("8801711000001@c.us", "my number 01711000001");
    const client = answer('{"keep":[1]}');
    await run(client);
    expect(client.complete).not.toHaveBeenCalled();
    expect(await rawPrisma.contact.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("reads past conversations too, from the oldest message", async () => {
    await settings({ auto: true }, true);
    await incoming("8801711000002@c.us", "hello", { createdAt: new Date(Date.now() - 30 * 86_400_000) });
    await run(null);
    expect(await contactsFor("8801711000002@c.us")).toHaveLength(1);
  });

  it("a project with no settings row collects by default", async () => {
    await rawPrisma.contactSettings.deleteMany({ where: { projectId: project.id } });
    await incoming("8801711000010@c.us", "email me at old.customer@example.com", { createdAt: new Date(Date.now() - 86_400_000) });
    await run(null);
    const [contact] = await contactsFor("8801711000010@c.us");
    expect(contact!.identifiers.map((i) => i.kind).sort()).toEqual(["EMAIL", "PHONE"]);
  });

  it("a team member's message is not a customer's", async () => {
    await settings({ ai: true, auto: true });
    await incoming("8801711000003@c.us", "call 01711000003", { isFromTeamMember: true });
    const client = answer('{"keep":[1]}');
    await run(client);
    expect(client.complete).not.toHaveBeenCalled();
    expect(await rawPrisma.contact.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("a group nobody monitors is left alone", async () => {
    await settings({ ai: true });
    await incoming(QUIET_CHAT, "my number 01711000004", { groupId: quietGroupId });
    const client = answer('{"keep":[1]}');
    await run(client);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("a message with no number costs no AI call", async () => {
    await settings({ ai: true });
    await incoming(GROUP_CHAT, "the internet is down again", { groupId });
    const client = answer('{"keep":[]}');
    await run(client);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("does not read the same message twice", async () => {
    await settings({ ai: true });
    await incoming(GROUP_CHAT, "my number 01711000005", { groupId });
    const client = answer('{"keep":[1]}');
    await run(client);
    await run(client);
    expect(client.complete).toHaveBeenCalledTimes(1);
  });
});

describe("what it saves", () => {
  it("a new personal chat becomes a contact with its proven number, without AI", async () => {
    await settings({ auto: true });
    const chat = "8801711000006@c.us";
    await incoming(chat, "hello", { senderName: "Tanvir" });
    await run(null);
    const [contact] = await contactsFor(chat);
    expect(contact).toMatchObject({ name: "Tanvir", source: "WHATSAPP", collectedByAi: false });
    expect(contact!.identifiers[0]).toMatchObject({ kind: "PHONE", normalized: "8801711000006", isWhatsApp: true });
  });

  it("a LID chat becomes a contact with no number", async () => {
    await settings({ auto: true });
    const chat = "190123456789012@lid";
    await incoming(chat, "hello", { senderName: "Hidden" });
    await run(null);
    const [contact] = await contactsFor(chat);
    expect(contact!.identifiers).toEqual([]);
  });

  it("a group is one contact and can hold several numbers, each once", async () => {
    await settings({ ai: true });
    await incoming(GROUP_CHAT, "office 01711000007", { groupId });
    await incoming(GROUP_CHAT, "and home 01811000008", { groupId });
    await incoming(GROUP_CHAT, "again office 01711000007", { groupId });
    await run(answer('{"keep":[1]}'));
    const contacts = await contactsFor(GROUP_CHAT);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.identifiers.map((i) => i.normalized).sort()).toEqual(["8801711000007", "8801811000008"]);
    expect(contacts[0]).toMatchObject({ name: "Client Group", collectedByAi: true });
  });

  it("the AI cannot add a number the message does not hold", async () => {
    await settings({ ai: true });
    await incoming(GROUP_CHAT, "my number 01711000009", { groupId });
    await run(answer('{"keep":[7],"phones":["01999999999"],"name":"Invented"}'));
    expect(await rawPrisma.contactIdentifier.count({ where: { projectId: project.id, normalized: "8801999999999" } })).toBe(0);
    expect(await contactsFor(GROUP_CHAT)).toHaveLength(0);
  });

  it("our own number is never offered to the AI", async () => {
    await settings({ ai: true });
    await incoming(GROUP_CHAT, "your number is 01700000000 right?", { groupId });
    const client = answer('{"keep":[1]}');
    await run(client);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("past the pass's AI budget it reads without AI, so the cursor never waits", async () => {
    await settings({ ai: true });
    for (let i = 0; i < 7; i++) await incoming(GROUP_CHAT, `number 0171100${String(100 + i)}1`, { groupId });
    const client = answer('{"keep":[1]}');
    await run(client);
    expect(client.complete).toHaveBeenCalledTimes(5);
    expect((await contactsFor(GROUP_CHAT))[0]!.identifiers).toHaveLength(7);
    await run(client);
    expect(client.complete).toHaveBeenCalledTimes(5);
  });

  it("without AI, values in the text are saved, and an @mention is never read as a number", async () => {
    await settings({ auto: true });
    await incoming(GROUP_CHAT, "@190123456789012 call 01711000011, mail Rahim@Example.com, page https://fb.com/rahim", { groupId });
    await run(null);
    const [contact] = await contactsFor(GROUP_CHAT);
    expect(contact!.identifiers.map((i) => `${i.kind}:${i.normalized}`).sort()).toEqual(expect.arrayContaining(["EMAIL:rahim@example.com", "PHONE:8801711000011"]));
    expect(contact!.identifiers.some((i) => i.kind === "FACEBOOK")).toBe(true);
    expect(contact!.identifiers.some((i) => i.normalized.includes("190123456789012"))).toBe(false);
  });
});
