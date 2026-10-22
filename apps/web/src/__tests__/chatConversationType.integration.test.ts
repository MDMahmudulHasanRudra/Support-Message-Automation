import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";
import {
  conversationPath,
  isPersonalChatId,
  parseConversationType,
  personalChatFallbackName,
  personalChatIdFromKey,
  personalConversationKey,
} from "@/lib/chatConversationType";

/**
 * WhatsApp Chat — the Groups / Personal filter. Called as the browser calls them, with only the
 * request plumbing stubbed. What must hold:
 *   - All is groups + personal chats; Groups never holds a 1:1 chat; Personal never holds a group;
 *   - the type is applied in SQL, so counts, the 300 limit, search, Waiting and Seen-unanswered all
 *     compose with it;
 *   - a personal chat is derived from its messages (a @c.us / @lid chat id, no group) and belongs to
 *     the account that has the messages — never to another account with the same customer;
 *   - archive, group threads, sending and every automation flag are untouched.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const digits = String(Date.now()).slice(-7); // digits-only, unique per run
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
/** One stored message. `groupId` null + a @c.us / @lid chat id is a personal chat — nothing else marks it. */
async function msg(
  accountId: string,
  chatId: string,
  groupId: string | null,
  minutes: number,
  direction: "INCOMING" | "OUTGOING",
  body: string,
  extra: { senderName?: string | null; isFromTeamMember?: boolean } = {},
) {
  return rawPrisma.message.create({
    data: {
      ...pid,
      accountId,
      groupId,
      chatId,
      whatsappMessageId: `ct-${tag}-${n++}`,
      senderPhone: direction === "INCOMING" ? chatId.split("@")[0]! : "us",
      senderName: extra.senderName ?? null,
      isFromTeamMember: extra.isFromTeamMember ?? false,
      direction,
      body,
      normalizedBody: body.toLowerCase(),
      timestampWa: ago(minutes),
      processingStatus: "PROCESSED",
    },
  });
}
async function group(accountId: string, name: string, extra: { chatArchivedAt?: Date; chatReviewedAt?: Date; isMonitored?: boolean; aiAutomationEnabled?: boolean } = {}) {
  return rawPrisma.whatsAppGroup.create({
    data: { ...pid, accountId, whatsappGroupId: `ct-${tag}-${n++}@g.us`, name: `${name} ${tag}`, isActive: true, ...extra },
    select: { id: true, whatsappGroupId: true },
  });
}

const A = { id: "", gWaiting: { id: "", whatsappGroupId: "" }, gSeen: { id: "", whatsappGroupId: "" }, gAnswered: { id: "", whatsappGroupId: "" }, gArchived: { id: "", whatsappGroupId: "" } };
const B = { id: "", gWaiting: { id: "", whatsappGroupId: "" } };
const C = { id: "" };
const sessions = {} as Record<"rudra" | "viewer", Session>;

// Personal chats. The same customer number writes to account A AND account B: two different chats.
const P_WAITING = `88017${digits}1@c.us`;
const P_SEEN = `88017${digits}2@c.us`;
const P_ANSWERED = `1${digits}0000001@lid`;
const P_TEAM = `88017${digits}3@c.us`;
const P_B_ONLY = `88017${digits}4@c.us`;
const STATUS = "status@broadcast";
const MANY_PERSONAL = 302;

