import { describe, expect, it } from "vitest";
import {
  applyAck,
  describeReceipt,
  forwardRefusal,
  isSendableSticker,
  locationMapUrl,
  outboundSummary,
  parseCoordinates,
  readRichContent,
  recordableAckLevel,
  validateLocation,
  validatePoll,
} from "../chatRichMessages.js";
import { isMediaOnlyBody } from "../mediaPlaceholders.js";
import { isMediaPlaceholderBody, mediaCaption } from "../messageMedia.js";

const T0 = new Date("2026-10-16T08:00:00Z");
const T1 = new Date("2026-10-16T08:05:00Z");
const EMPTY = { ackLevel: null, deliveredAt: null, readAt: null, playedAt: null };

describe("receipts", () => {
  it("records only the levels that describe a message that left (1–4)", () => {
    expect([-1, 0, 1, 2, 3, 4, 5, 2.5, "3", "", null, undefined, "x"].map(recordableAckLevel)).toEqual([null, null, 1, 2, 3, 4, null, null, 3, null, null, null, null]);
  });

  it("only ever raises the level, and never rewrites a time it already holds", () => {
    const delivered = applyAck(EMPTY, 2, T0)!;
    expect(delivered).toEqual({ ackLevel: 2, deliveredAt: T0, readAt: null, playedAt: null });
    // A late "delivered" after "read" changes nothing.
    const read = applyAck(delivered, 3, T1)!;
    expect(read).toEqual({ ackLevel: 3, deliveredAt: T0, readAt: T1, playedAt: null });
    expect(applyAck(read, 2, T1)).toBeNull();
    expect(applyAck(read, 3, T1)).toBeNull();
  });

  it("reaching a level implies the ones below it", () => {
    expect(applyAck(EMPTY, 4, T0)).toEqual({ ackLevel: 4, deliveredAt: T0, readAt: T0, playedAt: T0 });
    expect(applyAck(EMPTY, 0, T0)).toBeNull();
  });

  it("names a group's ticks for everyone, and treats no receipt as sent", () => {
    expect(describeReceipt(null, false)).toEqual({ ticks: 1, read: false, label: "Sent" });
    expect(describeReceipt(2, false)).toEqual({ ticks: 2, read: false, label: "Delivered" });
    expect(describeReceipt(2, true).label).toBe("Delivered to everyone");
    expect(describeReceipt(3, true)).toEqual({ ticks: 2, read: true, label: "Read by everyone" });
    expect(describeReceipt(4, false)).toEqual({ ticks: 2, read: true, label: "Played" });
  });
});

describe("polls", () => {
  it("accepts a real poll and trims it", () => {
    expect(validatePoll({ name: "  Which plan? ", options: [" Basic", "Pro "], allowMultiple: true })).toEqual({
      ok: true,
      value: { name: "Which plan?", options: ["Basic", "Pro"], allowMultiple: true },
    });
    expect(validatePoll({ name: "Q", options: ["a", "b"], allowMultiple: "yes" })).toMatchObject({ ok: true, value: { allowMultiple: false } });
  });

  it("refuses rather than trims away anything the author wrote", () => {
    expect(validatePoll({ name: "", options: ["a", "b"] }).ok).toBe(false);
    expect(validatePoll({ name: "Q", options: ["a"] }).ok).toBe(false);
    expect(validatePoll({ name: "Q", options: ["a", " "] }).ok).toBe(false);
    expect(validatePoll({ name: "Q", options: Array.from({ length: 13 }, (_, i) => `o${i}`) }).ok).toBe(false);
    expect(validatePoll({ name: "Q", options: ["Yes", "yes"] })).toEqual({ ok: false, error: expect.stringContaining("twice") });
    expect(validatePoll({ name: "x".repeat(256), options: ["a", "b"] }).ok).toBe(false);
    expect(validatePoll({ name: "Q", options: ["a", "b".repeat(101)] }).ok).toBe(false);
    expect(validatePoll(null).ok).toBe(false);
  });

  it("is never a question for the AI, and never a file", () => {
    expect(isMediaOnlyBody("[Poll] Which plan?")).toBe(true);
    expect(isMediaOnlyBody("[Poll]")).toBe(true);
    expect(isMediaPlaceholderBody("[Poll] Which plan?")).toBe(false);
    expect(mediaCaption("[Poll] Which plan?", null)).toBe("Which plan?");
    // Nothing else moved: a captioned image is still a question, a bare one is still media-only.
    expect(isMediaOnlyBody("[Image] amar bill ashe nai")).toBe(false);
    expect(isMediaOnlyBody("[Image]")).toBe(true);
    expect(isMediaPlaceholderBody("[Location] Dhaka")).toBe(false);
  });
});

