import { describe, expect, it, vi } from "vitest";

/**
 * How a poll, a location, a deleted message and a receipt arrive from the provider
 * (CHAT_RICH_MESSAGING.md). Pure — no database, no browser.
 *
 * The shapes are WhatsApp Web's own fields as wa-automate 4.76 passes them through: a location's
 * `body` is its JPEG map preview (never text), a poll keeps its question in `pollName`, and a message
 * deleted for everyone arrives as type "revoked" with nothing left in it.
 */

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: { IMAGE: "image", VIDEO: "video", AUDIO: "audio", VOICE: "ptt", DOCUMENT: "document", STICKER: "sticker", LOCATION: "location" },
}));

const GROUP = "120363000000000001@g.us";
const JPEG_PREVIEW = `/9j/${"A".repeat(200)}`;

async function convert(message: Record<string, unknown>) {
  const { toRawIncomingMessage } = await import("../provider/openwa/OpenWAProvider.js");
  return toRawIncomingMessage("acc-1", {
    id: "false_x_ABC",
    timestamp: 1_700_000_000,
    chatId: GROUP,
    isGroupMsg: true,
    author: "8801711000001@c.us",
    from: GROUP,
    ...message,
  } as never);
}

describe("a location", () => {
  it("is labelled by its name, carries its coordinates, and is not a file to fetch", async () => {
    const raw = await convert({ type: "location", isMedia: false, body: JPEG_PREVIEW, lat: "23.8103", lng: "90.4125", loc: "Dhaka office" });
    expect(raw.body).toBe("[Location] Dhaka office");
    expect(raw.media).toBeNull();
    expect(raw.richContent).toEqual({ kind: "LOCATION", latitude: 23.8103, longitude: 90.4125, name: "Dhaka office" });
  });

  it("never stores the map preview as text, even when WhatsApp marks it media", async () => {
    const raw = await convert({ type: "location", isMedia: true, mimetype: "image/jpeg", mediaKey: "k", body: JPEG_PREVIEW, lat: 1, lng: 2 });
    expect(raw.body).toBe("[Location]");
    expect(raw.media).toBeNull();
  });
});

describe("a poll", () => {
  it("is labelled by its question and keeps its options", async () => {
    const raw = await convert({
      type: "poll_creation",
      body: "",
      pollName: "Which plan?",
      pollOptions: [{ name: "Basic", localId: 0 }, { name: "Pro", localId: 1 }],
      pollSelectableOptionsCount: 1,
    });
    expect(raw.body).toBe("[Poll] Which plan?");
    expect(raw.richContent).toEqual({ kind: "POLL", name: "Which plan?", options: ["Basic", "Pro"], allowMultiple: false });
  });

  it("reads 0 selectable options as 'any number'", async () => {
    const raw = await convert({ type: "poll_creation", pollName: "Q", pollOptions: [{ name: "a" }, { name: "b" }], pollSelectableOptionsCount: 0 });
    expect(raw.richContent).toMatchObject({ allowMultiple: true });
  });
});

describe("a message deleted for everyone", () => {
  it("is flagged and carries no text to store", async () => {
    const raw = await convert({ type: "revoked", body: "" });
    expect(raw.revoked).toBe(true);
    expect(raw.body).toBe("");
  });

  it("is never flagged for an ordinary message", async () => {
    const raw = await convert({ type: "chat", body: "hello" });
    expect(raw.revoked).toBe(false);
    expect(raw.richContent).toBeNull();
  });
});

describe("receipts", () => {
  it("are read only from messages this account sent", async () => {
    expect((await convert({ type: "chat", body: "ours", fromMe: true, ack: 2 })).ackLevel).toBe(2);
    expect((await convert({ type: "chat", body: "theirs", fromMe: false, ack: 3 })).ackLevel).toBeNull();
    expect((await convert({ type: "chat", body: "clock", fromMe: true, ack: 0 })).ackLevel).toBeNull();
  });
});