beforeAll(async () => {
  sessions.rudra = await user("Rudra", await role("CT reply", ["messages.view", "messages.reply"]));
  sessions.viewer = await user("Viewer", await role("CT view", ["messages.view"]));

  A.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `CT Primary ${tag}`, status: "CONNECTED", phoneNumber: "8801700000009" } })).id;
  B.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `CT Second ${tag}`, status: "CONNECTED" } })).id;
  C.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `CT Busy ${tag}`, status: "CONNECTED" } })).id;

  // ── Account A: three live groups (waiting, seen-unanswered, answered) and one archived ─────────
  A.gWaiting = await group(A.id, "CT Billing", { isMonitored: true, aiAutomationEnabled: true });
  await msg(A.id, A.gWaiting.whatsappGroupId, A.gWaiting.id, 30, "INCOMING", "bill pai ni");
  A.gSeen = await group(A.id, "CT Support", { chatReviewedAt: ago(5) });
  await msg(A.id, A.gSeen.whatsappGroupId, A.gSeen.id, 40, "INCOMING", "net slow");
  A.gAnswered = await group(A.id, "CT Done");
  await msg(A.id, A.gAnswered.whatsappGroupId, A.gAnswered.id, 50, "INCOMING", "thanks");
  await msg(A.id, A.gAnswered.whatsappGroupId, A.gAnswered.id, 45, "OUTGOING", "welcome");
  A.gArchived = await group(A.id, "CT Old", { chatArchivedAt: ago(60) });
  await msg(A.id, A.gArchived.whatsappGroupId, A.gArchived.id, 70, "INCOMING", "hello?");

  // ── Account A: personal chats ───────────────────────────────────────────────────────────────
  // Waiting: the customer wrote last and nobody opened it. Named by their WhatsApp name.
  await msg(A.id, P_WAITING, null, 20, "INCOMING", "amar line off", { senderName: `Karim ${tag}` });
  // Seen, unanswered: the customer wrote last; somebody opened it after.
  await msg(A.id, P_SEEN, null, 25, "INCOMING", "recharge hoy ni");
  await rawPrisma.personalChatReview.create({ data: { ...pid, accountId: A.id, chatId: P_SEEN, reviewedAt: ago(2) } });
  // Answered from the phone (a @lid chat: WhatsApp hides this person's number).
  await msg(A.id, P_ANSWERED, null, 35, "INCOMING", "ok?", { senderName: `Hidden ${tag}` });
  await msg(A.id, P_ANSWERED, null, 33, "OUTGOING", "done bhai");
  // A colleague writing to the business number 1:1 is not a customer waiting.
  await msg(A.id, P_TEAM, null, 15, "INCOMING", "lunch?", { isFromTeamMember: true });
  // The status broadcast has no group either, and is not a conversation.
  await msg(A.id, STATUS, null, 10, "INCOMING", "status update");

  // ── Account B: one group, and the SAME customer number as A's waiting chat ────────────────────
  B.gWaiting = await group(B.id, "CT Billing");
  await msg(B.id, B.gWaiting.whatsappGroupId, B.gWaiting.id, 12, "INCOMING", "B group");
  await msg(B.id, P_WAITING, null, 8, "INCOMING", `B only ${tag}`, { senderName: `Karim ${tag}` });
  await msg(B.id, P_B_ONLY, null, 9, "INCOMING", "only B knows me");

  // ── Account C: more personal chats than the list renders, all newer than its three groups ──────
  for (let i = 0; i < 3; i++) {
    const g = await group(C.id, `CT Busy group ${i}`);
    await msg(C.id, g.whatsappGroupId, g.id, 600 + i, "INCOMING", "old group question");
  }
  await rawPrisma.message.createMany({
    data: Array.from({ length: MANY_PERSONAL }, (_, i) => ({
      ...pid,
      accountId: C.id,
      groupId: null,
      chatId: `8801${digits}${String(i).padStart(4, "0")}@c.us`,
      whatsappMessageId: `ct-${tag}-c${i}`,
      senderPhone: "x",
      direction: "OUTGOING" as const,
      body: "sent",
      normalizedBody: "sent",
      timestampWa: ago(1 + i),
      processingStatus: "PROCESSED" as const,
    })),
  });

  const biz = (await rawPrisma.project.findFirst({ where: { slug: "bizify" } })) ?? (await createProjectWithDefaults({ name: "Bizify", slug: "bizify", status: "ACTIVE", creatorUserId: sessions.rudra.userId }, rawPrisma));
  ids.biz = (await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `CT Biz ${tag}`, status: "CONNECTED" } })).id;
  current = sessions.rudra;
  await rawPrisma.message.create({
    data: { projectId: biz.id, accountId: ids.biz, chatId: P_WAITING, whatsappMessageId: `ct-${tag}-biz`, senderPhone: "x", direction: "INCOMING", body: "biz", normalizedBody: "biz", timestampWa: ago(1), processingStatus: "PROCESSED" },
  });
});

afterAll(async () => {
  const accounts = [A.id, B.id, C.id, ids.biz].filter(Boolean);
  await rawPrisma.personalChatReview.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.outboundMessage.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.message.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: accounts } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
});

