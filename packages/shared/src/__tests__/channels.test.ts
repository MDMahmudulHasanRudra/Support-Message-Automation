import { describe, expect, it } from "vitest";
import {
  advanceDeliveryStatus,
  channelBySlug,
  channelMessagePreview,
  channelRetryDelayMs,
  decideReplyWindow,
  isInboxScope,
  normalizeMetaEvent,
  normalizeTelegramUpdate,
  readMetaError,
  readTelegramError,
  splitMetaWebhook,
  telegramDedupKey,
  validateChannelText,
} from "../channels.js";

const NOW = new Date("2026-10-11T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("decideReplyWindow", () => {
  it("refuses a conversation the customer never wrote in", () => {
    const d = decideReplyWindow({ type: "MESSENGER", lastInboundAt: null, now: NOW, humanAgentEnabled: true, automated: false });
    expect(d).toMatchObject({ allowed: false, code: "NO_CUSTOMER_MESSAGE" });
  });

  it("answers inside 24 hours as a RESPONSE, people and AI alike", () => {
    for (const automated of [true, false]) {
      expect(decideReplyWindow({ type: "INSTAGRAM", lastInboundAt: hoursAgo(23.9), now: NOW, humanAgentEnabled: false, automated })).toEqual({
        allowed: true,
        messagingType: "RESPONSE",
        tag: null,
      });
    }
  });

  it("never lets AI use the Human Agent tag, even with it switched on", () => {
    expect(decideReplyWindow({ type: "MESSENGER", lastInboundAt: hoursAgo(30), now: NOW, humanAgentEnabled: true, automated: true })).toMatchObject({
      allowed: false,
      code: "AUTOMATED_OUTSIDE_WINDOW",
    });
  });

  it("lets a person reply for 7 days only with Human Agent on", () => {
    expect(decideReplyWindow({ type: "MESSENGER", lastInboundAt: hoursAgo(30), now: NOW, humanAgentEnabled: false, automated: false })).toMatchObject({
      allowed: false,
      code: "HUMAN_AGENT_OFF",
    });
    expect(decideReplyWindow({ type: "MESSENGER", lastInboundAt: hoursAgo(30), now: NOW, humanAgentEnabled: true, automated: false })).toEqual({
      allowed: true,
      messagingType: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
    });
    expect(decideReplyWindow({ type: "MESSENGER", lastInboundAt: hoursAgo(24 * 7 + 1), now: NOW, humanAgentEnabled: true, automated: false })).toMatchObject({
      allowed: false,
      code: "WINDOW_CLOSED",
    });
  });

  it("gives Telegram no window", () => {
    expect(decideReplyWindow({ type: "TELEGRAM", lastInboundAt: hoursAgo(24 * 90), now: NOW, humanAgentEnabled: false, automated: true })).toEqual({
      allowed: true,
      messagingType: null,
      tag: null,
    });
  });
});

describe("validateChannelText", () => {
  it("refuses empty text", () => {
    expect(validateChannelText("TELEGRAM", "   ")).toMatch(/Type a message/);
  });

  it("counts Instagram in bytes, so Bangla runs out sooner", () => {
    const bangla = "আ".repeat(400); // 3 bytes each = 1200 bytes, 400 characters
    expect(validateChannelText("MESSENGER", bangla)).toBeNull();
    expect(validateChannelText("INSTAGRAM", bangla)).toMatch(/1000 bytes/);
    expect(validateChannelText("INSTAGRAM", "a".repeat(1000))).toBeNull();
  });

  it("enforces each channel's character limit", () => {
    expect(validateChannelText("MESSENGER", "x".repeat(2001))).toMatch(/2000 characters/);
    expect(validateChannelText("TELEGRAM", "x".repeat(4096))).toBeNull();
    expect(validateChannelText("TELEGRAM", "x".repeat(4097))).toMatch(/4096/);
  });
});

