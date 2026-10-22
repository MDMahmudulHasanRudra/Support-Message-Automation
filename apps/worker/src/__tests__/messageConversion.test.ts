import { describe, expect, it, vi } from "vitest";
import { createSenderResolver } from "@support-automation/shared";

/**
 * Who sent a message, as the provider hands it to the pipeline (WHATSAPP_IDENTITY.md §2).
 *
 * The domain of the sender id is the only thing that tells a phone number from a WhatsApp private id
 * (LID), and `senderPhone` strips it — so `senderJid` keeps it. A group message WhatsApp named no
 * author for falls back to the GROUP's own id; kept with its `@g.us`, the identity rule reads it as
 * not a person and never credits it to a colleague. Pure — no database, no browser.
 */

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: { IMAGE: "image", VIDEO: "video", AUDIO: "audio", VOICE: "ptt", DOCUMENT: "document", STICKER: "sticker", LOCATION: "location" },
}));

const GROUP = "120363000000000001@g.us";

async function convert(message: Record<string, unknown>) {
  const { toRawIncomingMessage } = await import("../provider/openwa/OpenWAProvider.js");
  return toRawIncomingMessage("acc-1", { id: "false_x_ABC", timestamp: 1_700_000_000, body: "hi", ...message } as never);
}

describe("toRawIncomingMessage — the sender", () => {
  it("keeps a group author's LID with its domain, and strips it for senderPhone", async () => {
    const raw = await convert({ chatId: GROUP, isGroupMsg: true, author: "161679983804516@lid", from: GROUP });
    expect(raw).toMatchObject({ senderPhone: "161679983804516", senderJid: "161679983804516@lid", whatsappGroupId: GROUP });
  });

  it("keeps a group author's phone id", async () => {
    const raw = await convert({ chatId: GROUP, isGroupMsg: true, author: "8801711000001@c.us", from: GROUP });
    expect(raw).toMatchObject({ senderPhone: "8801711000001", senderJid: "8801711000001@c.us" });
  });

  it("uses the attached contact when WhatsApp gave no author", async () => {
    const raw = await convert({ chatId: GROUP, isGroupMsg: true, author: undefined, sender: { id: "8801711000001@c.us" }, from: GROUP });
    expect(raw.senderJid).toBe("8801711000001@c.us");
  });

  it("falls back to the group id with its domain, which the identity rule never credits to anyone", async () => {
    const raw = await convert({ chatId: GROUP, isGroupMsg: true, author: undefined, from: GROUP });
    expect(raw.senderJid).toBe(GROUP);
    const member = { id: "m-1", phoneNumber: raw.senderPhone, whatsappId: null };
    expect(createSenderResolver([member]).resolve(raw.senderPhone, raw.senderJid)).toMatchObject({ status: "NOT_A_PERSON", memberId: null });
  });

  it("takes a one-to-one sender from `from`", async () => {
    const raw = await convert({ chatId: "8801711000001@c.us", isGroupMsg: false, from: "8801711000001@c.us" });
    expect(raw).toMatchObject({ senderPhone: "8801711000001", senderJid: "8801711000001@c.us", whatsappGroupId: null });
  });

  it("prefers a real push name, then the message's own notifyName, then formattedName", async () => {
    const base = { chatId: GROUP, isGroupMsg: true, author: "161679983804516@lid", from: GROUP };
    expect((await convert({ ...base, sender: { pushname: "Rakib", formattedName: "+880…" }, notifyName: "R" })).senderName).toBe("Rakib");
    expect((await convert({ ...base, sender: { formattedName: "161679983804516" }, notifyName: "Rakib H" })).senderName).toBe("Rakib H");
    expect((await convert({ ...base, sender: { formattedName: "Rakib F" } })).senderName).toBe("Rakib F");
    expect((await convert({ ...base })).senderName).toBeNull();
  });
});
