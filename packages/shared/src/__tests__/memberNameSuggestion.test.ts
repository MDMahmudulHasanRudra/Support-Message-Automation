import { describe, expect, it } from "vitest";
import { namesMatch, nameTokens, suggestMemberForSender, type SuggestableMember } from "../unifiedReporting/memberNameSuggestion.js";
import { whatsappIdBadge } from "../unifiedReporting/whatsappIdLinkState.js";

// Synthetic names only; the Bengali names are made up.
const member = (id: string, name: string, extra: Partial<SuggestableMember> = {}): SuggestableMember => ({
  id,
  name,
  phoneNumber: "+8801000000001",
  whatsappId: null,
  matchedRecently: false,
  ...extra,
});

describe("nameTokens", () => {
  it("folds case, punctuation, whitespace and Latin diacritics", () => {
    expect(nameTokens("  José   Álvarez-Test. ")).toEqual(["jose", "alvarez", "test"]);
    expect(nameTokens("RINA_akter")).toEqual(["rina", "akter"]);
    expect(nameTokens("Rina 🙂 Akter")).toEqual(["rina", "akter"]);
    expect(nameTokens(null)).toEqual([]);
    expect(nameTokens("   ")).toEqual([]);
  });

  it("keeps Bengali letters and their vowel signs intact (they are combining marks, not diacritics)", () => {
    expect(nameTokens("মৌসুমী আক্তার")).toEqual(["মৌসুমী", "আক্তার"]);
  });
});

describe("namesMatch", () => {
  it("the same words in any order match", () => {
    expect(namesMatch("Akter Rina", "rina   akter")).toBe(true);
    expect(namesMatch("Rina", "RINA")).toBe(true);
  });

  it("a name with extra words matches when the shorter has at least two words (a company suffix)", () => {
    expect(namesMatch("Rina Akter SoftifyBD", "Rina Akter")).toBe(true);
    expect(namesMatch("Rina Akter", "Rina Akter SoftifyBD")).toBe(true);
    expect(namesMatch("SoftifyBD | Babul Hossain Test", "Babul Hossain")).toBe(true);
  });

  it("a one-word name inside a longer one does NOT match", () => {
    expect(namesMatch("Rina Akter SoftifyBD", "Rina")).toBe(false);
    expect(namesMatch("Rina", "Rina Akter")).toBe(false);
  });

  it("different words do not match, and neither does an empty name", () => {
    expect(namesMatch("Rina Akter", "Rina Begum")).toBe(false);
    expect(namesMatch("", "Rina Akter")).toBe(false);
    expect(namesMatch("Rina Akter", null)).toBe(false);
  });

  it("matches Bengali names, with an extra word and a different order", () => {
    expect(namesMatch("মৌসুমী আক্তার SoftifyBD", "মৌসুমী আক্তার")).toBe(true);
    expect(namesMatch("আক্তার মৌসুমী", "মৌসুমী আক্তার")).toBe(true);
    expect(namesMatch("মৌসুমী", "মৌসুমী আক্তার")).toBe(false);
    expect(namesMatch("মৌসুমী আক্তার", "মৌসুমী বেগম")).toBe(false);
  });
});

describe("suggestMemberForSender", () => {
  it("names one member", () => {
    expect(suggestMemberForSender("Rina Akter SoftifyBD", [member("m1", "Rina Akter"), member("m2", "Babul Hossain")])).toEqual({ kind: "ONE", memberId: "m1" });
  });

  it("several candidates is NOT a single suggestion", () => {
    const result = suggestMemberForSender("Rina Akter Test", [member("m2", "Rina Akter Test"), member("m1", "Rina Akter")]);
    expect(result).toEqual({ kind: "SEVERAL", memberIds: ["m1", "m2"] });
  });

  it("nobody matches, or the sender has no name", () => {
    expect(suggestMemberForSender("Someone Else", [member("m1", "Rina Akter")])).toEqual({ kind: "NONE" });
    expect(suggestMemberForSender(null, [member("m1", "Rina Akter")])).toEqual({ kind: "NONE" });
    expect(suggestMemberForSender("   ", [member("m1", "Rina Akter")])).toEqual({ kind: "NONE" });
  });

  it("a member whose messages already match (a real WhatsApp ID, seen recently) is not the missing half", () => {
    const matched = member("m1", "Rina Akter", { matchedRecently: true, whatsappId: "100000000001" });
    expect(suggestMemberForSender("Rina Akter", [matched])).toEqual({ kind: "NONE" });
  });

  it("a member who matched no message in the window is offered, even with a stored WhatsApp ID", () => {
    expect(suggestMemberForSender("Rina Akter", [member("m1", "Rina Akter", { whatsappId: "100000000001" })])).toEqual({ kind: "ONE", memberId: "m1" });
  });

  it("a member whose stored WhatsApp ID is empty or only their phone is offered even when messages matched them", () => {
    const placeholder = member("m1", "Rina Akter", { matchedRecently: true, whatsappId: "8801000000001@c.us" });
    expect(suggestMemberForSender("Rina Akter", [placeholder])).toEqual({ kind: "ONE", memberId: "m1" });
    const empty = member("m2", "Babul Hossain", { matchedRecently: true, whatsappId: "" });
    expect(suggestMemberForSender("Babul Hossain", [empty])).toEqual({ kind: "ONE", memberId: "m2" });
  });

  it("works on Bengali names", () => {
    expect(suggestMemberForSender("মৌসুমী আক্তার SoftifyBD", [member("m1", "মৌসুমী আক্তার"), member("m2", "Rina Akter")])).toEqual({ kind: "ONE", memberId: "m1" });
  });
});

describe("whatsappIdBadge (display only)", () => {
  const badge = (phoneNumber: string, whatsappId: string | null) => whatsappIdBadge({ phoneNumber, whatsappId });

  it("an ID equal to a Bangladeshi mobile number is 'not linked' (the number is real, the private ID is missing)", () => {
    expect(badge("8801712345678", "8801712345678")).toBe("UNLINKED_BD_MOBILE");
    expect(badge("+8801712345678", "8801712345678")).toBe("UNLINKED_BD_MOBILE");
    expect(badge("8801312345678", "8801312345678@c.us")).toBe("UNLINKED_BD_MOBILE");
  });

  it("an ID equal to the phone that is NOT a Bangladeshi mobile number keeps 'needs phone number'", () => {
    expect(badge("100000000001", "100000000001")).toBe("NEEDS_PHONE"); // a private ID typed into both fields
    expect(badge("8801212345678", "8801212345678")).toBe("NEEDS_PHONE"); // 8801[3-9] required
    expect(badge("880171234567", "880171234567")).toBe("NEEDS_PHONE"); // too short
    expect(badge("88017123456789", "88017123456789")).toBe("NEEDS_PHONE"); // too long
  });

  it("an empty ID, or one that differs from the phone, shows nothing", () => {
    expect(badge("8801712345678", null)).toBe("NONE");
    expect(badge("8801712345678", "")).toBe("NONE");
    expect(badge("8801712345678", "100000000001")).toBe("NONE");
  });
});
