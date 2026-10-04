import { describe, expect, it } from "vitest";
import {
  classifyWhatsAppMedia,
  decideMediaRegistration,
  DEFAULT_MEDIA_STORAGE_SWITCHES,
  describeMediaRetention,
  formatMediaBytes,
  formatMediaDuration,
  inlineMediaKind,
  isMediaPlaceholderBody,
  MEDIA_SIZE_LIMIT_BYTES,
  mediaCaption,
  mediaRetentionCutoff,
  MESSAGE_MEDIA_SETTING_FIELD,
  MESSAGE_MEDIA_TYPES,
  parseMediaRetentionDays,
} from "../messageMedia.js";

describe("classifyWhatsAppMedia", () => {
  it("maps WhatsApp's own types, voice notes to audio and GIFs apart from video", () => {
    expect(classifyWhatsAppMedia({ waType: "image", mimeType: "image/jpeg" })).toBe("IMAGE");
    expect(classifyWhatsAppMedia({ waType: "video", mimeType: "video/mp4" })).toBe("VIDEO");
    expect(classifyWhatsAppMedia({ waType: "video", mimeType: "video/mp4", isGif: true })).toBe("GIF");
    expect(classifyWhatsAppMedia({ waType: "ptt", mimeType: "audio/ogg" })).toBe("AUDIO");
    expect(classifyWhatsAppMedia({ waType: "audio", mimeType: "audio/mpeg" })).toBe("AUDIO");
    expect(classifyWhatsAppMedia({ waType: "sticker", mimeType: "image/webp" })).toBe("STICKER");
  });

  it("any document is a document, whatever its extension — never limited to PDF", () => {
    for (const mime of ["application/pdf", "application/zip", "application/vnd.android.package-archive", "text/csv", "application/x-rar-compressed", "application/octet-stream"]) {
      expect(classifyWhatsAppMedia({ waType: "document", mimeType: mime })).toBe("DOCUMENT");
    }
  });

  it("an attachment WhatsApp did not label is OTHER; text, locations and contact cards are not files", () => {
    expect(classifyWhatsAppMedia({ waType: "unknown", mimeType: "application/x-something" })).toBe("OTHER");
    expect(classifyWhatsAppMedia({ waType: "unknown", mimeType: null })).toBeNull();
    for (const waType of ["chat", "location", "vcard", "multi_vcard", "revoked"]) {
      expect(classifyWhatsAppMedia({ waType, mimeType: "text/vcard" })).toBeNull();
    }
  });
});

describe("decideMediaRegistration", () => {
  it("every type is stored by default", () => {
    for (const type of MESSAGE_MEDIA_TYPES) {
      expect(decideMediaRegistration({ type, switches: DEFAULT_MEDIA_STORAGE_SWITCHES, declaredSizeBytes: 100 })).toEqual({ status: "PENDING" });
    }
  });

  it("each switch governs only its own type", () => {
    for (const type of MESSAGE_MEDIA_TYPES) {
      const switches = { ...DEFAULT_MEDIA_STORAGE_SWITCHES, [MESSAGE_MEDIA_SETTING_FIELD[type]]: false };
      expect(decideMediaRegistration({ type, switches, declaredSizeBytes: 100 })).toEqual({ status: "NOT_STORED", reason: "SETTING_OFF" });
      for (const other of MESSAGE_MEDIA_TYPES.filter((t) => t !== type)) {
        expect(decideMediaRegistration({ type: other, switches, declaredSizeBytes: 100 }).status).toBe("PENDING");
      }
    }
  });

  it("a file announced over its limit is refused up front; an unknown size is left to the worker", () => {
    expect(decideMediaRegistration({ type: "VIDEO", switches: DEFAULT_MEDIA_STORAGE_SWITCHES, declaredSizeBytes: MEDIA_SIZE_LIMIT_BYTES.VIDEO + 1 })).toEqual({
      status: "NOT_STORED",
      reason: "TOO_LARGE",
    });
    expect(decideMediaRegistration({ type: "VIDEO", switches: DEFAULT_MEDIA_STORAGE_SWITCHES, declaredSizeBytes: MEDIA_SIZE_LIMIT_BYTES.VIDEO })).toEqual({ status: "PENDING" });
    expect(decideMediaRegistration({ type: "VIDEO", switches: DEFAULT_MEDIA_STORAGE_SWITCHES, declaredSizeBytes: null })).toEqual({ status: "PENDING" });
  });
});

