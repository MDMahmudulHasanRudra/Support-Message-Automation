import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Team, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { LocalMediaStorage } from "@support-automation/media-storage";
import { prisma, rawPrisma, inIsp, ISP_DIGITAL } from "./helpers/projectFixtures.js";
import { processIncomingMessage, storeMissedMessage } from "../pipeline/processIncomingMessage.js";
import { recordMessageAck, recordMessageRevoked, storeHistoryMessages } from "../pipeline/messageUpdates.js";
import type { RawIncomingMessage } from "../pipeline/types.js";
import { processOne } from "../queue/outboundQueueProcessor.js";
import { processOneCommand } from "../commands/commandProcessor.js";
import { resetProjectCachesForTests } from "../project/context.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Chat v2 rich messaging (CHAT_RICH_MESSAGING.md), against a real database:
 *   - receipts only rise, never rewrite a time, and only ever touch our own sends;
 *   - a deletion keeps the row and its text and is never stored as a message of its own;
 *   - history loaded on request is STORED ONLY — with response tracking switched on, so a wait would
 *     open if that path ran the pipeline (the control case proves it would);
 *   - polls, locations, stickers and forwards leave through the one queue, re-checked at send time;
 *   - the star / pin / archive / load commands write what WhatsApp accepted and nothing sooner.
 */

const RUN = String(randomInt(100_000, 999_999));
let seq = 0;
const phone = () => `8801${RUN}${String(++seq).padStart(3, "0")}`;
const CUSTOMER = "8801912399901";

let account: WhatsAppAccount;
let other: WhatsAppAccount;
let group: WhatsAppGroup;
let support: Team;
let savedTeams: string[] = [];
let savedAutomation: boolean | null = null;
let mediaDir = "";

function raw(overrides: Partial<RawIncomingMessage> = {}): RawIncomingMessage {
  return {
    accountId: account.id,
    whatsappMessageId: `false_${group.whatsappGroupId}_${randomUUID()}`,
    chatId: group.whatsappGroupId,
    whatsappGroupId: group.whatsappGroupId,
    senderPhone: CUSTOMER,
    senderJid: `${CUSTOMER}@c.us`,
    senderName: null,
    direction: "INCOMING",
    body: "is the internet down?",
    timestampWa: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

async function storedOutgoing(body = "Checking now") {
  return prisma.message.create({
    data: {
      projectId: ISP_DIGITAL,
      accountId: account.id,
      groupId: group.id,
      chatId: group.whatsappGroupId,
      whatsappMessageId: `true_${group.whatsappGroupId}_${randomUUID()}`,
      senderPhone: "8801000000000",
      direction: "OUTGOING",
      body,
      normalizedBody: body,
      timestampWa: new Date(),
      processingStatus: "PROCESSED",
    },
  });
}

async function queue(contentType: "POLL" | "LOCATION" | "STICKER" | "FORWARD" | "MEDIA", content: object, overrides: Record<string, unknown> = {}) {
  return prisma.outboundMessage.create({
    data: {
      projectId: ISP_DIGITAL,
      accountId: account.id,
      chatId: group.whatsappGroupId,
      toPhone: group.whatsappGroupId,
      body: `[${contentType}]`,
      contentType,
      content,
      actionType: "MANUAL_REPLY",
      idempotencyKey: `rich-${RUN}-${randomUUID()}`,
      scheduledAt: new Date(Date.now() - 60_000),
      ...overrides,
    },
  });
}

async function drain(provider: MockProvider, id: string) {
  for (let i = 0; i < 50; i++) {
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    if (row.status !== "PENDING" && row.status !== "PROCESSING") return row;
    if (!(await inIsp(() => processOne(provider)))) break;
  }
  return prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
}

beforeAll(async () => {
  const settings = await prisma.supportActivitySettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  savedTeams = settings.responseTrackingTeamIds;
  savedAutomation = (await prisma.automationSettings.findFirst())?.automationEnabled ?? null;
  // Rules and AI are not under test; the kill switch keeps the pipeline from queueing replies.
  await prisma.automationSettings.upsert({ where: { id: "global" }, update: { automationEnabled: false }, create: { id: "global", automationEnabled: false } });
  mediaDir = await mkdtemp(join(tmpdir(), "rich-media-"));
  process.env.MEDIA_STORAGE_DIR = mediaDir;
});

beforeEach(async () => {
  resetProjectCachesForTests();
  const tag = randomUUID().slice(0, 8);
  // Response tracking ON: a customer message stored through the pipeline opens a wait.
  support = await prisma.team.create({ data: { name: `Support ${tag}` } });
  await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { responseTrackingTeamIds: [support.id] } });
  account = await prisma.whatsAppAccount.create({ data: { label: `Rich ${tag}`, status: "CONNECTED" } });
  other = await prisma.whatsAppAccount.create({ data: { label: `Rich other ${tag}`, status: "CONNECTED" } });
  group = await prisma.whatsAppGroup.create({
    data: { accountId: account.id, whatsappGroupId: `1203632${RUN}${tag.replace(/\D/g, "")}@g.us`, name: `Rich ${tag}`, isActive: true, isMonitored: true },
  });
});

