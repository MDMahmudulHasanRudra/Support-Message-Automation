import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * WhatsApp Chat — one account at a time (WHATSAPP_CHAT_MULTI_ACCOUNT_AUDIT.md). Called as the
 * browser calls them, with only the request plumbing stubbed. What must hold:
 *   - the inbox, its counts, search, views, categories and threads belong to ONE account;
 *   - counts are real totals, not the 300 rendered;
 *   - a reply goes out from the selected account only, attributed to the session's user;
 *   - bulk actions never touch another account's rows;
 *   - another project's account is never reachable.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { roles: [] as string[], users: [] as string[], biz: "" };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const inbox = await import("@/server/chatInbox");
const chat = await import("@/server/actions/chat");
const org = await import("@/server/actions/chatOrganisation");
const search = await import("@/server/actions/chatSearch");

const isp = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(isp, fn);
const pid = { projectId: ORIGINAL_PROJECT_ID };
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);

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
async function message(accountId: string, group: { id: string; whatsappGroupId: string }, minutes: number, direction: "INCOMING" | "OUTGOING", body: string, whatsappMessageId = `cm-${tag}-${n++}`) {
  return rawPrisma.message.create({
    data: { ...pid, accountId, groupId: group.id, chatId: group.whatsappGroupId, whatsappMessageId, senderPhone: direction === "INCOMING" ? "8801999000111" : "us", direction, body, normalizedBody: body.toLowerCase(), timestampWa: ago(minutes), processingStatus: "PROCESSED" },
  });
}

const A = { id: "", gShared: { id: "", whatsappGroupId: "" }, gOld: { id: "", whatsappGroupId: "" } };
const B = { id: "", gShared: { id: "", whatsappGroupId: "" }, offline: "" };
const sessions = {} as Record<"rudra" | "hasan" | "viewer", Session>;
let categoryId = "";
const SHARED_WGID = `cm-${tag}-shared@g.us`;
const MANY = 305;

beforeAll(async () => {
  const replyRole = await role("CM reply", ["messages.view", "messages.reply"]);
  sessions.rudra = await user("Rudra", replyRole);
  sessions.hasan = await user("Hasan", replyRole);
  sessions.viewer = await user("Viewer", await role("CM view", ["messages.view"]));

  A.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `CM Primary ${tag}`, status: "CONNECTED", phoneNumber: "8801700000001" } })).id;
  B.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `CM Support ${tag}`, status: "CONNECTED" } })).id;
  B.offline = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `CM Offline ${tag}`, status: "DISCONNECTED" } })).id;
  categoryId = (await rawPrisma.chatCategory.create({ data: { ...pid, name: `CM Billing ${tag}`, color: "blue", position: 99 } })).id;

  // Account A: 305 groups where we spoke last, newest first — more than the list renders.
  await rawPrisma.whatsAppGroup.createMany({
    data: Array.from({ length: MANY }, (_, i) => ({ ...pid, accountId: A.id, whatsappGroupId: `cm-${tag}-a${i}@g.us`, name: `CM A group ${i} ${tag}`, isActive: true })),
  });
  const many = await rawPrisma.whatsAppGroup.findMany({ where: { accountId: A.id }, select: { id: true, whatsappGroupId: true, name: true } });
  await rawPrisma.message.createMany({
    data: many.map((g, i) => ({ ...pid, accountId: A.id, groupId: g.id, chatId: g.whatsappGroupId, whatsappMessageId: `cm-${tag}-m${i}`, senderPhone: "us", direction: "OUTGOING" as const, body: "done", normalizedBody: "done", timestampWa: ago(10 + i), processingStatus: "PROCESSED" as const })),
  });
  // Two of them filed under the category.
  await rawPrisma.whatsAppGroup.updateMany({ where: { id: { in: many.slice(0, 2).map((g) => g.id) } }, data: { chatCategoryId: categoryId } });

  // A customer waiting for days — older than all 305, so outside the rendered list, still waiting.
  A.gOld = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: A.id, whatsappGroupId: `cm-${tag}-old@g.us`, name: `CM A forgotten ${tag}`, isActive: true }, select: { id: true, whatsappGroupId: true } });
  await message(A.id, A.gOld, 60 * 24 * 3, "INCOMING", "keu achen?");

  // One WhatsApp group both accounts are in: two rows, two copies of the conversation.
  A.gShared = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: A.id, whatsappGroupId: SHARED_WGID, name: `CM Shared ${tag}`, isActive: true }, select: { id: true, whatsappGroupId: true } });
  B.gShared = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: B.id, whatsappGroupId: SHARED_WGID, name: `CM Shared ${tag}`, isActive: true, aiAutomationEnabled: true, chatCategoryId: categoryId }, select: { id: true, whatsappGroupId: true } });
  await message(A.id, A.gShared, 5, "INCOMING", "internet nai");
  await message(B.id, B.gShared, 5, "INCOMING", "internet nai");
  // B's queued (unsent) reply to the same WhatsApp group: B's business, never A's.
  await rawPrisma.outboundMessage.create({
    data: { ...pid, accountId: B.id, chatId: SHARED_WGID, toPhone: SHARED_WGID, body: `B queued ${tag}`, actionType: "MANUAL_REPLY", idempotencyKey: `cm-${tag}-bq`, status: "FAILED", groupId: B.gShared.id, createdById: sessions.hasan.userId },
  });

  const biz = (await rawPrisma.project.findFirst({ where: { slug: "bizify" } })) ?? (await createProjectWithDefaults({ name: "Bizify", slug: "bizify", status: "ACTIVE", creatorUserId: sessions.rudra.userId }, rawPrisma));
  ids.biz = (await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `CM Biz ${tag}`, status: "CONNECTED" } })).id;
});

