import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { getChatInbox } from "@/server/chatInbox";
import { PERSONAL_CHATS_ALWAYS_LISTED } from "@/lib/chatInboxLimits";

/**
 * Personal chats must not vanish from WhatsApp Chat's "All" list on a number in hundreds of busy
 * groups (18 Oct 2026 incident: "personal messages are not coming").
 *
 * "All" ranks groups and personal chats together by their newest message and renders the first
 * 300. On an account in ~1,900 groups the 300th most recent group can be minutes old, so a customer's
 * personal message from half an hour ago was simply not in the list — stored, counted on the Personal
 * chip, and invisible where the operator was looking. The most recent personal chats now always make
 * the list, in their place by recency.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let project: ActiveProject;
let accountId: string;
let creatorId: string;
const NOW = Date.now();
const personalChat = `8801${String(Date.now()).slice(-7)}11@c.us`;

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `pall_${tag}`, email: `pall_${tag}@example.test`, name: "P", passwordHash: "x" } })).id;
  const created = await createProjectWithDefaults({ name: `Personal ${tag}`, slug: `pall-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  project = { id: created.id, slug: created.slug, name: `Personal ${tag}`, status: "ACTIVE" };
  const pid = { projectId: project.id };
  accountId = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `busy ${tag}`, status: "CONNECTED" } })).id;

  // 320 groups, every one more recently active than the personal chat.
  const groups = Array.from({ length: 320 }, (_, i) => ({
    ...pid,
    id: `g-${tag}-${i}`,
    accountId,
    whatsappGroupId: `${tag}${i}@g.us`,
    name: `Group ${i}`,
  }));
  await rawPrisma.whatsAppGroup.createMany({ data: groups });
  await rawPrisma.message.createMany({
    data: groups.map((g, i) => ({
      ...pid,
      accountId,
      groupId: g.id,
      chatId: g.whatsappGroupId,
      whatsappMessageId: `wamid-${tag}-g${i}`,
      senderPhone: "8801711000333",
      direction: "INCOMING" as const,
      body: "x",
      normalizedBody: "x",
      timestampWa: new Date(NOW - (i + 1) * 60_000),
    })),
  });
  await rawPrisma.message.create({
    data: {
      ...pid,
      accountId,
      chatId: personalChat,
      whatsappMessageId: `wamid-${tag}-p`,
      senderPhone: personalChat.split("@")[0]!,
      direction: "INCOMING",
      body: "amar line kaj korche na",
      normalizedBody: "amar line kaj korche na",
      timestampWa: new Date(NOW - 400 * 60_000),
    },
  });
});

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const table of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = $1`, project.id).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: project.id } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

describe("All in WhatsApp Chat on a number in hundreds of busy groups", () => {
  it("still lists the most recent personal chats, in their place by recency", async () => {
    const { conversations, counts } = await runWithProject(project, () => getChatInbox(accountId));

    expect(counts.personal.total).toBe(1);
    const personal = conversations.filter((c) => c.kind === "PERSONAL");
    expect(personal.map((c) => c.chatId)).toEqual([personalChat]);
    // Older than every group, so it sits after them — never in front of newer conversations.
    expect(conversations.at(-1)!.chatId).toBe(personalChat);
    // The groups are still capped as before.
    expect(conversations.filter((c) => c.kind === "GROUP")).toHaveLength(300);
    expect(PERSONAL_CHATS_ALWAYS_LISTED).toBeGreaterThan(0);
  });
});
