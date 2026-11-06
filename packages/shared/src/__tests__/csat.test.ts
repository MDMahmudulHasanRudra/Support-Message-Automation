import { describe, expect, it } from "vitest";
import {
  clampCsatCooldownDays,
  csatChannelEnabled,
  csatChannelForConversation,
  csatChannelForWhatsApp,
  csatCustomerKey,
  csatQuestionFor,
  DEFAULT_CSAT_QUESTION,
  DEFAULT_CSAT_SWITCHES,
  DEFAULT_CSAT_WIDGET_QUESTION,
  parseCsatRating,
  readCsatComment,
  readCsatRating,
  summarizeCsat,
} from "../csat.js";

describe("parseCsatRating — only a message that IS a rating counts", () => {
  it.each([
    ["5", 5],
    ["1", 1],
    [" 3 ", 3],
    ["4.", 4],
    ["5!", 5],
    ["৫", 5],
    ["২", 2],
    ["৪।", 4],
    ["٤", 4],
    ["4/5", 4],
    ["4 / 5", 4],
    ["৪/৫", 4],
    ["৩ / ৫", 3],
    ["5 out of 5", 5],
    ["2 of 5", 2],
    ["5⭐", 5],
    ["3 stars", 3],
    ["1 star", 1],
    ["⭐", 1],
    ["⭐⭐⭐⭐", 4],
    ["⭐ ⭐ ⭐", 3],
    ["★★★★★", 5],
    ["🌟🌟", 2],
    ["5️⃣", 5],
  ])("reads %j as %i", (text, rating) => {
    expect(parseCsatRating(text)).toBe(rating);
  });

  it.each([
    "",
    "   ",
    "0",
    "6",
    "10",
    "45",
    "5/10",
    "0/5",
    "6/5",
    "1-5",
    "5 days and still no internet",
    "আমার বিল ৫ টাকা বেশি",
    "ok",
    "thanks",
    "ধন্যবাদ",
    "⭐⭐⭐⭐⭐⭐",
    "⭐5",
    "5 5",
    "👍",
    "invoice 5",
    "5 please call me",
  ])("leaves %j as an ordinary message", (text) => {
    expect(parseCsatRating(text)).toBeNull();
  });

  it("refuses anything that is not a string and long messages", () => {
    expect(parseCsatRating(null)).toBeNull();
    expect(parseCsatRating(undefined)).toBeNull();
    expect(parseCsatRating(`5${" ".repeat(60)}`)).toBeNull();
  });
});

describe("widget input", () => {
  it("takes only an integer 1–5", () => {
    expect(readCsatRating(4)).toBe(4);
    expect(readCsatRating("5")).toBe(5);
    for (const bad of [0, 6, 2.5, "x", null, undefined, "6", -1, "1e0"]) expect(readCsatRating(bad)).toBeNull();
  });
  it("trims and caps a comment; empty is none", () => {
    expect(readCsatComment("  great  ")).toBe("great");
    expect(readCsatComment("   ")).toBeNull();
    expect(readCsatComment(5)).toBeNull();
    expect(readCsatComment("x".repeat(5000))).toHaveLength(1000);
  });
});

describe("where a survey may be asked", () => {
  it("never in a WhatsApp group; personal chats by phone or LID", () => {
    expect(csatChannelForWhatsApp("120363-1@g.us")).toBeNull();
    expect(csatChannelForWhatsApp("8801712345678@c.us")).toBe("WHATSAPP_PERSONAL");
    expect(csatChannelForWhatsApp("123456789012345@lid")).toBe("WHATSAPP_PERSONAL");
    expect(csatChannelForWhatsApp("status@broadcast")).toBeNull();
  });
  it("never in a channel group thread", () => {
    expect(csatChannelForConversation("TELEGRAM", "GROUP")).toBeNull();
    expect(csatChannelForConversation("TELEGRAM", "DIRECT")).toBe("TELEGRAM");
    expect(csatChannelForConversation("WEBCHAT", "DIRECT")).toBe("WEBCHAT");
    expect(csatChannelForConversation("TIKTOK", "DIRECT")).toBeNull();
  });
  it("every channel is off until the project switches it on", () => {
    for (const ch of ["WHATSAPP_PERSONAL", "WEBCHAT", "MESSENGER", "INSTAGRAM", "TELEGRAM"] as const) expect(csatChannelEnabled(DEFAULT_CSAT_SWITCHES, ch)).toBe(false);
    expect(csatChannelEnabled({ ...DEFAULT_CSAT_SWITCHES, telegramEnabled: true }, "TELEGRAM")).toBe(true);
    expect(csatChannelEnabled({ ...DEFAULT_CSAT_SWITCHES, telegramEnabled: true }, "MESSENGER")).toBe(false);
  });
  it("the customer key spans our numbers for WhatsApp and is per thread for channels", () => {
    expect(csatCustomerKey({ kind: "whatsapp", chatId: "88017@c.us" })).toBe("wa:88017@c.us");
    expect(csatCustomerKey({ kind: "channel", connectionId: "c1", externalThreadId: "t1" })).toBe("ch:c1:t1");
  });
});

describe("settings", () => {
  it("question: the admin's text, else the built-in for that channel", () => {
    expect(csatQuestionFor("TELEGRAM", null)).toBe(DEFAULT_CSAT_QUESTION);
    expect(csatQuestionFor("WEBCHAT", "  ")).toBe(DEFAULT_CSAT_WIDGET_QUESTION);
    expect(csatQuestionFor("MESSENGER", " Rate us 1-5 ")).toBe("Rate us 1-5");
  });
  it("cooldown is clamped to 0–365 days, default 7", () => {
    expect(clampCsatCooldownDays("abc")).toBe(7);
    expect(clampCsatCooldownDays(-3)).toBe(0);
    expect(clampCsatCooldownDays(900)).toBe(365);
    expect(clampCsatCooldownDays("14")).toBe(14);
  });
});

describe("summarizeCsat — one formula for every figure", () => {
  it("CSAT is 4–5 of the answered; response rate is answered of asked; skipped surveys do not count", () => {
    const s = summarizeCsat([
      { asked: true, rating: 5 },
      { asked: true, rating: 4 },
      { asked: true, rating: 2 },
      { asked: true, rating: null },
      { asked: false, rating: null },
    ]);
    expect(s).toMatchObject({ asked: 4, answered: 3, distribution: [0, 1, 0, 1, 1] });
    expect(s.responseRate).toBeCloseTo(0.75);
    expect(s.csat).toBeCloseTo(2 / 3);
    expect(s.average).toBeCloseTo(11 / 3);
  });
  it("nothing asked or answered is unknown, never zero", () => {
    expect(summarizeCsat([])).toMatchObject({ asked: 0, answered: 0, responseRate: null, csat: null, average: null });
    expect(summarizeCsat([{ asked: true, rating: null }])).toMatchObject({ responseRate: 0, csat: null, average: null });
  });
});