afterAll(async () => {
  const accounts = [A.id, B.id, B.offline, ids.biz].filter(Boolean);
  await rawPrisma.outboundMessage.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.message.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: accounts } } });
  await rawPrisma.chatCategory.deleteMany({ where: { id: categoryId } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
});

describe("the inbox belongs to one account", () => {
  it("lists only the chosen account's conversations", async () => {
    const a = await inIsp(() => inbox.getChatInbox(A.id));
    const b = await inIsp(() => inbox.getChatInbox(B.id));
    expect(a.conversations.every((c) => c.accountId === A.id)).toBe(true);
    expect(b.conversations.map((c) => c.id)).toEqual([B.gShared.id]);
    expect(a.conversations.some((c) => c.id === B.gShared.id)).toBe(false);
  });

  it("All is the real total, not the 300 rendered", async () => {
    const a = await inIsp(() => inbox.getChatInbox(A.id));
    expect(a.conversations).toHaveLength(300);
    expect(a.counts.total).toBe(MANY + 2);
  });

  it("Waiting counts a customer beyond the rendered 300, and the Waiting view lists them", async () => {
    const a = await inIsp(() => inbox.getChatInbox(A.id));
    expect(a.conversations.some((c) => c.id === A.gOld.id)).toBe(false);
    expect(a.counts.waiting).toBe(2);
    current = sessions.viewer;
    const waiting = await inIsp(() => search.listConversationView(A.id, { kind: "waiting" }));
    expect(waiting.map((c) => c.id).sort()).toEqual([A.gOld.id, A.gShared.id].sort());
  });

  it("another account's queued reply is in neither this account's thread nor its pending badge", async () => {
    const a = await inIsp(() => inbox.getChatInbox(A.id));
    const shared = a.conversations.find((c) => c.id === A.gShared.id)!;
    expect(shared.pendingCount).toBe(0);
    const thread = await inIsp(() => inbox.getChatThread(A.gShared.id));
    expect(thread!.entries.some((e) => e.body === `B queued ${tag}`)).toBe(false);
    const threadB = await inIsp(() => inbox.getChatThread(B.gShared.id));
    expect(threadB!.entries.some((e) => e.body === `B queued ${tag}`)).toBe(true);
  });

  it("category counts are per account", async () => {
    const a = await inIsp(() => inbox.getChatCategories(A.id));
    const b = await inIsp(() => inbox.getChatCategories(B.id));
    expect(a.find((c) => c.id === categoryId)!.count).toBe(2);
    expect(b.find((c) => c.id === categoryId)!.count).toBe(1);
  });

  it("search reaches every group of the account and none of another's", async () => {
    current = sessions.viewer;
    const fromA = await inIsp(() => search.searchConversations(A.id, `Shared ${tag}`));
    expect(fromA.map((c) => c.id)).toEqual([A.gShared.id]);
    const deep = await inIsp(() => search.searchConversations(A.id, `group 304 ${tag}`));
    expect(deep).toHaveLength(1);
  });

  it("another project's account is unreachable", async () => {
    current = sessions.viewer;
    expect(await inIsp(() => inbox.getChatInbox(ids.biz))).toEqual({ conversations: [], counts: { total: 0, waiting: 0, seenUnanswered: 0 } });
    expect(await inIsp(() => search.chatAccountSwitchTarget(ids.biz, null))).toBeNull();
  });

  it("switching account lands on that account's own copy of the open group, or its inbox", async () => {
    current = sessions.viewer;
    expect(await inIsp(() => search.chatAccountSwitchTarget(B.id, A.gShared.id))).toBe(`/chat/account/${B.id}/${B.gShared.id}`);
    expect(await inIsp(() => search.chatAccountSwitchTarget(B.id, A.gOld.id))).toBe(`/chat/account/${B.id}`);
  });
});

