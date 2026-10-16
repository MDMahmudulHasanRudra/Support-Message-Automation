import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * WhatsApp Chat v2 (CHAT_UI_V2.md) against a real database — the data and command paths, not the
 * look: paging stored history without repeating or skipping messages that share a timestamp; jumping
 * to an older message; search; quoted replies, tags and reactions refused unless the target, the
 * people and the emoji are valid for THIS conversation of THIS account; nothing new possible while
 * the CHAT_UI_V2 feature is off; and nothing of another project, account or chat reachable through a
 * cursor, a message id or a group id.
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
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const chat = await import("@/server/actions/chat");
const thread = await import("@/server/actions/chatThread");
const inbox = await import("@/server/chatInbox");
const v2 = await import("@/server/chatThreadV2");

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

async function setV2(enabled: boolean) {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId: ORIGINAL_PROJECT_ID, key: "CHAT_UI_V2" } },
    create: { projectId: ORIGINAL_PROJECT_ID, key: "CHAT_UI_V2", enabled },
    update: { enabled },
  });
  forgetProjectFeatureStates();
}

const BASE = Date.UTC(2026, 9, 1, 6, 0, 0);
let seq = 0;
async function groupMessage(accountId: string, group: { id: string; whatsappGroupId: string }, at: number, body: string, extra: { senderJid?: string; senderName?: string; direction?: "INCOMING" | "OUTGOING" } = {}) {
  return rawPrisma.message.create({
    data: {
      ...pid,
      accountId,
      groupId: group.id,
      chatId: group.whatsappGroupId,
      whatsappMessageId: `v2-${tag}-${seq++}`,
      senderPhone: (extra.senderJid ?? `88019${digits}9@c.us`).split("@")[0]!,
      senderJid: extra.senderJid ?? `88019${digits}9@c.us`,
      senderName: extra.senderName ?? null,
      direction: extra.direction ?? "INCOMING",
      body,
      normalizedBody: body.toLowerCase(),
      timestampWa: new Date(at),
      processingStatus: "PROCESSED",
    },
    select: { id: true, timestampWa: true },
  });
}
const form = (body: string, extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set("body", body);
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
};

const A = { id: "" };
const B = { id: "" };
let G: { id: string; whatsappGroupId: string };
let OTHER: { id: string; whatsappGroupId: string };
let BIZ_GROUP: { id: string; whatsappGroupId: string };
let BIZ_MESSAGE = "";
const all: string[] = [];
const sessions = {} as Record<"agent" | "viewer", Session>;
const PHONE_SENDER = `88017${digits}3@c.us`;
const LID_SENDER = `1${digits}00000003@lid`;
let bizProjectId = "";

beforeAll(async () => {
  sessions.agent = await user("V2Agent", await role("V2 reply", ["messages.view", "messages.reply"]));
  sessions.viewer = await user("V2Viewer", await role("V2 view", ["messages.view"]));
  A.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `V2 A ${tag}`, status: "CONNECTED" } })).id;
  B.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `V2 B ${tag}`, status: "CONNECTED" } })).id;
  ids.accounts.push(A.id, B.id);
  G = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: A.id, whatsappGroupId: `v2-${tag}@g.us`, name: `V2 group ${tag}`, isActive: true }, select: { id: true, whatsappGroupId: true } });
  OTHER = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: A.id, whatsappGroupId: `v2-${tag}-other@g.us`, name: `V2 other ${tag}`, isActive: true }, select: { id: true, whatsappGroupId: true } });

  // 150 messages, and ten of them sharing ONE second exactly where the 80-message window ends — the
  // tie a timestamp-only cursor repeats or skips.
  for (let i = 0; i < 150; i++) {
    const at = i >= 65 && i < 75 ? BASE + 65_000 : BASE + i * 1000;
    const m = await groupMessage(A.id, G, at, i === 3 ? `the router password is blinking ${tag}` : `line ${i}`);
    all.push(m.id);
  }
  await groupMessage(A.id, G, BASE + 200_000, `from a phone ${tag}`, { senderJid: PHONE_SENDER, senderName: "Karim" });
  await groupMessage(A.id, G, BASE + 201_000, `from a private id ${tag}`, { senderJid: LID_SENDER, senderName: "Hidden" });
  await groupMessage(A.id, OTHER, BASE, "another group");

  const creator = sessions.agent.userId;
  const biz = (await rawPrisma.project.findFirst({ where: { slug: "bizify" } })) ?? (await createProjectWithDefaults({ name: "Bizify", slug: "bizify", status: "ACTIVE", creatorUserId: creator }, rawPrisma));
  bizProjectId = biz.id;
  const bizAccount = await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `V2 Biz ${tag}`, status: "CONNECTED" } });
  ids.accounts.push(bizAccount.id);
  BIZ_GROUP = await rawPrisma.whatsAppGroup.create({ data: { projectId: biz.id, accountId: bizAccount.id, whatsappGroupId: `v2-${tag}-biz@g.us`, name: "Biz", isActive: true }, select: { id: true, whatsappGroupId: true } });
  BIZ_MESSAGE = (
    await rawPrisma.message.create({
      data: { projectId: biz.id, accountId: bizAccount.id, groupId: BIZ_GROUP.id, chatId: BIZ_GROUP.whatsappGroupId, whatsappMessageId: `v2-${tag}-biz`, senderPhone: "1", direction: "INCOMING", body: "biz secret", normalizedBody: "biz secret", timestampWa: new Date(BASE), processingStatus: "PROCESSED" },
      select: { id: true },
    })
  ).id;
});