describe("splitMetaWebhook", () => {
  const received = new Date("2026-10-11T10:00:00Z");
  const body = {
    object: "page",
    entry: [
      {
        id: "PAGE1",
        time: 1,
        messaging: [
          { sender: { id: "U1" }, recipient: { id: "PAGE1" }, timestamp: 1760176800000, message: { mid: "m.1", text: "hi" } },
          { sender: { id: "U1" }, recipient: { id: "PAGE1" }, timestamp: 1760176801000, delivery: { mids: ["m.b", "m.a"], watermark: 1760176801000 } },
          { sender: { id: "U1" }, recipient: { id: "PAGE1" }, timestamp: 1760176802000, read: { watermark: 1760176802000 } },
        ],
      },
    ],
  };

  it("cuts a batch into one keyed event per item", () => {
    const events = splitMetaWebhook(body, "MESSENGER", received)!;
    expect(events.map((e) => e.dedupKey)).toEqual(["msg:m.1", "delivery:U1:1760176801000:m.a,m.b", "read:U1:1760176802000"]);
    expect(events.every((e) => e.accountId === "PAGE1")).toBe(true);
  });

  it("gives the same keys to a retried body", () => {
    const again = splitMetaWebhook(JSON.parse(JSON.stringify(body)), "MESSENGER", new Date())!;
    expect(again.map((e) => e.dedupKey)).toEqual(splitMetaWebhook(body, "MESSENGER", received)!.map((e) => e.dedupKey));
  });

  it("refuses another channel's body", () => {
    expect(splitMetaWebhook(body, "INSTAGRAM", received)).toBeNull();
    expect(splitMetaWebhook({ object: "instagram", entry: [] }, "INSTAGRAM", received)).toEqual([]);
    expect(splitMetaWebhook("nope", "MESSENGER", received)).toBeNull();
  });
});

describe("normalizeMetaEvent", () => {
  const received = new Date("2026-10-11T10:00:00Z");

  it("reads a customer's message", () => {
    const e = normalizeMetaEvent(
      { sender: { id: "U1" }, recipient: { id: "PAGE1" }, timestamp: 1760176800000, message: { mid: "m.1", text: "price?", reply_to: { mid: "m.0" } } },
      "PAGE1",
      received,
    );
    expect(e).toMatchObject({ type: "MESSAGE", direction: "INBOUND", threadId: "U1", externalMessageId: "m.1", text: "price?", contentType: "TEXT", replyToExternalId: "m.0" });
  });

  it("reads an echo as OUTBOUND, keyed on the customer, with our metadata", () => {
    const e = normalizeMetaEvent(
      { sender: { id: "PAGE1" }, recipient: { id: "U1" }, timestamp: 1, message: { mid: "m.2", text: "hello", is_echo: true, app_id: 99, metadata: "cm_123" } },
      "PAGE1",
      received,
    );
    expect(e).toMatchObject({ type: "MESSAGE", direction: "OUTBOUND", threadId: "U1", appId: "99", metadata: "cm_123" });
  });

  it("keeps attachments as references only, and only http(s) links", () => {
    const e = normalizeMetaEvent(
      {
        sender: { id: "U1" },
        recipient: { id: "PAGE1" },
        timestamp: 1,
        message: { mid: "m.3", attachments: [{ type: "image", payload: { url: "https://cdn.example/a.jpg" } }, { type: "file", payload: { url: "javascript:alert(1)" } }, { type: "image", payload: { sticker_id: 1, url: "https://x/s.png" } }] },
      },
      "PAGE1",
      received,
    );
    expect(e).toMatchObject({ contentType: "IMAGE", text: null });
    if (e.type !== "MESSAGE") throw new Error("expected a message");
    expect(e.attachments).toEqual([
      { type: "IMAGE", url: "https://cdn.example/a.jpg", name: undefined },
      { type: "FILE", url: undefined, name: undefined },
      { type: "STICKER", url: "https://x/s.png", name: undefined },
    ]);
  });

  it("reads delivery and read receipts", () => {
    expect(normalizeMetaEvent({ sender: { id: "U1" }, recipient: { id: "P" }, delivery: { mids: ["m.1"], watermark: 1760176800000 } }, "P", received)).toMatchObject({
      type: "DELIVERY",
      threadId: "U1",
      externalMessageIds: ["m.1"],
    });
    expect(normalizeMetaEvent({ sender: { id: "U1" }, recipient: { id: "P" }, read: { mid: "m.9" } }, "P", received)).toMatchObject({
      type: "READ",
      externalMessageId: "m.9",
      watermark: null,
    });
  });

  it("ignores what this inbox does not use", () => {
    for (const item of [
      { sender: { id: "U1" }, postback: { payload: "x" } },
      { sender: { id: "U1" }, reaction: { reaction: "love" } },
      { sender: { id: "U1" }, recipient: { id: "P" }, message: { mid: "m.4", is_deleted: true } },
      42,
    ]) {
      expect(normalizeMetaEvent(item, "P", received).type).toBe("IGNORED");
    }
  });
});