describe("a reply goes out from the selected account, attributed to the person", () => {
  const form = (body: string, extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.set("body", body);
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };

  it("queues on the selected account with the session's user", async () => {
    current = sessions.rudra;
    const result = await inIsp(() => chat.sendChatMessage(A.id, A.gShared.id, {}, form(`Please check now ${tag}`)));
    expect(result.error).toBeUndefined();
    const row = await rawPrisma.outboundMessage.findFirstOrThrow({ where: { body: `Please check now ${tag}` } });
    expect(row).toMatchObject({ accountId: A.id, groupId: A.gShared.id, createdById: sessions.rudra.userId, actionType: "MANUAL_REPLY" });
  });

  it("two people on the same account stay two people", async () => {
    current = sessions.hasan;
    await inIsp(() => chat.sendChatMessage(A.id, A.gShared.id, {}, form(`Hasan here ${tag}`)));
    const row = await rawPrisma.outboundMessage.findFirstOrThrow({ where: { body: `Hasan here ${tag}` } });
    expect(row).toMatchObject({ accountId: A.id, createdById: sessions.hasan.userId });
    const thread = await inIsp(() => inbox.getChatThread(A.gShared.id));
    const mine = thread!.entries.filter((e) => e.kind === "QUEUED" && e.body.includes(tag) && e.authoredBy === "HUMAN_USER");
    expect(mine.map((e) => e.sentBy?.name).sort()).toEqual(["Hasan", "Rudra"]);
  });

  it("refuses a group that belongs to another account — nothing is queued", async () => {
    current = sessions.rudra;
    const result = await inIsp(() => chat.sendChatMessage(A.id, B.gShared.id, {}, form(`wrong account ${tag}`)));
    expect(result.error).toMatch(/different WhatsApp account/);
    expect(await rawPrisma.outboundMessage.count({ where: { body: `wrong account ${tag}` } })).toBe(0);
  });

  it("refuses the old cross-account 'reply as'", async () => {
    current = sessions.rudra;
    const result = await inIsp(() => chat.sendChatMessage(A.id, A.gShared.id, {}, form(`reply as ${tag}`, { sendAs: B.gShared.id })));
    expect(result.error).toMatch(/only from the selected account/);
    expect(await rawPrisma.outboundMessage.count({ where: { body: `reply as ${tag}` } })).toBe(0);
  });

  it("refuses another project's account, a disconnected account, and a read-only role", async () => {
    current = sessions.rudra;
    expect((await inIsp(() => chat.sendChatMessage(ids.biz, A.gShared.id, {}, form(`biz ${tag}`)))).error).toMatch(/not in this project/);
    const offlineGroup = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: B.offline, whatsappGroupId: SHARED_WGID, name: `CM Shared ${tag}`, isActive: true } });
    expect((await inIsp(() => chat.sendChatMessage(B.offline, offlineGroup.id, {}, form(`offline ${tag}`)))).error).toMatch(/disconnected/);
    current = sessions.viewer;
    expect((await inIsp(() => chat.sendChatMessage(A.id, A.gShared.id, {}, form(`viewer ${tag}`)))).error).toBeTruthy();
    expect(await rawPrisma.outboundMessage.count({ where: { body: { in: [`biz ${tag}`, `offline ${tag}`, `viewer ${tag}`] } } })).toBe(0);
  });

  it("pauses AI on the other accounts' copies of the group, which see the reply as a stranger's", async () => {
    const b = await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: B.gShared.id } });
    expect(b.aiSuppressedUntil && b.aiSuppressedUntil.getTime() > Date.now()).toBe(true);
  });

  it("an echoed send is attributed exactly: person, AI, rule — and a phone send stays unlabelled", async () => {
    const rule = await rawPrisma.automationRule.create({ data: { ...pid, name: `CM rule ${tag}`, type: "AUTO_REPLY", matchType: "ALWAYS" } });
    const sends = [
      { key: "p", over: { actionType: "MANUAL_REPLY" as const, createdById: sessions.rudra.userId } },
      { key: "r", over: { actionType: "AUTO_REPLY" as const, ruleId: rule.id } },
      { key: "ai", over: { actionType: "AUTO_REPLY" as const } },
    ];
    for (const s of sends) {
      await rawPrisma.outboundMessage.create({
        data: { ...pid, accountId: A.id, chatId: SHARED_WGID, toPhone: SHARED_WGID, body: `echo ${s.key}`, idempotencyKey: `cm-${tag}-e-${s.key}`, status: "SENT", providerMessageId: `cm-${tag}-wa-${s.key}`, ...s.over },
      });
      await message(A.id, A.gShared, 1, "OUTGOING", `echo ${s.key}`, `cm-${tag}-wa-${s.key}`);
    }
    const customer = await message(A.id, A.gShared, 2, "INCOMING", "ai question");
    const aiRow = await rawPrisma.outboundMessage.findUniqueOrThrow({ where: { idempotencyKey: `cm-${tag}-e-ai` } });
    await rawPrisma.aiFallbackDecision.create({ data: { ...pid, messageId: customer.id, accountId: A.id, groupId: A.gShared.id, outcome: "AI_REPLIED", reason: "ANSWERED", outboundMessageId: aiRow.id } });
    await message(A.id, A.gShared, 0, "OUTGOING", "from the phone");

    const thread = await inIsp(() => inbox.getChatThread(A.gShared.id));
    const by = (body: string) => thread!.entries.find((e) => e.body === body)!;
    expect(by("echo p")).toMatchObject({ kind: "OUTGOING", authoredBy: "HUMAN_USER", sentBy: { name: "Rudra" } });
    expect(by("echo r")).toMatchObject({ authoredBy: "RULE_AUTOMATION", sentBy: null });
    expect(by("echo ai")).toMatchObject({ authoredBy: "AI", sentBy: null });
    expect(by("from the phone").authoredBy).toBeUndefined();
    await rawPrisma.aiFallbackDecision.deleteMany({ where: { messageId: customer.id } });
    await rawPrisma.automationRule.delete({ where: { id: rule.id } });
  });
});