const key = personalConversationKey;
const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
/** A list read, as whoever is signed in (`current`). */
const view = (accountId: string, v: Parameters<typeof search.listConversationView>[1], type: "all" | "groups" | "personal") =>
  inIsp(() => search.listConversationView(accountId, v, type));

describe("how a conversation's type is decided", () => {
  it("from WhatsApp's chat id domain, never the name", () => {
    expect(isPersonalChatId("8801712345678@c.us")).toBe(true);
    expect(isPersonalChatId("123456789012345@lid")).toBe(true);
    expect(isPersonalChatId("120363000000000000@g.us")).toBe(false);
    expect(isPersonalChatId("status@broadcast")).toBe(false);
    expect(isPersonalChatId("1203630000@newsletter")).toBe(false);
    expect(isPersonalChatId("@c.us")).toBe(false);
    expect(isPersonalChatId("Karim's group @c.us name")).toBe(false);
  });

  it("the SQL predicate and isPersonalChatId agree on every shape", async () => {
    const shapes = ["8801712345678@c.us", "123456789012345@lid", "1203630@g.us", "status@broadcast", "1203630@newsletter", "x@c.us.evil", "abc@lid2"];
    const rows = await rawPrisma.$queryRaw<Array<{ chatId: string; personal: boolean }>>`
      SELECT s AS "chatId", (s LIKE '%@c.us' OR s LIKE '%@lid') AS personal FROM unnest(${shapes}::text[]) AS s`;
    for (const row of rows) expect([row.chatId, row.personal]).toEqual([row.chatId, isPersonalChatId(row.chatId)]);
  });

  it("keys, paths, the URL value and a nameless chat's label", () => {
    expect(personalChatIdFromKey(key(P_WAITING))).toBe(P_WAITING);
    expect(personalChatIdFromKey(A.gWaiting.id || "cm0groupcuid")).toBeNull();
    expect(personalChatIdFromKey("personal:status@broadcast")).toBeNull();
    expect(parseConversationType("personal")).toBe("personal");
    expect(parseConversationType("groups")).toBe("groups");
    expect(parseConversationType("everything")).toBe("all");
    expect(parseConversationType(null)).toBe("all");
    expect(conversationPath("acc", { id: key("8801@c.us"), kind: "PERSONAL", chatId: "8801@c.us" })).toBe("/chat/account/acc/personal/8801%40c.us");
    expect(conversationPath("acc", { id: "g1", kind: "GROUP", chatId: "1@g.us" })).toBe("/chat/account/acc/g1");
    expect(personalChatFallbackName("8801712345678@c.us")).toBe("+8801712345678");
    expect(personalChatFallbackName("123456789012345@lid")).toBe("Hidden number ···2345");
  });
});