beforeEach(() => {
  current = sessions.agent;
});

afterAll(async () => {
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID, key: "CHAT_UI_V2" } });
  forgetProjectFeatureStates();
  await rawPrisma.workerCommand.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.outboundMessage.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.message.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
});

const ref = () => ({ accountId: A.id, groupId: G.id });

describe("while CHAT_UI_V2 is off (every project's default)", () => {
  it("refuses the v2 reads and any reply that quotes or tags, and leaves a plain reply exactly as before", async () => {
    await setV2(false);
    expect(await inIsp(() => thread.loadOlderChatMessages(ref(), "1.x"))).toEqual({ error: expect.stringMatching(/not switched on/) });
    const quoted = await inIsp(() => chat.sendChatMessage(A.id, G.id, {}, form(`quote while off ${tag}`, { replyTo: all[149]! })));
    expect(quoted.error).toMatch(/new conversation view/);
    expect(await rawPrisma.outboundMessage.count({ where: { body: `quote while off ${tag}` } })).toBe(0);
    const plain = await inIsp(() => chat.sendChatMessage(A.id, G.id, {}, form(`plain while off ${tag}`)));
    expect(plain).toEqual({ sentAt: expect.any(Number) });
    expect(await rawPrisma.outboundMessage.findFirstOrThrow({ where: { body: `plain while off ${tag}` } })).toMatchObject({ replyToMessageId: null, mentions: [] });
  });
});