afterEach(async () => {
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: [account.id, other.id] } } });
  await rawPrisma.team.deleteMany({ where: { id: support.id } });
});

afterAll(async () => {
  await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { responseTrackingTeamIds: savedTeams } });
  // Put the kill switch back exactly as found — including "no settings row at all", which this file's
  // upsert would otherwise leave behind as automation OFF for every file that runs after it.
  if (savedAutomation !== null) await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: savedAutomation } });
  else await prisma.automationSettings.deleteMany({ where: { id: "global" } });
  delete process.env.MEDIA_STORAGE_DIR;
  await rm(mediaDir, { recursive: true, force: true });
  await rawPrisma.$disconnect();
});

describe("receipts", () => {
  it("rise only, and each time is written once", async () => {
    const m = await storedOutgoing();
    expect(await recordMessageAck(account.id, m.whatsappMessageId, 2)).toBe(true);
    const delivered = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(delivered.ackLevel).toBe(2);
    expect(delivered.deliveredAt).not.toBeNull();
    expect(delivered.readAt).toBeNull();

    // A late "sent" after "delivered" changes nothing.
    expect(await recordMessageAck(account.id, m.whatsappMessageId, 1)).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(await recordMessageAck(account.id, m.whatsappMessageId, 3)).toBe(true);
    const read = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(read.ackLevel).toBe(3);
    expect(read.readAt).not.toBeNull();
    expect(read.deliveredAt!.getTime()).toBe(delivered.deliveredAt!.getTime());
  });

  it("racing acks settle on the highest level", async () => {
    const m = await storedOutgoing();
    await Promise.all([recordMessageAck(account.id, m.whatsappMessageId, 3), recordMessageAck(account.id, m.whatsappMessageId, 2), recordMessageAck(account.id, m.whatsappMessageId, 1)]);
    const row = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.ackLevel).toBe(3);
    expect(row.deliveredAt).not.toBeNull();
    expect(row.readAt).not.toBeNull();
  });

  it("never touch a customer's message, another account's copy, or a level that is not a receipt", async () => {
    await processIncomingMessage(raw({ whatsappMessageId: `false_x_${RUN}_in` }));
    expect(await recordMessageAck(account.id, `false_x_${RUN}_in`, 3)).toBe(false);
    const m = await storedOutgoing();
    expect(await recordMessageAck(other.id, m.whatsappMessageId, 3)).toBe(false);
    expect(await recordMessageAck(account.id, m.whatsappMessageId, 0)).toBe(false);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: m.id } })).ackLevel).toBeNull();
  });

  it("start from the level our own echo carried, and a poll keeps its details", async () => {
    const echo = raw({ direction: "OUTGOING", senderPhone: "8801000000000", ackLevel: 1, body: "[Poll] Which plan?", richContent: { kind: "POLL", name: "Which plan?", options: ["Basic", "Pro"], allowMultiple: false } });
    await processIncomingMessage(echo);
    const row = await prisma.message.findFirstOrThrow({ where: { accountId: account.id, whatsappMessageId: echo.whatsappMessageId } });
    expect(row.ackLevel).toBe(1);
    expect(row.deliveredAt).toBeNull();
    expect(row.richContent).toEqual({ kind: "POLL", name: "Which plan?", options: ["Basic", "Pro"], allowMultiple: false });
  });
});

