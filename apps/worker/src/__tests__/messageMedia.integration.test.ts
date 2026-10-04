import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MediaStorageSettings, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { LocalMediaStorage } from "@support-automation/media-storage";
import { MESSAGE_MEDIA_SETTING_FIELD, MESSAGE_MEDIA_TYPES, type MessageMediaKind } from "@support-automation/shared";
import { prisma, rawPrisma } from "./helpers/projectFixtures.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import type { RawIncomingMessage, RawMediaDescriptor } from "../pipeline/types.js";
import {
  claimDueMediaDownloads,
  MEDIA_DOWNLOAD_MAX_ATTEMPTS,
  processMediaDownload,
  recoverStuckMediaDownloads,
  type MediaDownloadDeps,
} from "../media/mediaDownloadProcessor.js";
import { encryptLikeWhatsApp, mediaKeyKindFor } from "../media/whatsappMediaCrypto.js";
import { resetProjectCachesForTests, withProject } from "../project/context.js";
import { MockProvider } from "./mockProvider.js";
import { ISP_DIGITAL } from "./helpers/projectFixtures.js";

/**
 * WhatsApp Message & Media Storage (MEDIA_STORAGE.md), worker side: the pipeline RECORDS an
 * attachment and never fetches it; the media worker fetches, decrypts and stores the original; and
 * nothing that happens to a file can touch the message it belongs to.
 *
 * WhatsApp's media server is played by a local HTTP server holding files encrypted exactly as
 * WhatsApp encrypts them (`encryptLikeWhatsApp`, checked against OpenWA's own module in
 * whatsappMediaCrypto.test.ts).
 */

let account: WhatsAppAccount;
let group: WhatsAppGroup;
let savedSettings: MediaStorageSettings | null;
let savedAutomation: boolean | null = null;
let root: string;
let storage: LocalMediaStorage;
let server: Server;
let base: string;
const served = new Map<string, { status: number; body: Buffer }>();
const requests: string[] = [];

const fetchToTestServer: MediaDownloadDeps["fetchImpl"] = (url, init) => {
  requests.push(url);
  // Both of WhatsApp's addresses for a file — its full URL and its direct path on mmg.whatsapp.net —
  // lead to the fake media server.
  return fetch(url.replace("https://media.test", base).replace("https://mmg.whatsapp.net", base), init);
};

function deps(overrides: Partial<MediaDownloadDeps> = {}): MediaDownloadDeps {
  return { storage, fetchImpl: fetchToTestServer, minFreeBytes: 0, ...overrides };
}

const WA_TYPE: Record<MessageMediaKind, { waType: string; mime: string }> = {
  IMAGE: { waType: "image", mime: "image/jpeg" },
  VIDEO: { waType: "video", mime: "video/mp4" },
  AUDIO: { waType: "ptt", mime: "audio/ogg; codecs=opus" },
  DOCUMENT: { waType: "document", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  STICKER: { waType: "sticker", mime: "image/webp" },
  GIF: { waType: "video", mime: "video/mp4" },
  OTHER: { waType: "unknown", mime: "application/octet-stream" },
};

/** A real encrypted file on the fake media server, and the descriptor WhatsApp would send with it. */
function mediaFile(type: MessageMediaKind, opts: { size?: number; declaredSize?: number | null; withKeys?: boolean; thumbnail?: boolean } = {}) {
  const plain = randomBytes(opts.size ?? 2_000);
  const mediaKey = randomBytes(32).toString("base64");
  const { waType, mime } = WA_TYPE[type];
  const urlPath = `/mms/${randomUUID()}`;
  served.set(urlPath, { status: 200, body: encryptLikeWhatsApp(plain, mediaKey, mediaKeyKindFor(waType, mime)) });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(200)]);
  const descriptor: RawMediaDescriptor = {
    waType,
    mediaType: type,
    mimeType: mime,
    fileName: type === "DOCUMENT" ? "Invoice March.xlsx" : null,
    declaredSizeBytes: opts.declaredSize === undefined ? plain.length : opts.declaredSize,
    width: type === "IMAGE" ? 1280 : null,
    height: type === "IMAGE" ? 720 : null,
    durationSeconds: type === "AUDIO" ? 32 : null,
    isAnimated: false,
    download:
      opts.withKeys === false
        ? null
        : {
            mediaKey,
            filehash: createHash("sha256").update(plain).digest("base64"),
            encFilehash: null,
            url: `https://media.test${urlPath}`,
            directPath: urlPath,
            thumbnailJpegBase64: opts.thumbnail ? jpeg.toString("base64") : null,
          },
  };
  return { plain, descriptor, urlPath, mediaKey };
}

