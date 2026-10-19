import { describe, expect, it, vi } from "vitest";

/**
 * Report accuracy audit (19 Oct 2026): what the provider hands the pipeline decides what every report
 * can count. Pure — no database, no browser.
 *  - a multi-device sender ("…:12") is one person, not a second one with a wrong 15-digit number;
 *  - a WhatsApp system entry (someone added, an edit's protocol message, a call log) is not
 *    something anybody said, even when it carries a body — the store sweep reads every one;
 *  - a contact card's raw vCard (which carries a phone number) is never stored as text;
 *  - a message whose id arrives as WhatsApp's key object, or with no timestamp, is still stored.
 */

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: {
    IMAGE: "image",
    VIDEO: "video",
    AUDIO: "audio",
    VOICE: "ptt",
    DOCUMENT: "document",
    STICKER: "sticker",
    LOCATION: "location",
    CONTACT_CARD: "vcard",
    CONTACT_CARD_MULTI: "multi_vcard",
  },
}));

const GROUP = "120363000000000001@g.us";

async function convert(message: Record<string, unknown>) {
  const { toRawIncomingMessage } = await import("../provider/openwa/OpenWAProvider.js");
  return toRawIncomingMessage("acc-1", { id: "false_x_ABC", timestamp: 1_700_000_000, body: "hi", chatId: GROUP, isGroupMsg: true, ...message } as never);
}

describe("the sender", () => {
  it("drops the device suffix from senderPhone, keeping the full id in senderJid", async () => {
    const raw = await convert({ author: "8801711000001:12@s.whatsapp.net" });
    expect(raw.senderPhone).toBe("8801711000001");
    expect(raw.senderJid).toBe("8801711000001:12@s.whatsapp.net");
  });
});

describe("what is a message", () => {
  for (const type of ["gp2", "notification", "notification_template", "e2e_notification", "call_log", "protocol"]) {
    it(`reads a "${type}" entry as empty, so it is never stored as somebody's words`, async () => {
      const raw = await convert({ type, body: "Rakib added Bipul", author: "8801711000001@c.us" });
      expect(raw.body).toBe("");
    });
  }

  it("reads an entry WhatsApp flags as a notification as empty", async () => {
    expect((await convert({ type: "chat", isNotification: true, body: "changed the subject" })).body).toBe("");
  });

  it("keeps a message still being decrypted for the re-read, never as a system entry", async () => {
    const raw = await convert({ type: "ciphertext", body: undefined });
    expect(raw.body).toBe("");
  });

  it("stores a contact card as a label, never the vCard with its phone number", async () => {
    const raw = await convert({ type: "vcard", isMedia: false, body: "BEGIN:VCARD\nTEL:+8801711000001\nEND:VCARD" });
    expect(raw.body).toBe("[Contact card]");
  });

  it("labels a video note instead of storing its preview as text", async () => {
    expect((await convert({ type: "ptv", isMedia: false, body: "/9j/4AAQSkZJRg" })).body).toBe("[Video note]");
  });

  it("keeps an ordinary text message", async () => {
    expect((await convert({ type: "chat", body: "my internet is down" })).body).toBe("my internet is down");
  });
});

describe("a message is never lost to its own shape", () => {
  it("stores an id handed over as WhatsApp's key object as its serialised string", async () => {
    const raw = await convert({ id: { fromMe: false, remote: GROUP, id: "ABC123", participant: "8801711000001@c.us" } });
    expect(raw.whatsappMessageId).toBe(`false_${GROUP}_ABC123_8801711000001@c.us`);
  });

  it("uses WhatsApp's `t` when `timestamp` is missing, and the read time when both are", async () => {
    expect((await convert({ timestamp: undefined, t: 1_700_000_100 })).timestampWa.getTime()).toBe(1_700_000_100_000);
    const before = Date.now();
    const raw = await convert({ timestamp: undefined });
    expect(Number.isNaN(raw.timestampWa.getTime())).toBe(false);
    expect(raw.timestampWa.getTime()).toBeGreaterThanOrEqual(before);
  });
});