describe("a customer's location", () => {
  it("is stored with its coordinates, and has no receipt", async () => {
    const location = raw({ body: "[Location] Our shop", ackLevel: 3, richContent: { kind: "LOCATION", latitude: 23.8103, longitude: 90.4125, name: "Our shop" } });
    await processIncomingMessage(location);
    const row = await prisma.message.findFirstOrThrow({ where: { accountId: account.id, whatsappMessageId: location.whatsappMessageId } });
    expect(row.richContent).toEqual({ kind: "LOCATION", latitude: 23.8103, longitude: 90.4125, name: "Our shop" });
    expect(row.ackLevel).toBeNull();
  });
});

describe("deleted for everyone", () => {
  it("marks the stored original once and keeps its text", async () => {
    const m = await storedOutgoing("wrong price, sorry");
    expect(await recordMessageRevoked(account.id, m.whatsappMessageId)).toBe(true);
    const first = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(first.revokedAt).not.toBeNull();
    expect(first.body).toBe("wrong price, sorry");
    expect(await recordMessageRevoked(account.id, m.whatsappMessageId)).toBe(false);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: m.id } })).revokedAt!.getTime()).toBe(first.revokedAt!.getTime());
  });

  it("arriving through the pipeline marks the original and stores no message of its own", async () => {
    const original = raw({ body: "my bill is wrong" });
    await processIncomingMessage(original);
    const before = await prisma.message.count({ where: { accountId: account.id } });
    await processIncomingMessage({ ...original, body: "", revoked: true });
    expect(await prisma.message.count({ where: { accountId: account.id } })).toBe(before);
    const row = await prisma.message.findFirstOrThrow({ where: { accountId: account.id, whatsappMessageId: original.whatsappMessageId } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.body).toBe("my bill is wrong");
  });
});

