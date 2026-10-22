import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { WhatsAppAccount } from "@prisma/client";
import { ISP_DIGITAL, prisma, rawPrisma } from "./helpers/projectFixtures.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import type { RawIncomingMessage } from "../pipeline/types.js";
import { resetProjectCachesForTests, withProject } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import {
  claimDuePictures,
  forgetRecordedPicturesForTests,
  processPicture,
  recordMessagePictures,
  type PictureFetch,
} from "../avatars/whatsappPictures.js";

/**
 * WhatsApp profile pictures, passively (WHATSAPP_AVATARS.md): only pictures an incoming message
 * already carried are recorded, only while the project's feature is on and the server's emergency
 * switch is off, and a picture can never cost a message anything.
 */

const PPS = (n: string) => `https://pps.whatsapp.net/v/t61/${n}.jpg?oh=signed&oe=1`;
const LID = "123456789012345@lid";
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const jpeg = (w: number, h: number) =>
  new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x06, ...ascii("JFIF"),
    0xff, 0xc0, 0x00, 0x0b, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 1, 1, 0x11, 0,
    0xff, 0xda, 0x00, 0x02, 9, 9, 9, 0xff, 0xd9,
  ]);

let account: WhatsAppAccount;
let savedAutomation: boolean | null = null;
const requests: string[] = [];
const answer = (status: number, body: Uint8Array | string, type = "image/jpeg", extra: Record<string, string> = {}): PictureFetch =>
  async (url) => {
    requests.push(url);
    return new Response(typeof body === "string" ? body : Buffer.from(body), { status, headers: { "content-type": type, ...extra } });
  };

async function setFeature(enabled: boolean) {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId: ISP_DIGITAL, key: "WHATSAPP_AVATARS" } },
    create: { projectId: ISP_DIGITAL, key: "WHATSAPP_AVATARS", enabled },
    update: { enabled },
  });
  resetProjectFeatureCacheForTests();
}

const groupEvent = (over: Partial<RawIncomingMessage> = {}) => ({
  accountId: account.id,
  chatId: "120363000000000001@g.us",
  whatsappGroupId: "120363000000000001@g.us",
  senderJid: LID,
  pictures: { sender: { url: PPS("person"), tag: "t1" }, group: { url: PPS("group"), tag: "g1" } },
  ...over,
});
const rows = () => prisma.whatsAppPicture.findMany({ where: { accountId: account.id }, orderBy: { jid: "asc" } });
const inProject = <T>(fn: () => Promise<T>) => withProject(ISP_DIGITAL, fn);

beforeAll(async () => {
  savedAutomation = (await prisma.automationSettings.findFirst())?.automationEnabled ?? null;
  await prisma.automationSettings.upsert({ where: { id: "global" }, update: { automationEnabled: false }, create: { id: "global", automationEnabled: false } });
});

beforeEach(async () => {
  resetProjectCachesForTests();
  forgetRecordedPicturesForTests();
  requests.length = 0;
  delete process.env.WHATSAPP_AVATARS_DISABLED;
  account = await prisma.whatsAppAccount.create({ data: { label: `Pictures ${randomUUID()}`, status: "CONNECTED" } });
  await setFeature(true);
});

afterEach(async () => {
  delete process.env.WHATSAPP_AVATARS_DISABLED;
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: account.id } }); // cascades messages and pictures
});

afterAll(async () => {
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ISP_DIGITAL, key: "WHATSAPP_AVATARS" } });
  if (savedAutomation !== null) await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: savedAutomation } });
});