describe("retention", () => {
  it("parses keep-everything, presets and custom days, and refuses nonsense", () => {
    expect(parseMediaRetentionDays("")).toEqual({ days: null });
    expect(parseMediaRetentionDays("never")).toEqual({ days: null });
    expect(parseMediaRetentionDays("90")).toEqual({ days: 90 });
    expect(parseMediaRetentionDays("400")).toEqual({ days: 400 });
    for (const bad of ["0", "3", "-5", "1.5", "abc", "99999"]) expect(parseMediaRetentionDays(bad)).toHaveProperty("error");
  });

  it("the cutoff is exactly that many days before now", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    expect(mediaRetentionCutoff(now, 90).toISOString()).toBe("2026-07-07T12:00:00.000Z");
  });

  it("describes the setting in words", () => {
    expect(describeMediaRetention(null)).toBe("Keep everything");
    expect(describeMediaRetention(90)).toBe("Keep the last 3 months");
    expect(describeMediaRetention(45)).toBe("Keep the last 45 days");
  });
});

describe("display helpers", () => {
  it("drops the placeholder label and keeps the caption a person typed", () => {
    expect(mediaCaption("[Image]", "IMAGE")).toBeNull();
    expect(mediaCaption("[Image] amar bill ashe nai", "IMAGE")).toBe("amar bill ashe nai");
    expect(mediaCaption("[Document] Invoice.pdf", "DOCUMENT")).toBeNull();
    expect(mediaCaption("[Voice message]", "AUDIO")).toBeNull();
    expect(mediaCaption("plain text", null)).toBe("plain text");
  });

  it("recognises a message that carried a file, but not a location or a contact card", () => {
    expect(isMediaPlaceholderBody("[Image]")).toBe(true);
    expect(isMediaPlaceholderBody("[Video] look")).toBe(true);
    expect(isMediaPlaceholderBody("[Location] Dhaka")).toBe(false);
    expect(isMediaPlaceholderBody("[Contact card]")).toBe(false);
    expect(isMediaPlaceholderBody("[Imagery] not a label")).toBe(false);
  });

  it("only media a browser renders as media is inline; HTML, SVG and anything unknown are downloads", () => {
    expect(inlineMediaKind("image/jpeg")).toBe("image");
    expect(inlineMediaKind("audio/ogg; codecs=opus")).toBe("audio");
    expect(inlineMediaKind("video/mp4")).toBe("video");
    expect(inlineMediaKind("application/pdf")).toBe("pdf");
    for (const mime of ["text/html", "image/svg+xml", "application/javascript", "application/xhtml+xml", null, ""]) {
      expect(inlineMediaKind(mime)).toBeNull();
    }
  });

  it("formats sizes and durations from real values only", () => {
    expect(formatMediaBytes(null)).toBe("—");
    expect(formatMediaBytes(40)).toBe("40 bytes");
    expect(formatMediaBytes(2.4 * 1024 * 1024)).toBe("2.4 MB");
    expect(formatMediaBytes(184.7 * 1024 ** 3)).toBe("185 GB");
    expect(formatMediaBytes(18.7 * 1024 ** 3)).toBe("18.7 GB");
    expect(formatMediaDuration(32)).toBe("0:32");
    expect(formatMediaDuration(134)).toBe("2:14");
    expect(formatMediaDuration(3729)).toBe("1:02:09");
    expect(formatMediaDuration(null)).toBeNull();
  });
});