describe("history loaded on request", () => {
  it("control: the same old customer message through the catch-up path DOES open a wait", async () => {
    // Without this the assertion below could pass because tracking was simply off.
    await storeMissedMessage(raw({ timestampWa: new Date(Date.now() - 30 * 86_400_000) }));
    expect(await prisma.supportResponseEpisode.count({ where: { groupId: group.id } })).toBe(1);
  });

  it("is stored for reading only: no wait, case, escalation, mood event or reply", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    const page = [
      raw({ timestampWa: old, body: "internet down since morning" }),
      raw({ timestampWa: new Date(old.getTime() + 60_000), body: "anyone there??", senderPhone: phone() }),
      raw({ direction: "OUTGOING", senderPhone: "8801000000000", timestampWa: new Date(old.getTime() + 120_000), body: "Checking", ackLevel: 3 }),
    ];
    const result = await storeHistoryMessages(account.id, group.whatsappGroupId, page);
    expect(result).toMatchObject({ seen: 3, stored: 3, markedDeleted: 0 });
    expect(result.oldestAt!.getTime()).toBe(old.getTime());

    const rows = await prisma.message.findMany({ where: { accountId: account.id }, orderBy: { timestampWa: "asc" } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.loadedFromHistoryAt !== null)).toBe(true);
    expect(rows.map((r) => r.processingStatus)).toEqual(["IGNORED", "IGNORED", "PROCESSED"]);
    expect(rows[2]!.ackLevel).toBe(3);
    expect(rows.every((r) => r.groupId === group.id)).toBe(true);

    expect(await prisma.supportResponseEpisode.count({ where: { groupId: group.id } })).toBe(0);
    expect(await prisma.supportAssignment.count({ where: { whatsappGroupId: group.whatsappGroupId } })).toBe(0);
    expect(await prisma.supportEscalationCase.count({ where: { groupId: group.id } })).toBe(0);
    expect(await prisma.customerMoodEvent.count({ where: { messageId: { in: rows.map((r) => r.id) } } })).toBe(0);
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(0);
    expect(await prisma.processingCheckpoint.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("stores each message once, only this chat's, and marks a stored one the page shows deleted", async () => {
    const known = raw({ body: "first" });
    await storeHistoryMessages(account.id, group.whatsappGroupId, [known]);
    const elsewhere = raw({ chatId: "1203639999999999@g.us", whatsappGroupId: "1203639999999999@g.us" });
    const result = await storeHistoryMessages(account.id, group.whatsappGroupId, [known, { ...known, body: "", revoked: true }, elsewhere]);
    // `known` appears twice (once stored, once revoked): the stored copy is marked, not duplicated.
    expect(result).toMatchObject({ seen: 2, stored: 0, markedDeleted: 1 });
    expect(await prisma.message.count({ where: { accountId: account.id } })).toBe(1);
    expect((await prisma.message.findFirstOrThrow({ where: { accountId: account.id } })).revokedAt).not.toBeNull();
  });

  it("is refused for anything that is not a group or a personal chat", async () => {
    const result = await storeHistoryMessages(account.id, "status@broadcast", [raw({ chatId: "status@broadcast", whatsappGroupId: null })]);
    expect(result.stored).toBe(0);
  });
});

describe("rich sends leave through the one queue", () => {
  it("a poll reaches the provider re-validated, to a group", async () => {
    const provider = new MockProvider();
    const row = await queue("POLL", { name: " Which plan? ", options: ["Basic", "Pro"], allowMultiple: true });
    const settled = await drain(provider, row.id);
    expect(settled.status).toBe("SENT");
    expect(settled.providerMessageId).toBe("mock-rich-id");
    expect(provider.richSends).toEqual([{ kind: "POLL", chatId: group.whatsappGroupId, detail: { name: "Which plan?", options: ["Basic", "Pro"], allowMultiple: true } }]);
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("an invalid poll, a poll to a person, or a rich row nobody typed is failed without sending", async () => {
    const provider = new MockProvider();
    provider.personalChats.add("8801711111111@c.us");
    const bad = await queue("POLL", { name: "Q", options: ["only one"] });
    const personal = await queue("POLL", { name: "Q", options: ["a", "b"] }, { chatId: "8801711111111@c.us", toPhone: "8801711111111@c.us" });
    const automated = await queue("LOCATION", { latitude: 23.8, longitude: 90.4, name: "" }, { actionType: "AUTO_REPLY" });
    // Automation is paused in this file, so an AUTO_REPLY is cancelled by the kill switch first;
    // switch it on for that row so it reaches the rich-content guard.
    await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: true } });
    try {
      for (const id of [bad.id, personal.id, automated.id]) expect((await drain(provider, id)).status).toBe("FAILED");
    } finally {
      await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: false } });
    }
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: automated.id } })).failureReason).toMatch(/typed in WhatsApp Chat/);
    expect(provider.richSends).toHaveLength(0);
  });

  it("a location is sent with its validated coordinates", async () => {
    const provider = new MockProvider();
    const row = await queue("LOCATION", { latitude: "23.8103", longitude: "90.4125", name: "Office" });
    expect((await drain(provider, row.id)).status).toBe("SENT");
    expect(provider.richSends[0]).toMatchObject({ kind: "LOCATION", detail: { latitude: 23.8103, longitude: 90.4125, name: "Office" } });
  });

  it("a sticker is sent from the stored file as it is, and a file that is not a stored WebP is refused", async () => {
    const bytes = Buffer.from(`RIFF....WEBPVP8 sticker-${RUN}`);
    const key = `media/${randomUUID()}`;
    await new LocalMediaStorage(mediaDir).put(key, bytes);
    const source = await storedOutgoing("[Sticker]");
    const media = await prisma.messageMedia.create({
      data: { messageId: source.id, accountId: account.id, mediaType: "STICKER", waType: "sticker", mimeType: "image/webp", status: "STORED", sizeBytes: BigInt(bytes.length), storageKey: key, isAnimated: true },
    });
    const provider = new MockProvider();
    expect((await drain(provider, (await queue("STICKER", { mediaId: media.id })).id)).status).toBe("SENT");
    expect(provider.richSends[0]).toEqual({ kind: "STICKER", chatId: group.whatsappGroupId, detail: { webpBase64: bytes.toString("base64"), animated: true } });

    await prisma.messageMedia.update({ where: { id: media.id }, data: { status: "DELETED" } });
    const refused = await drain(provider, (await queue("STICKER", { mediaId: media.id })).id);
    expect(refused.status).toBe("FAILED");
    expect(refused.failureReason).toMatch(/no longer stored/);
    expect(provider.richSends).toHaveLength(1);
  });

  it("a forward goes only from a stored, undeleted message of the same account", async () => {
    const provider = new MockProvider();
    const mine = await storedOutgoing("Our hours are 9–6");
    expect((await drain(provider, (await queue("FORWARD", { sourceMessageId: mine.id })).id)).status).toBe("SENT");
    expect(provider.richSends[0]).toEqual({ kind: "FORWARD", chatId: group.whatsappGroupId, detail: mine.whatsappMessageId });

    const theirs = await prisma.message.create({
      data: { projectId: ISP_DIGITAL, accountId: other.id, chatId: "x@g.us", whatsappMessageId: `x_${randomUUID()}`, senderPhone: "1", direction: "INCOMING", body: "b", normalizedBody: "b", timestampWa: new Date() },
    });
    await prisma.message.update({ where: { id: mine.id }, data: { revokedAt: new Date() } });
    for (const sourceMessageId of [theirs.id, mine.id, "missing"]) {
      expect((await drain(provider, (await queue("FORWARD", { sourceMessageId })).id)).status).toBe("FAILED");
    }
    expect(provider.richSends).toHaveLength(1);
  });

  it("a file goes once, exactly as stored and re-checked, and its upload is removed after sending", async () => {
    const bytes = Buffer.concat([Buffer.from("%PDF-1.7 "), Buffer.from(`bill-${RUN}`)]);
    const key = `outbound/${ISP_DIGITAL}/${account.id}/2026/10/${randomUUID()}`;
    const storage = new LocalMediaStorage(mediaDir);
    await storage.put(key, bytes);
    const content = { storageKey: key, fileName: "bill.pdf", mimeType: "application/pdf", sizeBytes: bytes.length, kind: "DOCUMENT", caption: "Your bill" };
    const provider = new MockProvider();
    expect((await drain(provider, (await queue("MEDIA", content)).id)).status).toBe("SENT");
    expect(provider.richSends).toEqual([
      {
        kind: "MEDIA",
        chatId: group.whatsappGroupId,
        detail: { base64: bytes.toString("base64"), mimeType: "application/pdf", fileName: "bill.pdf", caption: "Your bill", asDocument: true, voiceNote: false },
      },
    ]);
    // Gone after sending: a row recovered later cannot send it a second time.
    expect(await storage.exists(key)).toBe(false);
    const again = await drain(provider, (await queue("MEDIA", content)).id);
    expect(again.status).toBe("FAILED");
    expect(again.failureReason).toMatch(/could not be read from storage/);
    expect(provider.richSends).toHaveLength(1);
  });

  it("a file is refused unless the row and the stored bytes still pass every check", async () => {
    const storage = new LocalMediaStorage(mediaDir);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100, 1)]);
    const put = async (bytes: Buffer, projectId = ISP_DIGITAL) => {
      const key = `outbound/${projectId}/${account.id}/2026/10/${randomUUID()}`;
      await storage.put(key, bytes);
      return key;
    };
    const base = { fileName: "a.jpg", mimeType: "image/jpeg", kind: "IMAGE", caption: "" };
    const provider = new MockProvider();
    const cases: Array<[object, RegExp]> = [
      // Another project's upload, even one that really exists.
      [{ ...base, storageKey: await put(jpeg, "proj_other"), sizeBytes: jpeg.length }, /not this project's/],
      // The bytes changed after the check: a program in place of the photo.
      [{ ...base, storageKey: await put(exe), sizeBytes: exe.length }, /not the file that was checked/],
      // The row's size disagrees with the stored file.
      [{ ...base, storageKey: await put(jpeg), sizeBytes: jpeg.length + 5 }, /could not be read/],
      [{ ...base, storageKey: await put(jpeg), sizeBytes: jpeg.length, fileName: "a.exe" }, /name is not allowed/],
    ];
    for (const [content, reason] of cases) {
      const row = await drain(provider, (await queue("MEDIA", content)).id);
      expect(row.status).toBe("FAILED");
      expect(row.failureReason).toMatch(reason);
    }
    // Only a person composes a file.
    const automated = await drain(provider, (await queue("MEDIA", { ...base, storageKey: await put(jpeg), sizeBytes: jpeg.length }, { actionType: "AUTO_REPLY" })).id);
    expect(automated.status).not.toBe("SENT");
    expect(provider.richSends).toHaveLength(0);
  });

  it("a voice note and a photo go in their own form", async () => {
    const storage = new LocalMediaStorage(mediaDir);
    const ogg = Buffer.alloc(120, 0);
    ogg.write("OggS", 0, "latin1");
    ogg.write("OpusHead", 28, "latin1");
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 2)]);
    const provider = new MockProvider();
    for (const [bytes, meta] of [
      [ogg, { fileName: "v.ogg", mimeType: "audio/ogg", kind: "VOICE", caption: "" }],
      [jpeg, { fileName: "p.jpg", mimeType: "image/jpeg", kind: "IMAGE", caption: "Router photo" }],
    ] as const) {
      const key = `outbound/${ISP_DIGITAL}/${account.id}/2026/10/${randomUUID()}`;
      await storage.put(key, bytes);
      expect((await drain(provider, (await queue("MEDIA", { ...meta, storageKey: key, sizeBytes: bytes.length })).id)).status).toBe("SENT");
    }
    expect(provider.richSends.map((s) => s.detail)).toMatchObject([
      { voiceNote: true, asDocument: false, mimeType: "audio/ogg" },
      { voiceNote: false, asDocument: false, caption: "Router photo" },
    ]);
  });

  it("a plain text reply is untouched by all of this", async () => {
    const provider = new MockProvider();
    const row = await prisma.outboundMessage.create({
      data: { projectId: ISP_DIGITAL, accountId: account.id, chatId: group.whatsappGroupId, toPhone: group.whatsappGroupId, body: `text ${RUN}`, actionType: "MANUAL_REPLY", idempotencyKey: `rich-${RUN}-${randomUUID()}`, scheduledAt: new Date(Date.now() - 60_000) },
    });
    expect((await drain(provider, row.id)).status).toBe("SENT");
    expect(provider.sentMessages).toEqual([{ chatId: group.whatsappGroupId, body: `text ${RUN}` }]);
    expect(provider.richSends).toHaveLength(0);
  });
});

