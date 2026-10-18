import { describe, expect, it, vi } from "vitest";

/**
 * A media message is recognised by its TYPE, not only by WhatsApp Web's `isMedia` getter.
 *
 * `resolveMessageBody` trusted `isMedia` to decide between "this is text" and "this is a file". The
 * same WhatsApp Web update that removed `isGroupMsg` (which this code already stopped trusting) can
 * remove `isMedia`; then a voice note — no body, no caption — read as an empty message and was
 * dropped as EMPTY_BODY on the live path, and every recovery path skips empty bodies too, so it was
 * lost for good. An image would have been stored with its base64 preview as the "text". Personal
 * chats carry far more voice notes than groups do (18 Oct 2026 incident). Pure — no database.
 */

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(() => new Promise(() => {})),
  ev: { on: vi.fn() },
  STATE: {},
  // The library's own values (dist/api/model/message.js).
  MessageTypes: {
    TEXT: "chat",
    AUDIO: "audio",
    VOICE: "ptt",
    IMAGE: "image",
    VIDEO: "video",
    DOCUMENT: "document",
    STICKER: "sticker",
    LOCATION: "location",
    CONTACT_CARD: "vcard",
    CONTACT_CARD_MULTI: "multi_vcard",
    REVOKED: "revoked",
  },
}));

const { toRawIncomingMessage } = await import("../provider/openwa/OpenWAProvider.js");

const chatId = "8801700000009@c.us";
function message(fields: Record<string, unknown>) {
  return { id: "m-1", timestamp: 1_760_000_000, from: chatId, chatId, fromMe: false, isGroupMsg: false, ...fields };
}

describe("a media message without WhatsApp Web's isMedia flag", () => {
  it("a voice note is still a voice note, not an empty message", () => {
    const raw = toRawIncomingMessage("acct", message({ type: "ptt", body: undefined, isMedia: undefined }) as never);
    expect(raw.body).toBe("[Voice message]");
  });

  it("an image keeps its caption and never stores the preview data as text", () => {
    const raw = toRawIncomingMessage("acct", message({ type: "image", body: "/9j/4AAQSkZJRgABAQ", caption: "bill", isMedia: undefined }) as never);
    expect(raw.body).toBe("[Image] bill");
  });

  it("ordinary text is unchanged", () => {
    const raw = toRawIncomingMessage("acct", message({ type: "chat", body: "hello", isMedia: false }) as never);
    expect(raw.body).toBe("hello");
  });
});
