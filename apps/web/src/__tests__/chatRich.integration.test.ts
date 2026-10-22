import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Chat v2 rich messaging (CHAT_RICH_MESSAGING.md), the dashboard side, against a real database: what a
 * poll, location, sticker or forward writes (ONE MANUAL_REPLY outbound row, typed, never a send);
 * what is refused (feature off, no permission, a poll to a person, a sticker or message of another
 * project or account, a disconnected account); and the star / pin / archive / load-earlier commands
 * (deduplicated, readable, refused for anything that is not this project's).
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
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
const rich = await import("@/server/actions/chatRich");
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
async function setV2(enabled: boolean) {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId: ORIGINAL_PROJECT_ID, key: "CHAT_UI_V2" } },
    create: { projectId: ORIGINAL_PROJECT_ID, key: "CHAT_UI_V2", enabled },
    update: { enabled },
  });
  forgetProjectFeatureStates();
}

let seq = 0;
async function message(accountId: string, chatId: string, groupId: string | null, body: string, projectId = ORIGINAL_PROJECT_ID) {
  return rawPrisma.message.create({
    data: { projectId, accountId, groupId, chatId, whatsappMessageId: `rich-${tag}-${seq++}`, senderPhone: "8801700000001", direction: "INCOMING", body, normalizedBody: body, timestampWa: new Date(), processingStatus: "PROCESSED" },
    select: { id: true },
  });
}

const A = { id: "" };
const B = { id: "" };
const OFF = { id: "" };
let G: { id: string; whatsappGroupId: string };
let G2: { id: string; whatsappGroupId: string };
let G_OFF: { id: string; whatsappGroupId: string };
const PERSONAL = `8801711${String(Date.now()).slice(-6)}@c.us`;
let SOURCE = "";
let B_MESSAGE = "";
let BIZ_MESSAGE = "";
let STICKER = "";
let BIZ_STICKER = "";
const sessions = {} as Record<"agent" | "viewer", Session>;