describe("All, Groups and Personal", () => {
  it("1. All returns groups and personal chats together", async () => {
    const all = await view(A.id, { kind: "all" }, "all");
    expect(idsOf(all)).toEqual(idsOf([A.gWaiting, A.gSeen, A.gAnswered, { id: key(P_WAITING) }, { id: key(P_SEEN) }, { id: key(P_ANSWERED) }, { id: key(P_TEAM) }]));
    // The layout's own list is the same set.
    const layout = await inIsp(() => inbox.getChatInbox(A.id));
    expect(idsOf(layout.conversations)).toEqual(idsOf(all));
  });

  it("2 + 5. Groups returns only groups — never a personal chat", async () => {
    const groups = await view(A.id, { kind: "all" }, "groups");
    expect(idsOf(groups)).toEqual(idsOf([A.gWaiting, A.gSeen, A.gAnswered]));
    expect(groups.every((c) => c.kind === "GROUP" && c.chatId.endsWith("@g.us"))).toBe(true);
  });

  it("3 + 4. Personal returns only 1:1 chats — never a group, never the status broadcast", async () => {
    const personal = await view(A.id, { kind: "all" }, "personal");
    expect(idsOf(personal)).toEqual(idsOf([{ id: key(P_WAITING) }, { id: key(P_SEEN) }, { id: key(P_ANSWERED) }, { id: key(P_TEAM) }]));
    expect(personal.every((c) => c.kind === "PERSONAL" && isPersonalChatId(c.chatId))).toBe(true);
    expect(personal.some((c) => c.chatId === STATUS)).toBe(false);
  });

  it("a personal row says who it is and what it is, and carries no group settings", async () => {
    const personal = await view(A.id, { kind: "all" }, "personal");
    const karim = personal.find((c) => c.chatId === P_WAITING)!;
    expect(karim).toMatchObject({ name: `Karim ${tag}`, lastMessagePreview: "amar line off", isMonitored: false, aiAutomationEnabled: false, isPinned: false, categoryId: null, mood: null });
    expect(personal.find((c) => c.chatId === P_SEEN)!.name).toBe(`+${P_SEEN.split("@")[0]}`);
    expect(personal.find((c) => c.chatId === P_ANSWERED)).toMatchObject({ name: `Hidden ${tag}`, lastMessageOutgoing: true, isUnanswered: false });
  });

  it("6. counts are real per type, and All is their sum", async () => {
    const { counts } = await inIsp(() => inbox.getChatInbox(A.id));
    expect(counts.groups).toEqual({ total: 3, waiting: 1, seenUnanswered: 1 });
    expect(counts.personal).toEqual({ total: 4, waiting: 1, seenUnanswered: 1 });
    expect({ total: counts.total, waiting: counts.waiting, seenUnanswered: counts.seenUnanswered }).toEqual({ total: 7, waiting: 2, seenUnanswered: 2 });
  });

  it("7. each type's list is complete on its own, past the rendered limit of the other", async () => {
    const inboxC = await inIsp(() => inbox.getChatInbox(C.id));
    // All: the 300 most recent are all personal, so no group made the loaded list…
    expect(inboxC.conversations).toHaveLength(300);
    expect(inboxC.conversations.every((c) => c.kind === "PERSONAL")).toBe(true);
    expect(inboxC.counts).toMatchObject({ total: MANY_PERSONAL + 3, groups: { total: 3 }, personal: { total: MANY_PERSONAL } });
    // …and still Groups lists every group, ranked newest first.
    const groups = await view(C.id, { kind: "all" }, "groups");
    expect(groups.map((c) => c.name)).toEqual([0, 1, 2].map((i) => `CT Busy group ${i} ${tag}`));
    // Personal is bounded by the same limit, newest first, independent of the groups.
    const personal = await view(C.id, { kind: "all" }, "personal");
    expect(personal).toHaveLength(300);
    expect(personal[0]!.chatId).toBe(`8801${digits}0000@c.us`);
    expect(personal.at(-1)!.chatId).toBe(`8801${digits}0299@c.us`);
    // Waiting under Groups reaches all three though none is in the loaded 300.
    expect(await view(C.id, { kind: "waiting" }, "groups")).toHaveLength(3);
    expect(await view(C.id, { kind: "waiting" }, "personal")).toHaveLength(0);
  });
});