function raw(media: RawMediaDescriptor | null, overrides: Partial<RawIncomingMessage> = {}): RawIncomingMessage {
  return {
    accountId: account.id,
    whatsappMessageId: `false_${group.whatsappGroupId}_${randomUUID()}`,
    chatId: group.whatsappGroupId,
    whatsappGroupId: group.whatsappGroupId,
    senderPhone: "8801700000001",
    senderName: "Customer",
    direction: "INCOMING",
    body: media ? `[${media.mediaType === "AUDIO" ? "Voice message" : "Image"}]` : "hello",
    timestampWa: new Date(),
    media,
    ...overrides,
  };
}

async function setSwitches(data: Partial<MediaStorageSettings>) {
  await prisma.mediaStorageSettings.update({ where: { id: "global" }, data });
}
const ALL_ON = Object.fromEntries(Object.values(MESSAGE_MEDIA_SETTING_FIELD).map((f) => [f, true]));

async function mediaFor(whatsappMessageId: string) {
  const message = await prisma.message.findUniqueOrThrow({ where: { accountId_whatsappMessageId: { accountId: account.id, whatsappMessageId } }, include: { media: true } });
  return { message, media: message.media };
}

/** Claims and runs every due download once, as the loop would. */
async function runDownloads(d: MediaDownloadDeps = deps()) {
  const claimed = await claimDueMediaDownloads(50);
  for (const row of claimed) await withProject(row.projectId, () => processMediaDownload(row.id, d));
  return claimed.length;
}

async function readStored(key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of (await storage.get(key)).stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "media-int-"));
  storage = new LocalMediaStorage(root);
  server = createServer((req, res) => {
    const file = served.get(req.url ?? "");
    if (!file) return void res.writeHead(404).end();
    res.writeHead(file.status, { "content-length": file.body.length }).end(file.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  savedSettings = await prisma.mediaStorageSettings.findUnique({ where: { id: "global" } });
  savedAutomation = (await prisma.automationSettings.findFirst())?.automationEnabled ?? null;
  // The kill switch is off: these tests are about storage, and nothing here should try to reply.
  await prisma.automationSettings.upsert({ where: { id: "global" }, update: { automationEnabled: false }, create: { id: "global", automationEnabled: false } });
});

beforeEach(async () => {
  resetProjectCachesForTests();
  requests.length = 0;
  account = await prisma.whatsAppAccount.create({ data: { label: `Media ${randomUUID()}`, status: "CONNECTED" } });
  group = await prisma.whatsAppGroup.create({ data: { accountId: account.id, whatsappGroupId: `media-${randomUUID().slice(0, 8)}@g.us`, name: "Media group", isActive: true } });
  await setSwitches({ ...ALL_ON, retentionDays: null });
});

afterEach(async () => {
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: account.id } }); // cascades messages and media
});

afterAll(async () => {
  if (savedSettings) {
    const { id: _id, projectId: _p, updatedAt: _u, ...rest } = savedSettings;
    await setSwitches(rest);
  }
  if (savedAutomation !== null) await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: savedAutomation } });
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
  await rawPrisma.$disconnect();
});