beforeAll(async () => {
  sessions.agent = await user("RichAgent", await role("Rich reply", ["messages.view", "messages.reply"]));
  sessions.viewer = await user("RichViewer", await role("Rich view", ["messages.view"]));
  A.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Rich A ${tag}`, status: "CONNECTED" } })).id;
  B.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Rich B ${tag}`, status: "CONNECTED" } })).id;
  OFF.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Rich off ${tag}`, status: "DISCONNECTED" } })).id;
  ids.accounts.push(A.id, B.id, OFF.id);
  const group = (accountId: string, suffix: string) =>
    rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId, whatsappGroupId: `rich-${tag}-${suffix}@g.us`, name: `Rich ${suffix} ${tag}`, isActive: true }, select: { id: true, whatsappGroupId: true } });
  G = await group(A.id, "g");
  G2 = await group(A.id, "g2");
  G_OFF = await group(OFF.id, "off");
  SOURCE = (await message(A.id, G.whatsappGroupId, G.id, "Our office hours are 9 to 6")).id;
  await message(A.id, PERSONAL, null, "hello from a customer");
  B_MESSAGE = (await message(B.id, `rich-${tag}-b@g.us`, null, "account B's message")).id;
  const sticker = async (projectId: string, accountId: string, messageId: string) =>
    (
      await rawPrisma.messageMedia.create({
        data: { projectId, messageId, accountId, mediaType: "STICKER", waType: "sticker", mimeType: "image/webp", status: "STORED", sizeBytes: BigInt(20_000), sha256: randomUUID(), storageKey: `media/${randomUUID()}` },
        select: { id: true },
      })
    ).id;
  STICKER = await sticker(ORIGINAL_PROJECT_ID, A.id, (await message(A.id, G.whatsappGroupId, G.id, "[Sticker]")).id);

  const biz = (await rawPrisma.project.findFirst({ where: { slug: "bizify" } })) ?? (await createProjectWithDefaults({ name: "Bizify", slug: "bizify", status: "ACTIVE", creatorUserId: sessions.agent.userId }, rawPrisma));
  const bizAccount = await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `Rich Biz ${tag}`, status: "CONNECTED" } });
  ids.accounts.push(bizAccount.id);
  BIZ_MESSAGE = (await message(bizAccount.id, `rich-${tag}-biz@g.us`, null, "biz", biz.id)).id;
  BIZ_STICKER = await sticker(biz.id, bizAccount.id, BIZ_MESSAGE);
});

beforeEach(async () => {
  current = sessions.agent;
  await setV2(true);
});

afterAll(async () => {
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID, key: "CHAT_UI_V2" } });
  forgetProjectFeatureStates();
  await rawPrisma.workerCommand.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.outboundMessage.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.messageMedia.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.message.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
});

const groupRef = () => ({ accountId: A.id, groupId: G.id });
const personalRef = () => ({ accountId: A.id, personalChatId: PERSONAL });
const outbound = (where: object) => rawPrisma.outboundMessage.findMany({ where: { accountId: A.id, ...where }, orderBy: { createdAt: "asc" } });

describe("sends", () => {
  it("a poll writes ONE typed manual row for the worker, with a readable summary", async () => {
    const result = await inIsp(() => rich.sendChatPoll(groupRef(), { name: `Which plan ${tag}?`, options: ["Basic", "Pro"], allowMultiple: false }));
    expect(result).toEqual({ sentAt: expect.any(Number) });
    const rows = await outbound({ contentType: "POLL" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actionType: "MANUAL_REPLY",
      status: "PENDING",
      chatId: G.whatsappGroupId,
      toPhone: G.whatsappGroupId,
      groupId: G.id,
      body: `[Poll] Which plan ${tag}?`,
      content: { name: `Which plan ${tag}?`, options: ["Basic", "Pro"], allowMultiple: false },
      createdById: sessions.agent.userId,
      mentions: [],
      replyToMessageId: null,
    });
    // A double press is the same send.
    await inIsp(() => rich.sendChatPoll(groupRef(), { name: `Which plan ${tag}?`, options: ["Basic", "Pro"], allowMultiple: false }));
    expect(await outbound({ contentType: "POLL" })).toHaveLength(1);
  });

  it("a poll is refused for a personal chat, and an invalid one writes nothing", async () => {
    expect((await inIsp(() => rich.sendChatPoll(personalRef(), { name: "Q", options: ["a", "b"], allowMultiple: false }))).error).toMatch(/groups only/);
    expect((await inIsp(() => rich.sendChatPoll(groupRef(), { name: "Q", options: ["a"], allowMultiple: false }))).error).toMatch(/at least 2/);
    expect(await outbound({ contentType: "POLL", body: "[Poll] Q" })).toHaveLength(0);
  });

  it("a location goes to a group or a personal chat the account already has", async () => {
    expect(await inIsp(() => rich.sendChatLocation(personalRef(), { latitude: "23.8103", longitude: "90.4125", name: "Office" }))).toEqual({ sentAt: expect.any(Number) });
    const [row] = await outbound({ contentType: "LOCATION" });
    expect(row).toMatchObject({ chatId: PERSONAL, groupId: null, body: "[Location] Office", content: { latitude: 23.8103, longitude: 90.4125, name: "Office" } });
    const stranger = await inIsp(() => rich.sendChatLocation({ accountId: A.id, personalChatId: "8801999999999@c.us" }, { latitude: 1, longitude: 1, name: "" }));
    expect(stranger.error).toMatch(/never start one/);
  });

  it("a sticker must be one of this project's stored stickers", async () => {
    expect(await inIsp(() => rich.sendChatSticker(groupRef(), STICKER))).toEqual({ sentAt: expect.any(Number) });
    expect((await outbound({ contentType: "STICKER" }))[0]).toMatchObject({ body: "[Sticker]", content: { mediaId: STICKER } });
    expect((await inIsp(() => rich.sendChatSticker(groupRef(), BIZ_STICKER))).error).toMatch(/no longer stored/);
    expect(await outbound({ contentType: "STICKER" })).toHaveLength(1);
  });

  it("the sticker list is this project's sendable stickers only", async () => {
    const list = await inIsp(() => rich.listStickerChoices());
    expect(list.map((s) => s.mediaId)).toContain(STICKER);
    expect(list.map((s) => s.mediaId)).not.toContain(BIZ_STICKER);
  });

  it("a forward goes from a message of the same account to another of its conversations", async () => {
    expect(await inIsp(() => rich.forwardChatMessage(SOURCE, { accountId: A.id, groupId: G2.id }))).toEqual({ sentAt: expect.any(Number) });
    expect((await outbound({ contentType: "FORWARD" }))[0]).toMatchObject({ chatId: G2.whatsappGroupId, body: "[Forwarded] Our office hours are 9 to 6", content: { sourceMessageId: SOURCE } });
    expect((await inIsp(() => rich.forwardChatMessage(SOURCE, groupRef()))).error).toMatch(/already in this conversation/);
    expect((await inIsp(() => rich.forwardChatMessage(B_MESSAGE, { accountId: A.id, groupId: G2.id }))).error).toMatch(/this account/);
    expect((await inIsp(() => rich.forwardChatMessage(BIZ_MESSAGE, { accountId: A.id, groupId: G2.id }))).error).toMatch(/could not be found/);
    expect(await outbound({ contentType: "FORWARD" })).toHaveLength(1);
  });

  it("nothing is sent from a disconnected account, without the reply permission, or with the feature off", async () => {
    const before = await rawPrisma.outboundMessage.count({ where: { accountId: { in: ids.accounts } } });
    expect((await inIsp(() => rich.sendChatLocation({ accountId: OFF.id, groupId: G_OFF.id }, { latitude: 1, longitude: 1, name: "" }))).error).toMatch(/disconnected/);
    current = sessions.viewer;
    expect((await inIsp(() => rich.sendChatLocation(groupRef(), { latitude: 1, longitude: 1, name: "" }))).error).toBeTruthy();
    current = sessions.agent;
    await setV2(false);
    expect((await inIsp(() => rich.sendChatLocation(groupRef(), { latitude: 1, longitude: 1, name: "" }))).error).toMatch(/not switched on/);
    expect((await inIsp(() => rich.forwardChatMessage(SOURCE, { accountId: A.id, groupId: G2.id }))).error).toMatch(/not switched on/);
    expect(await rawPrisma.outboundMessage.count({ where: { accountId: { in: ids.accounts } } })).toBe(before);
  });
});

describe("commands", () => {
  it("star is one command per message and state, readable while it runs", async () => {
    const first = await inIsp(() => rich.starChatMessage(SOURCE, true));
    const again = await inIsp(() => rich.starChatMessage(SOURCE, true));
    expect(again.commandId).toBe(first.commandId);
    const cmd = await rawPrisma.workerCommand.findUniqueOrThrow({ where: { id: first.commandId! } });
    expect(cmd).toMatchObject({ type: "STAR_MESSAGE", accountId: A.id, status: "PENDING" });
    expect(cmd.payload).toMatchObject({ messageId: SOURCE, star: true });
    expect(await inIsp(() => rich.readRichCommand(first.commandId))).toMatchObject({ status: "PENDING" });
    expect((await inIsp(() => rich.starChatMessage(BIZ_MESSAGE, true))).error).toMatch(/could not be found/);
  });

  it("pin and archive name exactly one change, on this conversation's chat", async () => {
    const pin = await inIsp(() => rich.setWhatsAppChatState(groupRef(), { pin: true }));
    expect((await rawPrisma.workerCommand.findUniqueOrThrow({ where: { id: pin.commandId! } })).payload).toEqual({ chatId: G.whatsappGroupId, pin: true });
    const archive = await inIsp(() => rich.setWhatsAppChatState(personalRef(), { archive: false }));
    expect((await rawPrisma.workerCommand.findUniqueOrThrow({ where: { id: archive.commandId! } })).payload).toEqual({ chatId: PERSONAL, archive: false });
    expect((await inIsp(() => rich.setWhatsAppChatState(groupRef(), { pin: true, archive: true }))).error).toMatch(/Choose/);
    expect((await inIsp(() => rich.setWhatsAppChatState({ accountId: B.id, groupId: G.id }, { pin: true }))).error).toMatch(/could not be found/);
  });

  it("load earlier joins a load already running, and reports the worker's answer", async () => {
    const first = await inIsp(() => rich.loadEarlierFromWhatsApp(groupRef()));
    expect((await inIsp(() => rich.loadEarlierFromWhatsApp(groupRef()))).commandId).toBe(first.commandId);
    await rawPrisma.workerCommand.update({ where: { id: first.commandId! }, data: { status: "DONE", result: { success: true, stored: 7, reachedStart: false } } });
    expect(await inIsp(() => rich.readRichCommand(first.commandId))).toMatchObject({ status: "DONE", stored: 7, reachedStart: false });
    // A viewer may read history; the command is read-only for them as for anyone.
    current = sessions.viewer;
    expect((await inIsp(() => rich.loadEarlierFromWhatsApp(groupRef()))).commandId).toBeTruthy();
  });

  it("only these command types are readable through this reader", async () => {
    const other = await rawPrisma.workerCommand.create({ data: { ...pid, type: "RECONNECT", accountId: A.id } });
    expect(await inIsp(() => rich.readRichCommand(other.id))).toEqual({ status: "UNKNOWN" });
  });
});

describe("the thread shows what WhatsApp reported", () => {
  it("receipts, deletion, star and rich details reach the entry; a queued poll shows its card", async () => {
    await rawPrisma.message.update({
      where: { id: SOURCE },
      data: { revokedAt: new Date(), starredAt: new Date(), richContent: { kind: "LOCATION", latitude: 23.8, longitude: 90.4, name: "Office" } },
    });
    const thread = await inIsp(() => inbox.getChatThread(G.id));
    const entry = thread!.entries.find((e) => e.id === SOURCE)!;
    expect(entry).toMatchObject({ starred: true, rich: { kind: "LOCATION", latitude: 23.8, longitude: 90.4, name: "Office" } });
    expect(entry.revokedAt).toBeInstanceOf(Date);
    const queuedPoll = thread!.entries.find((e) => e.kind === "QUEUED" && e.queuedContent?.type === "POLL");
    expect(queuedPoll?.queuedContent?.rich).toMatchObject({ kind: "POLL", options: ["Basic", "Pro"] });
  });
});
