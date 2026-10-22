import { describe, expect, it } from "vitest";
import { avatarsGloballyDisabled, isAllowedPictureUrl, pictureRefFromThumb, resolveContactPhone } from "../whatsappPictures.js";

const PPS = "https://pps.whatsapp.net/v/t61.24694-24/123_n.jpg?ccb=11-4&oh=01_x&oe=6720";

describe("picture addresses (SSRF)", () => {
  it("accepts only HTTPS to WhatsApp's own picture hosts", () => {
    expect(isAllowedPictureUrl(PPS)).toBe(true);
    expect(isAllowedPictureUrl("https://mmg.whatsapp.net/x.jpg")).toBe(true);
  });
  it.each([
    ["plain http", "http://pps.whatsapp.net/x.jpg"],
    ["another site", "https://example.com/x.jpg"],
    ["a look-alike host", "https://pps.whatsapp.net.evil.com/x.jpg"],
    ["a suffix trick", "https://evilwhatsapp.net/x.jpg"],
    ["an IP address", "https://127.0.0.1/x.jpg"],
    ["a metadata service", "https://169.254.169.254/latest"],
    ["localhost", "https://localhost/x.jpg"],
    ["credentials", "https://user:pass@pps.whatsapp.net/x.jpg"],
    ["another port", "https://pps.whatsapp.net:8443/x.jpg"],
    ["a data URL", "data:image/png;base64,AAAA"],
    ["a file URL", "file:///etc/passwd"],
    ["not a URL", "pps.whatsapp.net/x.jpg"],
    ["too long", `https://pps.whatsapp.net/${"a".repeat(3000)}`],
  ])("refuses %s", (_label, url) => {
    expect(isAllowedPictureUrl(url)).toBe(false);
  });
  it("refuses non-strings", () => {
    expect(isAllowedPictureUrl(undefined)).toBe(false);
    expect(isAllowedPictureUrl({ toString: () => PPS })).toBe(false);
  });
});

describe("pictures carried on an event", () => {
  it("prefers the thumbnail and keeps WhatsApp's tag", () => {
    expect(pictureRefFromThumb({ img: PPS, eurl: "https://pps.whatsapp.net/full.jpg", tag: "1700000000" })).toEqual({ url: PPS, tag: "1700000000" });
  });
  it("falls back to another allowed address, and to no tag", () => {
    expect(pictureRefFromThumb({ img: "https://evil.example/x.jpg", eurl: PPS })).toEqual({ url: PPS, tag: null });
  });
  it("reads an empty, missing or hostile object as no picture", () => {
    expect(pictureRefFromThumb({})).toBeNull();
    expect(pictureRefFromThumb(null)).toBeNull();
    expect(pictureRefFromThumb("https://pps.whatsapp.net/x.jpg")).toBeNull();
    expect(pictureRefFromThumb({ img: "http://169.254.169.254/" })).toBeNull();
  });
});

describe("the emergency switch", () => {
  it("is on only when set to a true value", () => {
    expect(avatarsGloballyDisabled({ WHATSAPP_AVATARS_DISABLED: "true" })).toBe(true);
    expect(avatarsGloballyDisabled({ WHATSAPP_AVATARS_DISABLED: "1" })).toBe(true);
    expect(avatarsGloballyDisabled({ WHATSAPP_AVATARS_DISABLED: "" })).toBe(false);
    expect(avatarsGloballyDisabled({})).toBe(false);
  });
});

describe("phone numbers are evidence, never a guess", () => {
  const LID = "123456789012345";
  it("a LID is never read as a number", () => {
    expect(resolveContactPhone({ senderPhone: LID, senderJid: `${LID}@lid` })).toEqual({ state: "UNAVAILABLE", reason: "HIDDEN_BY_WHATSAPP" });
  });
  it("a number WhatsApp gave is shown as WhatsApp's", () => {
    expect(resolveContactPhone({ senderPhone: "8801712345678", senderJid: "8801712345678@c.us" })).toEqual({ state: "KNOWN", phone: "+8801712345678", source: "WHATSAPP" });
  });
  it("a team member's typed number is used, but not a LID stored as a placeholder", () => {
    const lid = `${LID}@lid`;
    expect(resolveContactPhone({ senderPhone: LID, senderJid: lid, rosterPhone: { phoneNumber: "01712345678", whatsappId: LID } })).toEqual({ state: "KNOWN", phone: "+8801712345678", source: "TEAM_ROSTER" });
    expect(resolveContactPhone({ senderPhone: LID, senderJid: lid, rosterPhone: { phoneNumber: LID, whatsappId: LID } })).toEqual({ state: "UNAVAILABLE", reason: "HIDDEN_BY_WHATSAPP" });
  });
  it("a linked client's number is used, and WhatsApp's own number wins over both", () => {
    expect(resolveContactPhone({ senderPhone: LID, senderJid: `${LID}@lid`, clientPhone: "+880 1812-345678" })).toEqual({ state: "KNOWN", phone: "+8801812345678", source: "CLIENT_RECORD" });
    expect(resolveContactPhone({ senderPhone: "8801712345678", senderJid: "8801712345678@c.us", clientPhone: "01812345678" })).toMatchObject({ phone: "+8801712345678", source: "WHATSAPP" });
  });
  it("a group or broadcast id is not a person", () => {
    expect(resolveContactPhone({ senderPhone: "1203630", senderJid: "1203630@g.us" })).toEqual({ state: "UNAVAILABLE", reason: "NOT_A_PERSON" });
  });
  it("a client value that is a LID is not a number", () => {
    expect(resolveContactPhone({ senderPhone: LID, senderJid: `${LID}@lid`, clientPhone: `${LID}@lid` })).toEqual({ state: "UNAVAILABLE", reason: "HIDDEN_BY_WHATSAPP" });
  });
});
