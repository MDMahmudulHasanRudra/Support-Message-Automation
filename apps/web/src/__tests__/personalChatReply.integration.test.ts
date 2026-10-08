import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";
import { personalConversationKey } from "@/lib/chatConversationType";

/**
 * Replying to a PERSONAL (one-to-one) chat from WhatsApp Chat (`sendPersonalChatMessage`). What must
 * hold: it queues exactly one MANUAL_REPLY on the selected account, addressed to the chat, recorded
 * against the person who pressed send; it only ever continues a chat that account already has —
 * never a first message, never another account's chat, never a group, broadcast or channel; and
 * the queued reply counts as an answer, so the chat leaves Waiting at once.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const digits = String(Date.now()).slice(-7);
const ids = { roles: [] as string[], users: [] as string[], accounts: [] as string[] };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const chat = await import("@/server/actions/chat");
const search = await import("@/server/actions/chatSearch");
const inbox = await import("@/server/chatInbox");

const isp = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(isp, fn);
const pid = { projectId: ORIGINAL_PROJECT_ID };

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
async function user(name: string, roleId: string): Promise<Session> {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  await rawPrisma.projectAccess.create({ data: { projectId: ORIGINAL_PROJECT_ID, userId: u.id } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}

let n = 0;
async function msg(accountId: string, chatId: string, minutesAgo: number, direction: "INCOMING" | "OUTGOING", body: string, senderName: string | null = null) {
  await rawPrisma.message.create({
    data: {
      ...pid,
      accountId,
      chatId,
      groupId: null,
      whatsappMessageId: `pcr-${tag}-${n++}`,
      senderPhone: chatId.split("@")[0]!,
      senderName,
      direction,
      body,
      normalizedBody: body.toLowerCase(),
      timestampWa: new Date(Date.now() - minutesAgo * 60_000),
      processingStatus: "PROCESSED",
    },
  });
}
const form = (body: string) => {
  const f = new FormData();
  f.set("body", body);
  return f;
};

const A = { id: "" };
const B = { id: "" };
const OFFLINE = { id: "" };
const CUSTOMER = `88017${digits}1@c.us`;
const HIDDEN = `1${digits}0000001@lid`;
const ONLY_ON_B = `88017${digits}2@c.us`;
const sessions = {} as Record<"agent" | "viewer", Session>;

beforeAll(async () => {
  sessions.agent = await user("Agent", await role("PCR reply", ["messages.view", "messages.reply"]));
  sessions.viewer = await user("Viewer", await role("PCR view", ["messages.view"]));
  A.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `PCR Primary ${tag}`, status: "CONNECTED" } })).id;
  B.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `PCR Second ${tag}`, status: "CONNECTED" } })).id;
  OFFLINE.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `PCR Offline ${tag}`, status: "DISCONNECTED" } })).id;
  ids.accounts.push(A.id, B.id, OFFLINE.id);

  await msg(A.id, CUSTOMER, 10, "INCOMING", "I can contact you afterwards.", `Tasharok ${tag}`);
  await msg(A.id, HIDDEN, 20, "INCOMING", "hello?");
  await msg(B.id, ONLY_ON_B, 5, "INCOMING", "only B knows me");
  await msg(OFFLINE.id, CUSTOMER, 5, "INCOMING", "offline number");
});

beforeEach(() => {
  current = sessions.agent;
});

afterAll(async () => {
  await rawPrisma.outboundMessage.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.message.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
});

describe("replying to a personal chat", () => {
  it("queues one MANUAL_REPLY on the selected account, to the chat, by the person who pressed send", async () => {
    // Waiting before the reply: the customer wrote last.
    expect((await inIsp(() => search.listConversationView(A.id, { kind: "waiting" }, "personal"))).map((c) => c.id)).toContain(personalConversationKey(CUSTOMER));

    const result = await inIsp(() => chat.sendPersonalChatMessage(A.id, CUSTOMER, {}, form(`Ok brother ${tag}`)));
    expect(result).toEqual({ sentAt: expect.any(Number) });
    const row = await rawPrisma.outboundMessage.findFirstOrThrow({ where: { body: `Ok brother ${tag}` } });
    expect(row).toMatchObject({
      accountId: A.id,
      chatId: CUSTOMER,
      toPhone: CUSTOMER,
      actionType: "MANUAL_REPLY",
      status: "PENDING",
      groupId: null,
      groupNameSnapshot: `Tasharok ${tag}`,
      createdById: sessions.agent.userId,
    });
  });

  it("the queued reply shows in the thread and takes the chat out of Waiting at once", async () => {
    const thread = await inIsp(() => inbox.getPersonalChatThread(A.id, CUSTOMER));
    expect(thread!.entries.some((e) => e.kind === "QUEUED" && e.body === `Ok brother ${tag}` && e.sentBy?.name === "Agent")).toBe(true);
    expect((await inIsp(() => search.listConversationView(A.id, { kind: "waiting" }, "personal"))).map((c) => c.id)).not.toContain(personalConversationKey(CUSTOMER));
  });

  it("a double submit of the same text is one message", async () => {
    await inIsp(() => chat.sendPersonalChatMessage(A.id, HIDDEN, {}, form(`Twice ${tag}`)));
    await inIsp(() => chat.sendPersonalChatMessage(A.id, HIDDEN, {}, form(`Twice ${tag}`)));
    expect(await rawPrisma.outboundMessage.count({ where: { body: `Twice ${tag}` } })).toBe(1);
  });

  it("never starts a chat: a number this account has no conversation with is refused", async () => {
    const result = await inIsp(() => chat.sendPersonalChatMessage(A.id, ONLY_ON_B, {}, form(`Cold ${tag}`)));
    expect(result.error).toMatch(/no conversation with this number/);
    expect(await rawPrisma.outboundMessage.count({ where: { body: `Cold ${tag}` } })).toBe(0);
  });

  it("refuses a group, the status broadcast and a channel as a personal chat", async () => {
    for (const chatId of [`1203630${digits}@g.us`, "status@broadcast", `1203630${digits}@newsletter`]) {
      expect((await inIsp(() => chat.sendPersonalChatMessage(A.id, chatId, {}, form(`Not personal ${tag}`)))).error, chatId).toMatch(/not a personal chat/);
    }
    expect(await rawPrisma.outboundMessage.count({ where: { body: `Not personal ${tag}` } })).toBe(0);
  });

  it("refuses a read-only role, a disconnected account, and an empty message", async () => {
    current = sessions.viewer;
    expect((await inIsp(() => chat.sendPersonalChatMessage(A.id, CUSTOMER, {}, form(`Viewer ${tag}`)))).error).toBeTruthy();
    current = sessions.agent;
    expect((await inIsp(() => chat.sendPersonalChatMessage(OFFLINE.id, CUSTOMER, {}, form(`Offline ${tag}`)))).error).toMatch(/disconnected/);
    expect((await inIsp(() => chat.sendPersonalChatMessage(A.id, CUSTOMER, {}, form("   ")))).error).toMatch(/Type a message/);
    expect(await rawPrisma.outboundMessage.count({ where: { body: { in: [`Viewer ${tag}`, `Offline ${tag}`] } } })).toBe(0);
  });
});