describe("with CHAT_UI_V2 on", () => {
  beforeAll(() => setV2(true));

  it("pages the whole stored history: every message exactly once, oldest first, across a timestamp tie", async () => {
    const live = (await inIsp(() => inbox.getChatThread(G.id)))!;
    expect(live.hasMore).toBe(true);
    const seen = live.entries.filter((e) => e.kind === "INCOMING").map((e) => e.id);
    let cursor = v2.cursorBefore(live.entries);
    let pages = 0;
    while (cursor) {
      const page = await inIsp(() => thread.loadOlderChatMessages(ref(), cursor!));
      if ("error" in page) throw new Error(page.error);
      seen.unshift(...page.entries.map((e) => e.id));
      cursor = page.cursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    }
    const stored = await rawPrisma.message.findMany({ where: { groupId: G.id }, orderBy: [{ timestampWa: "asc" }, { id: "asc" }], select: { id: true } });
    expect(seen).toEqual(stored.map((m) => m.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("jumps to an old message in one request, and refuses a message of another conversation", async () => {
    const live = (await inIsp(() => inbox.getChatThread(G.id)))!;
    const target = all[2]!;
    const page = await inIsp(() => thread.loadOlderChatMessages(ref(), v2.cursorBefore(live.entries)!, target));
    if ("error" in page) throw new Error(page.error);
    expect(page.entries.map((e) => e.id)).toContain(target);
    const foreign = await rawPrisma.message.findFirstOrThrow({ where: { groupId: OTHER.id }, select: { id: true } });
    expect(await inIsp(() => thread.loadOlderChatMessages(ref(), v2.cursorBefore(live.entries)!, foreign.id))).toEqual({ error: expect.stringMatching(/not in this conversation/) });
  });

  it("searches only this conversation", async () => {
    const result = await inIsp(() => thread.searchChatThread(ref(), "router password"));
    expect("hits" in result && result.hits.map((h) => h.id)).toEqual([all[3]]);
    const elsewhere = await inIsp(() => thread.searchChatThread({ accountId: A.id, groupId: OTHER.id }, "router password"));
    expect("hits" in elsewhere && elsewhere.hits).toEqual([]);
  });

  it("never reaches another account's or another project's conversation, whatever ids are sent", async () => {
    const live = (await inIsp(() => inbox.getChatThread(G.id)))!;
    const cursor = v2.cursorBefore(live.entries)!;
    // A's group named under B.
    expect(await inIsp(() => thread.loadOlderChatMessages({ accountId: B.id, groupId: G.id }, cursor))).toEqual({ error: expect.stringMatching(/could not be found/) });
    // Bizify's group from inside ISP Digital.
    expect(await inIsp(() => thread.loadOlderChatMessages({ accountId: A.id, groupId: BIZ_GROUP.id }, cursor))).toEqual({ error: expect.stringMatching(/could not be found/) });
    expect(await inIsp(() => thread.searchChatThread({ accountId: A.id, groupId: BIZ_GROUP.id }, "biz secret"))).toEqual({ error: expect.stringMatching(/could not be found/) });
    // Bizify's message as a reply target, and as a reaction target.
    const r = await inIsp(() => chat.sendChatMessage(A.id, G.id, {}, form(`cross-project quote ${tag}`, { replyTo: BIZ_MESSAGE })));
    expect(r.error).toMatch(/not in this conversation/);
    expect((await inIsp(() => chat.reactToChatMessage(BIZ_MESSAGE, "👍"))).error).toMatch(/could not be found/);
    expect(await rawPrisma.workerCommand.count({ where: { projectId: bizProjectId, type: "REACT_TO_MESSAGE", payload: { path: ["messageId"], equals: BIZ_MESSAGE } } })).toBe(0);
    // A forged cursor is refused, never interpreted.
    expect(await inIsp(() => thread.loadOlderChatMessages(ref(), "0.' OR 1=1 --"))).toEqual({ error: expect.stringMatching(/not valid/) });
  });

  it("queues a quoted reply with the target recorded, and refuses a target from another conversation", async () => {
    const ok = await inIsp(() => chat.sendChatMessage(A.id, G.id, {}, form(`quoted ${tag}`, { replyTo: all[149]! })));
    expect(ok).toEqual({ sentAt: expect.any(Number) });
    expect(await rawPrisma.outboundMessage.findFirstOrThrow({ where: { body: `quoted ${tag}` } })).toMatchObject({ replyToMessageId: all[149], actionType: "MANUAL_REPLY", accountId: A.id });
    const foreign = await rawPrisma.message.findFirstOrThrow({ where: { groupId: OTHER.id }, select: { id: true } });
    expect((await inIsp(() => chat.sendChatMessage(A.id, G.id, {}, form(`bad quote ${tag}`, { replyTo: foreign.id })))).error).toMatch(/not in this conversation/);
    // The same words quoting another message are a different message, not a double submit.
    await inIsp(() => chat.sendChatMessage(A.id, G.id, {}, form(`quoted ${tag}`, { replyTo: all[148]! })));
    expect(await rawPrisma.outboundMessage.count({ where: { body: `quoted ${tag}` } })).toBe(2);
    // The queued bubble shows what it quotes.
    const live = (await inIsp(() => inbox.getChatThread(G.id)))!;
    expect(live.entries.find((e) => e.kind === "QUEUED" && e.body === `quoted ${tag}`)?.quoted?.id).toBeTruthy();
  });

  it("offers and accepts tags only for phone-number ids that wrote here; refuses a private id, a stranger and a tag with a quote", async () => {
    const candidates = await inIsp(() => thread.getChatMentionCandidates(ref()));
    if ("error" in candidates) throw new Error(candidates.error);
    expect(candidates.candidates.map((c) => c.jid)).toContain(PHONE_SENDER);
    expect(candidates.candidates.map((c) => c.jid).some((j) => j.endsWith("@lid"))).toBe(false);
    expect(candidates.unmentionable).toBeGreaterThanOrEqual(1);

    const number = PHONE_SENDER.split("@")[0]!;
    const ok = await inIsp(() => chat.sendChatMessage(A.id, G.id, {}, form(`@${number} please check ${tag}`, { mentions: JSON.stringify([PHONE_SENDER]) })));
    expect(ok).toEqual({ sentAt: expect.any(Number) });
    expect(await rawPrisma.outboundMessage.findFirstOrThrow({ where: { body: `@${number} please check ${tag}` } })).toMatchObject({ mentions: [PHONE_SENDER] });

    const lid = await inIsp(() => chat.sendChatMessage(A.id, G.id, {}, form(`@${LID_SENDER.split("@")[0]} hi ${tag}`, { mentions: JSON.stringify([LID_SENDER]) })));
    expect(lid.error).toMatch(/phone number/);
    const stranger = await inIsp(() => chat.sendChatMessage(A.id, G.id, {}, form(`@8801999999999 hi ${tag}`, { mentions: JSON.stringify(["8801999999999@c.us"]) })));
    expect(stranger.error).toMatch(/has not written in this group/);
    const both = await inIsp(() => chat.sendChatMessage(A.id, G.id, {}, form(`@${number} both ${tag}`, { mentions: JSON.stringify([PHONE_SENDER]), replyTo: all[149]! })));
    expect(both.error).toMatch(/cannot also tag/);
    expect(await rawPrisma.outboundMessage.count({ where: { body: { in: [`@${LID_SENDER.split("@")[0]} hi ${tag}`, `@8801999999999 hi ${tag}`, `@${number} both ${tag}`] } } })).toBe(0);
  });

  it("queues a reaction once, shows it as sent only when the worker confirmed it, and refuses a non-emoji", async () => {
    const target = all[149]!;
    expect((await inIsp(() => chat.reactToChatMessage(target, "ok"))).error).toMatch(/one emoji/);
    expect((await inIsp(() => chat.reactToChatMessage(target, "👍👍"))).error).toMatch(/one emoji/);
    expect(await inIsp(() => chat.reactToChatMessage(target, "👍"))).toEqual({});
    expect(await inIsp(() => chat.reactToChatMessage(target, "👍"))).toEqual({});
    const commands = await rawPrisma.workerCommand.findMany({ where: { accountId: A.id, type: "REACT_TO_MESSAGE" } });
    expect(commands).toHaveLength(1);
    expect(commands[0]!.payload).toMatchObject({ messageId: target, emoji: "👍", requestedById: sessions.agent.userId });

    let entry = (await inIsp(async () => v2.attachOwnReactions(A.id, (await inbox.getChatThread(G.id))!.entries))).find((e) => e.id === target)!;
    expect(entry.ownReaction).toMatchObject({ confirmed: null, pending: { emoji: "👍" } });

    await rawPrisma.workerCommand.update({ where: { id: commands[0]!.id }, data: { status: "DONE", result: { success: true, error: null } } });
    entry = (await inIsp(async () => v2.attachOwnReactions(A.id, (await inbox.getChatThread(G.id))!.entries))).find((e) => e.id === target)!;
    expect(entry.ownReaction).toMatchObject({ confirmed: { emoji: "👍" }, pending: null, failed: null });
  });

  it("a read-only role can page and search but not reply, tag or react", async () => {
    current = sessions.viewer;
    const live = (await inIsp(() => inbox.getChatThread(G.id)))!;
    expect("entries" in (await inIsp(() => thread.loadOlderChatMessages(ref(), v2.cursorBefore(live.entries)!)))).toBe(true);
    expect((await inIsp(() => chat.sendChatMessage(A.id, G.id, {}, form(`viewer ${tag}`, { replyTo: all[149]! })))).error).toBeTruthy();
    expect((await inIsp(() => chat.reactToChatMessage(all[149]!, "🙏"))).error).toBeTruthy();
    expect(await rawPrisma.outboundMessage.count({ where: { body: `viewer ${tag}` } })).toBe(0);
  });
});