describe("bulk actions stay inside the selected account", () => {
  it("touches only the account's rows and says how many it left alone", async () => {
    current = sessions.rudra;
    const result = await inIsp(() => org.setChatPinned(A.id, [A.gShared.id, B.gShared.id], true));
    expect(result).toMatchObject({ updated: 1, outsideAccount: 1 });
    expect((await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: B.gShared.id } })).chatPinnedAt).toBeNull();
    expect((await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: A.gShared.id } })).chatPinnedAt).not.toBeNull();
  });

  it("a selection made entirely of another account's rows changes nothing", async () => {
    current = sessions.rudra;
    const result = await inIsp(() => org.setChatArchived(A.id, [B.gShared.id], true));
    expect(result.error).toMatch(/None of the selected conversations/);
    expect((await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: B.gShared.id } })).chatArchivedAt).toBeNull();
  });

  it("category and review bulk actions are scoped the same way", async () => {
    current = sessions.rudra;
    expect(await inIsp(() => org.setChatCategory(B.id, [A.gOld.id, B.gShared.id], null))).toMatchObject({ updated: 1, outsideAccount: 1 });
    expect((await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: B.gShared.id } })).chatCategoryId).toBeNull();
    expect(await inIsp(() => org.setChatReviewed(A.id, [A.gOld.id, B.gShared.id], true))).toMatchObject({ updated: 1, outsideAccount: 1 });
    expect((await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: B.gShared.id } })).chatReviewedAt).toBeNull();
  });
});