describe("the pipeline records an attachment and never fetches it", () => {
  it("an image message is stored, and its attachment queued with everything needed to fetch it later", async () => {
    const { descriptor } = mediaFile("IMAGE");
    const r = raw(descriptor);
    await processIncomingMessage(r);
    const { message, media } = await mediaFor(r.whatsappMessageId);
    expect(message.body).toBe("[Image]");
    expect(media).toMatchObject({ status: "PENDING", mediaType: "IMAGE", waType: "image", mimeType: "image/jpeg", width: 1280, height: 720, groupId: group.id });
    expect((media!.download as { mediaKey?: string }).mediaKey).toBe(descriptor.download!.mediaKey);
    expect(requests).toEqual([]); // nothing fetched on the message path
  });

  it("text, and an outgoing message without a file, get no media row", async () => {
    const text = raw(null);
    await processIncomingMessage(text);
    expect((await mediaFor(text.whatsappMessageId)).media).toBeNull();
  });

  it("a file an executive sent from the business phone is recorded too", async () => {
    const { descriptor } = mediaFile("DOCUMENT");
    const r = raw(descriptor, { direction: "OUTGOING", body: "[Document] Invoice March.xlsx" });
    await processIncomingMessage(r);
    const { message, media } = await mediaFor(r.whatsappMessageId);
    expect(message.direction).toBe("OUTGOING");
    expect(media).toMatchObject({ status: "PENDING", mediaType: "DOCUMENT", fileName: "Invoice March.xlsx" });
  });

  it("a redelivered event never creates a second attachment", async () => {
    const { descriptor } = mediaFile("IMAGE");
    const r = raw(descriptor);
    await processIncomingMessage(r);
    await processIncomingMessage(r);
    const rows = await prisma.messageMedia.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
  });

  it("an attachment that cannot be recorded does not cost the message", async () => {
    // An attachment the database refuses outright (a type outside the enum) — the worst case.
    const { descriptor } = mediaFile("IMAGE");
    const r = raw({ ...descriptor, mediaType: "HOLOGRAM" as MessageMediaKind });
    await processIncomingMessage(r);
    const { message, media } = await mediaFor(r.whatsappMessageId);
    expect(message.body).toBe("[Image]");
    expect(media).toBeNull();
    expect(message.processingStatus).not.toBe("PENDING"); // the pipeline carried on and settled it
  });
});

describe("each media type has its own switch", () => {
  for (const type of MESSAGE_MEDIA_TYPES) {
    it(`${type}: on → queued, off → recorded as not stored, with nothing kept to fetch it`, async () => {
      const field = MESSAGE_MEDIA_SETTING_FIELD[type];
      const on = raw(mediaFile(type).descriptor);
      await processIncomingMessage(on);
      expect((await mediaFor(on.whatsappMessageId)).media).toMatchObject({ status: "PENDING", mediaType: type });

      await setSwitches({ [field]: false });
      const off = raw(mediaFile(type).descriptor);
      await processIncomingMessage(off);
      const { message, media } = await mediaFor(off.whatsappMessageId);
      expect(message.body).toBeTruthy(); // the message itself is always stored
      expect(media).toMatchObject({ status: "NOT_STORED", statusReason: "SETTING_OFF", mediaType: type });
      expect(media!.download).toBeNull();
    });
  }

  it("turning a type off does not touch files already stored", async () => {
    const r = raw(mediaFile("VIDEO").descriptor);
    await processIncomingMessage(r);
    await runDownloads();
    const before = (await mediaFor(r.whatsappMessageId)).media!;
    expect(before.status).toBe("STORED");
    await setSwitches({ storeVideos: false });
    await runDownloads();
    const after = (await mediaFor(r.whatsappMessageId)).media!;
    expect(after.status).toBe("STORED");
    expect(await storage.exists(after.storageKey!)).toBe(true);
  });

  it("a file announced larger than its type's limit is refused before a byte is fetched", async () => {
    const r = raw(mediaFile("IMAGE", { declaredSize: 900 * 1024 * 1024 }).descriptor);
    await processIncomingMessage(r);
    expect((await mediaFor(r.whatsappMessageId)).media).toMatchObject({ status: "NOT_STORED", statusReason: "TOO_LARGE" });
    await runDownloads();
    expect(requests).toEqual([]);
  });
});