describe("locations", () => {
  it("accepts real coordinates, rounded to six places", () => {
    expect(validateLocation({ latitude: "23.81031234567", longitude: 90.4125, name: " Office " })).toEqual({
      ok: true,
      value: { latitude: 23.810312, longitude: 90.4125, name: "Office" },
    });
  });

  it("refuses out-of-range, missing and the empty 0,0", () => {
    expect(validateLocation({ latitude: 91, longitude: 0 }).ok).toBe(false);
    expect(validateLocation({ latitude: 0, longitude: 181 }).ok).toBe(false);
    expect(validateLocation({ latitude: "", longitude: 1 }).ok).toBe(false);
    expect(validateLocation({ latitude: 0, longitude: 0 }).ok).toBe(false);
    expect(validateLocation({ latitude: 1, longitude: 1, name: "n".repeat(121) }).ok).toBe(false);
  });

  it("reads coordinates out of what people paste, and nothing else", () => {
    expect(parseCoordinates("23.8103, 90.4125")).toEqual({ latitude: 23.8103, longitude: 90.4125 });
    expect(parseCoordinates("https://www.google.com/maps/place/X/@23.8103,90.4125,17z")).toEqual({ latitude: 23.8103, longitude: 90.4125 });
    expect(parseCoordinates("https://maps.google.com/?q=23.8103%2C90.4125")).toEqual({ latitude: 23.8103, longitude: 90.4125 });
    expect(parseCoordinates("https://www.google.com/maps/search/?api=1&query=-33.86,151.2")).toEqual({ latitude: -33.86, longitude: 151.2 });
    expect(parseCoordinates("https://www.openstreetmap.org/?mlat=23.81&mlon=90.41#map=17")).toEqual({ latitude: 23.81, longitude: 90.41 });
    expect(parseCoordinates("https://maps.app.goo.gl/abc123")).toBeNull();
    expect(parseCoordinates("Dhaka")).toBeNull();
    expect(parseCoordinates("95, 10")).toBeNull();
  });

  it("builds the map link from numbers only", () => {
    expect(locationMapUrl(23.81, 90.41)).toBe("https://www.google.com/maps/search/?api=1&query=23.81%2C90.41");
  });
});

describe("stored rich content", () => {
  it("reads what WhatsApp delivered, and nothing malformed", () => {
    expect(readRichContent({ kind: "POLL", name: "Q", options: ["a", 2, "b"], allowMultiple: true })).toEqual({ kind: "POLL", name: "Q", options: ["a", "b"], allowMultiple: true });
    expect(readRichContent({ kind: "LOCATION", latitude: "23.8", longitude: "90.4", name: "X" })).toEqual({ kind: "LOCATION", latitude: 23.8, longitude: 90.4, name: "X" });
    expect(readRichContent({ kind: "LOCATION", latitude: 200, longitude: 1 })).toBeNull();
    expect(readRichContent({ kind: "POLL", name: 1, options: [] })).toBeNull();
    expect(readRichContent({ kind: "BUTTONS" })).toBeNull();
    expect(readRichContent("x")).toBeNull();
  });
});

describe("what we send", () => {
  it("summarises with the same labels the provider writes for a received one", () => {
    expect(outboundSummary("POLL", { poll: { name: "Which plan?", options: ["a", "b"], allowMultiple: false } })).toBe("[Poll] Which plan?");
    expect(outboundSummary("LOCATION", { location: { latitude: 1, longitude: 2, name: "" } })).toBe("[Location] 1, 2");
    expect(outboundSummary("LOCATION", { location: { latitude: 1, longitude: 2, name: "Office" } })).toBe("[Location] Office");
    expect(outboundSummary("STICKER", {})).toBe("[Sticker]");
    expect(outboundSummary("FORWARD", { forwardedBody: "hello" })).toBe("[Forwarded] hello");
    expect(outboundSummary("FORWARD", { forwardedBody: "x".repeat(600) })).toHaveLength("[Forwarded] ".length + 501);
  });

  it("offers only stored WebP stickers under the ceiling", () => {
    const ok = { mediaType: "STICKER", mimeType: "image/webp", status: "STORED", sizeBytes: 30_000n };
    expect(isSendableSticker(ok)).toBe(true);
    expect(isSendableSticker({ ...ok, mediaType: "IMAGE" })).toBe(false);
    expect(isSendableSticker({ ...ok, mimeType: "image/png" })).toBe(false);
    expect(isSendableSticker({ ...ok, status: "DELETED" })).toBe(false);
    expect(isSendableSticker({ ...ok, sizeBytes: 2_000_000 })).toBe(false);
    expect(isSendableSticker({ ...ok, sizeBytes: null })).toBe(false);
  });

  it("forwards only a stored, undeleted message of the same account", () => {
    expect(forwardRefusal({ accountId: "a", revokedAt: null }, "a")).toBeNull();
    expect(forwardRefusal(null, "a")).toMatch(/could not be found/);
    expect(forwardRefusal({ accountId: "b", revokedAt: null }, "a")).toMatch(/this account/);
    expect(forwardRefusal({ accountId: "a", revokedAt: T0 }, "a")).toMatch(/deleted/);
  });
});