describe("the type composes with search and the views", () => {
  it("8. Search + Groups", async () => {
    current = sessions.viewer;
    const found = await inIsp(() => search.searchConversations(A.id, `CT Billing ${tag}`, "groups"));
    expect(found.map((c) => c.id)).toEqual([A.gWaiting.id]);
    // The tag is in group names and personal names alike: Groups returns only the groups.
    const both = await inIsp(() => search.searchConversations(A.id, tag, "groups"));
    expect(both.every((c) => c.kind === "GROUP")).toBe(true);
    expect(both).toHaveLength(3);
  });

  it("9. Search + Personal — by WhatsApp name or by number", async () => {
    current = sessions.viewer;
    expect((await inIsp(() => search.searchConversations(A.id, `Karim ${tag}`, "personal"))).map((c) => c.id)).toEqual([key(P_WAITING)]);
    expect((await inIsp(() => search.searchConversations(A.id, P_SEEN.split("@")[0]!, "personal"))).map((c) => c.id)).toEqual([key(P_SEEN)]);
    const both = await inIsp(() => search.searchConversations(A.id, tag, "personal"));
    expect(idsOf(both)).toEqual(idsOf([{ id: key(P_WAITING) }, { id: key(P_ANSWERED) }]));
    // All finds both kinds; a group name never matches under Personal.
    expect((await inIsp(() => search.searchConversations(A.id, tag, "all"))).length).toBe(5);
    expect(await inIsp(() => search.searchConversations(A.id, `CT Billing ${tag}`, "personal"))).toEqual([]);
  });

  it("10. Waiting + Personal", async () => {
    expect(idsOf(await view(A.id, { kind: "waiting" }, "personal"))).toEqual([key(P_WAITING)]);
  });

  it("11. Waiting + Groups", async () => {
    expect(idsOf(await view(A.id, { kind: "waiting" }, "groups"))).toEqual([A.gWaiting.id]);
  });

  it("12. Seen, unanswered + Personal", async () => {
    expect(idsOf(await view(A.id, { kind: "seen-unanswered" }, "personal"))).toEqual([key(P_SEEN)]);
  });

  it("13. Seen, unanswered + Groups", async () => {
    expect(idsOf(await view(A.id, { kind: "seen-unanswered" }, "groups"))).toEqual([A.gSeen.id]);
  });

  it("a category holds groups only, so Personal + a category is empty", async () => {
    const category = await rawPrisma.chatCategory.create({ data: { ...pid, name: `CT Cat ${tag}`, color: "blue" } });
    await rawPrisma.whatsAppGroup.update({ where: { id: A.gSeen.id }, data: { chatCategoryId: category.id } });
    expect(idsOf(await view(A.id, { kind: "category", id: category.id }, "all"))).toEqual([A.gSeen.id]);
    expect(await view(A.id, { kind: "category", id: category.id }, "personal")).toEqual([]);
    await rawPrisma.whatsAppGroup.update({ where: { id: A.gSeen.id }, data: { chatCategoryId: null } });
    await rawPrisma.chatCategory.delete({ where: { id: category.id } });
  });

  it("a type the browser makes up is read as All", async () => {
    current = sessions.viewer;
    const odd = await inIsp(() => search.listConversationView(A.id, { kind: "all" }, "everything" as never));
    expect(odd).toHaveLength(7);
  });
});

