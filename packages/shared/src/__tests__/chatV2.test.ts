import { describe, expect, it } from "vitest";
import {
  compareThreadPosition,
  decodeThreadCursor,
  encodeThreadCursor,
  mergeThreadPages,
  oldestPosition,
} from "../chatThreadCursor.js";
import { formatMessageBody, safeLinkHref, tokensToPlainText, type FormatToken } from "../chatMessageFormat.js";
import { isValidReactionEmoji, summariseOwnReactions, type ReactionCommandRow } from "../chatReactions.js";
import { MAX_MENTIONS, phoneJidDigits, validateMentions } from "../chatMentions.js";

describe("thread cursor", () => {
  it("round-trips a position", () => {
    const cursor = encodeThreadCursor({ at: 1791986574000, id: "cmv86l3bw000nvtsm2cms316u" });
    expect(decodeThreadCursor(cursor)).toEqual({ at: 1791986574000, id: "cmv86l3bw000nvtsm2cms316u" });
  });

  it("refuses anything it did not write", () => {
    for (const bad of [null, 42, "", "abc", "1.2.3", "-1.abc", "12.ab cd", "12.' OR 1=1 --", "9".repeat(20) + ".a", `1.${"a".repeat(65)}`]) {
      expect(decodeThreadCursor(bad)).toBeNull();
    }
  });

  it("orders by time then id, so equal timestamps neither repeat nor skip", () => {
    const sameSecond = [
      { at: 1000, id: "b" },
      { at: 1000, id: "a" },
      { at: 999, id: "z" },
    ];
    expect([...sameSecond].sort(compareThreadPosition).map((p) => p.id)).toEqual(["z", "a", "b"]);
    expect(oldestPosition(sameSecond)).toEqual({ at: 999, id: "z" });
    expect(oldestPosition([])).toBeNull();
  });

  it("merges pages without duplicates; the later page's copy wins", () => {
    const older = [
      { id: "a", at: new Date(1000), v: 1 },
      { id: "b", at: new Date(2000), v: 1 },
    ];
    const live = [
      { id: "b", at: new Date(2000), v: 2 },
      { id: "c", at: new Date(3000), v: 2 },
    ];
    const merged = mergeThreadPages(older, live);
    expect(merged.map((e) => `${e.id}${e.v}`)).toEqual(["a1", "b2", "c2"]);
  });
});

const plain = (tokens: FormatToken[]) => tokens.map((t) => t.type).join(",");

describe("message formatting", () => {
  it("reads WhatsApp's markers", () => {
    expect(formatMessageBody("*bold* _it_ ~gone~")).toEqual([
      { type: "bold", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " " },
      { type: "italic", children: [{ type: "text", text: "it" }] },
      { type: "text", text: " " },
      { type: "strike", children: [{ type: "text", text: "gone" }] },
    ]);
  });

  it("nests and leaves arithmetic and identifiers alone", () => {
    expect(plain(formatMessageBody("*_both_*"))).toBe("bold");
    expect(formatMessageBody("2*3*4")).toEqual([{ type: "text", text: "2*3*4" }]);
    expect(formatMessageBody("snake_case_name")).toEqual([{ type: "text", text: "snake_case_name" }]);
    expect(formatMessageBody("* not bold *")).toEqual([{ type: "text", text: "* not bold *" }]);
    expect(formatMessageBody("*across\nlines*")).toEqual([{ type: "text", text: "*across\nlines*" }]);
  });

  it("keeps code verbatim", () => {
    expect(formatMessageBody("run ```a *b* _c_``` now")).toEqual([
      { type: "text", text: "run " },
      { type: "codeBlock", text: "a *b* _c_" },
      { type: "text", text: " now" },
    ]);
    expect(formatMessageBody("use `x_y_z`")).toEqual([{ type: "text", text: "use " }, { type: "code", text: "x_y_z" }]);
  });

  it("links only http(s), never formats inside a URL, and leaves sentence punctuation outside", () => {
    expect(formatMessageBody("see https://ex.com/a_b_c.")).toEqual([
      { type: "text", text: "see " },
      { type: "link", href: "https://ex.com/a_b_c", text: "https://ex.com/a_b_c" },
      { type: "text", text: "." },
    ]);
    expect(formatMessageBody("www.softifybd.com")).toEqual([{ type: "link", href: "https://www.softifybd.com/", text: "www.softifybd.com" }]);
    expect(safeLinkHref("javascript:alert(1)")).toBeNull();
    // A host, but not a web protocol: only the protocol check itself refuses this.
    expect(safeLinkHref("ftp://ex.com/file")).toBeNull();
    expect(safeLinkHref("http://ex.com/")).toBe("http://ex.com/");
    expect(plain(formatMessageBody("javascript:alert(1) data:text/html,<b>x</b>"))).toBe("text");
  });

  it("treats a body as text, never markup", () => {
    const tokens = formatMessageBody('<img src=x onerror="alert(1)"> <script>alert(1)</script>');
    expect(tokens).toEqual([{ type: "text", text: '<img src=x onerror="alert(1)"> <script>alert(1)</script>' }]);
  });

  it("marks @digits as a mention without deciding what the digits are", () => {
    expect(formatMessageBody("hi @8801712345678, and @38552482127921")).toEqual([
      { type: "text", text: "hi " },
      { type: "mention", digits: "8801712345678", text: "@8801712345678" },
      { type: "text", text: ", and " },
      { type: "mention", digits: "38552482127921", text: "@38552482127921" },
    ]);
    expect(formatMessageBody("mail me@1234567")).toEqual([{ type: "text", text: "mail me@1234567" }]);
  });

  it("keeps Bangla and emoji intact", () => {
    const body = "আপনার বিল *পরিশোধ* হয়েছে 🙏";
    expect(tokensToPlainText(formatMessageBody(body))).toBe("আপনার বিল পরিশোধ হয়েছে 🙏");
    expect(formatMessageBody(body)[1]).toEqual({ type: "bold", children: [{ type: "text", text: "পরিশোধ" }] });
  });

  it("does not format an enormous paste", () => {
    const huge = "*x* ".repeat(5000);
    expect(formatMessageBody(huge)).toEqual([{ type: "text", text: huge }]);
  });
});