describe("commands", () => {
  async function run(type: "STAR_MESSAGE" | "PIN_CHAT" | "ARCHIVE_CHAT" | "LOAD_EARLIER_MESSAGES", payload: object, provider: MockProvider) {
    const command = await prisma.workerCommand.create({ data: { type, accountId: account.id, payload } });
    // The command queue is one global oldest-first line, so an older row another file left PENDING can
    // be claimed first: keep claiming until THIS command has settled.
    for (let i = 0; i < 20; i++) {
      const row = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
      if (row.status !== "PENDING" && row.status !== "PROCESSING") return row;
      if (!(await processOneCommand(account.id, provider))) break;
    }
    return prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
  }

  it("STAR_MESSAGE writes the star only after WhatsApp accepted it", async () => {
    const m = await storedOutgoing();
    const provider = new MockProvider();
    provider.nextStarResult = { success: false, error: "no" };
    expect((await run("STAR_MESSAGE", { messageId: m.id, whatsappMessageId: m.whatsappMessageId, star: true }, provider)).status).toBe("FAILED");
    expect((await prisma.message.findUniqueOrThrow({ where: { id: m.id } })).starredAt).toBeNull();

    provider.nextStarResult = { success: true };
    expect((await run("STAR_MESSAGE", { messageId: m.id, whatsappMessageId: m.whatsappMessageId, star: true }, provider)).status).toBe("DONE");
    expect((await prisma.message.findUniqueOrThrow({ where: { id: m.id } })).starredAt).not.toBeNull();
    expect((await run("STAR_MESSAGE", { messageId: m.id, whatsappMessageId: m.whatsappMessageId, star: false }, provider)).status).toBe("DONE");
    expect((await prisma.message.findUniqueOrThrow({ where: { id: m.id } })).starredAt).toBeNull();
  });

  it("STAR_MESSAGE never stars another account's row through its payload", async () => {
    const theirs = await prisma.message.create({
      data: { projectId: ISP_DIGITAL, accountId: other.id, chatId: "x@g.us", whatsappMessageId: `x_${randomUUID()}`, senderPhone: "1", direction: "INCOMING", body: "b", normalizedBody: "b", timestampWa: new Date() },
    });
    await run("STAR_MESSAGE", { messageId: theirs.id, whatsappMessageId: theirs.whatsappMessageId, star: true }, new MockProvider());
    expect((await prisma.message.findUniqueOrThrow({ where: { id: theirs.id } })).starredAt).toBeNull();
  });

  it("PIN_CHAT / ARCHIVE_CHAT report whether anything changed", async () => {
    const provider = new MockProvider();
    expect((await run("PIN_CHAT", { chatId: group.whatsappGroupId, pin: true }, provider)).result).toMatchObject({ success: true, changed: true });
    expect((await run("ARCHIVE_CHAT", { chatId: group.whatsappGroupId, archive: true }, provider)).result).toMatchObject({ success: true, changed: false });
    expect(provider.chatStates).toEqual([{ chatId: group.whatsappGroupId, pin: true }, { chatId: group.whatsappGroupId, archive: true }]);
    expect((await run("PIN_CHAT", { chatId: group.whatsappGroupId }, provider)).status).toBe("FAILED");
  });

  it("LOAD_EARLIER_MESSAGES stores the page and reports it; a failed read stores nothing", async () => {
    const provider = new MockProvider();
    provider.earlierMessages = [raw({ timestampWa: new Date(Date.now() - 40 * 86_400_000), body: "old question" })];
    const done = await run("LOAD_EARLIER_MESSAGES", { chatId: group.whatsappGroupId }, provider);
    expect(done.status).toBe("DONE");
    expect(done.result).toMatchObject({ success: true, seen: 1, stored: 1, reachedStart: false });
    expect(await prisma.supportResponseEpisode.count({ where: { groupId: group.id } })).toBe(0);

    provider.earlierMessages = null;
    const failed = await run("LOAD_EARLIER_MESSAGES", { chatId: group.whatsappGroupId }, provider);
    expect(failed.status).toBe("FAILED");
    expect(await prisma.message.count({ where: { accountId: account.id } })).toBe(1);
  });
});