describe("Telegram", () => {
  const received = new Date("2026-10-11T10:00:00Z");
  const update = {
    update_id: 501,
    message: {
      message_id: 7,
      date: 1760176800,
      chat: { id: 1234, type: "private", first_name: "Nusrat", last_name: "J" },
      from: { id: 1234, is_bot: false, first_name: "Nusrat", last_name: "J", username: "nusratj" },
      text: "internet nai",
    },
  };

  it("keys an update by its number", () => {
    expect(telegramDedupKey(update)).toBe("update:501");
    expect(telegramDedupKey({})).toBeNull();
  });

  it("reads a private message", () => {
    expect(normalizeTelegramUpdate(update, received)).toMatchObject({
      type: "MESSAGE",
      direction: "INBOUND",
      externalMessageId: "1234:7",
      threadId: "1234",
      threadKind: "DIRECT",
      threadTitle: "Nusrat J",
      senderUsername: "nusratj",
      senderIsBot: false,
      text: "internet nai",
      occurredAt: new Date(1760176800 * 1000),
    });
  });

  it("reads a group photo with a caption, and marks bots", () => {
    const e = normalizeTelegramUpdate(
      { update_id: 9, message: { message_id: 3, date: 1, chat: { id: -100, type: "supergroup", title: "Branch office" }, from: { id: 5, is_bot: true, first_name: "Alert bot" }, photo: [{ file_id: "small" }, { file_id: "big" }], caption: "router light red" } },
      received,
    );
    expect(e).toMatchObject({ threadKind: "GROUP", threadTitle: "Branch office", contentType: "IMAGE", text: "router light red", senderIsBot: true });
    if (e.type !== "MESSAGE") throw new Error("expected a message");
    expect(e.attachments).toEqual([{ type: "IMAGE", fileId: "big" }]);
  });

  it("ignores edits, channel posts and service messages", () => {
    expect(normalizeTelegramUpdate({ update_id: 1, edited_message: {} }, received)).toEqual({ type: "IGNORED", reason: "an edited message" });
    expect(normalizeTelegramUpdate({ update_id: 1, message: { message_id: 1, chat: { id: -5, type: "channel" } } }, received).type).toBe("IGNORED");
    expect(normalizeTelegramUpdate({ update_id: 1, message: { message_id: 1, chat: { id: -5, type: "group" }, new_chat_members: [] } }, received).type).toBe("IGNORED");
  });
});

describe("statuses, previews and errors", () => {
  it("only moves a receipt forward", () => {
    expect(advanceDeliveryStatus("SENT", "DELIVERED")).toBe("DELIVERED");
    expect(advanceDeliveryStatus("READ", "DELIVERED")).toBe("READ");
    expect(advanceDeliveryStatus("UNKNOWN", "DELIVERED")).toBe("DELIVERED");
    expect(advanceDeliveryStatus("FAILED", "READ")).toBe("FAILED");
    expect(advanceDeliveryStatus("QUEUED", "READ")).toBe("QUEUED");
  });

  it("previews text, and names media", () => {
    expect(channelMessagePreview("  hello \n there ", "TEXT")).toBe("hello there");
    expect(channelMessagePreview(null, "AUDIO")).toBe("[Voice or audio]");
    expect(channelMessagePreview("x".repeat(200), "TEXT")).toHaveLength(140);
  });

  it("reads Meta errors into what to do", () => {
    expect(readMetaError(400, { error: { code: 190, message: "Error validating access token" } })).toMatchObject({ needsReauth: true, retryable: false });
    expect(readMetaError(400, { error: { code: 10, error_subcode: 2018278, message: "outside window" } })).toMatchObject({ retryable: false, needsReauth: false });
    expect(readMetaError(400, { error: { code: 613 } })).toMatchObject({ retryable: true });
    expect(readMetaError(503, {})).toMatchObject({ retryable: true });
    expect(readMetaError(400, { error: { code: 100, message: "bad access_token=EAAB123 param" } }).message).not.toContain("EAAB123");
  });

  it("reads Telegram errors, hiding the token", () => {
    expect(readTelegramError(401, { ok: false, error_code: 401, description: "Unauthorized" })).toMatchObject({ needsReauth: true });
    expect(readTelegramError(429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 33 } })).toMatchObject({ retryable: true, retryAfterSeconds: 33 });
    expect(readTelegramError(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" })).toMatchObject({ retryable: false, needsReauth: false });
    expect(readTelegramError(400, { description: "bad url https://api.telegram.org/bot123:ABC-def/sendMessage" }).message).not.toContain("123:ABC");
  });

  it("backs off and then stops", () => {
    expect(channelRetryDelayMs(1)).toBe(15_000);
    expect(channelRetryDelayMs(2, 120)).toBe(120_000);
    expect(channelRetryDelayMs(5)).toBeNull();
  });

  it("recognises scopes and slugs", () => {
    expect(channelBySlug("instagram")).toBe("INSTAGRAM");
    expect(channelBySlug("whatsapp")).toBeNull();
    expect(isInboxScope("all")).toBe(true);
    expect(isInboxScope("tiktok")).toBe(false);
  });
});