describe("recording what an event carried", () => {
  it("records the group icon and the sender's picture, keyed by the ids WhatsApp gave", async () => {
    await inProject(() => recordMessagePictures(groupEvent()));
    const all = await rows();
    expect(all.map((r) => [r.jid, r.state, r.sourceTag])).toEqual([
      ["120363000000000001@g.us", "PENDING", "g1"],
      [LID, "PENDING", "t1"],
    ]);
    expect(all.every((r) => r.projectId === ISP_DIGITAL)).toBe(true);
  });

  it("records nothing while the project's feature is off", async () => {
    await setFeature(false);
    await inProject(() => recordMessagePictures(groupEvent()));
    expect(await rows()).toHaveLength(0);
  });

  it("records nothing, and claims nothing, under the server's emergency switch", async () => {
    await inProject(() => recordMessagePictures(groupEvent()));
    process.env.WHATSAPP_AVATARS_DISABLED = "true";
    forgetRecordedPicturesForTests();
    await inProject(() => recordMessagePictures(groupEvent({ pictures: { sender: { url: PPS("p2"), tag: "t2" }, group: null } })));
    expect((await rows()).find((r) => r.jid === LID)?.sourceTag).toBe("t1");
    expect(await claimDuePictures(10)).toEqual([]);
    const first = (await rows())[0]!;
    await inProject(() => processPicture(first.id, { fetchImpl: answer(200, jpeg(96, 96)) }));
    expect(requests).toEqual([]);
  });

  it("writes once per picture version, however many messages carry it", async () => {
    await inProject(() => recordMessagePictures(groupEvent()));
    const before = (await rows()).map((r) => r.updatedAt.getTime());
    forgetRecordedPicturesForTests(); // even without the in-memory memo, the database is not rewritten
    await inProject(() => recordMessagePictures(groupEvent()));
    expect((await rows()).map((r) => r.updatedAt.getTime())).toEqual(before);
    await inProject(() => recordMessagePictures(groupEvent({ pictures: { sender: { url: PPS("p3"), tag: "t3" }, group: null } })));
    expect((await rows()).find((r) => r.jid === LID)?.sourceTag).toBe("t3");
  });

  it("never records a group, broadcast or missing id as a person", async () => {
    await inProject(() => recordMessagePictures(groupEvent({ senderJid: "120363000000000001@g.us", pictures: { sender: { url: PPS("x"), tag: "x" }, group: null } })));
    await inProject(() => recordMessagePictures(groupEvent({ senderJid: null, pictures: { sender: { url: PPS("y"), tag: "y" }, group: null } })));
    expect(await rows()).toHaveLength(0);
  });

  it("a picture never costs the message: stored even when recording cannot run", async () => {
    const raw: RawIncomingMessage = {
      accountId: account.id,
      whatsappMessageId: `false_${randomUUID()}`,
      chatId: LID,
      whatsappGroupId: null,
      senderPhone: "123456789012345",
      senderJid: LID,
      senderName: "Customer",
      direction: "INCOMING",
      body: "hello",
      timestampWa: new Date(),
      // An address that is not WhatsApp's: the provider would have dropped it; here it must still be harmless.
      pictures: { sender: { url: "http://169.254.169.254/latest", tag: "bad" }, group: null },
    };
    await processIncomingMessage(raw);
    expect(await prisma.message.count({ where: { accountId: account.id, whatsappMessageId: raw.whatsappMessageId } })).toBe(1);
  });
});

describe("fetching a recorded picture", () => {
  async function pendingPersonPicture(url = PPS("person")) {
    await inProject(() => recordMessagePictures(groupEvent({ pictures: { sender: { url, tag: "t1" }, group: null } })));
    const [claimed] = await claimDuePictures(1);
    expect(claimed).toBeTruthy();
    return claimed!;
  }

  it("stores a real, small image, then forgets WhatsApp's address", async () => {
    const row = await pendingPersonPicture();
    await inProject(() => processPicture(row.id, { fetchImpl: answer(200, jpeg(96, 96)) }));
    const stored = (await rows())[0]!;
    expect(stored).toMatchObject({ state: "STORED", mimeType: "image/jpeg", sourceUrl: null });
    expect(stored.bytes?.byteLength).toBeGreaterThan(0);
    expect(requests).toEqual([PPS("person")]);
  });

  it.each([
    ["a redirect", answer(302, "", "text/html", { location: "http://127.0.0.1/" })],
    ["an HTML page", answer(200, "<html>", "text/html")],
    ["bytes that are not an image", answer(200, "GIF89a not really", "image/jpeg")],
    ["an image larger than the cap", answer(200, new Uint8Array(200 * 1024).fill(1), "image/jpeg")],
    ["a declared size over the cap", answer(200, jpeg(96, 96), "image/jpeg", { "content-length": String(500 * 1024) })],
  ])("refuses %s and keeps nothing", async (_label, fetchImpl) => {
    const row = await pendingPersonPicture();
    await inProject(() => processPicture(row.id, { fetchImpl }));
    const after = (await rows())[0]!;
    expect(after.bytes).toBeNull();
    expect(after.state).toBe("PENDING");
    expect(after.lastError).toBeTruthy();
  });

  it("never fetches an address that is not WhatsApp's, even one already in the database", async () => {
    const row = await pendingPersonPicture();
    await prisma.whatsAppPicture.update({ where: { id: row.id }, data: { sourceUrl: "https://169.254.169.254/latest" } });
    await inProject(() => processPicture(row.id, { fetchImpl: answer(200, jpeg(96, 96)) }));
    expect(requests).toEqual([]);
  });

  it("gives up after the attempt limit and clears the address", async () => {
    const row = await pendingPersonPicture();
    await prisma.whatsAppPicture.update({ where: { id: row.id }, data: { attempts: 3 } });
    await inProject(() => processPicture(row.id, { fetchImpl: answer(500, "") }));
    expect((await rows())[0]).toMatchObject({ state: "FAILED", sourceUrl: null });
  });

  it("claims nothing for a project whose feature is off", async () => {
    await inProject(() => recordMessagePictures(groupEvent()));
    await setFeature(false);
    expect(await claimDuePictures(10)).toEqual([]);
  });
});