describe("reactions", () => {
  it("accepts exactly one emoji", () => {
    for (const ok of ["👍", "❤️", "🙏🏽", "🇧🇩", "1️⃣", "👨‍👩‍👧"]) expect(isValidReactionEmoji(ok), ok).toBe(true);
    for (const bad of ["", " ", "👍👍", "ok", "a👍", " 👍", "1", "<b>", null, 5]) expect(isValidReactionEmoji(bad), String(bad)).toBe(false);
  });

  const row = (over: Partial<ReactionCommandRow>): ReactionCommandRow => ({
    messageId: "m1",
    emoji: "👍",
    status: "DONE",
    createdAt: new Date(1000),
    error: null,
    requestedById: "u1",
    ...over,
  });

  it("shows a reaction as sent only once the worker confirmed it", () => {
    const pendingOnly = summariseOwnReactions([row({ status: "PENDING" })]).get("m1")!;
    expect(pendingOnly).toEqual({ confirmed: null, pending: { emoji: "👍" }, failed: null });
  });

  it("keeps the last confirmed reaction while a newer one is pending or failed", () => {
    const state = summariseOwnReactions([
      row({ emoji: "❤️", status: "DONE", createdAt: new Date(1000) }),
      row({ emoji: "😂", status: "FAILED", createdAt: new Date(2000), error: "Provider is not connected." }),
    ]).get("m1")!;
    expect(state.confirmed?.emoji).toBe("❤️");
    expect(state.failed).toEqual({ emoji: "😂", error: "Provider is not connected." });
    expect(state.pending).toBeNull();
  });

  it("the newest confirmed reaction replaces an older one", () => {
    const state = summariseOwnReactions([
      row({ emoji: "❤️", createdAt: new Date(1000) }),
      row({ emoji: "🙏", createdAt: new Date(3000) }),
    ]).get("m1")!;
    expect(state).toMatchObject({ confirmed: { emoji: "🙏" }, pending: null, failed: null });
  });
});

describe("mentions", () => {
  const candidates = new Set(["8801712345678@c.us", "8801812345678@c.us"]);

  it("reads only phone-number ids", () => {
    expect(phoneJidDigits("8801712345678@c.us")).toBe("8801712345678");
    expect(phoneJidDigits("8801712345678:12@s.whatsapp.net")).toBe("8801712345678");
    expect(phoneJidDigits("38552482127921@lid")).toBeNull();
    expect(phoneJidDigits("120363150226726211@g.us")).toBeNull();
    expect(phoneJidDigits("8801712345678")).toBeNull();
  });

  it("accepts candidates whose @number is in the text", () => {
    expect(validateMentions(["8801712345678@c.us", "8801712345678@c.us"], candidates, "hi @8801712345678 please")).toEqual({
      ok: true,
      mentions: ["8801712345678@c.us"],
    });
    expect(validateMentions(undefined, candidates, "hi")).toEqual({ ok: true, mentions: [] });
  });

  it("refuses a LID, a stranger, a missing @number, and garbage", () => {
    expect(validateMentions(["38552482127921@lid"], candidates, "@38552482127921").ok).toBe(false);
    expect(validateMentions(["8801999999999@c.us"], candidates, "@8801999999999").ok).toBe(false);
    expect(validateMentions(["8801712345678@c.us"], candidates, "hi there").ok).toBe(false);
    expect(validateMentions(["8801712345678@c.us"], candidates, "@88017123456789").ok).toBe(false);
    expect(validateMentions("8801712345678@c.us", candidates, "@8801712345678").ok).toBe(false);
    expect(validateMentions([42], candidates, "@42").ok).toBe(false);
  });

  it("caps the count", () => {
    const many = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) => `88017000000${String(i).padStart(2, "0")}@c.us`);
    const all = new Set(many);
    const body = many.map((jid) => `@${jid.split("@")[0]}`).join(" ");
    expect(validateMentions(many, all, body).ok).toBe(false);
  });
});