describe("opening and marking a personal chat", () => {
  it("opening clears it from Waiting into Seen; the customer's next message puts it back", async () => {
    current = sessions.rudra;
    await inIsp(() => org.markPersonalChatReviewed(A.id, P_WAITING));
    expect(idsOf(await view(A.id, { kind: "waiting" }, "personal"))).toEqual([]);
    expect(idsOf(await view(A.id, { kind: "seen-unanswered" }, "personal"))).toEqual(idsOf([{ id: key(P_WAITING) }, { id: key(P_SEEN) }]));
    // Account B's chat with the same customer is its own: still waiting there.
    expect(idsOf(await view(B.id, { kind: "waiting" }, "personal"))).toEqual(idsOf([{ id: key(P_WAITING) }, { id: key(P_B_ONLY) }]));

    // Opened ten minutes ago; the customer writes again five minutes ago.
    await rawPrisma.personalChatReview.updateMany({ where: { accountId: A.id, chatId: P_WAITING }, data: { reviewedAt: ago(10) } });
    await msg(A.id, P_WAITING, null, 5, "INCOMING", "ekhono hoy ni");
    expect(idsOf(await view(A.id, { kind: "waiting" }, "personal"))).toEqual([key(P_WAITING)]);
    // Opening it again re-stamps (the mark is older than the newest message), and only then.
    await inIsp(() => org.markPersonalChatReviewed(A.id, P_WAITING));
    const stamped = await rawPrisma.personalChatReview.findFirstOrThrow({ where: { accountId: A.id, chatId: P_WAITING } });
    expect(stamped.reviewedAt.getTime()).toBeGreaterThan(ago(1).getTime());
    await inIsp(() => org.markPersonalChatReviewed(A.id, P_WAITING));
    expect((await rawPrisma.personalChatReview.findFirstOrThrow({ where: { accountId: A.id, chatId: P_WAITING } })).updatedAt).toEqual(stamped.updatedAt);
    await rawPrisma.personalChatReview.updateMany({ where: { accountId: A.id, chatId: P_WAITING }, data: { reviewedAt: ago(10) } });
    expect(idsOf(await view(A.id, { kind: "waiting" }, "personal"))).toEqual([key(P_WAITING)]);
  });

  it("a read-only role opening it changes nothing", async () => {
    current = sessions.viewer;
    const before = await rawPrisma.personalChatReview.findFirst({ where: { accountId: A.id, chatId: P_WAITING } });
    await inIsp(() => org.markPersonalChatReviewed(A.id, P_WAITING));
    expect(await rawPrisma.personalChatReview.findFirst({ where: { accountId: A.id, chatId: P_WAITING } })).toEqual(before);
    current = sessions.rudra;
  });

  it("bulk read / waiting reach personal chats of the account, and only them", async () => {
    current = sessions.rudra;
    const read = await inIsp(() => org.setChatReviewed(A.id, [key(P_WAITING), A.gWaiting.id, key(`88019${digits}9@c.us`)], true));
    expect(read).toMatchObject({ updated: 2, outsideAccount: 1 });
    expect(await view(A.id, { kind: "waiting" }, "all")).toEqual([]);

    const back = await inIsp(() => org.markPersonalChatWaiting(A.id, P_WAITING));
    expect(back).toMatchObject({ updated: 1 });
    expect(idsOf(await view(A.id, { kind: "waiting" }, "personal"))).toEqual([key(P_WAITING)]);

    // A chat only account B has is not A's to mark, even when the id is real.
    const elsewhere = await inIsp(() => org.setChatReviewed(A.id, [key(P_B_ONLY)], true));
    expect(elsewhere).toMatchObject({ error: expect.stringMatching(/None of the selected conversations/), outsideAccount: 1 });
    expect(await rawPrisma.personalChatReview.count({ where: { chatId: P_B_ONLY } })).toBe(0);

    // Account B's chat with the same number is not A's to mark.
    const crossed = await inIsp(() => org.setChatReviewed(A.id, [key(P_WAITING)], true));
    expect(crossed).toMatchObject({ updated: 1 });
    expect(idsOf(await view(B.id, { kind: "waiting" }, "personal"))).toEqual(idsOf([{ id: key(P_WAITING) }, { id: key(P_B_ONLY) }]));
  });

  it("14. pin, category and archive are for groups: a personal chat is left alone and said so", async () => {
    current = sessions.rudra;
    expect((await inIsp(() => org.setChatArchived(A.id, [key(P_SEEN)], true))).error).toMatch(/group conversations only/);
    expect((await inIsp(() => org.setChatPinned(A.id, [key(P_SEEN)], true))).error).toMatch(/group conversations only/);
    const mixed = await inIsp(() => org.setChatPinned(A.id, [key(P_SEEN), A.gAnswered.id], true));
    expect(mixed).toMatchObject({ updated: 1, personalSkipped: 1 });
    await rawPrisma.whatsAppGroup.update({ where: { id: A.gAnswered.id }, data: { chatPinnedAt: null } });
    // The archive is still groups only, and an archived group is in no type.
    const archived = await inIsp(() => inbox.getArchivedChatConversations(A.id));
    expect(archived.map((c) => [c.id, c.kind])).toEqual([[A.gArchived.id, "GROUP"]]);
    for (const type of ["all", "groups", "personal"] as const) {
      expect((await view(A.id, { kind: "all" }, type)).some((c) => c.id === A.gArchived.id)).toBe(false);
    }
  });
});

