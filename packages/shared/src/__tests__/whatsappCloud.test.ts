import { describe, expect, it } from "vitest";
import { decideReplyWindow } from "../channels.js";
import { normalizeWhatsAppCloudEvent, readCloudTemplate, renderCloudTemplate, splitWhatsAppCloudWebhook } from "../whatsappCloud.js";

/** Simulated payloads in Meta's published shape. Nothing here has been checked against a real number. */

const at = new Date("2026-11-09T10:00:00Z");
const body = (value: object) => ({ object: "whatsapp_business_account", entry: [{ id: "waba1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "111" }, ...value } }] }] });

describe("splitting a webhook", () => {
  it("makes one event per message and per status, keyed so a status can report each stage", () => {
    const events = splitWhatsAppCloudWebhook(
      body({
        contacts: [{ wa_id: "8801711111111", profile: { name: "Rahim" } }],
        messages: [{ id: "wamid.1", from: "8801711111111", type: "text", timestamp: "1762682400", text: { body: "hello" } }],
        statuses: [
          { id: "wamid.9", status: "delivered", recipient_id: "8801711111111", timestamp: "1762682401" },
          { id: "wamid.9", status: "read", recipient_id: "8801711111111", timestamp: "1762682402" },
        ],
      }),
      at,
    );
    expect(events.map((e) => e.dedupKey)).toEqual(["m:wamid.1", "s:wamid.9:delivered", "s:wamid.9:read"]);
    expect(events.every((e) => e.accountId === "111")).toBe(true);
  });

  it("ignores another object, another field, and a change with no phone number id", () => {
    expect(splitWhatsAppCloudWebhook({ object: "page", entry: [] }, at)).toEqual([]);
    expect(splitWhatsAppCloudWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "account_update", value: {} }] }] }, at)).toEqual([]);
    expect(splitWhatsAppCloudWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messages: [{ id: "x", from: "1" }] } }] }] }, at)).toEqual([]);
  });
});

describe("reading an event", () => {
  it("reads a text, with the WhatsApp profile name and number", () => {
    const e = normalizeWhatsAppCloudEvent({ kind: "message", contact: { profile: { name: "Rahim" } }, message: { id: "w1", from: "8801711111111", type: "text", text: { body: "hi" } } }, at);
    expect(e).toMatchObject({ type: "MESSAGE", direction: "INBOUND", threadId: "8801711111111", senderName: "Rahim", text: "hi", contentType: "TEXT" });
  });

  it("keeps a photo's caption and marks a type it cannot read as unsupported, rather than dropping it", () => {
    expect(normalizeWhatsAppCloudEvent({ kind: "message", message: { id: "w2", from: "1", type: "image", image: { caption: "my bill" } } }, at)).toMatchObject({ type: "MESSAGE", contentType: "IMAGE", text: "my bill" });
    expect(normalizeWhatsAppCloudEvent({ kind: "message", message: { id: "w3", from: "1", type: "order" } }, at)).toMatchObject({ type: "MESSAGE", contentType: "UNSUPPORTED" });
  });

  it("turns a failed status into a reason a person can read", () => {
    expect(normalizeWhatsAppCloudEvent({ kind: "status", status: { id: "w4", status: "failed", errors: [{ title: "Re-engagement message" }] } }, at)).toMatchObject({ type: "SEND_FAILED", externalMessageId: "w4", reason: expect.stringContaining("Re-engagement") });
  });
});

describe("the 24-hour window", () => {
  const decide = (hoursAgo: number) => decideReplyWindow({ type: "WHATSAPP_CLOUD", lastInboundAt: new Date(at.getTime() - hoursAgo * 3_600_000), now: at, humanAgentEnabled: true, automated: false });
  it("allows a free reply inside it, and never a tag outside it", () => {
    expect(decide(23).allowed).toBe(true);
    const closed = decide(25);
    expect(closed.allowed).toBe(false);
  });
});

describe("templates", () => {
  const base = { name: "bill_due", language: "en", category: "UTILITY", status: "APPROVED" };
  it("counts the blanks and fills them in", () => {
    const t = readCloudTemplate({ ...base, components: [{ type: "BODY", text: "Hi {{1}}, your bill is {{2}}." }] });
    expect(t).toMatchObject({ paramCount: 2, supported: true });
    expect(renderCloudTemplate(t!.bodyText, ["Rahim", "500"])).toBe("Hi Rahim, your bill is 500.");
  });

  it("will not offer one this screen cannot fill: a picture header, named blanks, or a link with a blank", () => {
    expect(readCloudTemplate({ ...base, components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi" }] })?.supported).toBe(false);
    expect(readCloudTemplate({ ...base, components: [{ type: "BODY", text: "Hi {{name}}" }] })?.supported).toBe(false);
    expect(readCloudTemplate({ ...base, components: [{ type: "BODY", text: "Hi" }, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://x.test/{{1}}" }] }] })?.supported).toBe(false);
  });
});