describe("the media worker", () => {
  it("stores the original byte for byte, with its SHA-256, WhatsApp's preview beside it, and the keys dropped", async () => {
    const { plain, descriptor } = mediaFile("IMAGE", { size: 250_000, thumbnail: true });
    const r = raw(descriptor);
    await processIncomingMessage(r);
    expect(await runDownloads()).toBe(1);
    const media = (await mediaFor(r.whatsappMessageId)).media!;
    expect(media).toMatchObject({ status: "STORED", statusReason: null, attemptCount: 1 });
    expect(Number(media.sizeBytes)).toBe(plain.length);
    expect(media.sha256).toBe(createHash("sha256").update(plain).digest("hex"));
    expect(media.download).toBeNull();
    expect(media.storageKey).toBe(`whatsapp/${ISP_DIGITAL}/${account.id}/${group.id}/${media.createdAt.getUTCFullYear()}/${String(media.createdAt.getUTCMonth() + 1).padStart(2, "0")}/${media.id}`);
    expect((await readStored(media.storageKey!)).equals(plain)).toBe(true);
    expect(media.thumbnailKey).toBe(`${media.storageKey}.thumb`);
    expect((await readStored(media.thumbnailKey!))[0]).toBe(0xff);
  });

  it("a file WhatsApp no longer has fails for good — and the message is untouched", async () => {
    const { descriptor, urlPath } = mediaFile("VIDEO");
    served.set(urlPath, { status: 404, body: Buffer.alloc(0) });
    const r = raw(descriptor);
    await processIncomingMessage(r);
    const { media: _pending, ...before } = (await mediaFor(r.whatsappMessageId)).message;
    await runDownloads();
    const { message, media } = await mediaFor(r.whatsappMessageId);
    expect(media).toMatchObject({ status: "FAILED", statusReason: "EXPIRED" });
    const { media: _failed, ...after } = message;
    expect(after).toEqual(before);
  });

  it("a failure that may pass is retried later, then gives up visibly", async () => {
    const { descriptor, urlPath } = mediaFile("AUDIO");
    served.set(urlPath, { status: 503, body: Buffer.from("busy") });
    const r = raw(descriptor);
    await processIncomingMessage(r);
    const t0 = Date.now();
    await runDownloads();
    let media = (await mediaFor(r.whatsappMessageId)).media!;
    expect(media).toMatchObject({ status: "PENDING", statusReason: "DOWNLOAD_FAILED", attemptCount: 1 });
    expect(media.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(t0 + 59_000);
    expect(media.lastError).toMatch(/503/);
    // Nothing is due yet.
    expect(await runDownloads()).toBe(0);
    for (let i = 1; i < MEDIA_DOWNLOAD_MAX_ATTEMPTS; i++) {
      await prisma.messageMedia.update({ where: { id: media.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await runDownloads();
    }
    media = (await mediaFor(r.whatsappMessageId)).media!;
    expect(media).toMatchObject({ status: "FAILED", statusReason: "DOWNLOAD_FAILED", attemptCount: MEDIA_DOWNLOAD_MAX_ATTEMPTS });
  });

  it("a type switched off between arrival and download is not fetched", async () => {
    const r = raw(mediaFile("STICKER").descriptor);
    await processIncomingMessage(r);
    await setSwitches({ storeStickers: false });
    await runDownloads();
    expect((await mediaFor(r.whatsappMessageId)).media).toMatchObject({ status: "NOT_STORED", statusReason: "SETTING_OFF" });
    expect(requests).toEqual([]);
  });

  it("with no storage configured, or a nearly full disk, nothing is written and the reason is recorded", async () => {
    const r = raw(mediaFile("IMAGE").descriptor);
    await processIncomingMessage(r);
    await runDownloads(deps({ storage: null }));
    let media = (await mediaFor(r.whatsappMessageId)).media!;
    expect(media).toMatchObject({ status: "PENDING", statusReason: "STORAGE_UNAVAILABLE" });

    await prisma.messageMedia.update({ where: { id: media.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await runDownloads(deps({ minFreeBytes: Number.MAX_SAFE_INTEGER }));
    media = (await mediaFor(r.whatsappMessageId)).media!;
    expect(media).toMatchObject({ status: "PENDING", statusReason: "DISK_LOW" });
    expect(requests).toEqual([]);
  });

  it("a message that arrived without the file's details gets them from the live session", async () => {
    const { plain, descriptor } = mediaFile("DOCUMENT");
    const r = raw({ ...descriptor, download: null });
    await processIncomingMessage(r);

    // Not connected: it waits, saying why.
    await runDownloads(deps({ providers: { get: () => undefined } }));
    let media = (await mediaFor(r.whatsappMessageId)).media!;
    expect(media).toMatchObject({ status: "PENDING", statusReason: "NO_DOWNLOAD_INFO" });

    const provider = new MockProvider();
    provider.connectionStatus = "CONNECTED";
    provider.mediaDownloadInfo.set(r.whatsappMessageId, descriptor.download!);
    await prisma.messageMedia.update({ where: { id: media.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await runDownloads(deps({ providers: { get: (id) => (id === account.id ? provider : undefined) } }));
    media = (await mediaFor(r.whatsappMessageId)).media!;
    expect(media.status).toBe("STORED");
    expect((await readStored(media.storageKey!)).equals(plain)).toBe(true);
  });

  it("each download is claimed once, however many claimers ask at the same moment", async () => {
    for (let i = 0; i < 6; i++) await processIncomingMessage(raw(mediaFile("IMAGE").descriptor));
    const [a, b, c] = await Promise.all([claimDueMediaDownloads(10), claimDueMediaDownloads(10), claimDueMediaDownloads(10)]);
    const mine = new Set((await prisma.messageMedia.findMany({ where: { accountId: account.id }, select: { id: true } })).map((m) => m.id));
    const claimedMine = [...a!, ...b!, ...c!].filter((row) => mine.has(row.id)).map((row) => row.id);
    expect(claimedMine).toHaveLength(6);
    expect(new Set(claimedMine).size).toBe(6);
  });

  it("a download that died with its process is put back — at boot all of them, later only stale ones", async () => {
    await processIncomingMessage(raw(mediaFile("IMAGE").descriptor));
    await processIncomingMessage(raw(mediaFile("IMAGE").descriptor));
    const rows = await prisma.messageMedia.findMany({ where: { accountId: account.id } });
    await prisma.messageMedia.update({ where: { id: rows[0]!.id }, data: { status: "DOWNLOADING", downloadStartedAt: new Date(Date.now() - 2 * 60 * 60_000) } });
    await prisma.messageMedia.update({ where: { id: rows[1]!.id }, data: { status: "DOWNLOADING", downloadStartedAt: new Date() } });

    await recoverStuckMediaDownloads();
    expect((await prisma.messageMedia.findUniqueOrThrow({ where: { id: rows[0]!.id } })).status).toBe("PENDING");
    expect((await prisma.messageMedia.findUniqueOrThrow({ where: { id: rows[1]!.id } })).status).toBe("DOWNLOADING");

    await recoverStuckMediaDownloads({ atBoot: true });
    expect((await prisma.messageMedia.findUniqueOrThrow({ where: { id: rows[1]!.id } })).status).toBe("PENDING");
  });
});