describe("accounts, projects and what stays unchanged", () => {
  it("15. each account sees only its own personal chats and groups", async () => {
    const b = await inIsp(() => inbox.getChatInbox(B.id));
    expect(idsOf(b.conversations)).toEqual(idsOf([B.gWaiting, { id: key(P_WAITING) }, { id: key(P_B_ONLY) }]));
    expect(b.counts.personal.total).toBe(2);
    const threadA = await inIsp(() => inbox.getPersonalChatThread(A.id, P_WAITING));
    const threadB = await inIsp(() => inbox.getPersonalChatThread(B.id, P_WAITING));
    expect(threadA!.entries.some((e) => e.body === `B only ${tag}`)).toBe(false);
    expect(threadB!.entries.map((e) => e.body)).toEqual([`B only ${tag}`]);
    expect(threadA!.chat).toMatchObject({ accountId: A.id, name: `Karim ${tag}`, chatId: P_WAITING });
  });

  it("a reply queued from another account to the same person answers that account's chat, not this one's", async () => {
    await rawPrisma.personalChatReview.deleteMany({ where: { chatId: P_WAITING, accountId: { in: [A.id, B.id] } } });
    const reply = await rawPrisma.outboundMessage.create({
      data: { ...pid, accountId: B.id, chatId: P_WAITING, toPhone: P_WAITING, body: `B replied ${tag}`, actionType: "MANUAL_REPLY", idempotencyKey: `ct-${tag}-b-reply`, status: "PENDING" },
    });
    expect(idsOf(await view(B.id, { kind: "waiting" }, "personal"))).toEqual([key(P_B_ONLY)]);
    expect(idsOf(await view(A.id, { kind: "waiting" }, "personal"))).toEqual([key(P_WAITING)]);
    // B's queued row is in B's thread and pending badge only.
    expect((await view(B.id, { kind: "all" }, "personal")).find((c) => c.chatId === P_WAITING)!.pendingCount).toBe(1);
    expect((await view(A.id, { kind: "all" }, "personal")).find((c) => c.chatId === P_WAITING)!.pendingCount).toBe(0);
    expect((await inIsp(() => inbox.getPersonalChatThread(B.id, P_WAITING)))!.entries.some((e) => e.kind === "QUEUED")).toBe(true);
    expect((await inIsp(() => inbox.getPersonalChatThread(A.id, P_WAITING)))!.entries.some((e) => e.kind === "QUEUED")).toBe(false);
    await rawPrisma.outboundMessage.delete({ where: { id: reply.id } });
  });

  it("another project's account, a group id, the status broadcast and an unknown chat are not personal threads", async () => {
    current = sessions.viewer;
    expect(await inIsp(() => inbox.getPersonalChatThread(ids.biz, P_WAITING))).toBeNull();
    expect(await inIsp(() => inbox.getPersonalChatThread(A.id, A.gWaiting.whatsappGroupId))).toBeNull();
    expect(await inIsp(() => inbox.getPersonalChatThread(A.id, STATUS))).toBeNull();
    expect(await inIsp(() => inbox.getPersonalChatThread(A.id, `88019${digits}9@c.us`))).toBeNull();
    const biz = await inIsp(() => inbox.getChatInbox(ids.biz));
    expect(biz.conversations).toEqual([]);
    expect(biz.counts.personal.total).toBe(0);
    current = sessions.rudra;
  });

  it("16. a group's thread loads exactly as before", async () => {
    const thread = await inIsp(() => inbox.getChatThread(A.gAnswered.id));
    expect(thread!.group.id).toBe(A.gAnswered.id);
    expect(thread!.entries.map((e) => [e.kind, e.body])).toEqual([
      ["INCOMING", "thanks"],
      ["OUTGOING", "welcome"],
    ]);
  });

  it("17. nothing here touches automation, monitoring or sending — and a personal chat cannot be sent to from the inbox", async () => {
    const snapshot = async () => ({
      groups: await rawPrisma.whatsAppGroup.findMany({
        where: { accountId: { in: [A.id, B.id, C.id] } },
        select: { id: true, isMonitored: true, aiAutomationEnabled: true, aiAutomationExcluded: true, aiSuppressedUntil: true, isActive: true },
        orderBy: { id: "asc" },
      }),
      outbound: await rawPrisma.outboundMessage.count({ where: { accountId: { in: [A.id, B.id, C.id] } } }),
      commands: await rawPrisma.workerCommand.count({ where: { accountId: { in: [A.id, B.id, C.id] } } }),
      messages: await rawPrisma.message.count({ where: { accountId: { in: [A.id, B.id, C.id] } } }),
    });
    const before = await snapshot();

    current = sessions.rudra;
    for (const type of ["all", "groups", "personal"] as const) {
      await view(A.id, { kind: "all" }, type);
      await inIsp(() => search.searchConversations(A.id, tag, type));
    }
    await inIsp(() => inbox.getPersonalChatThread(A.id, P_SEEN));
    await inIsp(() => org.markPersonalChatReviewed(A.id, P_SEEN));
    const form = new FormData();
    form.set("body", `to a person ${tag}`);
    const sent = await inIsp(() => chat.sendChatMessage(A.id, key(P_SEEN), {}, form));
    expect(sent.error).toMatch(/no longer exists/);

    expect(await snapshot()).toEqual(before);
    expect(await rawPrisma.outboundMessage.count({ where: { body: `to a person ${tag}` } })).toBe(0);
  });
});
